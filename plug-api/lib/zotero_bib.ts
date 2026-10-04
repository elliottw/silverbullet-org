/**
 * Zotero items in, a BibTeX file out.
 *
 * The bibliography is the contract with Emacs: `citar` and `org-cite`
 * resolve `[cite:@key]` against a `.bib`, and there is no Zotero-API backend
 * for either. So when SilverBullet takes the library from the API it still
 * writes the file -- and writing it from the API rather than from Better
 * BibTeX's export means an item added from a phone is citable without waiting
 * for a Mac to wake up.
 *
 * Citekeys are *not* invented here. Zotero carries Better BibTeX's key in
 * `citationKey`, and that is what is written, so keys stay exactly what they
 * already are and existing citations keep resolving.
 */
import type { BibEntry } from "./bibtex.ts";

/** An item as the Zotero API hands it over, with the fields we read. */
export type ZoteroApiItem = {
  key: string;
  version?: number;
  itemType: string;
  citationKey?: string;
  title?: string;
  shortTitle?: string;
  date?: string;
  creators?: {
    creatorType: string;
    firstName?: string;
    lastName?: string;
    name?: string;
  }[];
  tags?: { tag: string; type?: number }[];
  collections?: string[];
  parentItem?: string;
  /** Attachments only. */
  filename?: string;
  linkMode?: string;
  contentType?: string;
  [field: string]: unknown;
};

/**
 * Zotero's item types as BibTeX's, the way Better BibTeX maps them. Anything
 * unmapped is `misc`, which is what most of a personal library is anyway.
 */
const bibType: Record<string, string> = {
  journalArticle: "article",
  magazineArticle: "article",
  newspaperArticle: "article",
  preprint: "misc",
  book: "book",
  bookSection: "incollection",
  conferencePaper: "inproceedings",
  thesis: "phdthesis",
  report: "techreport",
  manuscript: "unpublished",
  webpage: "misc",
  blogPost: "misc",
  computerProgram: "software",
  patent: "patent",
  letter: "misc",
};

/**
 * Zotero's fields as BibTeX's. A few depend on the item type -- a journal's
 * `publicationTitle` is a `journal`, a chapter's is a `booktitle` -- which is
 * what `containerField` settles.
 */
const fieldMap: Record<string, string> = {
  publisher: "publisher",
  place: "address",
  volume: "volume",
  issue: "number",
  pages: "pages",
  DOI: "doi",
  ISBN: "isbn",
  ISSN: "issn",
  url: "url",
  language: "langid",
  abstractNote: "abstract",
  series: "series",
  edition: "edition",
  institution: "institution",
  university: "school",
  callNumber: "lccn",
  numPages: "pagetotal",
  accessDate: "urldate",
  websiteTitle: "journaltitle",
  blogTitle: "journaltitle",
  bookTitle: "booktitle",
  proceedingsTitle: "booktitle",
  reportNumber: "number",
  repository: "publisher",
};

function containerField(itemType: string): string {
  switch (itemType) {
    case "bookSection":
      return "booktitle";
    case "conferencePaper":
      return "booktitle";
    case "journalArticle":
    case "magazineArticle":
    case "newspaperArticle":
      return "journal";
    default:
      return "journaltitle";
  }
}

const authorName = (c: {
  firstName?: string;
  lastName?: string;
  name?: string;
}) => (c.name ? c.name : [c.lastName, c.firstName].filter(Boolean).join(", "));

/**
 * One item, with its attachments, as a bibliography entry. The citekey is
 * Zotero's own; an item without one cannot be cited and is skipped by the
 * caller.
 */
export function zoteroItemToEntry(
  item: ZoteroApiItem,
  attachments: ZoteroApiItem[] = [],
  storagePath = "~/Zotero/storage",
): BibEntry {
  const fields: Record<string, string> = {};
  const put = (key: string, value: unknown) => {
    if (typeof value === "string" && value.trim()) fields[key] = value.trim();
  };
  put("title", item.title);
  put("shorttitle", item.shortTitle);
  for (const [zotero, bib] of Object.entries(fieldMap)) {
    put(bib, item[zotero]);
  }
  put(containerField(item.itemType), item.publicationTitle);
  const year = /\b(\d{4})\b/.exec(item.date ?? "")?.[1];
  if (year) fields.year = year;
  if (item.date) fields.date = item.date;

  const creators = item.creators ?? [];
  const authors = creators
    .filter((c) => c.creatorType === "author" || c.creatorType === "inventor")
    .map(authorName);
  const editors = creators
    .filter((c) => c.creatorType === "editor")
    .map(authorName);
  // Nobody listed as an author: whoever is listed, so the entry is still
  // recognisable in a picker.
  const fallback = creators.map(authorName);
  const finalAuthors = authors.length
    ? authors
    : editors.length
      ? []
      : fallback;
  if (finalAuthors.length) fields.author = finalAuthors.join(" and ");
  if (editors.length) fields.editor = editors.join(" and ");

  const keywords = (item.tags ?? []).map((t) => t.tag).filter(Boolean);
  if (keywords.length) fields.keywords = keywords.join(",");

  const files = attachments
    .filter((a) => a.filename && a.linkMode !== "linked_url")
    .map((a) => `${storagePath.replace(/\/$/, "")}/${a.key}/${a.filename}`);
  if (files.length) fields.file = files.join(";");

  return {
    citekey: item.citationKey ?? "",
    type: bibType[item.itemType] ?? "misc",
    title: item.title ?? item.citationKey ?? "",
    authors: finalAuthors,
    ...(year ? { year } : {}),
    ...(typeof item.DOI === "string" && item.DOI ? { doi: item.DOI } : {}),
    ...(typeof item.url === "string" && item.url ? { url: item.url } : {}),
    keywords,
    attachments: attachments
      .filter((a) => a.filename)
      .map((a) => ({ key: a.key, name: a.filename! })),
    fields,
  };
}

/**
 * What must be escaped for the file to parse: TeX's own syntax. Deliberately
 * not more -- a title that reads `Hackers & Painters` in Zotero should read
 * that way in a picker, and over-escaping is how a bibliography turns into
 * line noise. For LaTeX-grade output, Better BibTeX's own export is better
 * than anything written here; turn its export back on for that.
 */
function escapeValue(value: string): string {
  return value
    .replace(/\\/g, "\\textbackslash{}")
    .replace(/([{}])/g, "\\$1")
    .replace(/([&%$#])/g, "\\$1");
}

/** The order fields are written in: the ones a reader scans first. */
const fieldOrder = [
  "title",
  "shorttitle",
  "author",
  "editor",
  "year",
  "date",
  "journal",
  "journaltitle",
  "booktitle",
  "publisher",
  "address",
  "school",
  "institution",
  "series",
  "edition",
  "volume",
  "number",
  "pages",
  "pagetotal",
  "doi",
  "isbn",
  "issn",
  "url",
  "urldate",
  "langid",
  "lccn",
  "abstract",
  "keywords",
  "file",
];

/**
 * A whole `.bib`, entries sorted by citekey so the file only changes when the
 * library does -- it lives in a synced space, and churn is conflicts.
 */
export function renderBibtex(entries: BibEntry[]): string {
  const out: string[] = [
    "% Written by SilverBullet from the Zotero API. Edits here are lost on",
    "% the next sync; change the item in Zotero instead.",
  ];
  const sorted = [...entries]
    .filter((e) => e.citekey)
    .sort((a, b) => a.citekey.localeCompare(b.citekey));
  for (const entry of sorted) {
    const keys = [
      ...fieldOrder.filter((f) => entry.fields[f]),
      ...Object.keys(entry.fields)
        .filter((f) => !fieldOrder.includes(f))
        .sort(),
    ];
    // An item Zotero holds nothing about but its key still belongs in the
    // file, so a citation of it resolves; with no fields it takes no comma.
    out.push("", `@${entry.type}{${entry.citekey}${keys.length ? "," : ""}`);
    for (const key of keys) {
      // `file` holds paths, which must survive verbatim: an escaped backslash
      // or brace in a path is a path that does not open.
      const value =
        key === "file" ? entry.fields[key] : escapeValue(entry.fields[key]);
      out.push(`  ${key} = {${value}},`);
    }
    if (keys.length) {
      // No trailing comma on the last field, as every exporter writes it.
      const last = out.length - 1;
      out[last] = out[last].replace(/,$/, "");
    }
    out.push("}");
  }
  return `${out.join("\n")}\n`;
}

/**
 * Where Zotero keeps its files, learned from a bibliography already in the
 * space: whatever directory its `file` paths share, which is the one
 * `citar-file-open` on that machine already works with. Beats guessing, and
 * beats asking.
 */
export function detectStoragePath(bibText: string): string | undefined {
  const paths = [...bibText.matchAll(/file = \{([^}]*)\}/g)]
    .flatMap((m) => m[1].split(";"))
    .map((p) => p.trim())
    .filter(Boolean);
  for (const path of paths) {
    const m = /^(.*\/storage)\/[A-Z0-9]{8}\//.exec(path);
    if (m) return m[1];
  }
  return undefined;
}
