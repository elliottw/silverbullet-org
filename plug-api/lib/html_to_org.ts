/**
 * HTML to Org, for a clipped web page.
 *
 * The editor already converts pasted HTML with turndown, which only speaks
 * Markdown -- fine for a Markdown space and wrong for this one, where a
 * clipped article has to arrive as Org or it is a foreign body in the
 * library.
 *
 * Deliberately a small subset: headings, paragraphs, lists, links, images,
 * emphasis, code and quotes. An article is prose, and the long tail of HTML
 * in a page's chrome is exactly what should not survive the clip.
 */

export type OrgFromHtml = {
  org: string;
  /** Image URLs the article referenced, in document order. */
  images: string[];
};

type Ctx = { images: string[]; listDepth: number };

const BLOCK = new Set([
  "P",
  "DIV",
  "SECTION",
  "ARTICLE",
  "MAIN",
  "HEADER",
  "FOOTER",
  "ASIDE",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "UL",
  "OL",
  "LI",
  "BLOCKQUOTE",
  "PRE",
  "FIGURE",
  "FIGCAPTION",
  "TABLE",
  "TR",
  "HR",
  "BR",
]);

/** Markup that carries no prose: script, style, navigation chrome. */
const DROP = new Set([
  "SCRIPT",
  "STYLE",
  "NOSCRIPT",
  "SVG",
  "CANVAS",
  "IFRAME",
  "FORM",
  "BUTTON",
  "INPUT",
  "SELECT",
  "TEXTAREA",
  "NAV",
]);

const collapse = (text: string) => text.replace(/[ \t\n\r]+/g, " ");

/**
 * Org emphasis only takes hold when the marker touches the word, so a run
 * whose own text is padded has to give the spaces back to the paragraph.
 */
function emphasise(inner: string, marker: string): string {
  const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(inner)!;
  if (!m[2]) return inner;
  return `${m[1]}${marker}${m[2]}${marker}${m[3]}`;
}

function inline(node: Node, ctx: Ctx): string {
  if (node.nodeType === 3) return collapse(node.nodeValue ?? "");
  if (node.nodeType !== 1) return "";
  const el = node as Element;
  const tag = el.tagName.toUpperCase();
  if (DROP.has(tag)) return "";
  const inner = Array.from(el.childNodes)
    .map((child) => inline(child, ctx))
    .join("");

  switch (tag) {
    case "A": {
      const href = el.getAttribute("href") ?? "";
      const text = inner.trim();
      if (!href || href.startsWith("#")) return inner;
      // A link whose text is its own address reads better bare -- and the
      // parser linkifies it.
      if (!text || text === href) return href;
      return `[[${href}][${text}]]`;
    }
    case "IMG": {
      const src = el.getAttribute("src") ?? "";
      if (src) ctx.images.push(src);
      const alt = el.getAttribute("alt")?.trim();
      return src ? (alt ? `[[${src}][${alt}]]` : `[[${src}]]`) : "";
    }
    case "STRONG":
    case "B":
      return emphasise(inner, "*");
    case "EM":
    case "I":
      return emphasise(inner, "/");
    case "CODE":
    case "KBD":
    case "SAMP":
      return emphasise(inner, "~");
    case "DEL":
    case "S":
      return emphasise(inner, "+");
    case "BR":
      return "\n";
    default:
      return inner;
  }
}

function block(node: Node, ctx: Ctx, out: string[]): void {
  if (node.nodeType === 3) {
    const text = collapse(node.nodeValue ?? "").trim();
    if (text) out.push(text);
    return;
  }
  if (node.nodeType !== 1) return;
  const el = node as Element;
  const tag = el.tagName.toUpperCase();
  if (DROP.has(tag)) return;

  const heading = /^H([1-6])$/.exec(tag);
  if (heading) {
    const text = inline(el, ctx).trim();
    // An article's own `h1` is its title, which the note already carries, so
    // every level shifts up one: `h2` becomes a top-level Org headline.
    if (text) {
      const level = Math.max(1, +heading[1] - 1);
      out.push(`${"*".repeat(level)} ${text}`);
    }
    return;
  }

  switch (tag) {
    case "UL":
    case "OL": {
      const ordered = tag === "OL";
      let n = 1;
      for (const li of Array.from(el.children)) {
        if (li.tagName.toUpperCase() !== "LI") continue;
        const indent = "  ".repeat(ctx.listDepth);
        const marker = ordered ? `${n++}.` : "-";
        // A nested list is a block of its own inside the item, so the item's
        // own text is taken from everything that is not one.
        const nested = Array.from(li.children).filter((c) =>
          ["UL", "OL"].includes(c.tagName.toUpperCase()),
        );
        const ownText = Array.from(li.childNodes)
          .filter((c) => !nested.includes(c as Element))
          .map((c) => inline(c, ctx))
          .join("")
          .trim();
        if (ownText) out.push(`${indent}${marker} ${ownText}`);
        ctx.listDepth++;
        for (const sub of nested) block(sub, ctx, out);
        ctx.listDepth--;
      }
      return;
    }
    case "BLOCKQUOTE": {
      const inner: string[] = [];
      for (const child of Array.from(el.childNodes)) block(child, ctx, inner);
      const text = inner.join("\n").trim();
      if (text) out.push(`#+BEGIN_QUOTE\n${text}\n#+END_QUOTE`);
      return;
    }
    case "PRE": {
      const text = (el.textContent ?? "").replace(/\s+$/, "");
      if (text) out.push(`#+BEGIN_SRC\n${text}\n#+END_SRC`);
      return;
    }
    case "HR":
      out.push("-----");
      return;
    case "FIGCAPTION": {
      const text = inline(el, ctx).trim();
      if (text) out.push(`#+CAPTION: ${text}`);
      return;
    }
    case "P": {
      const text = inline(el, ctx).trim();
      if (text) out.push(text);
      return;
    }
  }

  // A container: recurse. Anything with no block children of its own is
  // treated as a paragraph, which is what a bare `div` of text is.
  const hasBlocks = Array.from(el.children).some(
    (c) => BLOCK.has(c.tagName.toUpperCase()) || !!/^H[1-6]$/.exec(c.tagName),
  );
  if (hasBlocks) {
    for (const child of Array.from(el.childNodes)) block(child, ctx, out);
    return;
  }
  const text = inline(el, ctx).trim();
  if (text) out.push(text);
}

/**
 * Converts an article's HTML to Org. `doc` is any DOM-ish root -- a parsed
 * document's body, or an element.
 */
export function htmlToOrg(root: Element | DocumentFragment): OrgFromHtml {
  const ctx: Ctx = { images: [], listDepth: 0 };
  const out: string[] = [];
  for (const child of Array.from(root.childNodes)) block(child, ctx, out);
  const org = out
    .join("\n\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+$/gm, "")
    .trim();
  return { org, images: [...new Set(ctx.images)] };
}
