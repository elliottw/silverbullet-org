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

/** Renders front matter for a new note, per `denote-file-types`. */
export function formatDenoteFrontMatter(
  frontMatter: DenoteFrontMatter,
  fileType: DenoteFileType,
): string {
  return frontMatterSpecs[fileType].template({
    title: frontMatter.title ?? "",
    date: frontMatter.date ?? "",
    keywords: frontMatter.keywords,
    identifier: frontMatter.identifier ?? "",
    signature: frontMatter.signature ?? "",
  });
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
