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
import { join, relative, sep } from "node:path";
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
  kind: "note" | "attachment" | "verbatim" | "journal" | "journal-attachment";
  /** Path inside the library it becomes, or null when it is dropped. */
  target: string | null;
  identifier: string;
  /** Where the identifier's date came from — a later phase may want to know. */
  identifierFrom: "created" | "name" | "heading" | "birthtime";
  title: string;
  signature?: string;
  keywords: string[];
  /** For a journal split: the section's date and its source line range. */
  journal?: { date: string; lines: [number, number] };
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
};

// ---------------------------------------------------------------------------
// Walking the vault
// ---------------------------------------------------------------------------

// `.nosync` folders are code, kept verbatim; `reMarkable/` is 3 GB of tablet
// exports and is left where it is until someone asks for it.
const skipDirs = [/^\.obsidian/, /^\.trash$/, /^\.claude$/, /^reMarkable$/];
const skipFiles = [
  /^\.DS_Store$/,
  /^\.gitkeep$/,
  /^\.gitignore$/,
  /\.base$/,
  /^cleanup_denote_leftovers\.sh$/,
];

/** Whether a directory holds no notes at any depth — a folder *of files*. */
function isAssetBundle(dir: string): boolean {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!isAssetBundle(join(dir, entry.name))) return false;
    } else if (/\.md$/i.test(entry.name)) {
      return false;
    }
  }
  return true;
}

const projectMarkers = [
  ".git",
  "package.json",
  "Cargo.toml",
  "pyproject.toml",
  "requirements.txt",
  "go.mod",
  ".venv",
];
const sourceFile = /\.(py|js|ts|jsx|tsx|rs|swift|sh|go|rb|c|h|cpp|scad|ino)$/i;

/** A page saved with SingleFile or a browser: `name(4_7_2021_12_43_32_pm)`, `name_files`. */
const webClip = /\(\d{1,2}_\d{1,2}_\d{4}_[\d_]+[ap]m\)$|_files$/i;

/**
 * Whether a folder is copied byte-for-byte: nothing renamed, nothing
 * converted. That is a folder that is really a *thing* rather than a place
 * for notes and their files -- a repository, a code project, a saved web
 * page with its images, a dump of a few dozen photos or certificates. A
 * `README.md` inside one is part of the thing, not a note.
 *
 * A numbered folder is a JD place, never verbatim, whatever it holds: `05
 * landslide` with four PDFs in it is four attachments, Denote-named where
 * they are. So is a JD category that happens to be a repository (the
 * Pittsburgh book is); only a project *inside* the tree is verbatim.
 */
function isVerbatim(abs: string, name: string, isNumbered: boolean): boolean {
  if (/\.nosync$/.test(name) || /\.icon$/.test(name)) return true;
  // A JD place, or an `assets/` folder that dissolves into one.
  if (isNumbered || name === "assets") return false;
  const names = readdirSync(abs);
  if (names.some((n) => projectMarkers.includes(n))) return true;
  if (names.filter((n) => sourceFile.test(n)).length >= 3) return true;
  if (webClip.test(name)) return true;
  if (
    names.some((n) => /\.html?$/i.test(n)) &&
    names.some((n) => /\.(png|jpe?g|gif|webp|svg|css)$/i.test(n))
  ) {
    return true;
  }
  // A dump: no notes at any depth, and enough files that renaming each one
  // would be noise rather than organisation.
  return isAssetBundle(abs) && [...walkAll(abs)].length >= 10;
}

/** Yields every file, and every verbatim folder as one unit. */
function* walk(dir: string, rel = ""): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const relPath = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (skipDirs.some((r) => r.test(entry.name))) continue;
      const abs = join(dir, entry.name);
      const isNumbered =
        numberedDir.test(entry.name) || areaDir.test(entry.name);
      if (isVerbatim(abs, entry.name, isNumbered)) {
        yield relPath;
        continue;
      }
      yield* walk(abs, relPath);
    } else if (!skipFiles.some((r) => r.test(entry.name))) {
      yield relPath;
    }
  }
}

/** Plain file walk, for counting what a verbatim folder holds. */
function* walkAll(dir: string, rel = ""): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const relPath = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) yield* walkAll(join(dir, entry.name), relPath);
    else if (entry.name !== ".DS_Store") yield relPath;
  }
}

// ---------------------------------------------------------------------------
// Placement: the Johnny Decimal folders
// ---------------------------------------------------------------------------

const areaDir = /^\d+-\d+ /; // `20-29 Missions`
const numberedDir = /^(\d{2}) (.+)$/; // `21 iteam`
const jdIdFile = /^(\d{2})\.(\d{2}) (.+)$/; // `25.03 Acorn Medic Branding`

type Placement = {
  /** Library folder: the vault's own, minus the area layer and `assets/`. */
  folder: string;
  signature?: string;
  warnings: string[];
};

/**
 * Where a file lives in the library: exactly where it lived in the vault,
 * minus the area folder (the category number already says it) and any
 * `assets/` (assets live beside their notes). Deeper nesting is kept as it
 * is -- inboxes, code, trips by date, and things simply not sorted yet are
 * all legitimately not JD. The signature is the first two numbered levels,
 * and only when the tree starts with one; a non-JD top folder gets none.
 */
function place(relPath: string): Placement {
  const parts = relPath.split("/");
  const dirs = parts.slice(0, -1).filter((d) => d !== "assets");
  const kept = dirs[0] && areaDir.test(dirs[0]) ? dirs.slice(1) : dirs;
  const category = kept[0] && numberedDir.exec(kept[0]);
  const id = category && kept[1] && numberedDir.exec(kept[1]);
  const signature = category
    ? id
      ? `${category[1]}=${id[1]}`
      : category[1]
    : undefined;
  return {
    folder: kept.join("/"),
    signature,
    warnings: category
      ? []
      : [
          kept.length
            ? `not under a JD category: "${kept[0]}"`
            : "loose at the vault root",
        ],
  };
}

// ---------------------------------------------------------------------------
// Dates and identifiers
// ---------------------------------------------------------------------------

const taken = new Set<string>();

/** Seeds the collision set with every identifier the library already holds. */
function seedIdentifiers(dir: string) {
  for (const rel of walk(dir)) {
    const id = parseDenoteName(rel)?.identifier;
    if (id) taken.add(id);
  }
}

/** A free identifier for `date`, bumping seconds as `freeIdentifier` does. */
function claim(date: Date): string {
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
  return Number.isNaN(date.getTime()) || +y < 1990 ? undefined : date;
}

function stripPrefixes(stem: string): string {
  return stem
    .replace(/^#+\s*/, "") // a heading pasted as a file name
    .replace(jdIdFile, "$3")
    .replace(/^0?\d{8}\s*/, "")
    .replace(/^\d{4}-\d{2}-\d{2}\s*/, "")
    .trim();
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
const yearHeading =
  /^##\s+(?:(?:Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day\s+)?(\d{4})\s*(?:<!--.*-->)?\s*$/;

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
    const identifier = claim(date);
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
        // `days/02 Aug/IMG_1460.jpeg`: an attachment of that day's entry.
        const dayDir = under.split("/")[1];
        const [d, m] = dayDir.split(" ");
        const date =
          months[m] && +d
            ? new Date(2025, months[m] - 1, +d)
            : new Date(statSync(abs).birthtime);
        const identifier = claim(date);
        entries.push({
          source: rel,
          kind: "journal-attachment",
          target: `${config.journalFolder}/${denoteAttachmentName(identifier, name)}`,
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
      // Verbatim: copied whole, name and contents untouched.
      const target = `${placement.folder}/${name}`;
      entries.push({
        source: rel,
        kind: "verbatim",
        target,
        identifier: "",
        identifierFrom: "birthtime",
        title: name,
        keywords: [],
        warnings: placement.warnings,
      });
      links[rel] = target;
      links[name] = links[name] ?? target;
      for (const inner of walkAll(abs, rel)) {
        const innerName = inner.split("/").pop()!;
        links[inner] =
          `${placement.folder}/${inner.slice(rel.length - name.length)}`;
        links[innerName] = links[innerName] ?? links[inner];
        const innerStem = innerName.replace(/\.[^.]+$/, "");
        links[innerStem] = links[innerStem] ?? links[inner];
      }
      continue;
    }
    const stem = name.replace(/\.[^.]+$/, "");
    const isJournalFolder = placement.folder === config.vaultJournalFolder;

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
      const identifier = claim(date);
      const jd = jdIdFile.exec(stem);
      const signature = jd ? `${jd[1]}=${jd[2]}` : placement.signature;
      const warnings = [...placement.warnings];
      if (jd && placement.signature && !placement.signature.startsWith(jd[1])) {
        warnings.push(
          `file says ${jd[1]}.${jd[2]} but lives under ${placement.signature}`,
        );
      }
      const keywords = [
        ...new Set(fm.tags.map(keywordOf).filter(Boolean)),
      ].sort();
      const title = fm.title ?? stripPrefixes(stem) ?? stem;

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
      const target = `${placement.folder}/${formatDenoteName({ identifier, signature, title, keywords, extension: ".org" })}`;
      entries.push({
        source: rel,
        kind: "note",
        target,
        identifier,
        identifierFrom: from,
        title,
        signature,
        keywords,
        warnings,
      });
      links[stem] = target;
      links[rel.replace(/\.md$/, "")] = target;
      stems.set(stem, [...(stems.get(stem) ?? []), target]);
    } else {
      const date = dateFromName(stem) ?? new Date(stat.birthtime);
      const identifier = claim(date);
      const folder = isJournalFolder ? config.journalFolder : placement.folder;
      const target = `${folder}/${denoteAttachmentName(identifier, name)}`;
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
  const verbatim = by("verbatim");
  const mismatch = group((w) => w.includes("but lives under"));
  const shared = group((w) => w.includes("is shared by"));
  const folders = new Set(
    m.entries
      .filter((e) => e.target && e.kind === "note")
      .map((e) => e.target!.split("/").slice(0, -1).join("/")),
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
    `| verbatim folders, copied untouched (${by("verbatim").reduce((n, e) => n + [...walkAll(join(m.vault, e.source))].length, 0)} files) | ${by("verbatim").length} |`,
    `| journal entries (from ${new Set(by("journal").map((e) => e.source)).size} sources) | ${by("journal").length} |`,
    `| journal attachments | ${by("journal-attachment").length} |`,
    `| dropped | ${dropped.length} |`,
    `| library folders created | ${folders.size} |`,
    "",
    `Identifier dates from: ${idFrom.map(([k, v]) => `${k} ${v}`).join(", ")}.`,
    "",
    `## Needs a decision`,
    "",
    `### ${unassigned.length} files not under a JD category (kept where they are)`,
    "",
    ...summarise(
      unassigned.map((e) => e.source.split("/").slice(0, 2).join("/")),
    ),
    "",
    `### ${verbatim.length} folders copied verbatim (code, repositories, saved pages, batches of files)`,
    "",
    ...verbatim.map(
      (e) =>
        `- \`${e.source}\` (${[...walkAll(join(m.vault, e.source))].length} files)`,
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

main();
