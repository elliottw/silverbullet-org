import type { PageMeta } from "@silverbulletmd/silverbullet/type/index";
import { expect, test } from "vitest";
import { parseOrg } from "../../client/org_parser/parser.ts";
import { parseMarkdown } from "../../client/markdown_parser/parser.ts";
import { createMockSystem } from "../../plug-api/system_mock.ts";
import { extractFrontMatter } from "./frontmatter.ts";
import { indexOrgTodos } from "./org_todo.ts";
import { indexItems } from "./item.ts";

// Shaped after the real library this was built for: beorg writes headline
// TODOs with trailing Org tags, and a home page asking `index.tasks()` saw
// none of them.
const orgPage = `#+TITLE: Reminders

* TODO gas data from peoples                                          :Inbox:
* TODO Read the draft :struggle:2024hjr:
* DONE Book the room
* HOLD Wrap-up event
* Planning
Some prose.
** TODO [#A] Call the clinic :out:
** API design
- [ ] a checkbox, which item.ts owns
`;

const pageMeta: PageMeta = {
  ref: "reminders.org",
  name: "reminders.org",
  tag: "page",
  created: "",
  lastModified: "2026-10-26T12:00:00.000Z",
  perm: "rw",
};

async function todosOf(text: string, meta: PageMeta = pageMeta) {
  const tree = parseOrg(text);
  return await indexOrgTodos(meta, extractFrontMatter(tree), tree);
}

test("A headline TODO indexes as a task, like a checkbox does", async () => {
  createMockSystem();
  const tasks = await todosOf(orgPage);

  expect(tasks.map((t) => [t.state, t.name, t.done])).toEqual([
    ["TODO", "gas data from peoples", false],
    ["TODO", "Read the draft", false],
    ["DONE", "Book the room", true],
    ["TODO", "Call the clinic", false],
  ]);
  // `HOLD` is not a keyword under Org's default set, and `API design` is
  // prose: neither becomes a task.
  expect(tasks.map((t) => t.name)).not.toContain("Wrap-up event");
  expect(tasks.map((t) => t.name)).not.toContain("design");
  // The tag `index.tasks()` asks for.
  expect(new Set(tasks.map((t) => t.tag))).toEqual(new Set(["task"]));
});

test("Org's trailing tags and priority come through as fields", async () => {
  createMockSystem();
  const tasks = await todosOf(orgPage);
  expect(tasks[0].tags).toEqual(["Inbox"]);
  expect(tasks[1].tags).toEqual(["struggle", "2024hjr"]);
  expect(tasks[2].tags).toEqual([]);
  const urgent = tasks[3];
  expect(urgent.priority).toEqual("A");
  expect(urgent.tags).toEqual(["out"]);
  expect(urgent.level).toEqual(2);
});

test("Each task carries what a home-page query orders and links by", async () => {
  createMockSystem();
  const [first] = await todosOf(orgPage);
  expect(first.page).toEqual("reminders.org");
  expect(first.pageLastModified).toEqual("2026-10-26T12:00:00.000Z");
  expect(first.ref).toEqual(`reminders.org@${first.pos}`);
  expect(first.range).toEqual([first.pos, first.toPos]);
});

test("A file's own #+TODO: sequence decides what counts", async () => {
  createMockSystem();
  const tasks = await todosOf(`#+TODO: TODO NEXT HOLD | DONE CANCELLED

* HOLD Wrap-up event
* NEXT Email the board
* CANCELLED Old plan
* TODO Still ordinary
`);
  expect(tasks.map((t) => [t.state, t.done])).toEqual([
    ["HOLD", false],
    ["NEXT", false],
    ["CANCELLED", true],
    ["TODO", false],
  ]);
});

test("The space can set the keywords for files that declare none", async () => {
  const { config } = createMockSystem();
  config.set("org.todoKeywords", "TODO HOLD | DONE");
  const tasks = await todosOf(orgPage);
  // HOLD now counts, and nothing else changes.
  expect(tasks.map((t) => t.state)).toEqual([
    "TODO",
    "TODO",
    "DONE",
    "HOLD",
    "TODO",
  ]);
});

test("A Markdown heading that opens with the word TODO is still a heading", async () => {
  createMockSystem();
  const text = `# TODO later\n\n## DONE already\n`;
  const tree = parseMarkdown(text);
  const tasks = await indexOrgTodos(
    { ...pageMeta, name: "Notes.md", ref: "Notes.md" },
    extractFrontMatter(tree),
    tree,
  );
  expect(tasks).toEqual([]);
});

test("The checkbox indexer is left alone", async () => {
  createMockSystem();
  const tree = parseOrg(orgPage);
  const items = await indexItems(pageMeta, extractFrontMatter(tree), tree);
  // item.ts still sees exactly the one checkbox, and no headline.
  expect(items.map((i) => [i.tag, i.name])).toEqual([
    ["task", "a checkbox, which item.ts owns"],
  ]);
});
