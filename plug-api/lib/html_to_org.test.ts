import { expect, test } from "vitest";
import { htmlToOrg } from "./html_to_org.ts";

// This project's vitest has no DOM, and the converter walks one. The nodes
// below are the few properties it actually reads -- `nodeType`, `tagName`,
// `childNodes`, `children`, `getAttribute`, `textContent` -- so what is under
// test is the conversion itself: the level shift, the emphasis padding, the
// list nesting, and what gets dropped. HTML *parsing* is the browser's and is
// not being re-implemented here.
type N = any;

const text = (value: string): N => ({ nodeType: 3, nodeValue: value });

const el = (
  tagName: string,
  children: N[] = [],
  attrs: Record<string, string> = {},
): N => {
  const node: N = {
    nodeType: 1,
    tagName,
    childNodes: children,
    get children() {
      return children.filter((c: N) => c.nodeType === 1);
    },
    getAttribute: (name: string) => attrs[name] ?? null,
    get textContent(): string {
      const walk = (n: N): string =>
        n.nodeType === 3
          ? (n.nodeValue ?? "")
          : (n.childNodes ?? []).map(walk).join("");
      return walk(node);
    },
  };
  return node;
};

const root = (children: N[]): N => el("BODY", children);
const convert = (children: N[]) => htmlToOrg(root(children));

test("heading levels shift up: the article's h1 is the note's title", () => {
  const { org } = convert([
    el("H1", [text("The Title")]),
    el("P", [text("Prose.")]),
    el("H2", [text("A section")]),
    el("H3", [text("Deeper")]),
  ]);
  expect(org).toContain("* The Title");
  expect(org).toContain("* A section");
  expect(org).toContain("** Deeper");
  expect(org).toContain("Prose.");
});

test("emphasis gives its padding back to the sentence", () => {
  // Org emphasis only takes hold when the marker touches the word, so
  // `<strong> bold </strong>` must not become `* bold *` -- which renders as
  // literal asterisks.
  const { org } = convert([
    el("P", [text("a"), el("STRONG", [text(" bold ")]), text("b")]),
  ]);
  expect(org).toBe("a *bold* b");
});

test("inline markup maps to Org's markers", () => {
  const { org } = convert([
    el("P", [
      el("STRONG", [text("b")]),
      text(" "),
      el("EM", [text("i")]),
      text(" "),
      el("CODE", [text("c")]),
      text(" "),
      el("DEL", [text("d")]),
    ]),
  ]);
  expect(org).toBe("*b* /i/ ~c~ +d+");
});

test("lists nest, ordered and unordered", () => {
  const { org } = convert([
    el("UL", [
      el("LI", [text("one")]),
      el("LI", [text("two"), el("UL", [el("LI", [text("nested")])])]),
    ]),
    el("OL", [el("LI", [text("first")]), el("LI", [text("second")])]),
  ]);
  expect(org).toContain("- one");
  expect(org).toContain("- two");
  expect(org).toContain("  - nested");
  expect(org).toContain("1. first");
  expect(org).toContain("2. second");
});

test("quotes and code become Org blocks", () => {
  const { org } = convert([
    el("BLOCKQUOTE", [el("P", [text("Quoted words.")])]),
    el("PRE", [text("let x = 1;\n")]),
  ]);
  expect(org).toContain("#+BEGIN_QUOTE\nQuoted words.\n#+END_QUOTE");
  expect(org).toContain("#+BEGIN_SRC\nlet x = 1;\n#+END_SRC");
});

test("page chrome does not survive the clip", () => {
  const { org } = convert([
    el("SCRIPT", [text("alert(1)")]),
    el("STYLE", [text("p{color:red}")]),
    el("NAV", [el("A", [text("Home")], { href: "/home" })]),
    el("P", [text("Only this.")]),
    el("FORM", [el("BUTTON", [text("Subscribe")])]),
  ]);
  expect(org).toBe("Only this.");
});

test("links, and a link that is its own address", () => {
  const { org } = convert([
    el("P", [
      text("See "),
      el("A", [text("the page")], { href: "https://example.com/a" }),
      text(" and "),
      el("A", [text("https://example.com/b")], {
        href: "https://example.com/b",
      }),
      text(" and "),
      el("A", [text("anchor")], { href: "#section" }),
    ]),
  ]);
  expect(org).toContain("[[https://example.com/a][the page]]");
  // `[[x][x]]` reads worse than `x`, and the parser linkifies a bare URL.
  expect(org).toContain("and https://example.com/b and");
  // An in-page anchor is not a link once the page is a note.
  expect(org).toContain("and anchor");
  expect(org).not.toContain("#section");
});

test("images are collected in order, and deduplicated", () => {
  const { org, images } = convert([
    el("P", [
      el("IMG", [], { src: "https://example.com/a.png", alt: "A picture" }),
    ]),
    el("FIGURE", [
      el("IMG", [], { src: "https://example.com/b.png" }),
      el("FIGCAPTION", [text("Cap")]),
    ]),
    el("P", [el("IMG", [], { src: "https://example.com/a.png" })]),
  ]);
  expect(images).toEqual([
    "https://example.com/a.png",
    "https://example.com/b.png",
  ]);
  expect(org).toContain("[[https://example.com/a.png][A picture]]");
  expect(org).toContain("#+CAPTION: Cap");
});

test("a bare container of text is a paragraph", () => {
  const { org } = convert([
    el("DIV", [text("Just text.")]),
    el("DIV", [el("P", [text("And a para.")])]),
  ]);
  expect(org).toContain("Just text.");
  expect(org).toContain("And a para.");
});
