import {
  collectNodesOfType,
  findNodeOfType,
  type ParseTree,
  renderToText,
} from "@silverbulletmd/silverbullet/lib/tree";
import { expect, test } from "vitest";
import { parseOrg } from "./parser.ts";

function countOfType(tree: ParseTree, type: string): number {
  return types(tree).filter((t) => t === type).length;
}

function types(tree: ParseTree): string[] {
  const result: string[] = [];
  const walk = (n: ParseTree) => {
    if (n.type) result.push(n.type);
    n.children?.forEach(walk);
  };
  walk(tree);
  return result;
}

test("Parsing an Org document round-trips to the original text", () => {
  const text = `#+TITLE: Demo

* Top headline
Some *bold* and /italic/ text.

** Nested
- one
- two
  - nested item

#+BEGIN_SRC lua
print("hi")
#+END_SRC

| a | b |
|---+---|
| 1 | 2 |
`;
  expect(renderToText(parseOrg(text))).toEqual(text);
});

test("Headlines map onto ATXHeading nodes at the right level", () => {
  const tree = parseOrg("* One\n** Two\n***** Five\n******* Seven\n");
  const headings = collectNodesOfType(tree, "ATXHeading1");
  expect(headings.length).toEqual(1);
  expect(renderToText(headings[0])).toEqual("* One");
  expect(collectNodesOfType(tree, "ATXHeading2").length).toEqual(1);
  expect(collectNodesOfType(tree, "ATXHeading5").length).toEqual(1);
  // Org allows deeper nesting than Markdown has heading levels; it clamps at 6.
  expect(collectNodesOfType(tree, "ATXHeading6").length).toEqual(1);
});

test("A headline's name is derived the same way as for Markdown", () => {
  const tree = parseOrg("*** My headline\n");
  const heading = collectNodesOfType(tree, "ATXHeading3")[0];
  // This is verbatim what plugs/index/header.ts does.
  expect(renderToText(heading).slice(3 + 1)).toEqual("My headline");
});

test("Emphasis follows Org's pre/post character rules", () => {
  const tree = parseOrg("*bold* /italic/ _under_ +gone+ =verb= ~code~\n");
  expect(collectNodesOfType(tree, "StrongEmphasis").length).toEqual(1);
  expect(collectNodesOfType(tree, "Emphasis").length).toEqual(1);
  expect(collectNodesOfType(tree, "OrgUnderline").length).toEqual(1);
  expect(collectNodesOfType(tree, "Strikethrough").length).toEqual(1);
  expect(collectNodesOfType(tree, "InlineCode").length).toEqual(2);
});

test("Emphasis markers inside words stay plain text", () => {
  const tree = parseOrg("snake_case_name and 2 * 3 * 4\n");
  expect(collectNodesOfType(tree, "OrgUnderline").length).toEqual(0);
  expect(collectNodesOfType(tree, "StrongEmphasis").length).toEqual(0);
});

test("Lists nest by indentation and reuse the Markdown node names", () => {
  const tree = parseOrg("- one\n- two\n  - nested\n1. first\n2. second\n");
  // collectNodesOfType stops descending at a match, so count by hand to see
  // the nested list too.
  expect(countOfType(tree, "BulletList")).toEqual(2);
  expect(countOfType(tree, "OrderedList")).toEqual(1);
  expect(countOfType(tree, "ListItem")).toEqual(5);
  const outer = collectNodesOfType(tree, "BulletList")[0];
  const secondItem = outer.children!.filter((c) => c.type === "ListItem")[1];
  const nested = findNodeOfType(secondItem, "BulletList")!;
  expect(renderToText(nested).trim()).toEqual("- nested");
});

test("Checkbox items produce the Task shape plugs/index/item.ts reads", () => {
  const tree = parseOrg("- [ ] open task\n- [X] closed task\n");
  const tasks = collectNodesOfType(tree, "Task");
  expect(tasks.length).toEqual(2);
  // plugs/index/item.ts reads the state through exactly this path.
  expect(tasks[0].children![0].children![1].text).toEqual(" ");
  expect(tasks[1].children![0].children![1].text).toEqual("X");
});

test("A `*` bullet is only a bullet when indented", () => {
  const tree = parseOrg("* headline\n  * bullet\n");
  expect(collectNodesOfType(tree, "ATXHeading1").length).toEqual(1);
  expect(collectNodesOfType(tree, "ListItem").length).toEqual(1);
});

test("Source blocks become FencedCode with their language as CodeInfo", () => {
  const tree = parseOrg('#+BEGIN_SRC lua\nprint("hi")\n#+END_SRC\n');
  const code = findNodeOfType(tree, "FencedCode")!;
  expect(findNodeOfType(code, "CodeInfo")!.children![0].text).toEqual("lua");
  expect(findNodeOfType(code, "CodeText")!.children![0].text).toEqual(
    'print("hi")',
  );
});

test("Quote and comment blocks get their own node types", () => {
  const tree = parseOrg(
    "#+begin_quote\nquoted\n#+end_quote\n\n#+BEGIN_COMMENT\nhidden\n#+END_COMMENT\n",
  );
  expect(collectNodesOfType(tree, "Blockquote").length).toEqual(1);
  expect(collectNodesOfType(tree, "CommentBlock").length).toEqual(1);
});

test("Tables split into header, delimiter and body rows", () => {
  const tree = parseOrg("| a | b |\n|---+---|\n| 1 | 2 |\n");
  expect(collectNodesOfType(tree, "TableHeader").length).toEqual(1);
  expect(collectNodesOfType(tree, "TableRow").length).toEqual(1);
  const cells = collectNodesOfType(tree, "TableCell");
  expect(cells.map((c) => renderToText(c))).toEqual(["a", "b", "1", "2"]);
});

test("Keyword lines and property drawers are structured, not prose", () => {
  const tree = parseOrg(
    "#+TITLE: My page\n* Item\n:PROPERTIES:\n:COST: 250\n:END:\nBody text\n",
  );
  const keyword = findNodeOfType(tree, "OrgKeyword")!;
  expect(findNodeOfType(keyword, "OrgKeywordName")!.children![0].text).toEqual(
    "TITLE",
  );
  expect(findNodeOfType(keyword, "OrgKeywordValue")!.children![0].text).toEqual(
    "My page",
  );
  const drawer = findNodeOfType(tree, "OrgDrawer")!;
  const property = findNodeOfType(drawer, "OrgProperty")!;
  expect(
    findNodeOfType(property, "OrgPropertyName")!.children![0].text,
  ).toEqual("COST");
  expect(
    findNodeOfType(property, "OrgPropertyValue")!.children![0].text,
  ).toEqual("250");
  // The drawer must not swallow the paragraph that follows it.
  expect(collectNodesOfType(tree, "Paragraph").length).toEqual(1);
});

test("An unterminated drawer degrades to a paragraph", () => {
  const text = ":PROPERTIES:\n:COST: 250\n\nplain\n";
  const tree = parseOrg(text);
  expect(collectNodesOfType(tree, "OrgDrawer").length).toEqual(0);
  expect(renderToText(tree)).toEqual(text);
});

test("Comment lines and horizontal rules are recognised", () => {
  const tree = parseOrg("# a comment\n# another\n\n-----\n");
  expect(collectNodesOfType(tree, "CommentBlock").length).toEqual(1);
  expect(collectNodesOfType(tree, "HorizontalRule").length).toEqual(1);
});

test("Node ranges stay inside their parents for a large mixed document", () => {
  const text = [
    "#+TITLE: Everything",
    "",
    "* Heading with *bold*",
    ":PROPERTIES:",
    ":ID: abc",
    ":END:",
    "",
    "Paragraph one",
    "continued on a second line.",
    "",
    "- [ ] task one",
    "  with a continuation",
    "  - [X] nested done",
    "- plain item",
    "",
    "#+BEGIN_EXAMPLE",
    "  raw text * not a headline",
    "#+END_EXAMPLE",
    "",
    "| x | y |",
    "| 1 | 2 |",
    "",
  ].join("\n");
  const tree = parseOrg(text);
  expect(renderToText(tree)).toEqual(text);

  const check = (n: ParseTree) => {
    for (const child of n.children ?? []) {
      if (child.type) {
        expect(child.from!).toBeGreaterThanOrEqual(n.from!);
        expect(child.to!).toBeLessThanOrEqual(n.to!);
        check(child);
      }
    }
  };
  check(tree);
  expect(types(tree)).toContain("Task");
});

test("Empty and whitespace-only documents parse without throwing", () => {
  expect(renderToText(parseOrg(""))).toEqual("");
  expect(renderToText(parseOrg("\n\n\n"))).toEqual("\n\n\n");
});

test("Denote links parse into an identifier and a description", () => {
  // Verbatim from github.com/l-o-l-h/law.
  const text = "See [[denote:20240203T132026][sc 105 Wash.2d 39 Munden]].\n";
  const tree = parseOrg(text);
  const link = findNodeOfType(tree, "DenoteLink")!;
  expect(renderToText(link)).toEqual(
    "[[denote:20240203T132026][sc 105 Wash.2d 39 Munden]]",
  );
  expect(findNodeOfType(link, "DenoteLinkTarget")!.children![0].text).toEqual(
    "denote:20240203T132026",
  );
  expect(renderToText(findNodeOfType(link, "OrgLinkDescription")!)).toEqual(
    "sc 105 Wash.2d 39 Munden",
  );
});

test("A Denote link without a description still parses", () => {
  const tree = parseOrg("[[denote:20240203T132026]]\n");
  const link = findNodeOfType(tree, "DenoteLink")!;
  expect(findNodeOfType(link, "DenoteLinkTarget")!.children![0].text).toEqual(
    "denote:20240203T132026",
  );
  expect(findNodeOfType(link, "OrgLinkDescription")).toBeNull();
});

test("Non-Denote org links are their own node type", () => {
  const tree = parseOrg(
    "[[https://example.com][Example]] and [[file:a.org]]\n",
  );
  expect(countOfType(tree, "OrgLink")).toEqual(2);
  expect(countOfType(tree, "DenoteLink")).toEqual(0);
  const first = collectNodesOfType(tree, "OrgLink")[0];
  expect(findNodeOfType(first, "OrgLinkTarget")!.children![0].text).toEqual(
    "https://example.com",
  );
});

test("Links round-trip and do not swallow surrounding text", () => {
  const text = "a [[denote:20240203T132026][x]] b [[https://e.com]] c\n";
  expect(renderToText(parseOrg(text))).toEqual(text);
});

test("Emphasis inside a link description is parsed", () => {
  const tree = parseOrg("[[denote:20240203T132026][a *bold* one]]\n");
  expect(countOfType(tree, "StrongEmphasis")).toEqual(1);
});

test("Malformed brackets are left as plain text", () => {
  for (const text of ["[[unclosed\n", "[[a][b\n", "[[]]\n"]) {
    const tree = parseOrg(text);
    expect(
      countOfType(tree, "OrgLink") + countOfType(tree, "DenoteLink"),
    ).toEqual(0);
    expect(renderToText(tree)).toEqual(text);
  }
});

test("Space Lua directives parse inside Org text", () => {
  const text = "Total: ${1 + 2} done\n";
  const tree = parseOrg(text);
  const directive = findNodeOfType(tree, "LuaDirective")!;
  expect(renderToText(directive)).toEqual("${1 + 2}");
  expect(
    renderToText(findNodeOfType(directive, "LuaExpressionDirective")!),
  ).toEqual("1 + 2");
  expect(renderToText(tree)).toEqual(text);
});

test("A directive containing braces is balanced, not cut short", () => {
  const text = "${template.each(x, {a = 1})}\n";
  const tree = parseOrg(text);
  expect(renderToText(findNodeOfType(tree, "LuaDirective")!)).toEqual(
    "${template.each(x, {a = 1})}",
  );
});

test("A multi-line query directive is one node", () => {
  const text = "${query[[\n  from d = tags.denote\n  limit 5\n]]}\n";
  const tree = parseOrg(text);
  expect(renderToText(findNodeOfType(tree, "LuaDirective")!)).toEqual(
    "${query[[\n  from d = tags.denote\n  limit 5\n]]}",
  );
});

test("An unbalanced ${ is left as plain text", () => {
  const text = "${unclosed\n";
  expect(countOfType(parseOrg(text), "LuaDirective")).toEqual(0);
  expect(renderToText(parseOrg(text))).toEqual(text);
});
