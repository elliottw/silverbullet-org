/**
 * Phase 1 of the Obsidian → Denote migration: the manifest.
 *
 * Walks a Johnny Decimal Obsidian vault and decides, for every file, what it
 * becomes in the Denote library — without writing anything into it. The
 * output is a manifest every later phase reads from, and a report of the
 * cases that need a human decision.
 *
 *     npx tsx tools/obsidian-migration/manifest.ts
 *
 * Reads `config.ts` beside it for the vault and library locations.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  denoteAttachmentName,
  denoteIdentifier,
  formatDenoteName,
  journalTitle,
  parseDenoteName,
  sluggify,
} from "../../plug-api/lib/denote.ts";
import { config } from "./config.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Entry = {
  /** Path inside the vault. For a journal split, the day page it came from. */
  source: string;
  kind: "note" | "attachment" | "code" | "journal" | "journal-attachment";
  /**
   * Path inside the library it becomes, or null when it is dropped. For
   * code, the path under `config.folders.codeDir` instead.
   */
  target: string | null;
  identifier: string;
  /** Where the identifier's date came from — a later phase may want to know. */
  identifierFrom: "created" | "name" | "heading" | "birthtime";
  title: string;
  signature?: string;
  keywords: string[];
  /**
   * The vault folders the note sat in, for the hub notes: its category
   * (`26 upmc community paramedic`, or a non-JD top folder like `type`) and
   * the folder under that, if any.
   */
  category?: string;
  section?: string;
  /** Every folder below the category, for an ID note's contents by folder. */
  folders?: string[];
  /** For a journal split: the section's date and its source line range. */
  journal?: { date: string; lines: [number, number] };
  /**
   * For a page rendered out of a scanned PDF: the vault PDF and the page.
   * The file itself is in the raster cache, not the vault.
   */
  raster?: { source: string; page: number; date: string };
  warnings: string[];
};

export type Manifest = {
  generatedAt: string;
  vault: string;
  library: string;
  entries: Entry[];
  /** Vault stem/path → library target, for rewriting `[[wiki]]` links. */
  links: Record<string, string>;
  /** Vault targets that resolve to nothing, with how often they are linked. */
  unresolvedLinks: Record<string, number>;
  /** Vault notes whose title already exists as a Denote note in the library. */
  duplicatesOfLibrary: { source: string; existing: string }[];
  /** Dangling vault links that turned out to name a note the library has. */
  resolvedInLibrary: number;
  /** Vault PDF → the page images it became, in order. */
  pageImages: Record<string, string[]>;
};

// ---------------------------------------------------------------------------
// Walking the vault
// ---------------------------------------------------------------------------

// `reMarkable/` is 3 GB of tablet exports and is left where it is until
// someone asks for it.
const skipDirs = [/^\.obsidian/, /^\.trash$/, /^\.claude$/, /^reMarkable$/];
const skipFiles = [
  /^\.DS_Store$/,
  /^\.gitkeep$/,
  /^\.gitignore$/,
  /\.base$/,
  /^cleanup_denote_leftovers\.sh$/,
];

const codeFolders = new Map(Object.entries(config.folders.code));
const dropFolders = new Set(config.folders.drop);

/**
 * Yields every file, and every code folder as one unit. There are no other
 * special folders: a saved web page's images, a project's photos, a dump of
 * certificates are files like any other, and the flat library takes them
 * one by one. What is code goes to ~/code; what is listed to drop is
 * dropped.
 */
function* walk(dir: string, rel = ""): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const relPath = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (skipDirs.some((r) => r.test(entry.name))) continue;
      if (dropFolders.has(relPath)) continue;
      if (codeFolders.has(relPath)) {
        yield relPath;
        continue;
      }
      yield* walk(join(dir, entry.name), relPath);
    } else if (!skipFiles.some((r) => r.test(entry.name))) {
      yield relPath;
    }
  }
}

/** Plain file walk, for what a code folder holds. */
function* walkAll(dir: string, rel = ""): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const relPath = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) yield* walkAll(join(dir, entry.name), relPath);
    else if (entry.name !== ".DS_Store") yield relPath;
  }
}

// ---------------------------------------------------------------------------
// Placement: the Johnny Decimal folders become signatures
// ---------------------------------------------------------------------------

const areaDir = /^\d+-\d+ /; // `20-29 Missions`
const numberedDir = /^(\d{2}) (.+)$/; // `21 iteam`
const idDir = /^(?:\d{2}\.)?(\d{2}) (.+)$/; // `14 landslide mediation`, `26.01 Onboarding`
const jdIdFile = /^(\d{2})\.(\d{2}) (.+)$/; // `25.03 Acorn Medic Branding`
const jdIdSuffix = /^(.+?) (\d{2})\.(\d{2})$/; // `adrianna 61.54`

/** A Johnny Decimal ID written into a note's name, before or after the title. */
export function jdIdOf(
  stem: string,
): { category: string; id: string } | undefined {
  const prefix = jdIdFile.exec(stem);
  if (prefix) return { category: prefix[1], id: prefix[2] };
  const suffix = jdIdSuffix.exec(stem);
  if (suffix) return { category: suffix[2], id: suffix[3] };
  return undefined;
}

/**
 * The numbered folder a note stands for, if it is a *folder note*: a note
 * beside a numbered folder of the same name (`existential.md` next to
 * `02 existential/`), which Obsidian users write as the folder's own page.
 * Its address is the folder's.
 */
export function folderNoteId(
  dirAbs: string,
  stem: string,
): { id: string; folder: string } | undefined {
  const wanted = sluggify("title", stem);
  for (const entry of readdirSync(dirAbs, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const m = idDir.exec(entry.name);
    if (m && sluggify("title", m[2]) === wanted) {
      return { id: m[1], folder: entry.name };
    }
  }
  return undefined;
}

export type Placement = {
  category?: string;
  section?: string;
  /** Every folder below the category, in order. */
  folders: string[];
  warnings: string[];
};

/**
 * Where a file sat: its category (`21 iteam`, or a non-JD top folder like
 * `type`), the folder under that, and every folder below the category. The
 * library is flat, so none of this becomes a path; it is what the hub notes
 * list by. The area folder (`20-29 Missions`) is implied by the category
 * number and dropped; `assets/` folders dissolve.
 */
export function place(relPath: string): Placement {
  const parts = relPath.split("/");
  const dirs = parts.slice(0, -1).filter((d) => d !== "assets");
  const kept = dirs[0] && areaDir.test(dirs[0]) ? dirs.slice(1) : dirs;
  const category = kept[0] && numberedDir.exec(kept[0]);
  return {
    category: kept[0],
    section: kept[1],
    folders: kept.slice(1),
    warnings: category
      ? []
      : [
          kept.length
            ? `not under a JD category: "${kept[0]}"`
            : "loose at the vault root",
        ],
  };
}

/**
 * A note's signature, if it has one. In Johnny Decimal the address belongs
 * to an *ID* -- a folder, or a note that names one -- not to every note
 * inside it. So a signature goes only to: the category's own note
 * (`21.00 iteam`, or `iteam` in `21 iteam` or its `00 meta`), which is the
 * hub at `NN=00`; a note carrying an ID in its name, before or after the
 * title (`25.03 Acorn Medic Branding`, `adrianna 61.54`); and a folder note
 * -- the note named like its numbered folder, inside it (`02 howm/Howm`) or
 * beside it (`existential` next to `02 existential/`). Everything else,
 * including every other note in an ID's folder, has none: it is the ID's
 * contents, reached through the ID's note.
 */
export function signatureOf(
  placement: Placement,
  stem: string,
  dirAbs: string,
): { signature?: string; section?: string } {
  const cat = placement.category && numberedDir.exec(placement.category);
  if (!cat) return {};
  const jd = jdIdOf(stem);
  if (jd) return { signature: `${jd.category}=${jd.id}` };
  const title = sluggify("title", stripPrefixes(stem) ?? stem);
  const inMeta = placement.section && /^00 /.test(placement.section);
  if ((!placement.section || inMeta) && title === sluggify("title", cat[2])) {
    return { signature: `${cat[1]}=00` };
  }
  // Inside its folder: the note named like the numbered folder it sits in.
  const own = placement.folders.at(-1) && idDir.exec(placement.folders.at(-1)!);
  if (
    own &&
    placement.folders.length === 1 &&
    title === sluggify("title", own[2])
  ) {
    return { signature: `${cat[1]}=${own[1]}` };
  }
  // Beside its folder.
  if (!placement.section) {
    const beside = folderNoteId(dirAbs, stem);
    if (beside) {
      return { signature: `${cat[1]}=${beside.id}`, section: beside.folder };
    }
  }
  return {};
}

// ---------------------------------------------------------------------------
// Dates and identifiers
// ---------------------------------------------------------------------------

const taken = new Set<string>();

/**
 * The previous run's manifest, if any: its identifiers are kept, so a note
 * keeps its identity from one run to the next and the links already
 * written to it hold. The files that run produced are also known, so the
 * library can be read as it was before the migration touched it.
 */
const previous: Manifest | undefined = existsSync(
  join(config.out, "manifest.json"),
)
  ? JSON.parse(readFileSync(join(config.out, "manifest.json"), "utf8"))
  : undefined;
const previousIdentifiers = new Map<string, string>();
const previousTargets = new Set<string>();
for (const e of previous?.entries ?? []) {
  if (e.target) previousTargets.add(e.target);
  if (e.identifier) previousIdentifiers.set(claimKey(e), e.identifier);
}
// The converter makes notes the manifest does not list -- hubs, ID notes,
// scan-only journal entries -- so the previous staging is the full record.
// A library note the cutover replaced (appended to) is still the library's
// own; its original is kept under `replaced/`, which is how it is told apart.
for (const dir of ["staging", "staging-previous"]) {
  const abs = join(config.out, dir);
  if (!existsSync(abs)) continue;
  for (const rel of walkAll(abs)) {
    if (!existsSync(join(config.out, "replaced", rel)))
      previousTargets.add(rel);
  }
}

/** What identifies an entry across runs: its source, and for a split, the piece. */
function claimKey(e: {
  source: string;
  journal?: { date: string };
  raster?: { page: number };
}): string {
  return e.journal
    ? `${e.source}#${e.journal.date}`
    : e.raster
      ? `${e.source}#p${e.raster.page}`
      : e.source;
}

/** Whether a library file is one an earlier run wrote there. */
export function isMigrated(rel: string): boolean {
  return previousTargets.has(rel);
}

/** Seeds the collision set with every identifier the library already holds. */
function seedIdentifiers(dir: string) {
  for (const rel of walk(dir)) {
    if (isMigrated(rel)) continue;
    const id = parseDenoteName(rel)?.identifier;
    if (id) taken.add(id);
  }
}

/**
 * The identifier for `key`: the one the previous run gave it, else a free
 * one for `date`, bumping seconds as `freeIdentifier` does.
 */
function claim(date: Date, key?: string): string {
  const kept = key && previousIdentifiers.get(key);
  if (kept) {
    taken.add(kept);
    return kept;
  }
  const candidate = new Date(date.getTime());
  for (let attempt = 0; attempt < 24 * 3600; attempt++) {
    const id = denoteIdentifier(candidate);
    if (!taken.has(id)) {
      taken.add(id);
      return id;
    }
    candidate.setSeconds(candidate.getSeconds() + 1);
  }
  throw new Error(`no free identifier near ${date.toISOString()}`);
}

const frontMatter = /^---\n([\s\S]*?)\n---\n?/;

function readFrontMatter(text: string): {
  created?: string;
  tags: string[];
  title?: string;
  body: string;
} {
  const m = frontMatter.exec(text);
  if (!m) return { tags: [], body: text };
  const tags: string[] = [];
  let created: string | undefined;
  let title: string | undefined;
  for (const line of m[1].split("\n")) {
    const kv = /^(\w+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const [, key, raw] = kv;
    if (key === "created") created = raw.trim().replace(/^["']|["']$/g, "");
    if (key === "title") title = raw.trim().replace(/^["']|["']$/g, "");
    if (key === "tags" || key === "tag") {
      tags.push(
        ...raw
          .replace(/^\[|\]$/g, "")
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean),
      );
    }
  }
  return { created, tags, title, body: text.slice(m[0].length) };
}

/** Obsidian's nested tags (`type/Log`) become the leaf, as a Denote keyword. */
function keywordOf(tag: string): string {
  return sluggify("keyword", tag.replace(/^#/, "").split("/").pop() ?? "");
}

const datePrefixed = /^0?(\d{4})(\d{2})(\d{2})\b|^(\d{4})-(\d{2})-(\d{2})\b/;

function dateFromName(stem: string): Date | undefined {
  const m = datePrefixed.exec(stem);
  if (!m) return undefined;
  const [y, mo, d] = m[1] ? [m[1], m[2], m[3]] : [m[4], m[5], m[6]];
  const date = new Date(+y, +mo - 1, +d);
  // `9999-99-99 Future Trip Ideas` is a sort-to-the-end trick, not a date;
  // JavaScript would happily roll it over into the year 10007.
  const real =
    date.getFullYear() === +y &&
    date.getMonth() === +mo - 1 &&
    date.getDate() === +d;
  return !real || +y < 1990 || +y > 2100 ? undefined : date;
}

const entities: Record<string, string> = {
  "&#39;": "'",
  "&amp;": "&",
  "&quot;": '"',
  "&lt;": "<",
  "&gt;": ">",
};

function stripPrefixes(stem: string): string {
  return (
    stem
      // A file name that came through a browser: `Mike_O&#39;Toole`.
      .replace(/&(#39|amp|quot|lt|gt);/g, (w) => entities[w] ?? w)
      .replace(/^#+\s*/, "") // a heading pasted as a file name
      // Denote keeps a dash in a title as it is, which makes `shade-—-the` in
      // a file name; a plain hyphen reads the same and slugs cleanly.
      .replace(/\s*[—–]\s*/g, " - ")
      .replace(jdIdFile, "$3")
      .replace(jdIdSuffix, "$1")
      .replace(/^0?\d{8}\s*/, "")
      .replace(/^\d{4}-\d{2}-\d{2}\s*/, "")
      .trim()
  );
}

/**
 * A title short enough for its Denote name to fit a file system.
 *
 * Some notes are a whole first sentence with the same sentence as the body
 * (`Drinking and smoking a lot these days. Hopefully it's just…`); with an
 * identifier, signature and extension around it that passes 255 bytes. The
 * title is cut at a word boundary until the name fits, and nothing is lost:
 * the body still has every word.
 */
function fitTitle(title: string, name: (title: string) => string): string {
  let fitted = title;
  while (Buffer.byteLength(name(fitted)) > 200 && fitted.includes(" ")) {
    fitted = fitted.replace(/\s+\S*$/, "");
  }
  return fitted;
}

// ---------------------------------------------------------------------------
// Scanned PDFs → page images
// ---------------------------------------------------------------------------

/**
 * Renders a scanned PDF to one JPEG per page, cached under the output
 * directory by the PDF's content, and returns the page files.
 *
 * A scan in the journal is journal content -- a page of handwriting, a
 * receipt -- not reference material, so it does not go to Zotero; it becomes
 * images beside the entry, shown inline, the way a pasted screenshot is.
 */
function rasterize(absPdf: string): string[] {
  const hash = createHash("md5").update(readFileSync(absPdf)).digest("hex");
  const dir = join(config.out, "rasters", hash);
  if (!existsSync(join(dir, "done"))) {
    mkdirSync(dir, { recursive: true });
    execFileSync("pdftoppm", [
      "-jpeg",
      "-r",
      String(config.rasterDpi),
      "-jpegopt",
      "quality=85",
      absPdf,
      join(dir, "page"),
    ]);
    writeFileSync(join(dir, "done"), "");
  }
  return readdirSync(dir)
    .filter((f) => /^page-\d+\.jpg$/.test(f))
    .sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]))
    .map((f) => join(dir, f));
}

/** Emits the page-image entries for a journal scan, dated to `date`. */
function scanEntries(
  rel: string,
  absPdf: string,
  date: Date,
  entries: Entry[],
  links: Record<string, string>,
  pageImages: Record<string, string[]>,
): void {
  const name = rel.split("/").pop()!;
  const pages = rasterize(absPdf);
  const targets: string[] = [];
  pages.forEach((page, i) => {
    const identifier = claim(date, `${rel}#p${i + 1}`);
    const title =
      pages.length > 1
        ? `${name.replace(/\.pdf$/i, "")} p${i + 1}`
        : name.replace(/\.pdf$/i, "");
    const target = `${config.journalFolder}/${denoteAttachmentName(identifier, `${title}.jpg`)}`;
    targets.push(target);
    entries.push({
      source: page,
      kind: "journal-attachment",
      target,
      identifier,
      identifierFrom: "name",
      title,
      keywords: [],
      raster: {
        source: rel,
        page: i + 1,
        date: date.toISOString().slice(0, 10),
      },
      warnings: [],
    });
  });
  pageImages[rel] = targets;
  links[rel] = targets[0];
  links[name] = links[name] ?? targets[0];
}

// ---------------------------------------------------------------------------
// The perpetual calendar → journal entries
// ---------------------------------------------------------------------------

const months: Record<string, number> = {
  Jan: 1,
  Feb: 2,
  Mar: 3,
  Apr: 4,
  May: 5,
  Jun: 6,
  Jul: 7,
  Aug: 8,
  Sep: 9,
  Oct: 10,
  Nov: 11,
  Dec: 12,
};
// Case-insensitive, and lenient about the weekday's spelling: the pages hold
// a `friday 2026` and a `Wednesay 2026`, and each is a year section too.
const yearHeading = /^##\s+(?:[a-z]+day\s+)?(\d{4})\s*(?:<!--.*-->)?\s*$/i;

/** The year of the section in a day page that links `fileName`, else the last section's. */
function calendarYearFor(
  dayPage: string,
  fileName: string,
): number | undefined {
  if (!existsSync(dayPage)) return undefined;
  const needle = fileName.toLowerCase();
  let year: number | undefined;
  let last: number | undefined;
  for (const line of readFileSync(dayPage, "utf8").split("\n")) {
    const h = yearHeading.exec(line);
    if (h) {
      last = +h[1];
      continue;
    }
    if (
      last &&
      !year &&
      decodeURIComponent(line).toLowerCase().includes(needle)
    ) {
      year = last;
    }
  }
  return year ?? last;
}

function splitDayPage(relPath: string, text: string): Entry[] {
  const stem = relPath.split("/").pop()!.replace(/\.md$/, "");
  const [day, mon] = stem.split(" ");
  const lines = text.split("\n");
  const heads = lines
    .map((l, i) => [i, yearHeading.exec(l)?.[1]] as const)
    .filter(([, y]) => y);
  const out: Entry[] = [];
  heads.forEach(([start, year], k) => {
    const end = k + 1 < heads.length ? heads[k + 1][0] : lines.length;
    if (!lines.slice(start + 1, end).some((l) => l.trim())) return; // template scaffolding
    const date = new Date(+year!, months[mon] - 1, +day);
    const identifier = claim(
      date,
      `${relPath}#${date.toISOString().slice(0, 10)}`,
    );
    const title = journalTitle(date, config.journalTitleFormat);
    out.push({
      source: relPath,
      kind: "journal",
      target: `${config.journalFolder}/${formatDenoteName({ identifier, title, keywords: [config.journalKeyword], extension: ".org" })}`,
      identifier,
      identifierFrom: "heading",
      title,
      keywords: [config.journalKeyword],
      journal: {
        date: date.toISOString().slice(0, 10),
        lines: [start + 1, end],
      },
      warnings: [],
    });
  });
  return out;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const { vault, library, out } = config;
  mkdirSync(out, { recursive: true });
  seedIdentifiers(library);

  const entries: Entry[] = [];
  const links: Record<string, string> = {};
  const pageImages: Record<string, string[]> = {};
  const stems = new Map<string, string[]>(); // stem → targets (for ambiguity)

  // Notes first, so a journal entry claims the round `T000000` identifier for
  // its date and the attachments beside it take the bumped ones.
  const files = [...walk(vault)].sort(
    (a, b) => Number(/\.md$/i.test(b)) - Number(/\.md$/i.test(a)),
  );
  for (const rel of files) {
    const abs = join(vault, rel);
    const name = rel.split("/").pop()!;
    const isMd = /\.md$/i.test(name);
    const inCalendar = rel.startsWith(`${config.calendarDir}/`);

    // --- The perpetual calendar --------------------------------------------
    if (inCalendar) {
      const under = rel.slice(config.calendarDir.length + 1);
      if (under.startsWith("days/") && isMd) {
        entries.push(...splitDayPage(rel, readFileSync(abs, "utf8")));
        continue;
      }
      if (under.startsWith("days/")) {
        // `days/02 Aug/IMG_1460.jpeg`: an attachment of one of that day's
        // entries. Which year is decided by the section that links to it;
        // a file nothing links to is dated to the last section.
        const dayDir = under.split("/")[1];
        const [d, m] = dayDir.split(" ");
        const year = calendarYearFor(
          join(vault, config.calendarDir, "days", `${dayDir}.md`),
          name,
        );
        const date =
          months[m] && +d && year
            ? new Date(year, months[m] - 1, +d)
            : new Date(statSync(abs).birthtime);
        if (/\.pdf$/i.test(name)) {
          scanEntries(rel, abs, date, entries, links, pageImages);
          continue;
        }
        const identifier = claim(date, rel);
        const target = `${config.journalFolder}/${denoteAttachmentName(identifier, name)}`;
        links[rel] = target;
        links[name] = links[name] ?? target;
        entries.push({
          source: rel,
          kind: "journal-attachment",
          target,
          identifier,
          identifierFrom: "name",
          title: name,
          keywords: [],
          warnings: [],
        });
        continue;
      }
      // Months, Quarters, Years, Home: navigation for a layout that no longer exists.
      entries.push({
        source: rel,
        kind: "note",
        target: null,
        identifier: "",
        identifierFrom: "name",
        title: name,
        keywords: [],
        warnings: ["calendar navigation page: dropped"],
      });
      continue;
    }

    // --- Everything else -------------------------------------------------------
    const placement = place(rel);
    const stat = statSync(abs);
    if (stat.isDirectory()) {
      // Code: copied whole to ~/code, name and contents untouched. A link
      // into it becomes an absolute `file:` link, which Emacs follows.
      const target = codeFolders.get(rel)!;
      const home = `~/${relative(homedir(), config.folders.codeDir)}`;
      entries.push({
        source: rel,
        kind: "code",
        target,
        identifier: "",
        identifierFrom: "birthtime",
        title: name,
        keywords: [],
        warnings: [],
      });
      links[rel] = `${home}/${target}`;
      links[name] = links[name] ?? links[rel];
      for (const inner of walkAll(abs, rel)) {
        const innerName = inner.split("/").pop()!;
        links[inner] = `${home}/${target}/${inner.slice(rel.length + 1)}`;
        links[innerName] = links[innerName] ?? links[inner];
        const innerStem = innerName.replace(/\.[^.]+$/, "");
        links[innerStem] = links[innerStem] ?? links[inner];
      }
      continue;
    }
    const stem = name.replace(/\.[^.]+$/, "");
    const isJournalFolder = placement.category === config.vaultJournalFolder;

    if (isMd) {
      const text = readFileSync(abs, "utf8");
      const fm = readFrontMatter(text);
      let date: Date | undefined;
      let from: Entry["identifierFrom"] = "birthtime";
      if (fm.created && /^\d{4}-\d{2}-\d{2}/.test(fm.created)) {
        const [y, mo, d] = fm.created.slice(0, 10).split("-").map(Number);
        date = new Date(y, mo - 1, d);
        from = "created";
      } else if (dateFromName(stem)) {
        date = dateFromName(stem);
        from = "name";
      }
      if (!date) date = new Date(stat.birthtime);
      const identifier = claim(date, rel);
      const warnings = [...placement.warnings];
      const own = signatureOf(placement, stem, dirname(abs));
      const signature = own.signature;
      if (own.section) placement.section = own.section;
      const jd = jdIdOf(stem);
      const cat = placement.category && numberedDir.exec(placement.category);
      if (jd && cat && jd.category !== cat[1]) {
        warnings.push(
          `file says ${jd.category}.${jd.id} but lives under ${cat[1]}`,
        );
      }
      const keywords = [
        ...new Set(fm.tags.map(keywordOf).filter(Boolean)),
      ].sort();
      const title = fitTitle(
        fm.title ?? stripPrefixes(stem) ?? stem,
        (candidate) =>
          formatDenoteName({
            identifier,
            signature,
            title: candidate,
            keywords,
            extension: ".org",
          }),
      );

      if (isJournalFolder) {
        const jt = journalTitle(date, config.journalTitleFormat);
        const target = `${config.journalFolder}/${formatDenoteName({ identifier, title: jt, keywords: [config.journalKeyword], extension: ".org" })}`;
        entries.push({
          source: rel,
          kind: "journal",
          target,
          identifier,
          identifierFrom: from,
          title: jt,
          keywords: [config.journalKeyword],
          warnings,
        });
        continue;
      }
      const target = formatDenoteName({
        identifier,
        signature,
        title,
        keywords,
        extension: ".org",
      });
      entries.push({
        source: rel,
        kind: "note",
        target,
        identifier,
        identifierFrom: from,
        title,
        signature,
        keywords,
        category: placement.category,
        section: placement.section,
        folders: placement.folders,
        warnings,
      });
      links[stem] = target;
      links[rel.replace(/\.md$/, "")] = target;
      stems.set(stem, [...(stems.get(stem) ?? []), target]);
    } else {
      const date = dateFromName(stem) ?? new Date(stat.birthtime);
      if (isJournalFolder && /\.pdf$/i.test(name)) {
        scanEntries(rel, abs, date, entries, links, pageImages);
        continue;
      }
      const identifier = claim(date, rel);
      const named = denoteAttachmentName(identifier, name);
      const target = isJournalFolder
        ? `${config.journalFolder}/${named}`
        : named;
      entries.push({
        source: rel,
        kind: isJournalFolder ? "journal-attachment" : "attachment",
        target,
        identifier,
        identifierFrom: dateFromName(stem) ? "name" : "birthtime",
        title: name,
        keywords: [],
        warnings: placement.warnings,
      });
      links[name] = target;
      links[stem] = links[stem] ?? target;
      links[rel] = target;
    }
  }

  // --- Ambiguous names: a `[[stem]]` that could mean two notes ----------------
  for (const [stem, targets] of stems) {
    if (targets.length > 1) {
      for (const e of entries) {
        if (e.kind === "note" && targets.includes(e.target!))
          e.warnings.push(
            `name "${stem}" is shared by ${targets.length} notes; [[${stem}]] links resolve to the first`,
          );
      }
    }
  }

  // --- Link resolution -------------------------------------------------------
  for (const [from, to] of Object.entries(config.linkAliases)) links[from] = to;
  // A `[[Liesl]]` with no note in the vault may well have one in the library
  // already -- the two overlap -- so a dangling target is tried there by title
  // before being given up on.
  const libraryByTitle = new Map<string, string>();
  for (const rel of walk(library)) {
    if (isMigrated(rel)) continue;
    const parsed = parseDenoteName(rel);
    if (parsed?.identifier && parsed.title && /\.org$/.test(rel))
      libraryByTitle.set(parsed.title, rel);
  }
  let resolvedInLibrary = 0;
  const wiki = /\[\[([^\]|#^]+)(?:[#^][^\]|]*)?(?:\|[^\]]*)?\]\]/g;
  const unresolved: Record<string, number> = {};
  const lower = new Map(Object.keys(links).map((k) => [k.toLowerCase(), k]));
  // Only text that will actually be converted counts: a day page's section
  // bodies, not its navigation; nothing from a dropped page.
  const survivingText = new Map<string, string>();
  for (const e of entries) {
    if (!e.target || !/\.md$/i.test(e.source)) continue;
    const text = readFileSync(join(vault, e.source), "utf8");
    if (e.journal?.lines) {
      const slice = text
        .split("\n")
        .slice(e.journal.lines[0], e.journal.lines[1])
        .join("\n");
      survivingText.set(
        e.source,
        (survivingText.get(e.source) ?? "") + "\n" + slice,
      );
    } else {
      survivingText.set(e.source, text);
    }
  }
  for (const text of survivingText.values()) {
    for (const m of text.matchAll(wiki)) {
      const t = m[1].trim();
      const key = links[t]
        ? t
        : (lower.get(t.toLowerCase()) ??
          lower.get(t.split("/").pop()!.toLowerCase()));
      if (key) {
        if (key !== t) links[t] = links[key]; // case/path-insensitive alias
        continue;
      }
      const inLibrary = libraryByTitle.get(
        sluggify("title", t.split("/").pop()!),
      );
      if (inLibrary) {
        links[t] = inLibrary;
        resolvedInLibrary++;
        continue;
      }
      unresolved[t] = (unresolved[t] ?? 0) + 1;
    }
  }

  // --- Duplicates of what the library already has -----------------------------
  const libraryTitles = new Map<string, string>();
  for (const rel of walk(library)) {
    if (isMigrated(rel)) continue;
    const p = parseDenoteName(rel);
    if (p?.identifier && p.title && /\.org$/.test(rel))
      libraryTitles.set(p.title, rel);
  }
  const duplicatesOfLibrary: Manifest["duplicatesOfLibrary"] = [];
  for (const e of entries) {
    if (e.kind !== "note" || !e.target) continue;
    const existing = libraryTitles.get(sluggify("title", e.title));
    if (existing) {
      duplicatesOfLibrary.push({ source: e.source, existing });
      e.warnings.push(`title already in library: ${existing}`);
    }
  }

  const manifest: Manifest = {
    generatedAt: new Date().toISOString(),
    vault,
    library,
    entries,
    links,
    unresolvedLinks: unresolved,
    duplicatesOfLibrary,
    resolvedInLibrary,
    pageImages,
  };
  writeFileSync(join(out, "manifest.json"), JSON.stringify(manifest, null, 1));
  writeFileSync(join(out, "report.md"), report(manifest));
  console.log(`wrote ${join(out, "manifest.json")} and report.md`);
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

function report(m: Manifest): string {
  const by = (k: Entry["kind"]) =>
    m.entries.filter((e) => e.kind === k && e.target);
  const dropped = m.entries.filter((e) => !e.target);
  const warned = m.entries.filter((e) => e.warnings.length && e.target);
  const group = (pred: (w: string) => boolean) =>
    warned.filter((e) => e.warnings.some(pred));
  const unassigned = group(
    (w) => w.startsWith("not under") || w.startsWith("loose"),
  );
  const code = by("code");
  const mismatch = group((w) => w.includes("but lives under"));
  const shared = group((w) => w.includes("is shared by"));
  const signatures = new Set(
    m.entries.filter((e) => e.target && e.signature).map((e) => e.signature),
  );
  const categories = new Set(
    m.entries.filter((e) => e.target && e.category).map((e) => e.category),
  );
  const idFromCounts: Record<string, number> = {};
  for (const e of m.entries) {
    if (e.target)
      idFromCounts[e.identifierFrom] =
        (idFromCounts[e.identifierFrom] ?? 0) + 1;
  }
  const idFrom = Object.entries(idFromCounts);
  const unresolvedTotal = Object.values(m.unresolvedLinks).reduce(
    (a, b) => a + b,
    0,
  );
  const lines = [
    `# Migration manifest — ${m.generatedAt.slice(0, 16).replace("T", " ")}`,
    "",
    `Vault: \`${m.vault}\`  →  Library: \`${m.library}\``,
    "",
    "## Totals",
    "",
    `| what | count |`,
    `|---|---|`,
    `| notes | ${by("note").length} |`,
    `| attachments | ${by("attachment").length} |`,
    `| code folders, copied to ~/code (${code.reduce((n, e) => n + [...walkAll(join(m.vault, e.source))].length, 0)} files) | ${code.length} |`,
    `| journal entries (from ${new Set(by("journal").map((e) => e.source)).size} sources) | ${by("journal").length} |`,
    `| journal attachments | ${by("journal-attachment").length} |`,
    `| dropped | ${dropped.length} |`,
    `| distinct signatures | ${signatures.size} |`,
    `| categories (hub notes) | ${categories.size} |`,
    "",
    `Identifier dates from: ${idFrom.map(([k, v]) => `${k} ${v}`).join(", ")}.`,
    "",
    `## Needs a decision`,
    "",
    `### ${unassigned.length} files not under a JD category (no signature)`,
    "",
    ...summarise(
      unassigned.map((e) => e.source.split("/").slice(0, 2).join("/")),
    ),
    "",
    `### ${code.length} code folders → ~/code`,
    "",
    ...code.map(
      (e) =>
        `- \`${e.source}\` → \`${e.target}\` (${[...walkAll(join(m.vault, e.source))].length} files)`,
    ),
    "",
    `### ${mismatch.length} notes whose NN.NN prefix disagrees with their folder`,
    "",
    ...mismatch.map(
      (e) =>
        `- \`${e.source}\` — ${e.warnings.find((w) => w.includes("lives under"))}`,
    ),
    "",
    `### ${m.duplicatesOfLibrary.length} notes whose title already exists in the library`,
    "",
    ...m.duplicatesOfLibrary.map(
      (d) => `- \`${d.source}\` ↔ \`${d.existing}\``,
    ),
    "",
    `### ${shared.length} notes sharing a name (ambiguous \`[[links]]\`)`,
    "",
    ...shared.map((e) => `- \`${e.source}\``),
    "",
    `## Links`,
    "",
    `${m.resolvedInLibrary} links to notes the vault lacks resolve to notes the library already has.`,
    "",
    `${unresolvedTotal} wiki links to ${Object.keys(m.unresolvedLinks).length} targets resolve to nothing. They will be written as bare Org links, which render as missing pages -- and clicking one creates the note, which is how a wiki grows. Most-linked:`,
    "",
    ...Object.entries(m.unresolvedLinks)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 40)
      .map(([t, n]) => `- ${n} × \`${t}\``),
    "",
    `## Dropped`,
    "",
    ...summarise(dropped.map((e) => e.source.split("/").slice(0, 2).join("/"))),
    "",
  ];
  return lines.join("\n");
}

function summarise(paths: string[]): string[] {
  const c = new Map<string, number>();
  for (const p of paths) c.set(p, (c.get(p) ?? 0) + 1);
  return [...c]
    .sort((a, b) => b[1] - a[1])
    .map(([p, n]) => `- ${n} in \`${p}\``);
}

if (process.argv[1]?.endsWith("manifest.ts")) {
  main();
}
