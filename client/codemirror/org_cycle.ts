import { completionStatus } from "@codemirror/autocomplete";
import {
  foldable,
  foldedRanges,
  foldEffect,
  syntaxTree,
  unfoldEffect,
} from "@codemirror/language";
import type { EditorState, StateEffect } from "@codemirror/state";
import type { Command } from "@codemirror/view";
import { orgLanguage } from "../org_parser/parser.ts";

/**
 * Org's TAB cycling.
 *
 * `org-cycle` on a headline steps FOLDED → CHILDREN → SUBTREE, and
 * `org-shifttab` steps the whole buffer OVERVIEW → CONTENTS → SHOW ALL. The
 * state is derived from what is currently folded rather than stored, so the
 * cycle stays correct when folds are changed by other means.
 */

type Heading = {
  /** Start of the headline itself. */
  from: number;
  level: number;
  /** End of the headline's line — where a fold of its body begins. */
  bodyFrom: number;
  /** End of the whole subtree. */
  subtreeEnd: number;
  /** Start of the first child headline, or `subtreeEnd` when there is none. */
  firstChildFrom: number;
};

function headings(state: EditorState): Heading[] {
  const found: { from: number; level: number }[] = [];
  syntaxTree(state).iterate({
    enter: ({ name, from }) => {
      const match = /^ATXHeading(\d)$/.exec(name);
      if (match) {
        found.push({ from, level: +match[1] });
      }
    },
  });
  return found.map((heading, index) => {
    let subtreeEnd = state.doc.length;
    let firstChildFrom = -1;
    for (let next = index + 1; next < found.length; next++) {
      if (found[next].level <= heading.level) {
        subtreeEnd = found[next].from - 1;
        break;
      }
      if (firstChildFrom === -1) {
        firstChildFrom = found[next].from - 1;
      }
    }
    return {
      from: heading.from,
      level: heading.level,
      bodyFrom: state.doc.lineAt(heading.from).to,
      subtreeEnd: Math.max(subtreeEnd, state.doc.lineAt(heading.from).to),
      firstChildFrom:
        firstChildFrom === -1
          ? Math.max(subtreeEnd, state.doc.lineAt(heading.from).to)
          : firstChildFrom,
    };
  });
}

/**
 * Where a fold starting exactly at `from` ends, or undefined if there is none.
 *
 * The end matters: a headline that is FOLDED and one that is showing CHILDREN
 * both have a fold beginning right after their headline, and differ only in
 * whether it runs to the end of the subtree or stops at the first child.
 */
function foldEndAt(state: EditorState, from: number): number | undefined {
  let end: number | undefined;
  foldedRanges(state).between(from, from, (rangeFrom, rangeTo) => {
    if (rangeFrom === from) {
      end = rangeTo;
      return false;
    }
  });
  return end;
}

/** Whether a fold starting exactly at `from` is currently in place. */
function foldedAt(state: EditorState, from: number): boolean {
  return foldEndAt(state, from) !== undefined;
}

/** Unfolds every fold that starts within `[from, to]`. */
function unfoldWithin(
  state: EditorState,
  from: number,
  to: number,
): StateEffect<unknown>[] {
  const effects: StateEffect<unknown>[] = [];
  foldedRanges(state).between(from, to, (rangeFrom, rangeTo) => {
    if (rangeFrom >= from && rangeFrom <= to) {
      effects.push(unfoldEffect.of({ from: rangeFrom, to: rangeTo }));
    }
  });
  return effects;
}

function foldRange(from: number, to: number): StateEffect<unknown>[] {
  return to > from ? [foldEffect.of({ from, to })] : [];
}

/** The heading whose own line the cursor sits on, if any. */
function headingAtCursor(
  state: EditorState,
  headingList: Heading[],
): Heading | undefined {
  const line = state.doc.lineAt(state.selection.main.head);
  return headingList.find((heading) => heading.from === line.from);
}

/**
 * `org-cycle`: FOLDED → CHILDREN → SUBTREE on a headline, plain fold toggle on
 * a list item, and nothing at all anywhere else so TAB keeps its usual meaning.
 */
export const orgCycle: Command = (view) => {
  const { state } = view;
  if (!orgLanguage.isActiveAt(state, state.selection.main.head)) {
    return false;
  }
  // A completion in flight owns TAB.
  if (completionStatus(state) === "active") {
    return false;
  }

  const headingList = headings(state);
  const heading = headingAtCursor(state, headingList);
  if (!heading) {
    // `org-cycle-include-plain-lists`: on a list item, TAB folds it.
    const line = state.doc.lineAt(state.selection.main.head);
    const range = foldable(state, line.from, line.to);
    if (!range) {
      return false;
    }
    view.dispatch({
      effects: foldedAt(state, range.from)
        ? unfoldWithin(state, range.from, range.from)
        : foldRange(range.from, range.to),
    });
    return true;
  }

  const children = headingList.filter(
    (other) =>
      other.level === heading.level + 1 &&
      other.from > heading.from &&
      other.from <= heading.subtreeEnd,
  );

  const bodyFoldEnd = foldEndAt(state, heading.bodyFrom);
  // Folded outright: the fold swallows the children too.
  const isFolded =
    bodyFoldEnd !== undefined && bodyFoldEnd >= heading.subtreeEnd;
  const showingChildren =
    !isFolded &&
    children.length > 0 &&
    children.every((child) => foldedAt(state, child.bodyFrom));

  const effects = unfoldWithin(state, heading.bodyFrom, heading.subtreeEnd);
  if (!isFolded && !showingChildren) {
    // SUBTREE → FOLDED
    effects.push(...foldRange(heading.bodyFrom, heading.subtreeEnd));
  } else if (isFolded && children.length > 0) {
    // FOLDED → CHILDREN: child headlines back, their bodies folded. A childless
    // headline has no such state and goes straight to SUBTREE, as Org does.
    effects.push(...foldRange(heading.bodyFrom, heading.firstChildFrom));
    for (const child of children) {
      effects.push(...foldRange(child.bodyFrom, child.subtreeEnd));
    }
  }
  // CHILDREN → SUBTREE is the bare unfold above.
  view.dispatch({ effects });
  return true;
};

/** `org-shifttab`: OVERVIEW → CONTENTS → SHOW ALL across the whole document. */
export const orgGlobalCycle: Command = (view) => {
  const { state } = view;
  if (!orgLanguage.isActiveAt(state, state.selection.main.head)) {
    return false;
  }
  const headingList = headings(state);
  if (headingList.length === 0) {
    return false;
  }
  const topLevel = Math.min(...headingList.map((h) => h.level));
  const roots = headingList.filter((h) => h.level === topLevel);

  // OVERVIEW hides the sub-headlines, CONTENTS stops at the first child, so
  // again the two are told apart by where the fold ends rather than that one
  // exists.
  const inOverview =
    roots.length > 0 &&
    roots.every((h) => (foldEndAt(state, h.bodyFrom) ?? -1) >= h.subtreeEnd);
  const inContents =
    !inOverview && headingList.every((h) => foldedAt(state, h.bodyFrom));

  const effects = unfoldWithin(state, 0, state.doc.length);
  if (inOverview) {
    // OVERVIEW → CONTENTS: every headline visible, every body folded.
    for (const heading of headingList) {
      effects.push(...foldRange(heading.bodyFrom, heading.firstChildFrom));
    }
  } else if (!inContents) {
    // SHOW ALL → OVERVIEW: only the top-level headlines.
    for (const heading of roots) {
      effects.push(...foldRange(heading.bodyFrom, heading.subtreeEnd));
    }
  }
  // CONTENTS → SHOW ALL is the bare unfold above.
  view.dispatch({ effects });
  return true;
};
