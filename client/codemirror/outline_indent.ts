import type { Range } from "@codemirror/state";
import { Decoration } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
import { decoratorStateField } from "./util.ts";

/**
 * `org-indent-mode`: an outline laid out by indentation rather than by type
 * size.
 *
 * A heading sits one step in from its parent and the text under it one step
 * further, so depth is read off the left edge instead of off the font. Size
 * then stays constant down the whole document and weight carries the
 * hierarchy -- which is how a code editor shows structure, and it keeps a
 * level-four heading from looking like a mistake next to a level-one.
 *
 * Every line gets a depth, not just headings: that is what makes the
 * indentation an outline rather than a run of differently-placed titles, and
 * it is what gives the guide bars something continuous to paint against.
 */
export type Heading = { line: number; level: number };

/**
 * The indent depth of every line, given the headings in document order.
 *
 * Pure, and separate from the tree walk that finds the headings, because this
 * is the whole of the feature's logic -- the stylesheet only multiplies it by
 * a step -- and it is worth testing without a CodeMirror language attached.
 */
export function assignOutlineDepths(
  headings: Heading[],
  lineCount: number,
): Map<number, number> {
  const depths = new Map<number, number>();
  if (headings.length === 0) {
    return depths;
  }
  let next = 0;
  // The depth in force below the heading last seen; 0 until the first one, so
  // front matter and a preamble stay flush left.
  let under = 0;
  for (let line = 1; line <= lineCount; line++) {
    while (next < headings.length && headings[next].line === line) {
      // A heading stands one step out from the text it owns, so a section and
      // its title do not share a left edge.
      depths.set(line, headings[next].level - 1);
      under = headings[next].level;
      next++;
    }
    if (!depths.has(line) && under > 0) {
      depths.set(line, under);
    }
  }
  return depths;
}

export function outlineDepths(state: EditorState): Map<number, number> {
  const headings: Heading[] = [];
  syntaxTree(state).iterate({
    enter: ({ type, from }) => {
      const match = /^ATXHeading([1-6])$/.exec(type.name);
      if (match) {
        headings.push({
          line: state.doc.lineAt(from).number,
          level: +match[1],
        });
      }
    },
  });
  return assignOutlineDepths(headings, state.doc.lines);
}

/**
 * Contributes `--sb-outline-indent` per line, and `--sb-outline-depth` so the
 * guide bars know how many to draw.
 *
 * Kept out of `--sb-indent`, which the negative `text-indent` cancels so that
 * list markers hang: an outline indent has to move the first row too, or a
 * heading would sit flush left under its own indented body.
 */
export function outlineIndentPlugin() {
  return decoratorStateField((state) => {
    const widgets: Range<Decoration>[] = [];
    for (const [line, depth] of outlineDepths(state)) {
      if (depth <= 0) continue;
      widgets.push(
        Decoration.line({
          attributes: {
            style: `--sb-outline-depth:${depth}`,
          },
        }).range(state.doc.line(line).from),
      );
    }
    return Decoration.set(widgets, true);
  });
}
