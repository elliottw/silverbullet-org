/**
 * Pre-computed line data for efficient repeated snippet extraction from the same text.
 */
export type LineIndex = {
  lines: string[];
  // Cumulative character offsets: lineOffsets[i] = char position where line i starts
  lineOffsets: number[];
};

/**
 * Build a LineIndex for a given text, allowing multiple extractSnippet calls
 * without repeatedly splitting the text.
 */
export function buildLineIndex(text: string): LineIndex {
  const lines = text.split("\n");
  const lineOffsets: number[] = new Array(lines.length);
  let offset = 0;
  for (let i = 0; i < lines.length; i++) {
    lineOffsets[i] = offset;
    offset += lines[i].length + 1; // +1 for the newline
  }
  return { lines, lineOffsets };
}

/**
 * Extracts a snippet around a given index in markdown text based on indentation rules.
 *
 * If the line at the given index is indented, the snippet will include:
 * - The entire line containing the index
 * - All subsequent lines with indentation level greater than the current line
 *
 * @param pageName - The name of the page
 * @param textOrLineIndex - The full markdown text or a pre-computed LineIndex
 * @param index - The position within the text where extraction should be centered
 * @param maxLines - Maximum number of lines to include in the snippet (default: 10)
 * @returns The extracted snippet
 */
export function extractSnippet(
  pageName: string,
  textOrLineIndex: string | LineIndex,
  index: number,
  maxLines: number = 10,
): string {
  let lines: string[];
  let lineOffsets: number[];

  if (typeof textOrLineIndex === "string") {
    const li = buildLineIndex(textOrLineIndex);
    lines = li.lines;
    lineOffsets = li.lineOffsets;
  } else {
    lines = textOrLineIndex.lines;
    lineOffsets = textOrLineIndex.lineOffsets;
  }

  // Binary search for the target line
  let lo = 0;
  let hi = lines.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineOffsets[mid] <= index) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  const targetLineIndex = lo;

  const targetLine = lines[targetLineIndex];
  const targetIndent = getIndentationLevel(targetLine);

  // Start with the target line
  const snippetLines = [targetLine.substring(targetIndent)];

  // Add all subsequent lines that have greater indentation than the target line
  for (let i = targetLineIndex + 1; i < lines.length; i++) {
    let line = lines[i];
    const lineIndent = getIndentationLevel(line);

    if (snippetLines.length >= maxLines) {
      snippetLines.push("...");
      break;
    }

    // Stop if we hit an empty line
    if (line.trim() === "") {
      break;
    }

    // Stop if we hit a line with indentation equal to or less than the target line
    if (lineIndent <= targetIndent) {
      break;
    }

    // Find tasks that don't have a page reference, and add one
    const taskMatch = line.match(/^(\s*)([*-]\s+\[[^\]]+\]\s+)([^[][^[].+)$/);
    if (taskMatch) {
      const pos = lineOffsets[i] + taskMatch[1].length;
      line = `${taskMatch[1] + taskMatch[2]}[[${pageName}@${pos}]] ${taskMatch[3]}`;
    }
    snippetLines.push(line.substring(targetIndent));
  }

  let result = snippetLines.join("\n");

  // Specific cases: because headers look bad in snippets, let's strip those leading `#`
  result = result.replace(/^(#+)\s+/, "");

  // A `![[transclusion]]` must not survive into a snippet: consumers render
  // snippets through pipelines that expand transclusions, which would inline
  // the entire target page into what is meant to be a one-glance preview --
  // for a linked-mentions snippet, that is the very page the widget is on.
  // Show it as a plain link instead.
  result = result.replaceAll("![[", "[[");

  return result;
}

/**
 * Gets the indentation level of a line (number of leading spaces).
 *
 * @param line - The line to measure
 * @returns The number of leading spaces
 */
function getIndentationLevel(line: string): number {
  const match = line.match(/^( *)/);
  return match ? match[1].length : 0;
}

/**
 * The context an Org link sits in, the way org-roam's backlink buffer shows
 * it: the outline path above it (`Wednesday 20 August › Site visit`) and
 * the whole paragraph around it -- from the blank line or heading before to
 * the one after -- rather than the single line. A reader of the backlinks
 * then knows what was said without opening every page.
 */
export function orgLinkContext(
  lineIndex: LineIndex,
  index: number,
  maxLines = 8,
): { heading?: string; snippet: string } {
  const { lines, lineOffsets } = lineIndex;
  let lo = 0;
  let hi = lines.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineOffsets[mid] <= index) lo = mid;
    else hi = mid - 1;
  }
  const at = lo;
  const isHeading = (line: string) => /^\*+\s/.test(line);
  const isBlank = (line: string) => line.trim() === "";
  const level = (line: string) => /^(\*+)\s/.exec(line)?.[1].length ?? 0;

  // The outline path: the nearest heading of each level, innermost last.
  const crumbs: string[] = [];
  let want = Number.POSITIVE_INFINITY;
  for (let i = isHeading(lines[at]) ? at - 1 : at; i >= 0; i--) {
    const l = level(lines[i]);
    if (l && l < want) {
      crumbs.unshift(lines[i].replace(/^\*+\s+/, "").trim());
      want = l;
      if (l === 1) break;
    }
  }

  // The paragraph: contiguous non-blank lines around the link, headings
  // excluded, capped at maxLines with the link's line kept in view.
  let start = at;
  while (
    start > 0 &&
    !isBlank(lines[start - 1]) &&
    !isHeading(lines[start - 1])
  )
    start--;
  let end = at;
  while (
    end + 1 < lines.length &&
    !isBlank(lines[end + 1]) &&
    !isHeading(lines[end + 1])
  )
    end++;
  if (end - start + 1 > maxLines) {
    const before = Math.min(at - start, Math.floor(maxLines / 2));
    start = at - before;
    end = Math.min(end, start + maxLines - 1);
  }
  const snippet = lines
    .slice(start, end + 1)
    .map((l) => (isHeading(l) ? l.replace(/^\*+\s+/, "") : l))
    .join("\n")
    .trim();
  return {
    ...(crumbs.length ? { heading: crumbs.join(" › ") } : {}),
    snippet: snippet || lines[at].trim(),
  };
}
