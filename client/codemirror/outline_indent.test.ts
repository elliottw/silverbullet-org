import { expect, test } from "vitest";
import { assignOutlineDepths, type Heading } from "./outline_indent.ts";

const depths = (headings: Heading[], lines: number) =>
  Object.fromEntries(assignOutlineDepths(headings, lines));

test("a heading stands one step out from the text it owns", () => {
  // 1 #+title   2 blank   3 * Alpha   4 body   5 ** Beta   6 body
  expect(
    depths(
      [
        { line: 3, level: 1 },
        { line: 5, level: 2 },
      ],
      6,
    ),
  ).toEqual({
    // Front matter and preamble stay flush left: there is no section yet.
    3: 0, // the level-1 heading itself
    4: 1, // its body, one step in
    5: 1, // the level-2 heading, level 1's depth
    6: 2, // and its body
  });
});

test("coming back out of a deep section returns to the shallower depth", () => {
  expect(
    depths(
      [
        { line: 1, level: 1 },
        { line: 3, level: 3 },
        { line: 5, level: 1 },
      ],
      6,
    ),
  ).toEqual({ 1: 0, 2: 1, 3: 2, 4: 3, 5: 0, 6: 1 });
});

test("two headings on consecutive lines each get their own depth", () => {
  expect(
    depths(
      [
        { line: 1, level: 1 },
        { line: 2, level: 2 },
      ],
      2,
    ),
  ).toEqual({ 1: 0, 2: 1 });
});

test("a document with no headings is left flush left", () => {
  expect(depths([], 40)).toEqual({});
});

test("text before the first heading is not indented", () => {
  expect(depths([{ line: 4, level: 2 }], 5)).toEqual({ 4: 1, 5: 2 });
});
