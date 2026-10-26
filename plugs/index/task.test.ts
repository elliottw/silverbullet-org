import { parseMarkdown } from "../../client/markdown_parser/parser.ts";
import { createMockSystem } from "../../plug-api/system_mock.ts";
import { expect, test } from "vitest";
import { addParentPointers, renderToText } from "../../plug-api/lib/tree.ts";
import {
  completeStates,
  isTaskMarkerAt,
  removeCompletedTasksFromTree,
} from "./task.ts";

function removeCompleted(md: string): string {
  createMockSystem();
  const tree = parseMarkdown(md);
  addParentPointers(tree);
  removeCompletedTasksFromTree(tree, completeStates);
  return renderToText(tree);
}

test("removeCompletedTasks: flat list", () => {
  const input = `- [x] completed
- [ ] incomplete
`;
  const result = removeCompleted(input);
  expect(result).toEqual("- [ ] incomplete\n");
});

test("removeCompletedTasks: flat list, completed last", () => {
  const input = `- [ ] incomplete
- [x] completed
`;
  const result = removeCompleted(input);
  expect(result).toEqual("- [ ] incomplete\n");
});

test("removeCompletedTasks: flat list, all completed", () => {
  const input = `- [x] one
- [x] two
`;
  const result = removeCompleted(input);
  expect(result).toEqual("");
});

test("removeCompletedTasks: nested list, completed has sibling", () => {
  const input = `- [ ] parent item
  - [x] completed nested
  - [ ] incomplete nested
`;
  const result = removeCompleted(input);
  expect(result).toEqual("- [ ] parent item\n  - [ ] incomplete nested\n");
});

test("removeCompletedTasks: nested list, only nested item completed", () => {
  const input = `- [ ] parent item
  - [x] only nested item
- [ ] sibling item
`;
  const result = removeCompleted(input);
  expect(result).toEqual("- [ ] parent item\n- [ ] sibling item\n");
});

test("removeCompletedTasks: nested list, all nested completed", () => {
  const input = `- [ ] parent item
  - [x] nested completed one
  - [x] nested completed two
- [ ] sibling item
`;
  const result = removeCompleted(input);
  expect(result).toEqual("- [ ] parent item\n- [ ] sibling item\n");
});

test("removeCompletedTasks: mixed flat and nested", () => {
  const input = `- [x] flat completed
- [ ] flat incomplete
  - [x] nested completed
  - [ ] nested incomplete
`;
  const result = removeCompleted(input);
  expect(result).toEqual("- [ ] flat incomplete\n  - [ ] nested incomplete\n");
});

test("removeCompletedTasks: uppercase X treated as completed", () => {
  const input = `- [X] completed uppercase
- [ ] incomplete
`;
  const result = removeCompleted(input);
  expect(result).toEqual("- [ ] incomplete\n");
});

test("removeCompletedTasks: no completed tasks, no change", () => {
  const input = `- [ ] one
- [ ] two
`;
  const result = removeCompleted(input);
  expect(result).toEqual(input);
});

// A task ref carries a position, and the state used to be confirmed by
// reading it at a fixed offset from there. An Org headline two levels deep
// puts its keyword at exactly that offset, so such a ref passed the check and
// the keyword was rewritten as if it were a checkbox.
test("isTaskMarkerAt: a Markdown task marker is one", () => {
  expect(isTaskMarkerAt("* [ ] a thing", 0, " ")).toBe(true);
  expect(isTaskMarkerAt("* [x] a thing", 0, "x")).toBe(true);
  expect(isTaskMarkerAt("* [TODO] a thing", 0, "TODO")).toBe(true);
  const indented = "text\n* [TODO] a thing";
  expect(isTaskMarkerAt(indented, 5, "TODO")).toBe(true);
});

test("isTaskMarkerAt: an Org headline is not, at any depth", () => {
  // The level-2 case is the one that slipped through: chars 3-7 spell TODO.
  expect(isTaskMarkerAt("** TODO Call the clinic", 0, "TODO")).toBe(false);
  expect(isTaskMarkerAt("* TODO gas data from peoples", 0, "TODO")).toBe(false);
  expect(isTaskMarkerAt("*** DONE Book the room", 0, "DONE")).toBe(false);
});

test("isTaskMarkerAt: a stale ref pointing at prose is not", () => {
  expect(isTaskMarkerAt("just some words here", 0, " ")).toBe(false);
  expect(isTaskMarkerAt("* [ ] a thing", 99, " ")).toBe(false);
  // Right brackets, wrong state: the ref is out of date.
  expect(isTaskMarkerAt("* [x] a thing", 0, " ")).toBe(false);
});
