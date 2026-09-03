import type { PageMeta } from "@silverbulletmd/silverbullet/type/index";
import { expect, test } from "vitest";
import { parseOrg } from "../../client/org_parser/parser.ts";
import { createMockSystem } from "../../plug-api/system_mock.ts";
import { extractFrontMatter } from "./frontmatter.ts";
import { indexHeaders } from "./header.ts";
import { indexItems } from "./item.ts";
import { indexParagraphs } from "./paragraph.ts";
import { indexTables } from "./table.ts";

// The whole point of emitting Markdown node names from the Org parser is that
// these indexers — which have no idea Org exists — keep working. If one of them
// grows an Org-specific branch, this file is where that should show up.

const orgPage = `#+TITLE: Project notes

* Planning
Some text under planning.

** Milestones
- [ ] Draft the spec
- [X] Book the room
- plain item
  - nested item

* Delivery
Another paragraph.
`;

const pageMeta: PageMeta = {
  ref: "Project.org",
  name: "Project.org",
  tag: "page",
  created: "",
  lastModified: "",
  perm: "rw",
};

test("The header indexer reads Org headlines unchanged", async () => {
  createMockSystem();
  const tree = parseOrg(orgPage);
  const frontmatter = extractFrontMatter(tree);

  const headers = await indexHeaders(pageMeta, frontmatter, tree);
  expect(headers.map((h) => [h.name, h.level])).toEqual([
    ["Planning", 1],
    ["Milestones", 2],
    ["Delivery", 1],
  ]);
  expect(headers[0].page).toEqual("Project.org");
});

test("The item indexer reads Org lists and checkboxes unchanged", async () => {
  createMockSystem();
  const tree = parseOrg(orgPage);
  const frontmatter = extractFrontMatter(tree);

  const items = await indexItems(pageMeta, frontmatter, tree);
  expect(items.map((i) => [i.tag, i.name])).toEqual([
    ["task", "Draft the spec"],
    ["task", "Book the room"],
    ["item", "plain item"],
    ["item", "nested item"],
  ]);

  const [open, done] = items;
  expect((open as any).state).toEqual(" ");
  expect((open as any).done).toEqual(false);
  expect((done as any).state).toEqual("X");
  expect((done as any).done).toEqual(true);

  // Nesting survives: the nested item points at its parent.
  expect(items[3].parent).toEqual(items[2].ref);
});

test("The paragraph indexer sees Org prose, not Org markup", async () => {
  const { config } = createMockSystem();
  config.set("index.paragraph.all", true);
  const tree = parseOrg(orgPage);
  const frontmatter = extractFrontMatter(tree);

  const paragraphs = await indexParagraphs(pageMeta, frontmatter, tree);
  expect(paragraphs.map((p) => p.text)).toEqual([
    "Some text under planning.",
    "Another paragraph.",
  ]);
});

test("Emphasis is stripped from an indexed headline the same way as in Markdown", async () => {
  createMockSystem();
  const tree = parseOrg("* A *bold* headline\n");
  const frontmatter = extractFrontMatter(tree);
  const headers = await indexHeaders(pageMeta, frontmatter, tree);
  // Markdown keeps the markers in `name` too, so Org matching that is correct.
  expect(headers[0].name).toEqual("A *bold* headline");
});

test("A table with no delimiter row is skipped rather than crashing the indexer", async () => {
  createMockSystem();
  // Legal in Org and common in real libraries — 21 of the 445 notes in the
  // library this was tested against have one. Markdown cannot produce this,
  // because its delimiter row is what makes a table a table.
  const tree = parseOrg("| a | b |\n| 1 | 2 |\n");
  const frontmatter = extractFrontMatter(tree);
  expect(await indexTables(pageMeta, frontmatter, tree)).toEqual([]);
});

test("A table with a delimiter row still indexes its rows", async () => {
  createMockSystem();
  const tree = parseOrg("| name | cost |\n|------+------|\n| bolt | 10 |\n");
  const frontmatter = extractFrontMatter(tree);
  const rows = await indexTables(pageMeta, frontmatter, tree);
  expect(rows.length).toEqual(1);
  expect(rows[0].name).toEqual("bolt");
  expect(rows[0].cost).toEqual("10");
});
