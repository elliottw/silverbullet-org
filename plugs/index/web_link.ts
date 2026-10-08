import { editor } from "@silverbulletmd/silverbullet/syscalls";
import {
  type LinkSyntax,
  linkFor,
  linkSyntaxFor,
} from "@silverbulletmd/silverbullet/lib/link_syntax";
import {
  normalizeWebUrl,
  titleFromHtml,
} from "@silverbulletmd/silverbullet/lib/web_title";

/**
 * Long enough for a slow page, short enough that a dead host does not hold up
 * the prompt. The description is only a default either way.
 */
const titleTimeout = 5000;

/** How much of a page is read looking for its title; it is in the head. */
const maxTitleBytes = 512 * 1024;

/**
 * The page's own title, for a link to read as. Fetched inside the plug, where
 * `fetch` goes through the server's proxy -- the browser could not ask another
 * origin for its HTML, and the server can.
 *
 * Every failure is the same answer: no suggestion. A page behind a login, a
 * host that is down, no network at all -- none of that is a reason not to
 * insert the link you asked for.
 */
export async function fetchWebTitle(url: string): Promise<string | undefined> {
  if (!/^https?:\/\//i.test(url)) {
    return undefined;
  }
  try {
    const resp = await Promise.race([
      fetch(url, {
        headers: { Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5" },
      }),
      new Promise<undefined>((resolve) =>
        setTimeout(() => resolve(undefined), titleTimeout),
      ),
    ]);
    if (!resp?.ok) {
      return undefined;
    }
    const contentType = resp.headers.get("content-type") ?? "";
    if (contentType && !/html|xml/i.test(contentType)) {
      return undefined; // a PDF has no <title> to read
    }
    return titleFromHtml((await resp.text()).slice(0, maxTitleBytes));
  } catch {
    return undefined;
  }
}

/**
 * `org-insert-link`'s two prompts: the target, then what it reads as.
 *
 * The description is prefilled with the page's title, so the common case --
 * paste a URL, press Enter twice -- leaves a link that says what it points at.
 */
export async function insertUrlLink(
  syntax: LinkSyntax,
  from: number,
  to: number,
  url: string,
  description: string,
): Promise<void> {
  const typed = await editor.prompt("URL:", url);
  if (typed === undefined) {
    return;
  }
  const target = normalizeWebUrl(typed);
  if (!target) {
    return;
  }
  // A selection is already the description the author chose; only a link made
  // from nothing goes asking the page what it is called.
  let suggestion = description.trim();
  if (!suggestion) {
    suggestion = (await fetchWebTitle(target)) ?? "";
  }
  const text = await editor.prompt("Description:", suggestion);
  if (text === undefined) {
    return;
  }
  await editor.replaceRange(from, to, linkFor(syntax, target, text.trim()));
}

/**
 * `org-insert-link` (`M-I`) for a link out of the space: straight to the URL
 * prompt, where `Denote: Insert or Edit Link` (`M-i`) offers notes first.
 *
 * Which you want is known before you press the key -- a web link is not a
 * note you failed to find -- and a link to something you just read in a
 * browser is frequent enough to deserve its own.
 */
export async function insertWebLinkCommand(): Promise<void> {
  const [path, cursor, selection] = await Promise.all([
    editor.getCurrentPath(),
    editor.getCursor(),
    editor.getSelection(),
  ]);
  const syntax = linkSyntaxFor(path);
  const selected = (selection.text ?? "").trim();
  // A selected URL is the target; any other selection is the description.
  const isUrl =
    /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(selected) ||
    /^[^\s/]+\.[a-z]{2,}(?:[:/?#]|$)/i.test(selected);
  await insertUrlLink(
    syntax,
    selected ? selection.from : cursor,
    selected ? selection.to : cursor,
    isUrl ? selected : "",
    isUrl ? "" : selected,
  );
}
