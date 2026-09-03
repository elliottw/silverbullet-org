import { parseDenoteName } from "./denote.ts";
import { getPathExtension, type Path, parseToRef } from "./ref.ts";

/**
 * The link syntax a page is authored in.
 *
 * A space can hold both Markdown and Org pages, and writing a Markdown wiki
 * link into an Org note produces something neither format can follow. Every
 * place that *writes* a link asks this first, so the syntax always matches the
 * page it lands in.
 */
export type LinkSyntax = "markdown" | "org";

export function linkSyntaxFor(pathOrName: string): LinkSyntax {
  const path = parseToRef(pathOrName)?.path;
  return path && getPathExtension(path) === "org" ? "org" : "markdown";
}

/** Whether an Org link target already names a scheme (`https:`, `denote:`, …). */
export function hasLinkScheme(target: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(target);
}

/**
 * The Org link target for a page: a Denote identifier where the page has one,
 * because that is what survives the note being renamed, and the page name
 * otherwise.
 */
export function orgLinkTarget(pageName: string): string {
  const identifier = parseDenoteName(pageName)?.identifier;
  return identifier ? `denote:${identifier}` : pageName;
}

/**
 * The text belonging *between* an already-typed `[[` and its closing `]]`.
 *
 * Both syntaxes open with `[[`, so completion only ever fills the middle:
 * Markdown separates an alias with `|`, Org closes the target and opens a
 * description with `][`.
 */
export function innerPageLink(
  syntax: LinkSyntax,
  pageName: string,
  alias?: string,
): string {
  if (syntax === "org") {
    const target = orgLinkTarget(pageName);
    return alias ? `${target}][${alias}` : target;
  }
  return alias ? `${pageName}|${alias}` : pageName;
}

/** A complete link to a page, brackets included. */
export function pageLink(
  syntax: LinkSyntax,
  pageName: string,
  alias?: string,
): string {
  return `[[${innerPageLink(syntax, pageName, alias)}]]`;
}

/** A complete link to a URL, with link text. */
export function urlLink(syntax: LinkSyntax, url: string, text: string): string {
  return syntax === "org" ? `[[${url}][${text}]]` : `[${text}](${url})`;
}

/**
 * A link to an embedded document. Org has no `![[…]]` transclusion, so an
 * image is an ordinary link to its file.
 */
export function documentLink(
  syntax: LinkSyntax,
  path: Path,
  isImage: boolean,
): string {
  if (syntax === "org") {
    return `[[file:${path}]]`;
  }
  return isImage ? `![[${path}]]` : `[[${path}]]`;
}
