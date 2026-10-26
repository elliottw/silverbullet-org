import { expect, test } from "vitest";
import {
  defaultTodoKeywords,
  mergeTodoKeywords,
  parseHeadlineTodo,
  parseTodoSequence,
} from "./org_todo.ts";

test("A sequence splits at the bar", () => {
  expect(parseTodoSequence("TODO NEXT WAITING | DONE CANCELLED")).toEqual({
    notDone: ["TODO", "NEXT", "WAITING"],
    done: ["DONE", "CANCELLED"],
  });
  // No bar: Org closes on the last word.
  expect(parseTodoSequence("TODO DONE")).toEqual({
    notDone: ["TODO"],
    done: ["DONE"],
  });
  expect(parseTodoSequence("TODO NEXT HOLD DONE")).toEqual({
    notDone: ["TODO", "NEXT", "HOLD"],
    done: ["DONE"],
  });
  // Fast-access keys are not part of the keyword.
  expect(parseTodoSequence("TODO(t) WAIT(w) | DONE(d)")).toEqual({
    notDone: ["TODO", "WAIT"],
    done: ["DONE"],
  });
  expect(parseTodoSequence("   ")).toEqual({ notDone: [], done: [] });
});

test("Several sequences accumulate, and done wins", () => {
  expect(
    mergeTodoKeywords([
      { notDone: ["TODO"], done: ["DONE"] },
      { notDone: ["NEXT", "TODO"], done: ["CANCELLED"] },
    ]),
  ).toEqual({ notDone: ["TODO", "NEXT"], done: ["DONE", "CANCELLED"] });
  // A word listed on both sides is a mistake; closing is the stronger claim.
  expect(
    mergeTodoKeywords([{ notDone: ["HOLD"], done: [] }, { notDone: [], done: ["HOLD"] }]),
  ).toEqual({ notDone: [], done: ["HOLD"] });
});

test("A headline reads as a task only when its first word is a keyword", () => {
  expect(parseHeadlineTodo("TODO Buy milk")).toEqual({
    keyword: "TODO",
    done: false,
    text: "Buy milk",
    priority: undefined,
    tags: [],
  });
  expect(parseHeadlineTodo("DONE Buy milk")?.done).toBe(true);
  // The guard that keeps prose out: a capitalised first word is not a state.
  expect(parseHeadlineTodo("API design")).toBeUndefined();
  expect(parseHeadlineTodo("Todo list for later")).toBeUndefined();
  // Not a keyword under the default set, but one under a file's own.
  expect(parseHeadlineTodo("HOLD Wrap-up event")).toBeUndefined();
  expect(
    parseHeadlineTodo("HOLD Wrap-up event", {
      notDone: ["TODO", "HOLD"],
      done: ["DONE"],
    })?.keyword,
  ).toEqual("HOLD");
});

test("Tags and priority come off the text, and are kept", () => {
  expect(
    parseHeadlineTodo("TODO gas data from peoples          :Inbox:"),
  ).toEqual({
    keyword: "TODO",
    done: false,
    text: "gas data from peoples",
    priority: undefined,
    tags: ["Inbox"],
  });
  // Several tags, casing as written -- Org is case-sensitive about them.
  expect(parseHeadlineTodo("TODO Read the draft :struggle:2024hjr:")?.tags)
    .toEqual(["struggle", "2024hjr"]);
  const urgent = parseHeadlineTodo("TODO [#A] Call the clinic :out:");
  expect(urgent?.priority).toEqual("A");
  expect(urgent?.text).toEqual("Call the clinic");
  expect(urgent?.tags).toEqual(["out"]);
  // A headline that is only a keyword and tags has no text left.
  expect(parseHeadlineTodo("TODO :Inbox:")).toEqual({
    keyword: "TODO",
    done: false,
    text: "",
    priority: undefined,
    tags: ["Inbox"],
  });
  // A bare keyword is a task with nothing said yet.
  expect(parseHeadlineTodo("TODO")?.text).toEqual("");
  // A time range is not a tag string.
  expect(parseHeadlineTodo("TODO Meet at 10:30:")?.tags).toEqual([]);
});

test("The default set is Org's own", () => {
  expect(defaultTodoKeywords).toEqual({ notDone: ["TODO"], done: ["DONE"] });
});
