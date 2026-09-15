/**
 * Phase 2 of the Obsidian → Denote migration: the converter.
 *
 * Reads the manifest and writes the whole library-to-be into a staging
 * directory: every note as a Denote Org file, every link rewritten, every
 * attachment copied under its Denote name, every verbatim folder copied as
 * it is, and a category index page for each Johnny Decimal category. The
 * real library is not touched.
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

// ---------------------------------------------------------------------------
// Looking things up
// ---------------------------------------------------------------------------

/** Library path → the entry that produces it. */
const byTarget = new Map<string, Entry>();
for (const e of manifest.entries) if (e.target) byTarget.set(e.target, e);

/** Case-insensitive fallback for link targets, as Obsidian resolves them. */
const linksLower = new Map<string, string>();
for (const [k, v] of Object.entries(manifest.links)) {
  linksLower.set(k.toLowerCase(), v);
}

function resolveLink(target: string): string | undefined {
  const t = target.trim();
  return (
    manifest.links[t] ??
    linksLower.get(t.toLowerCase()) ??
    linksLower.get(t.split("/").pop()!.toLowerCase())
  );
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
  verbatim: 0,
  indexes: 0,
  linksToNotes: 0,
  linksToFiles: 0,
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
  stats.linksToFiles++;
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

const frontMatter = /^---\n[\s\S]*?\n---\n?/;

function convertNote(e: Entry) {
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
  write(e.target!, `${head}\n${body}`);
  stats[e.kind === "journal" ? "journal" : "notes"]++;
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
// Category index pages
// ---------------------------------------------------------------------------

/**
 * One index page per Johnny Decimal category, holding a `denote-links` block
 * for the notes directly in it and one per sub-folder -- so the walk is Home
 * → category → note, and no folder below a category gets a file it did not
 * ask for. The blocks are pre-filled so the page is useful before anything
 * refreshes it.
 *
 * A note already titled like the category (`21.00 iteam`) *is* the index:
 * the blocks are appended to it rather than a second page made.
 */
function writeCategoryIndexes() {
  const notes = manifest.entries.filter((e) => e.kind === "note" && e.target);
  const categories = new Map<string, Entry[]>();
  for (const e of notes) {
    const top = e.target!.split("/")[0];
    if (/^\d{2} /.test(top))
      categories.set(top, [...(categories.get(top) ?? []), e]);
  }
  for (const [cat, inCat] of categories) {
    const [, num, name] = /^(\d{2}) (.+)$/.exec(cat)!;
    const subs = new Map<string, Entry[]>();
    const direct: Entry[] = [];
    for (const e of inCat) {
      const rest = e.target!.slice(cat.length + 1).split("/");
      if (rest.length === 1) direct.push(e);
      else subs.set(rest[0], [...(subs.get(rest[0]) ?? []), e]);
    }
    const block = (heading: string, regexp: string, list: Entry[]) =>
      [
        `* ${heading}`,
        `#+BEGIN: denote-links :regexp ${JSON.stringify(regexp)} :not-regexp nil :excluded-dirs-regexp nil :sort-by-component title :reverse-sort nil :id-only nil :include-date nil`,
        ...list
          .sort((a, b) => a.title.localeCompare(b.title))
          .map((e) => `- [[denote:${e.identifier}][${e.title}]]`),
        "#+END:",
        "",
      ].join("\n");
    const sections = [
      ...(direct.length
        ? [block(name, `^${escapeRe(cat)}/[^/]+\\.org$`, direct)]
        : []),
      ...[...subs]
        .sort()
        .map(([sub, list]) =>
          block(sub, `^${escapeRe(`${cat}/${sub}`)}/`, list),
        ),
    ].join("\n");

    const isIndexFile = (e: Entry) => /(^|\/)\d{2}\.00 /.test(e.source);
    const existing = inCat
      .filter(
        (e) =>
          titleOf(e.title) === titleOf(name) &&
          e.target!.split("/").length <= 3,
      )
      // An explicit `21.00 iteam` note is the index if there is one; failing
      // that, the one nearest the category root.
      .sort(
        (a, b) =>
          Number(isIndexFile(b)) - Number(isIndexFile(a)) ||
          a.target!.length - b.target!.length,
      )[0];
    if (existing) {
      const abs = join(staging, existing.target!);
      writeFileSync(
        abs,
        `${readFileSync(abs, "utf8").trimEnd()}\n\n${sections}`,
      );
    } else {
      const identifier = `00000000T0000${num}`;
      const target = `${cat}/${formatDenoteName({ identifier, signature: `${num}=00`, title: name, keywords: [], extension: ".org" })}`;
      const head = formatDenoteFrontMatter(
        {
          title: name,
          date: denoteDate(new Date(0), "org"),
          keywords: [],
          hasKeywords: false,
          identifier,
          signature: `${num}=00`,
        },
        "org",
      );
      write(target, `${head}\n${sections}`);
    }
    stats.indexes++;
    homeLinks.push({
      num,
      name,
      identifier: existing ? existing.identifier : `00000000T0000${num}`,
    });
  }
  // The home page exists in the library already; this is appended to it at
  // cutover. A static list rather than a dblock: a `00 meta/` note carries
  // `==21=00--` as much as the index does, so no regexp picks out exactly
  // the indexes, and categories change rarely enough to edit by hand.
  const addendum = [
    "* Categories",
    ...homeLinks
      .sort((a, b) => a.num.localeCompare(b.num))
      .map((h) => `- [[denote:${h.identifier}][${h.num} ${h.name}]]`),
    "",
  ].join("\n");
  writeFileSync(join(config.out, "home-addendum.org"), addendum);
  // The staged library gets the merged home page too, so it can be browsed
  // -- and so the merge is rehearsed rather than done for the first time at
  // cutover. The library's own home is read, never written.
  const homeName = config.linkAliases["✱ Home"];
  let home = "";
  try {
    home = readFileSync(join(config.library, homeName), "utf8").trimEnd();
  } catch {
    home = `#+title:      Home\n#+identifier: 00000000T000000\n`;
  }
  write(homeName, `${home}\n\n${addendum}`);
  writeSpaceIgnore();
}

/**
 * What SilverBullet should not see. The verbatim folders hold thousands of
 * files no note links to -- a repository's objects, a saved page's images --
 * and indexing them is pure cost; `SB_SPACE_IGNORE` takes gitignore syntax.
 * The library's own ignore list (Emacs backups, sync conflicts) stays.
 */
function writeSpaceIgnore() {
  const lines = [
    "# Generated by the Obsidian migration: folders copied verbatim.",
    "# Append to SB_SPACE_IGNORE; also worth mirroring in .stignore for .git.",
    ...manifest.entries
      .filter((e) => e.kind === "verbatim" && e.target)
      .map((e) => `/${e.target!.replace(/[\[\]*?]/g, "\\$&")}/`),
    "*.nosync/",
    ".git/",
    "node_modules/",
  ];
  writeFileSync(join(config.out, "space-ignore.txt"), `${lines.join("\n")}\n`);
}

const homeLinks: { num: string; name: string; identifier: string }[] = [];

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  if (!only) rmSync(staging, { recursive: true, force: true });
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
        const dest = join(staging, e.target);
        mkdirSync(dirname(dest), { recursive: true });
        // A rendered page lives in the raster cache, not the vault.
        copyFileSync(e.raster ? e.source : abs, dest);
        stats.attachments++;
        break;
      }
      case "verbatim":
        cpSync(abs, join(staging, e.target), { recursive: true });
        stats.verbatim++;
        break;
    }
    if (++n % 500 === 0) console.log(`  ${n} entries…`);
  }
  if (!only) {
    attachOrphanScans();
    writeCategoryIndexes();
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
    `| verbatim folders | ${stats.verbatim} |`,
    `| category index pages | ${stats.indexes} |`,
    `| links → notes (\`denote:\`) | ${stats.linksToNotes} |`,
    `| links → files (\`file:\`) | ${stats.linksToFiles} |`,
    `| links left bare (no target) | ${stats.linksUnresolved} |`,
    `| pandoc failures (kept as Markdown) | ${stats.pandocFailures.length} |`,
    "",
    ...stats.pandocFailures.map((f) => `- \`${f}\``),
  ].join("\n");
  writeFileSync(join(config.out, "conversion.md"), summary);
  console.log(summary);
}

main();
