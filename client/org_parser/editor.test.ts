import {
  ensureSyntaxTree,
  foldable,
  highlightingFor,
  syntaxTree,
} from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { highlightTree } from "@lezer/highlight";
import { expect, test } from "vitest";
import highlightStyles from "../style.ts";
import { orgLanguage } from "./parser.ts";

// These exercise the CodeMirror side of the parser: the Lezer Parser contract,
// the Language wrapper, the styleTags props and the outline fold service.

function stateFor(doc: string): EditorState {
  const state = EditorState.create({ doc, extensions: [orgLanguage] });
  // Force a full parse; the editor would otherwise parse lazily by viewport.
  ensureSyntaxTree(state, doc.length, 5000);
  return state;
}

function nodeNamesAt(state: EditorState, pos: number): string[] {
  const names: string[] = [];
  for (
    let node = syntaxTree(state).resolveInner(pos, 1);
    node;
    node = node.parent!
  ) {
    names.push(node.name);
  }
  return names;
}

test("The Org language produces a syntax tree in a CodeMirror state", () => {
  const doc = "* Headline\n- [ ] a task\n";
  const state = stateFor(doc);
  const tree = syntaxTree(state);
  expect(tree.length).toEqual(doc.length);
  expect(tree.topNode.name).toEqual("Document");

  expect(nodeNamesAt(state, doc.indexOf("Headline"))).toContain("ATXHeading1");
  expect(nodeNamesAt(state, doc.indexOf("a task"))).toEqual(
    expect.arrayContaining(["Task", "ListItem", "BulletList", "Document"]),
  );
});

test("The parser honours stopAt so CodeMirror can time-slice it", () => {
  const doc = "* One\n* Two\n* Three\n";
  const parse = orgLanguage.parser.startParse(doc);
  parse.stopAt(6);
  const tree = parse.advance()!;
  expect(parse.parsedPos).toEqual(6);
  expect(tree.length).toEqual(6);
});

test("Headlines fold their whole subtree", () => {
  const doc = "* One\nbody\n** Under one\nmore\n* Two\ntail\n";
  const state = stateFor(doc);

  const firstLine = state.doc.line(1);
  const range = foldable(state, firstLine.from, firstLine.to);
  expect(range).toBeTruthy();
  expect(range!.from).toEqual(firstLine.to);
  // Folds up to (not including) the next same-level headline.
  expect(state.doc.sliceString(range!.from, range!.to).trim()).toEqual(
    "body\n** Under one\nmore",
  );

  // The last headline folds to the end of the document.
  const lastHeadline = state.doc.line(5);
  const tailRange = foldable(state, lastHeadline.from, lastHeadline.to);
  expect(state.doc.sliceString(tailRange!.from, tailRange!.to).trim()).toEqual(
    "tail",
  );
});

test("A paragraph line is not foldable", () => {
  const state = stateFor("* One\nbody\n");
  const line = state.doc.line(2);
  expect(foldable(state, line.from, line.to)).toBeNull();
});

test("Org nodes resolve to SilverBullet's existing highlight classes", () => {
  const doc = "* Headline\nSome *bold* text.\n";
  const state = stateFor(doc);
  const spans: [string, string][] = [];
  highlightTree(syntaxTree(state), highlightStyles(), (from, to, cls) => {
    spans.push([doc.slice(from, to), cls]);
  });
  expect(spans).toEqual([
    // Markers get the same "meta" treatment Markdown's do, which is what lets
    // hide_mark.ts blend them away in live preview.
    ["*", "sb-h1 sb-meta"],
    [" Headline", "sb-h1"],
    ["*", "sb-strong sb-meta"],
    ["bold", "sb-strong"],
    ["*", "sb-strong sb-meta"],
  ]);
});

test("highlightingFor resolves through the Org node set", () => {
  const state = stateFor("* Headline\n");
  const cls = highlightingFor(state, [], undefined);
  // Just asserting the call path doesn't throw with an Org language active.
  expect(cls === null || typeof cls === "string").toBe(true);
});
