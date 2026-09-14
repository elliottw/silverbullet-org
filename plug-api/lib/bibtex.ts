/**
 * A reader for the BibTeX that Better BibTeX exports from Zotero.
 *
 * Not a general BibTeX parser: it reads the one dialect BBT writes -- one
 * entry per item, fields in braces, `file` naming each attachment's path in
 * Zotero's storage -- and turns it into the join the fork needs: citekey to
 * title and year, and citekey to the attachment keys that name the files at
 * zotero.org. That export is the whole index of a Zotero library as far as a
 * note is concerned, and it is a text file that syncs.
 */

export type BibAttachment = {
  /** Zotero's eight-character item key of the attachment, from its storage path. */
  key: string;
  /** The file's name, e.g. `paper.pdf`. */
  name: string;
};

export type BibEntry = {
  citekey: string;
  /** `article`, `book`, `misc`… as BBT wrote it. */
  type: string;
  title: string;
  /** Authors as written, split on ` and `; an institution keeps its braces off. */
  authors: string[];
  year?: string;
  doi?: string;
  url?: string;
  keywords: string[];
  attachments: BibAttachment[];
  /** Every field, unprocessed beyond brace stripping, for anything above. */
  fields: Record<string, string>;
};

/** Parses a whole `.bib` file. Entries that fail to parse are skipped. */
export function parseBibtex(text: string): BibEntry[] {
  const entries: BibEntry[] = [];
  let at = 0;
  for (;;) {
    at = text.indexOf("@", at);
    if (at === -1) break;
    const entry = parseEntry(text, at);
    if (!entry) {
      at++;
      continue;
    }
    if (entry.entry) entries.push(entry.entry);
    at = entry.end;
  }
  return entries;
}

function parseEntry(
  text: string,
  at: number,
): { entry: BibEntry | null; end: number } | null {
  const head = /^@(\w+)\s*\{\s*([^,\s]+)\s*,/.exec(text.slice(at, at + 400));
  if (!head) return null;
  const type = head[1].toLowerCase();
  if (type === "comment" || type === "preamble" || type === "string") {
    const end = skipBraces(text, at + head[0].length - 1 - head[2].length - 1);
    return { entry: null, end };
  }
  const citekey = head[2];
  let i = at + head[0].length;
  const fields: Record<string, string> = {};
  for (;;) {
    while (i < text.length && /[\s,]/.test(text[i])) i++;
    if (text[i] === "}") {
      i++;
      break;
    }
    const name = /^([\w-]+)\s*=\s*/.exec(text.slice(i, i + 60));
    if (!name) return null;
    i += name[0].length;
    let value: string;
    if (text[i] === "{") {
      const end = skipBraces(text, i);
      value = text.slice(i + 1, end - 1);
      i = end;
    } else if (text[i] === '"') {
      const end = text.indexOf('"', i + 1);
      if (end === -1) return null;
      value = text.slice(i + 1, end);
      i = end + 1;
    } else {
      const m = /^[^,}\s]+/.exec(text.slice(i));
      if (!m) return null;
      value = m[0];
      i += m[0].length;
    }
    fields[name[1].toLowerCase()] = clean(value);
  }
  return { entry: toEntry(type, citekey, fields), end: i };
}

/** The index just past the brace group opening at `at`. */
function skipBraces(text: string, at: number): number {
  let depth = 0;
  for (let i = at; i < text.length; i++) {
    if (text[i] === "\\") {
      i++;
      continue;
    }
    if (text[i] === "{") depth++;
    else if (text[i] === "}") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return text.length;
}

/** Strips BBT's case-protecting braces and the escapes it writes. */
function clean(value: string): string {
  return value
    .replace(/[{}]/g, "")
    .replace(/\\([&%$#_])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function toEntry(
  type: string,
  citekey: string,
  fields: Record<string, string>,
): BibEntry {
  const attachments: BibAttachment[] = [];
  for (const path of (fields.file ?? "").split(";")) {
    // `/Users/…/Zotero/storage/479L4IC3/paper.pdf`: the key is the folder.
    const m = /\/storage\/([A-Z0-9]{8})\/([^/;]+)$/.exec(path.trim());
    if (m) attachments.push({ key: m[1], name: m[2] });
  }
  return {
    citekey,
    type,
    title: fields.title ?? citekey,
    authors: fields.author ? fields.author.split(/\s+and\s+/) : [],
    year: fields.year ?? /\b(\d{4})\b/.exec(fields.date ?? "")?.[1],
    doi: fields.doi,
    url: fields.url,
    keywords: (fields.keywords ?? "").split(",").map((k) => k.trim()).filter(Boolean),
    attachments,
    fields,
  };
}

/** `Graham 2004` — how a citation reads when it is not its title. */
export function shortCitation(entry: BibEntry): string {
  const surname = entry.authors[0]?.split(",")[0].trim();
  return [surname, entry.year].filter(Boolean).join(" ") || entry.citekey;
}

/** The citekeys in an org-cite body: `@key1;@key2` or `see @key p. 3`. */
export function citekeysIn(body: string): string[] {
  return [...body.matchAll(/@([\w:.+/-]+)/g)].map((m) => m[1]);
}

/** The item page at zotero.org, which opens the web reader for a file. */
export function zoteroWebUrl(username: string, itemKey: string): string {
  return `https://www.zotero.org/${username}/items/${itemKey}`;
}

/** The desktop app, by item key. */
export function zoteroSelectUrl(itemKey: string): string {
  return `zotero://select/library/items/${itemKey}`;
}
