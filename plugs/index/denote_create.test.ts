import { expect, test } from "vitest";
import { createsDenoteNote, parseKeywordInput } from "./denote.ts";

test("Keywords split on commas, as Denote's completing-read-multiple does", () => {
  // Whitespace does *not* separate keywords: a multi-word keyword is joined by
  // sluggification, which is why the real library contains `genuineissuetrial`.
  expect(parseKeywordInput("Case Law, trust")).toEqual(["caselaw", "trust"]);
  expect(parseKeywordInput("genuine issue trial")).toEqual([
    "genuineissuetrial",
  ]);
  expect(parseKeywordInput("case,law")).toEqual(["case", "law"]);
  expect(parseKeywordInput("  case ,  law  ")).toEqual(["case", "law"]);
});

test("Keywords are de-duplicated and sorted", () => {
  expect(parseKeywordInput("law, case, law")).toEqual(["case", "law"]);
  expect(parseKeywordInput("Law, CASE")).toEqual(["case", "law"]);
});

test("An empty answer means no keywords", () => {
  expect(parseKeywordInput("")).toEqual([]);
  expect(parseKeywordInput("   ")).toEqual([]);
  expect(parseKeywordInput(", ,")).toEqual([]);
});

const aNote = "20240125T164237--court-costs__costs_law.org";

test("Creating from a Denote note mints a Denote note", () => {
  // The bug this replaced: the picker's create row navigated to the phrase,
  // which in a Denote library made `Some New Note.md` -- no identifier, outside
  // the naming scheme, unreachable by every `denote:` link.
  expect(createsDenoteNote("Some New Note", aNote)).toBe(true);
  expect(createsDenoteNote("  Some New Note  ", aNote)).toBe(true);
});

test("Creating from an ordinary page is left alone", () => {
  // A space can hold both, and a stock Markdown space must not change.
  expect(createsDenoteNote("Some New Note", "Library/Std/Config.md")).toBe(
    false,
  );
  expect(createsDenoteNote("Some New Note", "")).toBe(false);
});

test("A phrase naming a file is taken literally", () => {
  // Denote is flat and derives the name from the title, so a path or an
  // extension means the phrase was meant as a file name.
  expect(createsDenoteNote("notes/scratch", aNote)).toBe(false);
  expect(createsDenoteNote("scratch.md", aNote)).toBe(false);
  expect(createsDenoteNote("scratch.org", aNote)).toBe(false);
  expect(createsDenoteNote("scratch.TXT", aNote)).toBe(false);
  // A title ending in something dot-like is still a title.
  expect(createsDenoteNote("Rule 5.2", aNote)).toBe(true);
});

test("An empty phrase creates nothing", () => {
  expect(createsDenoteNote("", aNote)).toBe(false);
  expect(createsDenoteNote("   ", aNote)).toBe(false);
});
