/**
 * Phase 2 of the Obsidian → Denote migration: the converter.
 *
 * Reads the manifest and writes the whole library-to-be into a staging
 * directory: every note as a Denote Org file, every link rewritten, every
 * attachment copied under its Denote name, and a hub note for each Johnny
 * Decimal category. Code folders are staged separately for ~/code. The real
 * library is not touched.
 *
 *     npx tsx tools/obsidian-migration/convert.ts [--only <substring>]
 */
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import {
  denoteDate,
  denoteIdentifier,
  formatDenoteFrontMatter,
  formatDenoteName,
  journalTitle,
  parseDenoteName,
  sluggify,
} from "../../plug-api/lib/denote.ts";
import { config } from "./config.ts";
import type { Entry, Manifest } from "./manifest.ts";

const only = process.argv.includes("--only")
  ? process.argv[process.argv.indexOf("--only") + 1]
  : undefined;

const manifest: Manifest = JSON.parse(
  readFileSync(join(config.out, "manifest.json"), "utf8"),
);
const staging = join(config.out, "staging");

/**
 * Vault path → Zotero keys, from the import. A document that is in Zotero
 * is linked there and left out of the library; only what is not -- images,
 * code -- is copied.
 */
type ZoteroEntry = { key: string; parent?: string };
const zoteroMapPath = join(config.out, "zotero-map.json");
const zoteroMap: Record<string, ZoteroEntry> = existsSync(zoteroMapPath)
  ? JSON.parse(readFileSync(zoteroMapPath, "utf8"))
  : {};
const inZotero = (source: string) => zoteroMap[source];

// ---------------------------------------------------------------------------
// Looking things up
// ---------------------------------------------------------------------------

/** Library path → the entry that produces it. */
const byTarget = new Map<string, Entry>();
for (const e of manifest.entries) if (e.target) byTarget.set(e.target, e);

/** Library path → the vault path it came from. */
const sourceByTarget = new Map<string, string>();
for (const e of manifest.entries) {
  if (!e.target) continue;
  sourceByTarget.set(e.target, e.source);
}

function* walkFiles(dir: string, rel = ""): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const r = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) yield* walkFiles(join(dir, entry.name), r);
    else yield r;
  }
}

const frontMatter = /^---\n[\s\S]*?\n---\n?/;

// ---------------------------------------------------------------------------
// Notes the library already has
// ---------------------------------------------------------------------------

/**
 * A vault note whose title is already a library note is one of four things:
 * the same note, migrated by hand earlier (dropped; links go to the library
 * copy); an empty vault stub (dropped); content the library has only a stub
 * for, or a stub the library has the content for (its body is appended to
 * the library note); or a different note under the same title (kept, and
 * listed for reconciling by hand). Sameness is the word-bag Dice coefficient,
 * which sees through Markdown/Org syntax differences.
 */
type DedupAction = "drop" | "append" | "keep";
type Dedup = { existing: string; action: DedupAction; similarity: number };
const dedup = new Map<string, Dedup>();
/** Vault library path → the library note its links go to instead. */
const redirect = new Map<string, string>();

function wordBag(text: string): Map<string, number> {
  const bag = new Map<string, number>();
  for (const w of text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []) {
    bag.set(w, (bag.get(w) ?? 0) + 1);
  }
  return bag;
}

function dice(a: Map<string, number>, b: Map<string, number>): number {
  let shared = 0;
  let total = 0;
  for (const [w, n] of a) {
    total += n;
    shared += Math.min(n, b.get(w) ?? 0);
  }
  for (const n of b.values()) total += n;
  return total ? (2 * shared) / total : 1;
}

const bagSize = (bag: Map<string, number>) =>
  [...bag.values()].reduce((a, b) => a + b, 0);

function planDedup() {
  for (const { source, existing } of manifest.duplicatesOfLibrary) {
    const e = manifest.entries.find((x) => x.source === source);
    if (!e?.target) continue;
    let vault: string;
    let lib: string;
    try {
      vault = dropTitleLine(
        readFileSync(join(config.vault, source), "utf8").replace(
          frontMatter,
          "",
        ),
        e.title,
      );
      lib = readFileSync(join(config.library, existing), "utf8").replace(
        /^#\+.*\n/gm,
        "",
      );
    } catch {
      continue;
    }
    const a = wordBag(vault);
    const b = wordBag(lib);
    const similarity = dice(a, b);
    let action: DedupAction;
    if (similarity >= 0.8 || bagSize(a) === 0) action = "drop";
    else if (bagSize(b) === 0 || bagSize(a) <= 20) action = "append";
    else action = "keep";
    dedup.set(source, { existing, action, similarity });
    if (action !== "keep") redirect.set(e.target, existing);
  }
}

/** Case-insensitive fallback for link targets, as Obsidian resolves them. */
const linksLower = new Map<string, string>();
for (const [k, v] of Object.entries(manifest.links)) {
  linksLower.set(k.toLowerCase(), v);
}

function resolveLink(target: string): string | undefined {
  const t = target.trim();
  const libPath =
    manifest.links[t] ??
    linksLower.get(t.toLowerCase()) ??
    linksLower.get(t.split("/").pop()!.toLowerCase());
  return libPath && (redirect.get(libPath) ?? libPath);
}

/** Page images written for a vault PDF, if it was a journal scan. */
function pagesFor(target: string): string[] | undefined {
  const t = target.trim();
  const direct = manifest.pageImages[t];
  if (direct) return direct;
  const lower = t.toLowerCase();
  for (const [source, pages] of Object.entries(manifest.pageImages)) {
    if (
      source.toLowerCase() === lower ||
      source.toLowerCase().endsWith(`/${lower}`)
    ) {
      return pages;
    }
  }
  return undefined;
}

/** Pages some entry has embedded, so the rest can be attached to their date. */
const linkedPages = new Set<string>();

const stats = {
  notes: 0,
  journal: 0,
  attachments: 0,
  code: 0,
  indexes: 0,
  linksToNotes: 0,
  linksToFiles: 0,
  linksToZotero: 0,
  linksToCode: 0,
  leftToZotero: 0,
  emptySkipped: 0,
  dedupDropped: 0,
  dedupAppended: 0,
  linksUnresolved: 0,
  linksExternal: 0,
  pandocFailures: [] as string[],
};

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

const isImage = (p: string) => /\.(png|jpe?g|gif|webp|svg|bmp|tiff?)$/i.test(p);

/**
 * An Org link to a vault target, from a note that will live at `fromTarget`.
 *
 * A note is addressed by identifier, which is what survives every later
 * rename; a file by a path relative to the linking note, which is what Org
 * and Emacs open natively and what the fork shows inline for an image.
 */
function orgLink(
  target: string,
  alias: string | undefined,
  embed: boolean,
  fromTarget: string,
  wasFileLink = false,
): string {
  // A scanned PDF in the journal became page images: every page, inline,
  // where the scan was linked. The alias goes -- a picture needs none.
  const pages = pagesFor(target);
  if (pages) {
    stats.linksToFiles++;
    for (const page of pages) linkedPages.add(page);
    // On one line: the scan may sit in a list item, and a second line would
    // fall out of it. Each image draws at full width anyway.
    return pages
      .map((page) => `[[file:${relative(dirname(fromTarget), page)}]]`)
      .join(" ");
  }
  const libPath = resolveLink(target);
  if (!libPath) {
    stats.linksUnresolved++;
    if (wasFileLink) {
      // A `[text](path/to/file)` whose file is gone was a broken file link in
      // the vault too. It stays one, rather than turning into a page that
      // never existed.
      return `[[file:${target}][${alias ?? target.split("/").pop()}]]`;
    }
    // Bare Org links render as missing pages in the fork, and clicking one
    // creates the note -- which is how a wiki grows. The `#heading` part, if
    // any, was already stripped by the caller.
    const name = target.trim().split("/").pop()!;
    return alias ? `[[${name}][${alias}]]` : `[[${name}]]`;
  }
  if (/\.org$/.test(libPath)) {
    stats.linksToNotes++;
    const id = parseDenoteName(libPath)?.identifier;
    const title = byTarget.get(libPath)?.title ?? libraryTitle(libPath);
    return `[[denote:${id}][${alias ?? title}]]`;
  }
  const source = sourceByTarget.get(libPath);
  const zotero = source ? inZotero(source) : undefined;
  if (zotero) {
    // The attachment's key: it opens the file, and the bibliography maps it
    // to the parent's title once Better BibTeX has exported the item. A bare
    // link reads as that title; an alias keeps the note's own words.
    stats.linksToZotero++;
    return alias
      ? `[[zotero:${zotero.key}][${alias}]]`
      : `[[zotero:${zotero.key}]]`;
  }
  stats.linksToFiles++;
  // Code lives under ~/code, outside the library: an absolute link, which
  // Emacs follows and SilverBullet shows for what it is.
  if (libPath.startsWith("~/")) {
    stats.linksToCode++;
    return `[[file:${libPath}][${alias ?? libPath.split("/").pop()}]]`;
  }
  const rel = relative(dirname(fromTarget), libPath).split("\\").join("/");
  if (embed && isImage(libPath)) return `[[file:${rel}]]`; // inline image
  return `[[file:${rel}][${alias ?? libPath.split("/").pop()}]]`;
}

const libraryTitles = new Map<string, string>();

/** The `#+title:` of a note already in the library, which the manifest has no entry for. */
function libraryTitle(libPath: string): string {
  const cached = libraryTitles.get(libPath);
  if (cached) return cached;
  let title = libPath.split("/").pop()!;
  try {
    const head = readFileSync(join(config.library, libPath), "utf8").slice(
      0,
      2000,
    );
    const m = /^#\+title:\s*(.+)$/im.exec(head);
    if (m) title = m[1].trim();
  } catch {
    // Not readable: the file name will do.
  }
  libraryTitles.set(libPath, title);
  return title;
}

// ---------------------------------------------------------------------------
// Markdown → Org
// ---------------------------------------------------------------------------

const wikiLink = /(!?)\[\[([^\]|#^]+)(?:[#^][^\]|]*)?(?:\|([^\]]*))?\]\]/g;
const mdLocalLink =
  /(!?)\[([^\]]*)\]\(((?!https?:|mailto:|shortcuts:|[a-z]+:\/\/)[^)\s]+)\)(<!--\s*\{[^}]*\}\s*-->)?/g;
const obsidianComment = /%%[\s\S]*?%%/g;
const embedComment = /<!--\s*\{[^}]*\}\s*-->/g;
const callout = /^(>\s*)\[!(\w+)\][+-]?\s*(.*)$/gm;

/**
 * Converts one note body. Links are lifted out before pandoc runs -- it has
 * no idea what an Obsidian link means and would guess -- and put back as Org
 * links afterwards, resolved through the manifest.
 */
function toOrg(
  markdown: string,
  fromTarget: string,
  sourceDir: string,
): string {
  const tokens: string[] = [];
  const stash = (org: string) => {
    tokens.push(org);
    return `QQLINK${tokens.length - 1}QQ`;
  };
  let md = markdown
    .replace(obsidianComment, "")
    .replace(embedComment, "")
    .replace(
      callout,
      (_w, quote: string, kind: string, title: string) =>
        `${quote}*${title || kind}*`,
    )
    .replace(wikiLink, (_w, bang: string, target: string, alias?: string) =>
      stash(
        orgLink(target, alias?.trim() || undefined, bang === "!", fromTarget),
      ),
    )
    .replace(mdLocalLink, (_w, bang: string, text: string, href: string) => {
      // A local Markdown link is relative to the note's own folder in the
      // vault; resolve it to a vault path so the manifest can map it.
      const decoded = decodeURIComponent(href).replace(/^\.\//, "");
      const vaultPath = decoded.startsWith("/")
        ? decoded.slice(1)
        : join(sourceDir, decoded).split("\\").join("/");
      return stash(
        orgLink(
          vaultPath,
          text.trim() || undefined,
          bang === "!",
          fromTarget,
          true,
        ),
      );
    });

  const pandoc = spawnSync(
    "pandoc",
    [
      "-f",
      // No YAML block: front matter is already stripped, and a note whose
      // body happens to open with `---` is not metadata.
      "gfm-gfm_auto_identifiers-yaml_metadata_block+task_lists",
      "-t",
      "org",
      // Keep the author's line breaks: a note written one field per line
      // stays one field per line, rather than being reflowed into a paragraph.
      "--wrap=preserve",
    ],
    { input: md, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  let org: string;
  if (pandoc.status !== 0) {
    stats.pandocFailures.push(fromTarget);
    org = md; // better a Markdown-flavoured note than a lost one
  } else {
    org = pandoc.stdout;
  }
  return (
    org
      .replace(/QQLINK(\d+)QQ/g, (_w, i: string) => tokens[Number(i)])
      // pandoc escapes what it thinks are Org specials; none of ours are.
      .replace(/\\(\[|\])/g, "$1")
      .replace(/^:PROPERTIES:\n:CUSTOM_ID:.*\n:END:\n/gm, "")
      .trimEnd() + "\n"
  );
}

function convertNote(e: Entry) {
  const d = dedup.get(e.source);
  if (d?.action === "drop") {
    stats.dedupDropped++;
    return;
  }
  const abs = join(config.vault, e.source);
  const sourceDir = dirname(e.source) === "." ? "" : dirname(e.source);
  let text = readFileSync(abs, "utf8");
  if (e.journal) {
    text = promoteHeadings(
      text.split("\n").slice(e.journal.lines[0], e.journal.lines[1]).join("\n"),
    );
  } else {
    text = text.replace(frontMatter, "").replace(/^\n+/, "");
    // Obsidian notes often start their sections at `##`, the title being the
    // file name; Org's start at `*`.
    text = promoteHeadings(dropTitleLine(text, e.title));
  }
  const date = dateOf(e.identifier);
  const head = formatDenoteFrontMatter(
    {
      title: e.title,
      date: denoteDate(date, "org"),
      keywords: e.keywords,
      hasKeywords: e.keywords.length > 0,
      identifier: e.identifier,
      signature: e.signature,
    },
    "org",
  );
  const body = toOrg(text, e.target!, sourceDir);
  if (d?.action === "append") {
    if (!body.trim()) {
      stats.dedupDropped++;
      return;
    }
    // The library note keeps its name and identifier; the vault's body goes
    // on the end, once (an earlier pass may have staged it already).
    const lib = stagedLibraryNote(d.existing);
    write(d.existing, `${lib.trimEnd()}\n\n${body.trim()}\n`);
    stats.dedupAppended++;
    return;
  }
  write(e.target!, `${head}\n${body}`);
  stats[e.kind === "journal" ? "journal" : "notes"]++;
}

/**
 * A library note as staged so far -- the staged copy if one pass has written
 * it, else the library's own. The library is read, never written.
 */
function stagedLibraryNote(libPath: string): string {
  const staged = join(staging, libPath);
  if (existsSync(staged)) return readFileSync(staged, "utf8");
  return readFileSync(join(config.library, libPath), "utf8");
}

/**
 * Lifts a section's headings so its shallowest is a top-level one. A journal
 * entry is cut from under a `## Friday 2025` that no longer exists, so its
 * `####` sub-headings would otherwise hang under nothing.
 */
function promoteHeadings(text: string): string {
  const levels = [...text.matchAll(/^(#{1,6})\s/gm)].map((m) => m[1].length);
  if (!levels.length) return text;
  const shallowest = Math.min(...levels);
  if (shallowest <= 1) return text;
  return text.replace(
    /^(#{1,6})(\s)/gm,
    (_w, hashes: string, sp: string) =>
      "#".repeat(Math.max(1, hashes.length - shallowest + 1)) + sp,
  );
}

const titleOf = (s: string) =>
  s
    .replace(/^\d{2}\.\d{2}\s+|^0?\d{8}\s*|^\d{4}-\d{2}-\d{2}\s*/, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");

/**
 * Drops a first line that merely repeats the title -- `# Title`, or the bare
 * `020120519 Liesl's Birthday` the older notes open with -- since `#+title:`
 * now says it. When that line was the note's only top-level heading, the
 * headings beneath it move up a level so they are not orphaned under
 * nothing.
 */
function dropTitleLine(text: string, title: string): string {
  const lines = text.split("\n");
  const first = lines[0] ?? "";
  const heading = /^(#+)\s+(.*)$/.exec(first);
  const plain = heading ? heading[2] : first;
  if (!plain.trim() || titleOf(plain) !== titleOf(title)) return text;
  let rest = lines.slice(1);
  if (heading?.[1] === "#" && !rest.some((l) => /^#\s/.test(l))) {
    rest = rest.map((l) => (/^#{2,}\s/.test(l) ? l.slice(1) : l));
  }
  return rest.join("\n").replace(/^\n+/, "");
}

function dateOf(identifier: string): Date {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/.exec(identifier)!;
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
}

function write(target: string, content: string) {
  const abs = join(staging, target);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

// ---------------------------------------------------------------------------
// Scans nothing linked
// ---------------------------------------------------------------------------

const takenIdentifiers = (() => {
  const taken = new Set<string>();
  for (const e of manifest.entries) if (e.identifier) taken.add(e.identifier);
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      if (entry.isDirectory()) walk(join(dir, entry.name));
      else {
        const id = parseDenoteName(entry.name)?.identifier;
        if (id) taken.add(id);
      }
    }
  };
  try {
    walk(config.library);
  } catch {
    // No library yet: only the manifest's identifiers are taken.
  }
  return taken;
})();

/** An identifier for `date` nothing holds, bumping seconds as Denote does. */
function freeIdentifier(date: Date): string {
  const candidate = new Date(date.getTime());
  for (let i = 0; i < 24 * 3600; i++) {
    const id = denoteIdentifier(candidate);
    if (!takenIdentifiers.has(id)) {
      takenIdentifiers.add(id);
      return id;
    }
    candidate.setSeconds(candidate.getSeconds() + 1);
  }
  throw new Error(`no free identifier on ${date.toDateString()}`);
}

/**
 * A scan no entry linked -- a day page that held the file but never
 * mentioned it, or a dated PDF in the journal folder with no page at all --
 * still belongs to a day. It is appended to that day's entry, and a day with
 * scans but no entry gets one holding just them.
 */
function attachOrphanScans() {
  const byDate = new Map<string, Entry[]>();
  for (const e of manifest.entries) {
    if (e.raster && e.target && !linkedPages.has(e.target)) {
      byDate.set(e.raster.date, [...(byDate.get(e.raster.date) ?? []), e]);
    }
  }
  const entriesByDate = new Map<string, Entry>();
  for (const e of manifest.entries) {
    if (e.kind === "journal" && e.target && e.journal) {
      entriesByDate.set(e.journal.date, e);
    }
  }
  let appended = 0;
  let made = 0;
  for (const [date, pages] of byDate) {
    const block = pages
      .sort((a, b) => a.target!.localeCompare(b.target!))
      .map(
        (p) => `[[file:${p.target!.slice(config.journalFolder.length + 1)}]]`,
      )
      .join(" ");
    const entry = entriesByDate.get(date);
    if (entry) {
      const abs = join(staging, entry.target!);
      writeFileSync(
        abs,
        `${readFileSync(abs, "utf8").trimEnd()}\n\n${block}\n`,
      );
      appended += pages.length;
      continue;
    }
    // No entry that day: the scans are the entry, under an identifier of
    // its own -- every identifier the manifest or the library holds is taken.
    const [y, m, d] = date.split("-").map(Number);
    const day = new Date(y, m - 1, d);
    const identifier = freeIdentifier(day);
    const title = journalTitle(day, config.journalTitleFormat);
    const target = `${config.journalFolder}/${formatDenoteName({ identifier, title, keywords: [config.journalKeyword], extension: ".org" })}`;
    const head = formatDenoteFrontMatter(
      {
        title,
        date: denoteDate(day, "org"),
        keywords: [config.journalKeyword],
        hasKeywords: true,
        identifier,
      },
      "org",
    );
    write(target, `${head}\n${block}\n`);
    made++;
    stats.journal++;
  }
  console.log(
    `scans: ${appended} pages appended to their day's entry, ${made} entries made of scans alone`,
  );
}

// ---------------------------------------------------------------------------
// Hub notes
// ---------------------------------------------------------------------------

/**
 * One hub note per vault category -- the note the category's number
 * resolves to, addressed `NN=00`, so the walk is Home → hub → note. It lists
 * the category's notes by the folder they sat in, since the flat library no
 * longer says: a `denote-links` block per signature (`==21=14`), pre-filled
 * and refreshable in Emacs and SilverBullet alike; a plain list for a folder
 * that had no number (a refresh would empty a block that matches nothing);
 * and a catch-all block for the whole category last, so nothing is lost when
 * the pre-filled lists go stale.
 *
 * A note the vault already had for the category (`21.00 iteam`, or `iteam`
 * in `21 iteam`) *is* the hub: the lists are appended to it. A category
 * without a number (`type`, `states`) gets a hub without a signature.
 */
function writeHubs() {
  const notes = manifest.entries.filter(
    (e) => e.kind === "note" && e.target && e.category,
  );
  const categories = new Map<string, Entry[]>();
  for (const e of notes) {
    categories.set(e.category!, [...(categories.get(e.category!) ?? []), e]);
  }
  for (const [cat, inCat] of [...categories].sort()) {
    const numbered = /^(\d{2}) (.+)$/.exec(cat);
    const num = numbered?.[1];
    const name = numbered?.[2] ?? cat;
    const sections = new Map<string, Entry[]>();
    const direct: Entry[] = [];
    for (const e of inCat) {
      if (e.section) {
        sections.set(e.section, [...(sections.get(e.section) ?? []), e]);
      } else {
        direct.push(e);
      }
    }
    // The hub itself: the vault's `21.00 iteam`, or `iteam` in `21 iteam`
    // or its `00 meta` (other notes in `00 meta` are the category's meta
    // notes and carry `21=00` too). It is not listed under itself.
    const isIndexFile = (e: Entry) =>
      num !== undefined && new RegExp(`(^|/)${num}\\.00 `).test(e.source);
    const existing = inCat
      .filter(
        (e) =>
          num !== undefined &&
          e.signature === `${num}=00` &&
          (isIndexFile(e) ||
            sluggify("title", e.title) === sluggify("title", name)),
      )
      .sort(
        (a, b) =>
          Number(isIndexFile(b)) - Number(isIndexFile(a)) ||
          a.source.length - b.source.length,
      )[0];
    const isHub = (e: Entry) => e === existing;
    const list = (entries: Entry[]) =>
      entries
        .filter((e) => !isHub(e))
        .map(linkTarget)
        .sort((a, b) => a.title.localeCompare(b.title))
        .map((l) => `- [[denote:${l.identifier}][${l.title}]]`);
    const block = (
      heading: string,
      regexp: string | undefined,
      entries: Entry[],
      sortBy = "title",
    ) =>
      [
        `* ${heading}`,
        ...(regexp
          ? [
              `#+BEGIN: denote-links :regexp ${JSON.stringify(regexp)} :not-regexp nil :excluded-dirs-regexp nil :sort-by-component ${sortBy} :reverse-sort nil :id-only nil :include-date nil`,
              ...list(entries),
              "#+END:",
            ]
          : list(entries)),
        "",
      ].join("\n");
    const body = [
      ...(list(direct).length
        ? [block(name, num ? `==${num}--` : undefined, direct)]
        : []),
      ...[...sections]
        .sort(([a], [b]) => a.localeCompare(b))
        .filter(([, entries]) => list(entries).length)
        .map(([section, entries]) => {
          const sub = num && /^(?:\d{2}\.)?(\d{2}) /.exec(section);
          return block(
            section,
            sub ? `==${num}=${sub[1]}--` : undefined,
            entries,
          );
        }),
      ...(num
        ? [block(`Everything in ${num}`, `==${num}[=-]`, inCat, "signature")]
        : []),
    ].join("\n");

    const existingPath = existing
      ? (redirect.get(existing.target!) ?? existing.target!)
      : undefined;
    let identifier: string;
    if (existing && existingPath) {
      const current = redirect.has(existing.target!)
        ? stagedLibraryNote(existingPath)
        : readFileSync(join(staging, existingPath), "utf8");
      write(existingPath, `${current.trimEnd()}\n\n${body}`);
      identifier =
        parseDenoteName(existingPath)?.identifier ?? existing.identifier;
    } else {
      identifier = hubIdentifier(num);
      const signature = num ? `${num}=00` : undefined;
      const target = formatDenoteName({
        identifier,
        signature,
        title: name,
        keywords: [],
        extension: ".org",
      });
      const head = formatDenoteFrontMatter(
        {
          title: name,
          date: denoteDate(new Date(), "org"),
          keywords: [],
          hasKeywords: false,
          identifier,
          signature,
        },
        "org",
      );
      write(target, `${head}\n${body}`);
    }
    stats.indexes++;
    homeLinks.push({ num, name, identifier });
  }
  writeHome();
}

/**
 * Home already lists the categories by number, by hand -- `21. iteam`, some
 * with a link to a favourite note after an arrow. Each such line gets its
 * hub linked in place: `21. [[denote:ID][iteam]]`, the arrow and what
 * follows kept. Hubs Home does not mention go in a section at the end. The
 * library's own Home is read, never written; the staged copy is what the
 * cutover installs, and `home-addendum.org` shows the difference.
 */
function writeHome() {
  const homeName = config.linkAliases["✱ Home"];
  let home = "";
  try {
    home = readFileSync(join(config.library, homeName), "utf8").trimEnd();
  } catch {
    home = `#+title:      Home\n#+identifier: 00000000T000000\n`;
  }
  const byNum = new Map(homeLinks.filter((h) => h.num).map((h) => [h.num!, h]));
  const placed = new Set<string>();
  const merged = home
    .split("\n")
    .map((line) => {
      const m = /^(\s*)(\d{2})\.\s*(.*)$/.exec(line);
      if (!m) return line;
      const hub = byNum.get(m[2]);
      if (!hub || /\[\[denote:/.test(m[3].split(" -> ")[0])) return line;
      placed.add(m[2]);
      const [text, ...rest] = m[3].split(" -> ");
      const label = text.trim() || hub.name;
      return `${m[1]}${m[2]}. [[denote:${hub.identifier}][${label}]]${
        rest.length ? ` -> ${rest.join(" -> ")}` : ""
      }`;
    })
    .join("\n");
  const missing = homeLinks
    .filter((h) => !h.num || !placed.has(h.num))
    .sort((a, b) => (a.num ?? "~").localeCompare(b.num ?? "~"));
  const addendum = missing.length
    ? [
        "* More hubs",
        ...missing.map(
          (h) =>
            `- [[denote:${h.identifier}][${h.num ? `${h.num} ${h.name}` : h.name}]]`,
        ),
        "",
      ].join("\n")
    : "";
  writeFileSync(
    join(config.out, "home-addendum.org"),
    `${placed.size} category lines linked in place.\n\n${addendum}`,
  );
  write(homeName, `${merged}\n${addendum ? `\n${addendum}` : ""}`);
}

const homeLinks: { num?: string; name: string; identifier: string }[] = [];

/**
 * A synthesized hub's identifier: `00000000T0000NN` for category NN,
 * `00000000T00NN0k` when the vault has a second category with that number
 * (it has two 81s), and `00000000T0090kk` for a category with no number.
 */
const hubIdentifiers = new Set<string>();
function hubIdentifier(num: string | undefined): string {
  let id = num ? `00000000T0000${num}` : "00000000T009001";
  for (let k = 1; hubIdentifiers.has(id); k++) {
    id = num
      ? `00000000T00${num}0${k}`
      : `00000000T0090${String(k + 1).padStart(2, "0")}`;
  }
  hubIdentifiers.add(id);
  return id;
}

/**
 * What an index list links to for a vault note: the note itself, or the
 * library note it was merged into.
 */
function linkTarget(e: Entry): { identifier: string; title: string } {
  const lib = redirect.get(e.target!);
  if (!lib) return { identifier: e.identifier, title: e.title };
  return {
    identifier: parseDenoteName(lib)?.identifier ?? e.identifier,
    title: libraryTitle(lib),
  };
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  planDedup();
  if (!only) {
    rmSync(staging, { recursive: true, force: true });
    rmSync(join(config.out, "staging-code"), { recursive: true, force: true });
  }
  mkdirSync(staging, { recursive: true });
  const started = Date.now();
  let n = 0;
  for (const e of manifest.entries) {
    if (!e.target) continue;
    if (only && !e.source.includes(only)) continue;
    const abs = join(config.vault, e.source);
    switch (e.kind) {
      case "note":
      case "journal":
        convertNote(e);
        break;
      case "attachment":
      case "journal-attachment": {
        if (inZotero(e.source)) {
          stats.leftToZotero++;
          break;
        }
        // An empty file is a sync placeholder, not a document.
        if (!e.raster && statSync(abs).size === 0) {
          stats.emptySkipped++;
          break;
        }
        const dest = join(staging, e.target);
        mkdirSync(dirname(dest), { recursive: true });
        // A rendered page lives in the raster cache, not the vault.
        copyFileSync(e.raster ? e.source : abs, dest);
        stats.attachments++;
        break;
      }
      case "code": {
        // Not part of the library: staged beside it, installed under ~/code
        // at cutover. Its documents that went to Zotero are not copied.
        const dest = join(config.out, "staging-code", e.target);
        cpSync(abs, dest, { recursive: true });
        for (const inner of walkFiles(abs)) {
          if (inZotero(`${e.source}/${inner}`)) {
            rmSync(join(dest, inner), { force: true });
            stats.leftToZotero++;
          }
        }
        stats.code++;
        break;
      }
    }
    if (++n % 500 === 0) console.log(`  ${n} entries…`);
  }
  if (!only) {
    attachOrphanScans();
    writeHubs();
  }
  const secs = ((Date.now() - started) / 1000).toFixed(0);
  const summary = [
    `# Conversion — ${new Date().toISOString().slice(0, 16).replace("T", " ")} (${secs}s)`,
    "",
    `Staged into \`${staging}\`.`,
    "",
    `| what | count |`,
    `|---|---|`,
    `| notes converted | ${stats.notes} |`,
    `| journal entries | ${stats.journal} |`,
    `| attachments copied | ${stats.attachments} |`,
    `| code folders staged for ~/code | ${stats.code} |`,
    `| hub notes | ${stats.indexes} |`,
    `| links → notes (\`denote:\`) | ${stats.linksToNotes} |`,
    `| links → files (\`file:\`) | ${stats.linksToFiles} |`,
    `| links → Zotero (\`zotero:\`) | ${stats.linksToZotero} |`,
    `| links → code under ~/code | ${stats.linksToCode} |`,
    `| documents left to Zotero, not copied | ${stats.leftToZotero} |`,
    `| empty files skipped | ${stats.emptySkipped} |`,
    `| notes the library already had (dropped) | ${stats.dedupDropped} |`,
    `| notes appended to a library note | ${stats.dedupAppended} |`,
    `| same-title notes kept apart | ${[...dedup.values()].filter((d) => d.action === "keep").length} |`,
    `| links left bare (no target) | ${stats.linksUnresolved} |`,
    `| pandoc failures (kept as Markdown) | ${stats.pandocFailures.length} |`,
    "",
    ...stats.pandocFailures.map((f) => `- \`${f}\``),
    "",
    "## Same title, different note -- both kept, reconcile by hand",
    "",
    ...[...dedup]
      .filter(([, d]) => d.action === "keep")
      .map(
        ([source, d]) =>
          `- \`${source}\` ↔ \`${d.existing}\` (${(d.similarity * 100).toFixed(0)}% alike)`,
      ),
    "",
    "## Merged into a library note",
    "",
    ...[...dedup]
      .filter(([, d]) => d.action !== "keep")
      .map(([source, d]) => `- ${d.action}: \`${source}\` → \`${d.existing}\``),
  ].join("\n");
  writeFileSync(join(config.out, "conversion.md"), summary);
  console.log(summary);
}

main();
