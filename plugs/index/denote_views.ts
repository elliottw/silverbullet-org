/**
 * Views over the library that are not files: generated, read-only pages
 * under `denote/`, the way `denote-sequence-dired`, `denote-journal`'s
 * calendar and `denote-explore` show things in Emacs.
 *
 *   denote/signatures        every signed note as a tree, in sequence order
 *   denote/signatures/21     the sequence under one signature
 *   denote/keywords          every keyword with its count
 *   denote/keywords/recipe   the notes carrying one keyword
 *   denote/calendar          this year's journal, a month per section
 *   denote/calendar/2024     another year's
 *   denote/health            what needs a look: duplicate identifiers,
 *                            dangling links, names out of step with their
 *                            front matter
 *
 * Plus the small navigation commands of `denote-find-link`,
 * `denote-find-backlink` and `denote-explore-random-note`.
 */
import {
  isDenoteNoteFile,
  journalDateStamp,
  parseDenoteName,
  signatureComponents,
} from "@silverbulletmd/silverbullet/lib/denote";
import {
  editor,
  index,
  lua,
  space,
} from "@silverbulletmd/silverbullet/syscalls";
import type { FilterOption } from "@silverbulletmd/silverbullet/type/client";
import { pathFromPageName } from "@silverbulletmd/silverbullet/lib/ref";
import {
  type DenoteNoteSummary,
  denoteJournalEntries,
  denoteNameFromFrontMatter,
  denoteNotes,
  denoteJournalOpenOrCreate,
} from "./denote.ts";
import { signedNotes } from "./denote_sequence.ts";

const prefix = "denote/";

type View = {
  pattern: RegExp;
  render: (...groups: string[]) => Promise<string>;
};

const views: View[] = [
  { pattern: /^signatures(?:\/(.+))?$/, render: renderSignatures },
  { pattern: /^keywords(?:\/(.+))?$/, render: renderKeywords },
  { pattern: /^calendar(?:\/(\d{4}))?$/, render: renderCalendar },
  { pattern: /^health$/, render: renderHealth },
];

/**
 * `editor:pageCreating`: a page under `denote/` that does not exist is
 * generated rather than created. Anything else is left to be created.
 */
export async function generateView(event: {
  name: string;
}): Promise<{ text: string; perm: "ro" } | undefined> {
  const name = event.name.replace(/\.org$/, "");
  if (!name.startsWith(prefix)) return;
  const rest = name.slice(prefix.length);
  for (const view of views) {
    const match = view.pattern.exec(rest);
    if (match) {
      return { text: await view.render(...match.slice(1)), perm: "ro" };
    }
  }
}

const link = (note: DenoteNoteSummary, text = note.title) =>
  `[[denote:${note.identifier}][${text}]]`;

// ---------------------------------------------------------------------------
// Signatures
// ---------------------------------------------------------------------------

/**
 * The sequence as a tree: each note under its parent, nested by depth, in
 * sequence order -- what `denote-sequence-dired` shows, with a prefix
 * narrowing it to one branch.
 */
async function renderSignatures(under?: string): Promise<string> {
  const notes = (await signedNotes()).filter(
    (n) =>
      !under || n.signature === under || n.signature!.startsWith(`${under}=`),
  );
  const base = under ? signatureComponents(under).length - 1 : 0;
  const lines = notes.map((n) => {
    const depth = Math.max(
      0,
      signatureComponents(n.signature!).length - 1 - base,
    );
    return `${"  ".repeat(depth)}- ${n.signature} ${link(n)}`;
  });
  return [
    `#+title: Signatures${under ? ` under ${under}` : ""}`,
    "",
    under
      ? `Up: [[denote/signatures][all signatures]]`
      : `${notes.length} notes carry a signature.`,
    "",
    ...lines,
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Keywords
// ---------------------------------------------------------------------------

async function renderKeywords(keyword?: string): Promise<string> {
  const notes = await denoteNotes();
  if (keyword) {
    const tagged = notes
      .filter((n) => n.keywords.includes(keyword))
      .sort((a, b) => a.title.localeCompare(b.title));
    return [
      `#+title: Keyword ${keyword}`,
      "",
      `Up: [[denote/keywords][all keywords]] · ${tagged.length} notes`,
      "",
      ...tagged.map((n) => `- ${link(n)}`),
      "",
    ].join("\n");
  }
  const counts = new Map<string, number>();
  for (const n of notes) {
    for (const k of n.keywords) counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const rows = [...counts].sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
  );
  const noteCount = notes.filter((n) => isDenoteNoteFile(n.name)).length;
  return [
    "#+title: Keywords",
    "",
    `${rows.length} keywords across ${noteCount} notes.`,
    "",
    ...rows.map(([k, c]) => `- [[denote/keywords/${k}][${k}]] ${c}`),
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// The journal calendar
// ---------------------------------------------------------------------------

const monthNames = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/**
 * A year of the journal, a month per section, laid out as a calendar. A day
 * with an entry links to it; a day without links to `journal:YYYY-MM-DD`,
 * which creates the entry for that day when followed -- the same gesture as
 * choosing a date in `denote-journal-calendar`. Days are two characters
 * wide, so the grid lines up in a monospaced face.
 */
async function renderCalendar(yearStr?: string): Promise<string> {
  const now = new Date();
  const year = yearStr ? Number(yearStr) : now.getFullYear();
  const entries = await denoteJournalEntries();
  const byDay = new Map<string, DenoteNoteSummary>();
  // Newest first from denoteJournalEntries; the first seen for a day wins.
  for (const e of entries) {
    const day = e.identifier.slice(0, 8);
    if (!byDay.has(day)) byDay.set(day, e);
  }
  const pad = (n: number) => String(n).padStart(2, "0");
  const out = [
    `#+title: Journal ${year}`,
    "",
    `[[denote/calendar/${year - 1}][← ${year - 1}]] · ${
      [...byDay.keys()].filter((d) => d.startsWith(String(year))).length
    } entries · [[denote/calendar/${year + 1}][${year + 1} →]]`,
    "",
  ];
  for (let m = 0; m < 12; m++) {
    const first = new Date(year, m, 1);
    const days = new Date(year, m + 1, 0).getDate();
    out.push(`* ${monthNames[m]}`, "Mo Tu We Th Fr Sa Su");
    // Monday-first, as Denote's calendar and most of the world have it.
    let line = "   ".repeat((first.getDay() + 6) % 7);
    for (let d = 1; d <= days; d++) {
      const stamp = `${year}${pad(m + 1)}${pad(d)}`;
      const entry = byDay.get(stamp);
      const iso = `${year}-${pad(m + 1)}-${pad(d)}`;
      line += entry
        ? `[[denote:${entry.identifier}][${pad(d)}]]`
        : `[[journal:${iso}][${pad(d)}]]`;
      const isSunday = new Date(year, m, d).getDay() === 0;
      if (isSunday || d === days) {
        out.push(line.trimEnd());
        line = "";
      } else {
        line += " ";
      }
    }
    out.push("");
  }
  return out.join("\n");
}

/** `Denote: Journal Calendar`: this year's calendar. */
export async function journalCalendarCommand(): Promise<void> {
  await editor.navigate({ path: `${prefix}calendar.org` } as any);
}

/** `Denote: Journal Open Date`: an entry for a date typed in. */
export async function journalOpenDateCommand(): Promise<void> {
  const today = journalDateStamp(new Date());
  const iso = `${today.slice(0, 4)}-${today.slice(4, 6)}-${today.slice(6, 8)}`;
  const answer = await editor.prompt("Date (YYYY-MM-DD):", iso);
  if (!answer) return;
  await denoteJournalOpenOrCreate(answer.trim());
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

type Relation = {
  page: string;
  to: string;
  toTag: string;
  kind: string;
  alias?: string;
};

/**
 * What `denote-explore` and a careful eye would flag: two files sharing an
 * identifier (a rename gone sideways, a sync conflict), links to identifiers
 * no note carries, and notes whose file name no longer says what their
 * front matter does.
 */
async function renderHealth(): Promise<string> {
  const notes = await denoteNotes();
  const byId = new Map<string, DenoteNoteSummary[]>();
  for (const n of notes) {
    byId.set(n.identifier, [...(byId.get(n.identifier) ?? []), n]);
  }
  const duplicates = [...byId.values()].filter((ns) => ns.length > 1);

  const dangling = (await index.queryLuaObjects<Relation>(
    "relation",
    {
      objectVariable: "_",
      where: await lua.parseExpression(
        `_.kind == "denote-link" and _.toTag == "denote-identifier"`,
      ),
    },
    {},
  )) as Relation[];
  const danglingByTarget = new Map<string, Relation[]>();
  for (const r of dangling) {
    danglingByTarget.set(r.to, [...(danglingByTarget.get(r.to) ?? []), r]);
  }

  // Names out of step: only notes, only their front matter, read one by one.
  // Keywords in a different order are not out of step -- Denote sorts them
  // on rename, the file name may predate that, and a save will settle it.
  const mismatched: { name: string; wanted: string }[] = [];
  const sortedKeywords = (name: string) => {
    const parsed = parseDenoteName(name);
    return parsed ? { ...parsed, keywords: [...parsed.keywords].sort() } : name;
  };
  for (const n of notes) {
    if (!isDenoteNoteFile(n.name)) continue;
    try {
      const text = await space.readPage(n.name);
      const wanted = denoteNameFromFrontMatter(n.name, text);
      if (
        wanted &&
        JSON.stringify(sortedKeywords(wanted)) !==
          JSON.stringify(sortedKeywords(n.name))
      ) {
        mismatched.push({ name: n.name, wanted });
      }
    } catch {
      // Unreadable here; not this page's problem.
    }
  }

  const pageLink = (name: string) =>
    `[[${name.replace(/\.org$/, "")}][${name}]]`;
  const noteCount = notes.filter((n) => isDenoteNoteFile(n.name)).length;
  return [
    "#+title: Library health",
    "",
    `${noteCount} notes. Generated now; reopen to refresh.`,
    "",
    `* ${duplicates.length} identifiers shared by more than one file`,
    ...(duplicates.length ? [] : ["None."]),
    ...duplicates.flatMap((ns) => [
      `- ${ns[0].identifier}`,
      ...ns.map((n) => `  - ${pageLink(n.name)}`),
    ]),
    "",
    `* ${danglingByTarget.size} identifiers linked to but carried by no note`,
    ...(danglingByTarget.size ? [] : ["None."]),
    ...[...danglingByTarget].flatMap(([id, rs]) => [
      `- ${id}${rs[0].alias ? ` "${rs[0].alias}"` : ""}, from`,
      ...[...new Set(rs.map((r) => r.page))].map((p) => `  - ${pageLink(p)}`),
    ]),
    "",
    `* ${mismatched.length} notes whose file name does not match their front matter`,
    ...(mismatched.length
      ? ["Open one and run *Denote: Rename File from Front Matter*."]
      : ["None."]),
    ...mismatched.map((m) => `- ${pageLink(m.name)} → ${m.wanted}`),
    "",
  ].join("\n");
}

export async function libraryHealthCommand(): Promise<void> {
  await editor.navigate({ path: `${prefix}health.org` } as any);
}

export async function browseSignaturesPageCommand(): Promise<void> {
  await editor.navigate({ path: `${prefix}signatures.org` } as any);
}

export async function browseKeywordsPageCommand(): Promise<void> {
  await editor.navigate({ path: `${prefix}keywords.org` } as any);
}

// ---------------------------------------------------------------------------
// Following links from a picker
// ---------------------------------------------------------------------------

/** `denote-find-link`: the Denote links in this note, as a picker. */
export async function findLinkCommand(): Promise<void> {
  const page = await editor.getCurrentPage();
  const relations = (await index.queryLuaObjects<Relation>(
    "relation",
    {
      objectVariable: "_",
      where: await lua.parseExpression(
        `_.kind == "denote-link" and _.page == target and _.toTag == "page"`,
      ),
    },
    { target: page },
  )) as Relation[];
  await pickPage(
    "Link",
    [...new Map(relations.map((r) => [r.to, r])).values()].map((r) => ({
      name: r.alias || r.to,
      description: r.to,
      value: r.to,
    })),
    "This note links to no other note",
  );
}

/** `denote-find-backlink`: the notes linking here, as a picker. */
export async function findBacklinkCommand(): Promise<void> {
  const page = await editor.getCurrentPage();
  const relations = (await index.queryLuaObjects<Relation>(
    "relation",
    {
      objectVariable: "_",
      where: await lua.parseExpression(
        `_.kind == "denote-link" and _.to == target`,
      ),
    },
    { target: page },
  )) as Relation[];
  const titles = new Map((await denoteNotes()).map((n) => [n.name, n.title]));
  await pickPage(
    "Backlink",
    [...new Set(relations.map((r) => r.page))].map((p) => ({
      name: titles.get(p) ?? p,
      description: p,
      value: p,
    })),
    "Nothing links here",
  );
}

/** `denote-explore-random-note`: somewhere you have not looked in a while. */
export async function randomNoteCommand(): Promise<void> {
  const notes = (await denoteNotes()).filter((n) => isDenoteNoteFile(n.name));
  if (!notes.length) return;
  const pick = notes[Math.floor(Math.random() * notes.length)];
  await editor.navigate(pathFromPageName(pick.name) as any);
}

async function pickPage(
  label: string,
  options: (FilterOption & { value: string })[],
  whenEmpty: string,
): Promise<void> {
  if (!options.length) {
    await editor.flashNotification(whenEmpty, "error");
    return;
  }
  const choice = (await editor.filterBox(
    label,
    options,
    `${options.length} ${options.length === 1 ? "note" : "notes"}`,
  )) as (FilterOption & { value: string }) | undefined;
  if (choice) {
    await editor.navigate(pathFromPageName(choice.value) as any);
  }
}
