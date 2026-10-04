import { expect, test } from "vitest";
import { mergeTags } from "./zotero_sync.ts";

const merge = (
  noteKeywords: string[],
  zoteroTags: string[],
  shadow: string[],
  push = true,
) => mergeTags({ noteKeywords, zoteroTags, shadow, push });

test("a tag added in Zotero becomes a keyword", () => {
  const out = merge(["landbank"], ["Landbank", "RTK"], ["landbank"]);
  expect(out.keywords).toEqual(["landbank", "rtk"]);
  expect(out.tags).toEqual(["Landbank", "RTK"]);
  expect(out.shadow).toEqual(["landbank", "rtk"]);
  expect(out.noteChanged).toBe(true);
  expect(out.zoteroChanged).toBe(false);
});

test("a tag removed in Zotero removes the keyword", () => {
  const out = merge(["landbank", "rtk"], ["Landbank"], ["landbank", "rtk"]);
  expect(out.keywords).toEqual(["landbank"]);
  expect(out.noteChanged).toBe(true);
  expect(out.zoteroChanged).toBe(false);
});

test("a keyword added on the note is pushed as a tag", () => {
  const out = merge(["landbank", "solar"], ["Landbank"], ["landbank"]);
  expect(out.tags).toEqual(["Landbank", "solar"]);
  expect(out.keywords).toEqual(["landbank", "solar"]);
  expect(out.zoteroChanged).toBe(true);
  expect(out.noteChanged).toBe(false);
});

test("a keyword removed on the note removes the tag", () => {
  const out = merge(["landbank"], ["Landbank", "RTK"], ["landbank", "rtk"]);
  expect(out.tags).toEqual(["Landbank"]);
  expect(out.keywords).toEqual(["landbank"]);
  expect(out.zoteroChanged).toBe(true);
  expect(out.noteChanged).toBe(false);
});

test("Zotero's spelling is kept; a pushed keyword goes up as its slug", () => {
  const out = merge(["landbank", "cityplanning"], ["Land Bank"], ["landbank"]);
  // `Land Bank` slugs to `landbank`, so it is the same tag, not a second one.
  expect(out.tags).toEqual(["Land Bank", "cityplanning"]);
  expect(out.keywords).toEqual(["cityplanning", "landbank"]);
});

test("without push, the note takes Zotero's tags and keeps its own keywords", () => {
  const out = merge(
    ["landbank", "mine"],
    ["Landbank", "RTK"],
    ["landbank"],
    false,
  );
  expect(out.keywords).toEqual(["landbank", "mine", "rtk"]);
  // Nothing is written to Zotero, and the local keyword stays out of the
  // shadow so a later pass does not read it as a tag Zotero dropped.
  expect(out.tags).toEqual(["Landbank", "RTK"]);
  expect(out.shadow).toEqual(["landbank", "rtk"]);
  expect(out.zoteroChanged).toBe(false);
});

test("a local keyword survives repeated syncs", () => {
  let out = merge(["mine"], ["Landbank"], [], false);
  expect(out.keywords).toEqual(["landbank", "mine"]);
  out = merge(out.keywords, ["Landbank"], out.shadow, false);
  expect(out.keywords).toEqual(["landbank", "mine"]);
  expect(out.noteChanged).toBe(false);
});

test("nothing to do is nothing changed", () => {
  const out = merge(["landbank"], ["Landbank"], ["landbank"]);
  expect(out.noteChanged).toBe(false);
  expect(out.zoteroChanged).toBe(false);
});

test("a first sync adopts both sides", () => {
  const out = merge(["mine"], ["Landbank"], []);
  expect(out.keywords).toEqual(["landbank", "mine"]);
  expect(out.tags).toEqual(["Landbank", "mine"]);
  expect(out.shadow).toEqual(["landbank", "mine"]);
});
