/**
 * Reading a web page's own title, so a link to it can say what it is.
 *
 * Pasting a URL leaves a note full of `https://…?utm_source=…` — unreadable,
 * and worse, unsearchable: what you will look for later is the title. Emacs
 * solves this with `org-cliplink`, which fetches the page and offers its title
 * as the link's description. This is the parsing half of that; the fetching
 * half lives in the plug, which has the server's proxy behind it.
 */

/**
 * The URL a typed or pasted string means.
 *
 * A browser's address bar hands over `example.com/x` with the scheme hidden,
 * and that is not a link until it names one — so a bare host gains `https://`.
 * Anything that already names a scheme is left exactly as it is, including
 * `mailto:` and `denote:`.
 */
export function normalizeWebUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) {
    return trimmed;
  }
  if (trimmed.startsWith("//")) {
    return `https:${trimmed}`;
  }
  // A host: something.tld, optionally with a port, path, query or fragment.
  if (/^[^\s/]+\.[a-z]{2,}(?:[:/?#]|$)/i.test(trimmed)) {
    return `https://${trimmed}`;
  }
  return trimmed;
}

const titleTag = /<title[^>]*>([\s\S]*?)<\/title>/i;
const metaTitle = [
  /<meta[^>]+(?:property|name)=["']og:title["'][^>]+content=["']([^"']*)["']/i,
  /<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']og:title["']/i,
];

const entities: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  middot: "·",
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]*);/gi, (whole, body) => {
    if (body[0] === "#") {
      const code =
        body[1] === "x" || body[1] === "X"
          ? parseInt(body.slice(2), 16)
          : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : whole;
    }
    return entities[body.toLowerCase()] ?? whole;
  });
}

/** How long a description taken from a page may be. */
const maxTitleLength = 300;

/**
 * The title of an HTML page: what its tab would read as, falling back to
 * `og:title` for pages that only set that. Undefined when there is nothing
 * worth offering — then the description is yours to write.
 */
export function titleFromHtml(html: string): string | undefined {
  let raw = titleTag.exec(html)?.[1];
  if (raw === undefined) {
    for (const pattern of metaTitle) {
      raw = pattern.exec(html)?.[1];
      if (raw !== undefined) break;
    }
  }
  if (raw === undefined) {
    return undefined;
  }
  const text = decodeEntities(raw.replace(/<[^>]*>/g, ""))
    .replace(/\s+/g, " ")
    .trim();
  if (!text) {
    return undefined;
  }
  return text.length > maxTitleLength
    ? `${text.slice(0, maxTitleLength).trimEnd()}…`
    : text;
}
