/**
 * Denote's file-naming scheme and front matter.
 *
 * Ported from Protesilaos Stavrou's `denote.el`, which is the specification:
 * the slug rules, delimiters and front matter templates here mirror
 * `denote-sluggify-*`, `denote-format-file-name` and `denote-file-types`. A
 * Denote note carries its metadata in its *file name*, so parsing that name is
 * how a note's identity, title and keywords are recovered:
 *
 *     20240322T131856==sig--some-title__topic1_topic2.org
 *     └ identifier ─┘  └sig┘ └ title ┘  └── keywords ──┘
 *
 * Each component is introduced by a doubled delimiter (`@@`, `==`, `--`, `__`)
 * and the components themselves never contain one, because sluggification
 * collapses runs of those characters to a single occurrence.
 */

/** `denote-date-identifier-format`, as a matcher: `%Y%m%dT%H%M%S`. */
export const denoteDateIdentifierRegex = /^\d{8}T\d{6}/;

export type DenoteComponent = "identifier" | "signature" | "title" | "keyword";

export type DenoteName = {
  identifier?: string;
  signature?: string;
  title?: string;
  keywords: string[];
  /** Extension including the leading dot, e.g. `.org`. Empty when absent. */
  extension: string;
};

/** The component order of `denote-file-name-components-order`. */
const componentOrder = [
  "identifier",
  "signature",
  "title",
  "keywords",
] as const;

const delimiters = {
  "@@": "identifier",
  "==": "signature",
  "--": "title",
  __: "keywords",
} as const;

// The three punctuation sets are deliberately different, matching
// `denote-sluggify-title`, `-keyword` and `-signature`. A signature keeps `=`
// and `_` (they become its own separator); a keyword drops everything that
// could be mistaken for a separator, since keywords are joined with `_`.
const titlePunctuation = /[\][{}!@#$%^&*()+'"?,.\\|;:~`‘’“”/=]/g;
const keywordPunctuation = /[\][{}!@#$%^&*()+'"?,.\\|;:~`‘’“”/_ =-]/g;
const signaturePunctuation = /[\][{}!@#$%^&*()+'"?,.\\|;:~`‘’“”/-]/g;

/** `denote-slug-hyphenate`. */
export function slugHyphenate(str: string): string {
  return str
    .replace(/_|\s+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "");
}

/** `denote-slug-put-equals`. */
export function slugPutEquals(str: string): string {
  return str
    .replace(/_|\s+/g, "=")
    .replace(/={2,}/g, "=")
    .replace(/^=|=$/g, "");
}

/** `denote-sluggify-title`. */
export function sluggifyTitle(str: string): string {
  return slugHyphenate(str.replace(titlePunctuation, "")).toLowerCase();
}

/** `denote-sluggify-keyword`: separate words are joined, not hyphenated. */
export function sluggifyKeyword(str: string): string {
  return str.replace(keywordPunctuation, "").toLowerCase();
}

/** `denote-sluggify-signature`: words are joined with `=`. */
export function sluggifySignature(str: string): string {
  return slugPutEquals(str.replace(signaturePunctuation, "")).toLowerCase();
}

function replaceConsecutiveTokens(str: string, component: DenoteComponent) {
  const collapsed = str
    .replace(/@{2,}/g, "@")
    .replace(/={2,}/g, "=")
    .replace(/_{2,}/g, "_");
  // `--` survives in a title only because a title may legitimately contain one
  // when the default sluggification is disabled.
  return component === "title" ? collapsed : collapsed.replace(/-{2,}/g, "-");
}

function trimRightTokens(str: string, component: DenoteComponent) {
  return component === "title"
    ? str.replace(/[=@_]+$/, "")
    : str.replace(/[=@_-]+$/, "");
}

/** `denote-sluggify-and-apply-rules`. */
export function sluggify(component: DenoteComponent, str: string): string {
  let slug: string;
  switch (component) {
    case "title":
      slug = sluggifyTitle(str);
      break;
    case "keyword":
      // Underscores separate keywords in a file name, so they can never occur
      // inside one.
      slug = sluggifyKeyword(str).replaceAll("_", "");
      break;
    case "signature":
      slug = sluggifySignature(str);
      break;
    case "identifier":
      slug = str;
      break;
  }
  return trimRightTokens(
    replaceConsecutiveTokens(slug.replaceAll(".", ""), component),
    component,
  );
}

function delimiterAt(str: string, at: number): keyof typeof delimiters | null {
  for (const delimiter of Object.keys(
    delimiters,
  ) as (keyof typeof delimiters)[]) {
    if (str.startsWith(delimiter, at)) {
      return delimiter;
    }
  }
  return null;
}

function nextDelimiterIndex(str: string, from: number): number {
  let best = -1;
  for (const delimiter of Object.keys(delimiters)) {
    const index = str.indexOf(delimiter, from);
    if (index !== -1 && (best === -1 || index < best)) {
      best = index;
    }
  }
  return best;
}

function splitExtension(base: string): { stem: string; extension: string } {
  const dot = base.lastIndexOf(".");
  // Sluggification strips dots from every component, so the last dot can only
  // be the extension separator.
  if (dot < 1) {
    return { stem: base, extension: "" };
  }
  return { stem: base.slice(0, dot), extension: base.slice(dot) };
}

/**
 * Parses a Denote file name into its components.
 * @param path a file name or a full path; only the basename is inspected
 * @returns the components, or null when the name follows no part of the scheme
 */
export function parseDenoteName(path: string): DenoteName | null {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const { stem, extension } = splitExtension(base);
  const result: DenoteName = { keywords: [], extension };

  let rest = stem;
  // A date-like identifier at the very start needs no `@@` marker — that is
  // the classic scheme, and what essentially every real library uses.
  const dateIdentifier = denoteDateIdentifierRegex.exec(rest);
  if (
    dateIdentifier &&
    (rest.length === dateIdentifier[0].length ||
      delimiterAt(rest, dateIdentifier[0].length))
  ) {
    result.identifier = dateIdentifier[0];
    rest = rest.slice(dateIdentifier[0].length);
  }

  let sawComponent = result.identifier !== undefined;
  while (rest.length > 0) {
    const delimiter = delimiterAt(rest, 0);
    if (!delimiter) {
      break;
    }
    const end = nextDelimiterIndex(rest, delimiter.length);
    const value =
      end === -1
        ? rest.slice(delimiter.length)
        : rest.slice(delimiter.length, end);
    switch (delimiters[delimiter]) {
      case "identifier":
        result.identifier = value;
        break;
      case "signature":
        result.signature = value;
        break;
      case "title":
        result.title = value;
        break;
      case "keywords":
        result.keywords = value.split("_").filter(Boolean);
        break;
    }
    sawComponent = true;
    rest = end === -1 ? "" : rest.slice(end);
  }

  return sawComponent ? result : null;
}

/** Whether a path is a Denote-named file carrying an identifier. */
export function isDenotePath(path: string): boolean {
  return !!parseDenoteName(path)?.identifier;
}

/**
 * Builds a Denote file name from its components, sluggifying each.
 * Mirrors `denote-format-file-name`.
 */
export function formatDenoteName(parts: DenoteName): string {
  let name = "";
  for (const component of componentOrder) {
    switch (component) {
      case "identifier":
        if (parts.identifier) {
          name += `@@${sluggify("identifier", parts.identifier)}`;
        }
        break;
      case "signature":
        if (parts.signature) {
          name += `==${sluggify("signature", parts.signature)}`;
        }
        break;
      case "title":
        if (parts.title) {
          name += `--${sluggify("title", parts.title)}`;
        }
        break;
      case "keywords":
        if (parts.keywords.length) {
          name += `__${parts.keywords.map((k) => sluggify("keyword", k)).join("_")}`;
        }
        break;
    }
  }
  if (!name) {
    throw new Error("A Denote file name needs at least one component");
  }
  name += parts.extension;
  // Drop the `@@` again when the identifier leads and is a plain timestamp.
  if (
    name.startsWith("@@") &&
    parts.identifier &&
    new RegExp(`^${denoteDateIdentifierRegex.source.slice(1)}$`).test(
      parts.identifier,
    )
  ) {
    name = name.slice(2);
  }
  return name;
}

/** Formats a `Date` as a Denote identifier, in local time as Denote does. */
export function denoteIdentifier(date: Date): string {
  const pad = (n: number, width = 2) => String(n).padStart(width, "0");
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `T${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

/** Parses a Denote identifier back into a `Date`, or null if malformed. */
export function denoteIdentifierToDate(identifier: string): Date | null {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/.exec(
    identifier,
  );
  if (!match) {
    return null;
  }
  const [, y, mo, d, h, mi, s] = match.map(Number) as unknown as number[];
  const date = new Date(y, mo - 1, d, h, mi, s);
  return Number.isNaN(date.getTime()) ? null : date;
}

// ---------------------------------------------------------------------------
// Front matter
// ---------------------------------------------------------------------------

/** The file types of `denote-file-types`. */
export type DenoteFileType = "org" | "markdown-yaml" | "markdown-toml" | "text";

export type DenoteFrontMatter = {
  title?: string;
  /** Kept verbatim; each file type writes its own date notation. */
  date?: string;
  keywords: string[];
  /**
   * Whether a keywords line was present at all. An absent line and an empty
   * one both yield no keywords, but they mean different things when writing a
   * file name back: absent says "nothing to go on", empty says "no keywords".
   */
  hasKeywords: boolean;
  identifier?: string;
  signature?: string;
};

type FrontMatterSpec = {
  /** Key matchers, mirroring the `:*-key-regexp` properties. */
  title: RegExp;
  date: RegExp;
  keywords: RegExp;
  identifier: RegExp;
  signature: RegExp;
  /** Whether string values are quoted (`denote-format-string-for-md-front-matter`). */
  quoted: boolean;
  template: (fm: Required<Omit<DenoteFrontMatter, "hasKeywords">>) => string;
};

/** `denote-format-keywords-for-org-front-matter`. */
function orgKeywords(keywords: string[]): string {
  return keywords.length ? `:${keywords.join(":")}:` : "";
}

/** `denote-format-keywords-for-md-front-matter`. */
function mdKeywords(keywords: string[]): string {
  return `[${keywords.map((k) => JSON.stringify(k)).join(", ")}]`;
}

const frontMatterSpecs: Record<DenoteFileType, FrontMatterSpec> = {
  org: {
    title: /^#\+title\s*:/i,
    date: /^#\+date\s*:/i,
    keywords: /^#\+filetags\s*:/i,
    identifier: /^#\+identifier\s*:/i,
    signature: /^#\+signature\s*:/i,
    quoted: false,
    template: (fm) =>
      `#+title:      ${fm.title}\n` +
      `#+date:       ${fm.date}\n` +
      `#+filetags:   ${orgKeywords(fm.keywords)}\n` +
      `#+identifier: ${fm.identifier}\n` +
      `#+signature:  ${fm.signature}\n\n`,
  },
  "markdown-yaml": {
    title: /^title\s*:/i,
    date: /^date\s*:/i,
    keywords: /^tags\s*:/i,
    identifier: /^identifier\s*:/i,
    signature: /^signature\s*:/i,
    quoted: true,
    template: (fm) =>
      `---\ntitle:      ${JSON.stringify(fm.title)}\n` +
      `date:       ${JSON.stringify(fm.date)}\n` +
      `tags:       ${mdKeywords(fm.keywords)}\n` +
      `identifier: ${JSON.stringify(fm.identifier)}\n` +
      `signature:  ${JSON.stringify(fm.signature)}\n---\n\n`,
  },
  "markdown-toml": {
    title: /^title\s*=/i,
    date: /^date\s*=/i,
    keywords: /^tags\s*=/i,
    identifier: /^identifier\s*=/i,
    signature: /^signature\s*=/i,
    quoted: true,
    template: (fm) =>
      `+++\ntitle      = ${JSON.stringify(fm.title)}\n` +
      `date       = ${JSON.stringify(fm.date)}\n` +
      `tags       = ${mdKeywords(fm.keywords)}\n` +
      `identifier = ${JSON.stringify(fm.identifier)}\n` +
      `signature  = ${JSON.stringify(fm.signature)}\n+++\n\n`,
  },
  text: {
    title: /^title\s*:/i,
    date: /^date\s*:/i,
    keywords: /^tags\s*:/i,
    identifier: /^identifier\s*:/i,
    signature: /^signature\s*:/i,
    quoted: false,
    template: (fm) =>
      `title:      ${fm.title}\n` +
      `date:       ${fm.date}\n` +
      `tags:       ${fm.keywords.join("  ")}\n` +
      `identifier: ${fm.identifier}\n` +
      `signature:  ${fm.signature}\n` +
      `---------------------------\n\n`,
  },
};

/** The Denote file type for an extension, defaulting Markdown to YAML. */
export function denoteFileType(
  extension: string,
  text?: string,
): DenoteFileType {
  switch (extension.toLowerCase()) {
    case ".org":
      return "org";
    case ".txt":
      return "text";
    case ".md":
      // `denote-get-file-type-markdown-toml` sniffs the opening fence.
      return text?.startsWith("+++") ? "markdown-toml" : "markdown-yaml";
    default:
      return "org";
  }
}

/** `denote-extract-keywords-from-front-matter`: one splitter for every type. */
export function extractDenoteKeywords(value: string): string[] {
  return value
    .split(/[:,\s]+/)
    .map((k) => k.replace(/^[[\] "']+|[[\] "']+$/g, ""))
    .filter(Boolean);
}

function unquote(value: string, quoted: boolean): string {
  const trimmed = value.trim();
  return quoted ? trimmed.replace(/^["']+|["']+$/g, "") : trimmed;
}

/**
 * Reads Denote front matter out of a note's text. Only the first line matching
 * each key counts, as in Denote.
 */
export function parseDenoteFrontMatter(
  text: string,
  fileType: DenoteFileType,
): DenoteFrontMatter {
  const spec = frontMatterSpecs[fileType];
  const result: DenoteFrontMatter = { keywords: [], hasKeywords: false };
  const seen = new Set<string>();
  for (const line of text.split("\n")) {
    for (const field of [
      "title",
      "date",
      "keywords",
      "identifier",
      "signature",
    ] as const) {
      if (seen.has(field)) {
        continue;
      }
      const key = spec[field].exec(line);
      if (!key) {
        continue;
      }
      seen.add(field);
      const value = line.slice(key[0].length);
      if (field === "keywords") {
        result.keywords = extractDenoteKeywords(value);
        result.hasKeywords = true;
      } else {
        const unquoted = unquote(value, spec.quoted);
        if (unquoted) {
          result[field] = unquoted;
        }
      }
    }
    // Front matter sits at the top; give up once past a plausible header.
    if (seen.size === 5) {
      break;
    }
  }
  return result;
}

/**
 * Renders front matter for a new note, per `denote-file-types`.
 *
 * A component with no value is dropped unless it is one Denote keeps anyway.
 * `denote-front-matter-components-present-even-if-empty-value` defaults to
 * title, keywords, date and identifier — so the *signature* line disappears
 * when there is no signature, rather than being written empty.
 */
export function formatDenoteFrontMatter(
  frontMatter: DenoteFrontMatter,
  fileType: DenoteFileType,
): string {
  const spec = frontMatterSpecs[fileType];
  const rendered = spec.template({
    title: frontMatter.title ?? "",
    date: frontMatter.date ?? "",
    keywords: frontMatter.keywords,
    identifier: frontMatter.identifier ?? "",
    signature: frontMatter.signature ?? "",
  });
  if (frontMatter.signature) {
    return rendered;
  }
  return rendered
    .split("\n")
    .filter((line) => !spec.signature.test(line))
    .join("\n");
}

/** `denote-date-org-timestamp`: `[2022-08-05 Fri 13:10]`. */
export function denoteOrgTimestamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][date.getDay()];
  return (
    `[${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${day} ${pad(date.getHours())}:${pad(date.getMinutes())}]`
  );
}

/**
 * A date in the notation the file type's front matter uses:
 * `denote-date-org-timestamp`, `denote-date-rfc3339` or `denote-date-iso-8601`.
 */
export function denoteDate(date: Date, fileType: DenoteFileType): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const ymd = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  switch (fileType) {
    case "org":
      return denoteOrgTimestamp(date);
    case "text":
      return ymd;
    default: {
      // RFC 3339, with the local UTC offset written as +HH:MM.
      const offset = -date.getTimezoneOffset();
      const sign = offset < 0 ? "-" : "+";
      const abs = Math.abs(offset);
      return (
        `${ymd}T${pad(date.getHours())}:${pad(date.getMinutes())}:` +
        `${pad(date.getSeconds())}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
      );
    }
  }
}

/** The file extension a Denote file type is written with. */
/**
 * The extensions `denote-file-types` defines, i.e. what makes a file a *note*.
 *
 * A Denote-named PDF is a file in the library, not a note: `denote-file-is-note-p`
 * requires one of these. The distinction matters for more than tidiness —
 * treating every Denote-named file as a note means opening it to read its front
 * matter, and a library's attachments are orders of magnitude larger than its
 * notes.
 */
export const denoteNoteExtensions = [".org", ".md", ".txt"];

/** `denote-file-is-note-p`: a Denote-named file with a note's extension. */
export function isDenoteNoteFile(path: string): boolean {
  const lower = path.toLowerCase();
  return denoteNoteExtensions.some((extension) => lower.endsWith(extension));
}

/**
 * A Denote file name for an attachment: a document that arrived by upload or
 * paste rather than being authored as a note.
 *
 * `denote-rename-file` renames any file, note or not — the scheme *is* the
 * name, and only a note additionally carries front matter. So an attachment
 * gets the same `IDENTIFIER--title.ext`, with its title taken from whatever
 * name it arrived under.
 *
 * A file that already carries an identifier is returned untouched, so naming
 * is idempotent: re-uploading a document does not stack a second identifier
 * onto its name, and a retroactive pass can be re-run safely.
 *
 * @param identifier a Denote identifier no other file in the library holds
 * @param name the name the file arrived under; empty for a clipboard item,
 *   which has none, in which case the identifier alone names it
 * @param fallbackExtension extension including the dot, used when `name`
 *   carries none
 */
export function denoteAttachmentName(
  identifier: string,
  name: string,
  fallbackExtension = "",
): string {
  const base = name.slice(name.lastIndexOf("/") + 1);
  if (parseDenoteName(base)?.identifier) {
    return base;
  }
  const split = splitExtension(base);
  const extension = split.extension || fallbackExtension;
  const stem = split.extension ? split.stem : base;
  return formatDenoteName({
    identifier,
    // A clipboard image has no name of its own, and a title sluggified away to
    // nothing is not worth a `--` delimiter. The identifier is a complete
    // Denote name by itself.
    title: sluggify("title", stem) || undefined,
    keywords: [],
    extension,
  });
}

export function denoteExtension(fileType: DenoteFileType): string {
  switch (fileType) {
    case "org":
      return ".org";
    case "text":
      return ".txt";
    default:
      return ".md";
  }
}

// ---------------------------------------------------------------------------
// Org dynamic blocks
// ---------------------------------------------------------------------------

export type DblockParams = Record<string, string | number | boolean | null>;

/**
 * Parses an Org dynamic block's parameter plist — `:regexp "_costs" :id-only nil`.
 *
 * Elisp `nil` is false and `t` is true; anything else unquoted is kept as a
 * string, since the parameters Denote reads are all strings or flags.
 */
export function parseDblockParams(text: string): DblockParams {
  const params: DblockParams = {};
  const token = /:([a-zA-Z][a-zA-Z0-9-]*)\s*("(?:[^"\\]|\\.)*"|[^\s]*)/g;
  for (const match of text.matchAll(token)) {
    const [, key, raw] = match;
    let value: string | number | boolean | null;
    if (raw === "" || raw === "nil") {
      value = null;
    } else if (raw === "t") {
      value = true;
    } else if (raw.startsWith('"')) {
      value = raw.slice(1, -1).replace(/\\(.)/g, "$1");
    } else if (/^-?\d+$/.test(raw)) {
      value = Number(raw);
    } else {
      value = raw;
    }
    params[key] = value;
  }
  return params;
}

/**
 * `denote-link-description-with-signature-and-title`, Denote's default: the
 * signature and the title separated by two spaces, or just the title.
 */
export function denoteLinkDescription(note: {
  signature?: string;
  title: string;
}): string {
  return note.signature ? `${note.signature}  ${note.title}` : note.title;
}

/** `YYYY-MM-DD` for an identifier, as `:include-date` appends. */
export function denoteIdentifierDate(identifier: string): string {
  const date = denoteIdentifierToDate(identifier);
  if (!date) {
    return "";
  }
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * Compiles a dynamic block's `:regexp`, which Denote matches against the whole
 * file name. Emacs regexp syntax that JavaScript cannot compile falls back to a
 * literal substring match rather than throwing the whole block away.
 */
const posixClasses: Record<string, string> = {
  alpha: "a-zA-Z",
  alnum: "a-zA-Z0-9",
  digit: "0-9",
  upper: "A-Z",
  lower: "a-z",
  space: "\\s",
  blank: " \\t",
  punct: "!-/:-@\\[-`{-~",
  word: "\\w",
  xdigit: "0-9a-fA-F",
};

/**
 * Translates the Emacs regexp constructs that JavaScript lacks.
 *
 * POSIX classes are the ones that matter in practice: `[[:alpha:]]` is legal
 * JavaScript but means something else entirely — a class of the literal
 * characters `[:alph]` — so it fails silently rather than throwing, quietly
 * dropping notes from a block.
 */
export function emacsRegexpToJs(pattern: string): string {
  return pattern.replace(
    /\[:([a-z]+):\]/g,
    (whole, name: string) => posixClasses[name] ?? whole,
  );
}

export function compileDblockRegexp(
  pattern: string,
): (name: string) => boolean {
  try {
    const regexp = new RegExp(emacsRegexpToJs(pattern));
    return (name) => regexp.test(name);
  } catch {
    return (name) => name.includes(pattern);
  }
}

// ---------------------------------------------------------------------------
// denote-journal
// ---------------------------------------------------------------------------

/** The symbolic values `denote-journal-title-format` accepts. */
export type JournalTitleFormat =
  | "day"
  | "day-date-month-year"
  | "day-date-month-year-24h"
  | "day-date-month-year-12h";

/**
 * `denote-journal-title-format`'s symbols, as the `format-time-string`
 * patterns denote-journal maps them to.
 */
const journalTitlePatterns: Record<JournalTitleFormat, string> = {
  day: "%A",
  "day-date-month-year": "%A %e %B %Y",
  "day-date-month-year-24h": "%A %e %B %Y %H:%M",
  "day-date-month-year-12h": "%A %e %B %Y %I:%M %^p",
};

const weekdays = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

const months = [
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

function pad(n: number, width = 2, filler = "0"): string {
  return String(n).padStart(width, filler);
}

/**
 * The subset of `format-time-string` that `denote-journal-title-format` uses.
 *
 * Only the specifiers reachable from that option are implemented; an unknown
 * one is left as written rather than silently dropped, so a custom format that
 * outruns this is visible in the title instead of quietly wrong.
 */
export function formatTimeString(pattern: string, date: Date): string {
  return pattern.replace(/%(\^?)([A-Za-z%])/g, (whole, caret: string, spec) => {
    let out: string | undefined;
    switch (spec) {
      case "A":
        out = weekdays[date.getDay()];
        break;
      case "a":
        out = weekdays[date.getDay()].slice(0, 3);
        break;
      case "B":
        out = months[date.getMonth()];
        break;
      case "b":
        out = months[date.getMonth()].slice(0, 3);
        break;
      case "Y":
        out = String(date.getFullYear());
        break;
      case "m":
        out = pad(date.getMonth() + 1);
        break;
      // `%e` is space-padded, `%d` zero-padded -- the difference survives into
      // the title, though sluggification collapses the run of spaces.
      case "e":
        out = pad(date.getDate(), 2, " ");
        break;
      case "d":
        out = pad(date.getDate());
        break;
      case "H":
        out = pad(date.getHours());
        break;
      case "M":
        out = pad(date.getMinutes());
        break;
      case "I":
        out = pad(date.getHours() % 12 === 0 ? 12 : date.getHours() % 12);
        break;
      case "p":
        out = date.getHours() < 12 ? "am" : "pm";
        break;
      case "%":
        return "%";
      default:
        return whole;
    }
    return caret ? out.toUpperCase() : out;
  });
}

/**
 * The title `denote-journal` gives an entry for `date`.
 *
 * `format` is either one of the symbols the Emacs option accepts or a literal
 * `format-time-string` pattern, exactly as `denote-journal-title-format` is.
 */
export function journalTitle(date: Date, format: string): string {
  const pattern = journalTitlePatterns[format as JournalTitleFormat] ?? format;
  return formatTimeString(pattern, date);
}

/**
 * `YYYY-MM-DD` as a date in the *local* zone.
 *
 * `new Date("2026-09-04")` is parsed as UTC midnight, which is the day before
 * everywhere west of Greenwich — so a journal keyed off it opens yesterday's
 * entry. Handing the components over separately avoids that. Anything else is
 * left to `Date` to interpret.
 */
export function parseLocalDate(dateStr: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr.trim());
  if (!match) {
    return new Date(dateStr);
  }
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

/** `YYYYMMDD` — the identifier prefix every entry for a day shares. */
export function journalDateStamp(date: Date): string {
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
}

// ---------------------------------------------------------------------------
// Rewriting front matter in place
// ---------------------------------------------------------------------------

export type FrontMatterChanges = {
  title?: string;
  keywords?: string[];
  /** An empty string removes the signature line, as Denote does. */
  signature?: string;
};

/**
 * `denote-rewrite-front-matter`: changes the title, keywords and signature
 * lines of a note's front matter and leaves everything else -- date,
 * identifier, the body, the user's own lines -- exactly as it was. A field
 * whose line is missing is added where Denote would put it: the signature
 * after the identifier, the keywords after the date, the title first.
 */
export function rewriteDenoteFrontMatter(
  text: string,
  fileType: DenoteFileType,
  changes: FrontMatterChanges,
): string {
  const spec = frontMatterSpecs[fileType];
  // The template writes each line the way Denote formats it for this type;
  // the wanted lines are picked out of one rendering.
  const rendered = spec
    .template({
      title: changes.title ?? "",
      date: "",
      keywords: changes.keywords ?? [],
      identifier: "",
      signature: changes.signature ?? "",
    })
    .split("\n");
  const lineFor = (field: "title" | "keywords" | "signature") =>
    rendered.find((line) => spec[field].test(line))!;

  const lines = text.split("\n");
  const end = frontMatterEnd(lines, spec);
  const indexOf = (field: keyof FrontMatterSpec & string) =>
    lines.findIndex(
      (line, i) => i < end && (spec[field as "title"] as RegExp).test(line),
    );

  if (changes.title !== undefined) {
    const at = indexOf("title");
    if (at === -1) {
      lines.splice(
        fileType === "org" || fileType === "text" ? 0 : 1,
        0,
        lineFor("title"),
      );
    } else {
      lines[at] = lineFor("title");
    }
  }
  if (changes.keywords !== undefined) {
    const at = indexOf("keywords");
    if (at === -1) {
      const after = indexOf("date");
      lines.splice(
        after === -1 ? indexOf("title") + 1 : after + 1,
        0,
        lineFor("keywords"),
      );
    } else {
      lines[at] = lineFor("keywords");
    }
  }
  if (changes.signature !== undefined) {
    const at = indexOf("signature");
    if (!changes.signature) {
      if (at !== -1) lines.splice(at, 1);
    } else if (at === -1) {
      const after = indexOf("identifier");
      lines.splice(
        after === -1 ? frontMatterEnd(lines, spec) : after + 1,
        0,
        lineFor("signature"),
      );
    } else {
      lines[at] = lineFor("signature");
    }
  }
  return lines.join("\n");
}

/** The line index just past the front matter, for a type's notation. */
function frontMatterEnd(lines: string[], spec: FrontMatterSpec): number {
  if (spec === frontMatterSpecs["markdown-yaml"] && lines[0] === "---") {
    const close = lines.indexOf("---", 1);
    return close === -1 ? lines.length : close;
  }
  if (spec === frontMatterSpecs["markdown-toml"] && lines[0] === "+++") {
    const close = lines.indexOf("+++", 1);
    return close === -1 ? lines.length : close;
  }
  // Org and text: the header is the run of lines that look like keys.
  let i = 0;
  while (
    i < lines.length &&
    (lines[i].startsWith("#+") || /^[a-z]+\s*:/i.test(lines[i]))
  ) {
    i++;
  }
  return i;
}

// ---------------------------------------------------------------------------
// Signatures as sequences
// ---------------------------------------------------------------------------

/**
 * A signature read as a sequence, the way `denote-sequence` reads it in its
 * numeric scheme: `21=14=3` is the third child of `21=14`, which is the
 * fourteenth child of `21`. A Johnny Decimal address is such a sequence with
 * two-digit components.
 */
export function signatureComponents(signature: string): string[] {
  return signature.split("=").filter(Boolean);
}

/** `21=14` → `21`; a top-level signature has no parent. */
export function signatureParent(signature: string): string | undefined {
  const parts = signatureComponents(signature);
  return parts.length > 1 ? parts.slice(0, -1).join("=") : undefined;
}

/** Whether `child` sits directly under `parent` in the sequence. */
export function isSignatureChildOf(child: string, parent: string): boolean {
  return signatureParent(child) === parent;
}

/**
 * Orders signatures as a sequence: component by component, numerically where
 * both are numbers (`21=2` before `21=14`), otherwise as text, a shorter
 * sequence before its own children.
 */
export function compareSignatures(a: string, b: string): number {
  const pa = signatureComponents(a);
  const pb = signatureComponents(b);
  for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
    const na = Number(pa[i]);
    const nb = Number(pb[i]);
    const c =
      Number.isFinite(na) && Number.isFinite(nb) && pa[i] !== "" && pb[i] !== ""
        ? na - nb
        : pa[i].localeCompare(pb[i]);
    if (c !== 0) return c;
  }
  return pa.length - pb.length;
}

/**
 * The next free child of `parent` given the signatures that exist: one past
 * the highest numeric child, written as wide as the widest sibling so a
 * Johnny Decimal `21=09` is followed by `21=10`, not `21=10` by `21=010`.
 * A first child of a two-digit address gets two digits too.
 */
export function nextChildSignature(
  parent: string | undefined,
  existing: string[],
): string {
  const children = existing.filter((s) =>
    parent
      ? isSignatureChildOf(s, parent)
      : signatureComponents(s).length === 1,
  );
  const lastParts = children.map((s) => signatureComponents(s).at(-1)!);
  const numbers = lastParts.map(Number).filter((n) => Number.isFinite(n));
  const next = numbers.length ? Math.max(...numbers) + 1 : 1;
  const width = Math.max(
    ...lastParts.map((p) => p.length),
    parent ? signatureComponents(parent).at(-1)!.length : 1,
    1,
  );
  const component = String(next).padStart(width, "0");
  return parent ? `${parent}=${component}` : component;
}

/** The next free sibling of `signature`: the next child of its parent. */
export function nextSiblingSignature(
  signature: string,
  existing: string[],
): string {
  return nextChildSignature(signatureParent(signature), existing);
}
