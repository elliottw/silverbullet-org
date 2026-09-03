import { foldService, Language, syntaxTree } from "@codemirror/language";
import {
  type Input,
  Parser,
  parseMixed,
  type ParseWrapper,
  type PartialParse,
  type SyntaxNode,
  Tree,
  type TreeFragment,
} from "@lezer/common";
import type { ParseTree } from "@silverbulletmd/silverbullet/lib/tree";
import { lezerToParseTree } from "../markdown_parser/parse_tree.ts";
import { orgLanguageFacet, orgNodeSet, orgNodeType } from "./node_types.ts";

/**
 * The parser's own intermediate representation: a plain tree of absolute source
 * ranges. It is converted to a Lezer {@link Tree} for CodeMirror and, through
 * `lezerToParseTree`, to the {@link ParseTree} the rest of SilverBullet speaks.
 */
export type OrgNode = {
  name: string;
  from: number;
  to: number;
  children: OrgNode[];
};

type Line = { text: string; from: number };

function node(
  name: string,
  from: number,
  to: number,
  children: OrgNode[] = [],
): OrgNode {
  return { name, from, to, children };
}

// ---------------------------------------------------------------------------
// Line classification
// ---------------------------------------------------------------------------

const headlineRegex = /^(\*+)([ \t]+)(.*)$/;
const blockBeginRegex =
  /^([ \t]*)(#\+begin_)([a-zA-Z][a-zA-Z0-9-]*)[ \t]*(.*)$/i;
const blockEndRegex = /^([ \t]*)(#\+end_)([a-zA-Z][a-zA-Z0-9-]*)[ \t]*$/i;
// Org dynamic blocks: `#+BEGIN: name :param value` ... `#+END:`. The colon is
// what separates them from `#+BEGIN_SRC` style blocks.
const dynamicBlockBeginRegex =
  /^([ \t]*)(#\+begin:)[ \t]*([a-zA-Z][a-zA-Z0-9-]*)[ \t]*(.*)$/i;
const dynamicBlockEndRegex = /^([ \t]*)(#\+end:)[ \t]*$/i;
const keywordRegex = /^([ \t]*)(#\+)([a-zA-Z][a-zA-Z0-9_-]*)(:)([ \t]*)(.*)$/;
const commentRegex = /^([ \t]*)(#)(?:[ \t].*)?$/;
const horizontalRuleRegex = /^[ \t]*-{5,}[ \t]*$/;
const drawerBeginRegex = /^([ \t]*):([a-zA-Z][a-zA-Z0-9_-]*):[ \t]*$/;
const drawerEndRegex = /^[ \t]*:end:[ \t]*$/i;
const propertyRegex = /^([ \t]*)(:)([^:\s]+)(:)([ \t]*)(.*)$/;
const bulletRegex = /^([ \t]*)([-+]|\*)([ \t]+)/;
const orderedRegex = /^([ \t]*)(\d+[.)])([ \t]+)/;
const tableRowRegex = /^[ \t]*\|/;
const tableSeparatorRegex = /^[ \t]*\|[-+|: \t]*$/;
const checkboxRegex = /^\[([ xX-])\](?=[ \t]|$)/;

function isBlank(line: Line): boolean {
  return !line.text.trim();
}

function indentOf(line: Line): number {
  return /^[ \t]*/.exec(line.text)![0].length;
}

function lineEnd(line: Line): number {
  return line.from + line.text.length;
}

/** A headline's stars must sit in column 0, which is also what makes a `*` bullet unambiguous. */
function headlineMatch(line: Line): RegExpExecArray | null {
  return headlineRegex.exec(line.text);
}

type ListMarkMatch = {
  ordered: boolean;
  indent: number;
  markFrom: number;
  markTo: number;
  contentFrom: number;
};

function listMarkMatch(line: Line): ListMarkMatch | null {
  const ordered = orderedRegex.exec(line.text);
  const bullet = ordered ? null : bulletRegex.exec(line.text);
  const match = ordered ?? bullet;
  if (!match) {
    return null;
  }
  const [full, indent, mark] = match;
  // `* item` in column 0 is a headline, not a list.
  if (!ordered && mark === "*" && indent.length === 0) {
    return null;
  }
  return {
    ordered: !!ordered,
    indent: indent.length,
    markFrom: line.from + indent.length,
    markTo: line.from + indent.length + mark.length,
    contentFrom: line.from + full.length,
  };
}

function splitLines(text: string): Line[] {
  const lines: Line[] = [];
  let from = 0;
  for (const raw of text.split("\n")) {
    lines.push({ text: raw, from });
    from += raw.length + 1;
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Inline parsing
// ---------------------------------------------------------------------------

type EmphasisSpec = { name: string; mark: string; verbatim: boolean };

const emphasisMarkers: Record<string, EmphasisSpec> = {
  "*": { name: "StrongEmphasis", mark: "EmphasisMark", verbatim: false },
  "/": { name: "Emphasis", mark: "EmphasisMark", verbatim: false },
  _: { name: "OrgUnderline", mark: "EmphasisMark", verbatim: false },
  "+": { name: "Strikethrough", mark: "StrikethroughMark", verbatim: false },
  "=": { name: "InlineCode", mark: "CodeMark", verbatim: true },
  "~": { name: "InlineCode", mark: "CodeMark", verbatim: true },
};

// Org only opens emphasis after one of these (or at the start of the object),
// and only closes it before one of these (or at the end) — the reason
// `foo_bar_baz` and `2 * 3 * 4` stay plain text.
const preChars = new Set([" ", "\t", "\n", "-", "(", "{", "'", '"']);
const postChars = new Set([
  " ",
  "\t",
  "\n",
  "-",
  ".",
  ",",
  ":",
  "!",
  "?",
  ";",
  "'",
  '"',
  ")",
  "}",
  "[",
  "\\",
]);

function isWhitespace(char: string): boolean {
  return char === " " || char === "\t" || char === "\n";
}

/**
 * Parses the inline markup of `text`, whose first character sits at `offset` in
 * the document. Only emphasis-style markers are recognised; everything else is
 * left as implicit text (`lezerToParseTree` fills the gaps).
 */
export function parseOrgInline(text: string, offset: number): OrgNode[] {
  const result: OrgNode[] = [];
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === "$" && text.startsWith("${", i)) {
      const directive = parseLuaDirective(text, i, offset);
      if (directive) {
        result.push(directive.node);
        i = directive.end - 1;
        continue;
      }
    }
    if (char === "[") {
      const link = parseOrgLink(text, i, offset);
      if (link) {
        result.push(link.node);
        i = link.end - 1;
        continue;
      }
    }
    const spec = emphasisMarkers[char];
    if (!spec) {
      continue;
    }
    if (i > 0 && !preChars.has(text[i - 1])) {
      continue;
    }
    if (i + 1 >= text.length || isWhitespace(text[i + 1])) {
      continue;
    }
    let close = -1;
    for (let j = i + 1; j < text.length; j++) {
      if (text[j] !== char) {
        continue;
      }
      if (isWhitespace(text[j - 1])) {
        continue;
      }
      if (j + 1 < text.length && !postChars.has(text[j + 1])) {
        continue;
      }
      close = j;
      break;
    }
    if (close === -1) {
      continue;
    }
    const bodyFrom = offset + i + 1;
    const bodyTo = offset + close;
    result.push(
      node(spec.name, offset + i, offset + close + 1, [
        node(spec.mark, offset + i, bodyFrom),
        ...(spec.verbatim
          ? []
          : parseOrgInline(text.slice(i + 1, close), bodyFrom)),
        node(spec.mark, bodyTo, bodyTo + 1),
      ]),
    );
    i = close;
  }
  return result;
}

/**
 * Parses a `${…}` Space Lua directive.
 *
 * These are a SilverBullet construct rather than an Org one, but a note is
 * only as useful as what it can show: without them an Org page cannot hold a
 * query. Braces are balanced so a directive can contain a Lua table.
 */
function parseLuaDirective(
  text: string,
  at: number,
  offset: number,
): { node: OrgNode; end: number } | null {
  let depth = 0;
  for (let i = at + 1; i < text.length; i++) {
    if (text[i] === "{") {
      depth++;
    } else if (text[i] === "}") {
      depth--;
      if (depth === 0) {
        const end = i + 1;
        return {
          node: node("LuaDirective", offset + at, offset + end, [
            node("LuaDirectiveMark", offset + at, offset + at + 2),
            node("LuaExpressionDirective", offset + at + 2, offset + i),
            node("LuaDirectiveMark", offset + i, offset + end),
          ]),
          end,
        };
      }
    }
  }
  return null;
}

/**
 * Parses an Org bracket link at `at`: `[[TARGET]]` or `[[TARGET][DESCRIPTION]]`.
 *
 * A `denote:` target gets its own node type. Those links carry an *identifier*
 * rather than a path — that is the whole point of Denote's scheme, since a note
 * can be renamed freely without breaking inbound links — so resolving one to a
 * file needs the space's file list and happens outside the parser.
 */
function parseOrgLink(
  text: string,
  at: number,
  offset: number,
): { node: OrgNode; end: number } | null {
  if (!text.startsWith("[[", at)) {
    return null;
  }
  const targetEnd = text.indexOf("]", at + 2);
  if (targetEnd === -1) {
    return null;
  }
  const target = text.slice(at + 2, targetEnd);
  if (!target || target.includes("[")) {
    return null;
  }

  let descriptionFrom = -1;
  let descriptionTo = -1;
  let end: number;
  if (text.startsWith("][", targetEnd)) {
    const close = text.indexOf("]]", targetEnd + 2);
    if (close === -1) {
      return null;
    }
    descriptionFrom = targetEnd + 2;
    descriptionTo = close;
    end = close + 2;
  } else if (text.startsWith("]]", targetEnd)) {
    end = targetEnd + 2;
  } else {
    return null;
  }

  const denote = /^denote:([^:\s]+)(::.*)?$/.exec(target);
  const children: OrgNode[] = [
    node("OrgLinkMark", offset + at, offset + at + 2),
    node(
      denote ? "DenoteLinkTarget" : "OrgLinkTarget",
      offset + at + 2,
      offset + targetEnd,
    ),
  ];
  if (descriptionFrom !== -1) {
    children.push(
      node("OrgLinkMark", offset + targetEnd, offset + descriptionFrom),
      ...(descriptionTo > descriptionFrom
        ? [
            node(
              "OrgLinkDescription",
              offset + descriptionFrom,
              offset + descriptionTo,
              parseOrgInline(
                text.slice(descriptionFrom, descriptionTo),
                offset + descriptionFrom,
              ),
            ),
          ]
        : []),
      node("OrgLinkMark", offset + descriptionTo, offset + end),
    );
  } else {
    children.push(node("OrgLinkMark", offset + targetEnd, offset + end));
  }
  return {
    node: node(
      denote ? "DenoteLink" : "OrgLink",
      offset + at,
      offset + end,
      children,
    ),
    end,
  };
}

// ---------------------------------------------------------------------------
// Block parsing
// ---------------------------------------------------------------------------

type BlockContext = {
  /** The full document text; every `from`/`to` is an offset into it. */
  source: string;
  lines: Line[];
  /** Blocks below this column belong to an enclosing list item, not to us. */
  minIndent: number;
};

/**
 * Parses `lines[from..to)` into block nodes.
 * @param firstBlockAsTask turns a leading `[ ]`/`[X]` paragraph into a `Task`,
 * which is only meaningful directly inside a list item.
 */
function parseBlocks(
  cx: BlockContext,
  from: number,
  to: number,
  firstBlockAsTask = false,
): OrgNode[] {
  const blocks: OrgNode[] = [];
  let i = from;
  let first = true;
  while (i < to) {
    const line = cx.lines[i];
    if (isBlank(line)) {
      i++;
      continue;
    }
    if (indentOf(line) < cx.minIndent && !headlineMatch(line)) {
      break;
    }

    const headline = headlineMatch(line);
    if (headline) {
      const [, stars, gap, content] = headline;
      const level = Math.min(stars.length, 6);
      const contentFrom = line.from + stars.length + gap.length;
      blocks.push(
        node(`ATXHeading${level}`, line.from, lineEnd(line), [
          node("HeaderMark", line.from, line.from + stars.length),
          ...parseOrgInline(content, contentFrom),
        ]),
      );
      i++;
      first = false;
      continue;
    }

    const dynamic = parseDynamicBlock(cx, i, to);
    if (dynamic) {
      blocks.push(dynamic.node);
      i = dynamic.next;
      first = false;
      continue;
    }

    const block = parseGreaterBlock(cx, i, to);
    if (block) {
      blocks.push(block.node);
      i = block.next;
      first = false;
      continue;
    }

    const drawer = parseDrawer(cx, i, to);
    if (drawer) {
      blocks.push(drawer.node);
      i = drawer.next;
      first = false;
      continue;
    }

    const keyword = keywordRegex.exec(line.text);
    if (keyword) {
      const [, indent, hashPlus, name, colon, gap, value] = keyword;
      let at = line.from + indent.length;
      const children = [node("OrgKeywordMark", at, at + hashPlus.length)];
      at += hashPlus.length;
      children.push(node("OrgKeywordName", at, at + name.length));
      at += name.length;
      children.push(node("OrgKeywordMark", at, at + colon.length));
      at += colon.length + gap.length;
      if (value) {
        children.push(node("OrgKeywordValue", at, at + value.length));
      }
      blocks.push(
        node("OrgKeyword", line.from + indent.length, lineEnd(line), children),
      );
      i++;
      first = false;
      continue;
    }

    if (commentRegex.test(line.text)) {
      const start = i;
      while (i < to && commentRegex.test(cx.lines[i].text)) {
        i++;
      }
      const commentFrom = cx.lines[start].from;
      const commentTo = lineEnd(cx.lines[i - 1]);
      blocks.push(
        node("CommentBlock", commentFrom, commentTo, [
          node(
            "CommentMarker",
            commentFrom + indentOf(cx.lines[start]),
            commentFrom + indentOf(cx.lines[start]) + 1,
          ),
        ]),
      );
      first = false;
      continue;
    }

    if (horizontalRuleRegex.test(line.text)) {
      blocks.push(node("HorizontalRule", line.from, lineEnd(line)));
      i++;
      first = false;
      continue;
    }

    if (tableRowRegex.test(line.text)) {
      const table = parseTable(cx, i, to);
      blocks.push(table.node);
      i = table.next;
      first = false;
      continue;
    }

    const listMark = listMarkMatch(line);
    if (listMark && listMark.indent >= cx.minIndent) {
      const list = parseList(cx, i, to, listMark.indent);
      blocks.push(list.node);
      i = list.next;
      first = false;
      continue;
    }

    const paragraph = parseParagraph(cx, i, to);
    blocks.push(
      first && firstBlockAsTask
        ? asTaskOrParagraph(cx, paragraph)
        : paragraphNode(cx, paragraph),
    );
    i = paragraph.next;
    first = false;
  }
  return blocks;
}

type Span = { from: number; to: number; next: number };

/** Consumes a run of non-blank lines that don't start another kind of block. */
function parseParagraph(cx: BlockContext, start: number, to: number): Span {
  let i = start + 1;
  while (i < to) {
    const line = cx.lines[i];
    if (isBlank(line)) break;
    if (indentOf(line) < cx.minIndent) break;
    if (headlineMatch(line)) break;
    if (listMarkMatch(line)) break;
    if (tableRowRegex.test(line.text)) break;
    if (horizontalRuleRegex.test(line.text)) break;
    if (commentRegex.test(line.text)) break;
    if (keywordRegex.test(line.text)) break;
    if (blockBeginRegex.test(line.text)) break;
    if (dynamicBlockBeginRegex.test(line.text)) break;
    if (drawerBeginRegex.test(line.text)) break;
    i++;
  }
  return {
    from: cx.lines[start].from + indentOf(cx.lines[start]),
    to: lineEnd(cx.lines[i - 1]),
    next: i,
  };
}

function textOf(cx: BlockContext, span: { from: number; to: number }): string {
  return cx.source.slice(span.from, span.to);
}

function paragraphNode(cx: BlockContext, span: Span): OrgNode {
  return node(
    "Paragraph",
    span.from,
    span.to,
    parseOrgInline(textOf(cx, span), span.from),
  );
}

function asTaskOrParagraph(cx: BlockContext, span: Span): OrgNode {
  const text = textOf(cx, span);
  const checkbox = checkboxRegex.exec(text);
  if (!checkbox) {
    return paragraphNode(cx, span);
  }
  const state = checkbox[1];
  const openFrom = span.from;
  const closeFrom = span.from + 1 + state.length;
  return node("Task", span.from, span.to, [
    node("TaskState", openFrom, closeFrom + 1, [
      node("TaskMark", openFrom, openFrom + 1),
      node("TaskMark", closeFrom, closeFrom + 1),
    ]),
    ...parseOrgInline(
      text.slice(checkbox[0].length),
      span.from + checkbox[0].length,
    ),
  ]);
}

/**
 * An Org dynamic block: `#+BEGIN: name :params` … `#+END:`.
 *
 * Its body is generated content, but it is still ordinary Org — the links a
 * `denote-links` block holds are real links — so the body is parsed normally
 * and only the delimiters are marked up. That is what lets the block's
 * contents stay readable and clickable without regenerating anything.
 */
function parseDynamicBlock(
  cx: BlockContext,
  start: number,
  to: number,
): { node: OrgNode; next: number } | null {
  const line = cx.lines[start];
  const begin = dynamicBlockBeginRegex.exec(line.text);
  if (!begin) {
    return null;
  }
  let i = start + 1;
  let endLine: Line | undefined;
  while (i < to) {
    if (dynamicBlockEndRegex.test(cx.lines[i].text)) {
      endLine = cx.lines[i];
      i++;
      break;
    }
    if (headlineMatch(cx.lines[i])) {
      // An unterminated block is not a block.
      return null;
    }
    i++;
  }
  if (!endLine) {
    return null;
  }

  const [, indent, mark, type, params] = begin;
  let at = line.from + indent.length;
  const children: OrgNode[] = [
    node("OrgDynamicBlockMark", at, at + mark.length),
  ];
  at = line.from + line.text.indexOf(type, indent.length + mark.length);
  children.push(node("OrgDynamicBlockType", at, at + type.length));
  if (params) {
    const paramsAt = lineEnd(line) - params.length;
    children.push(
      node("OrgDynamicBlockParams", paramsAt, paramsAt + params.length),
    );
  }
  // The generated body, parsed as ordinary Org.
  if (i - 1 > start + 1) {
    children.push(...parseBlocks(cx, start + 1, i - 1));
  }
  children.push(
    node(
      "OrgDynamicBlockMark",
      endLine.from + indentOf(endLine),
      lineEnd(endLine),
    ),
  );
  return {
    node: node(
      "OrgDynamicBlock",
      line.from + indent.length,
      lineEnd(endLine),
      children,
    ),
    next: i,
  };
}

/** `#+BEGIN_X ... #+END_X`. Source blocks and examples become `FencedCode`. */
function parseGreaterBlock(
  cx: BlockContext,
  start: number,
  to: number,
): { node: OrgNode; next: number } | null {
  const line = cx.lines[start];
  const begin = blockBeginRegex.exec(line.text);
  if (!begin) {
    return null;
  }
  const [, indent, beginMark, kind, info] = begin;
  let i = start + 1;
  let endLine: Line | undefined;
  while (i < to) {
    const end = blockEndRegex.exec(cx.lines[i].text);
    if (end && end[3].toLowerCase() === kind.toLowerCase()) {
      endLine = cx.lines[i];
      i++;
      break;
    }
    i++;
  }
  const blockFrom = line.from + indent.length;
  const blockTo = endLine ? lineEnd(endLine) : lineEnd(cx.lines[i - 1]);
  const markTo = line.from + indent.length + beginMark.length + kind.length;
  const children: OrgNode[] = [node("CodeMark", blockFrom, markTo)];
  if (info) {
    const infoFrom = lineEnd(line) - info.length;
    children.push(node("CodeInfo", infoFrom, infoFrom + info.length));
  }
  const bodyFrom = lineEnd(line) + 1;
  const bodyTo = endLine ? endLine.from - 1 : blockTo;
  if (bodyTo > bodyFrom) {
    children.push(node("CodeText", bodyFrom, bodyTo));
  }
  if (endLine) {
    children.push(
      node("CodeMark", endLine.from + indentOf(endLine), lineEnd(endLine)),
    );
  }
  const lowerKind = kind.toLowerCase();
  const name =
    lowerKind === "quote"
      ? "Blockquote"
      : lowerKind === "comment"
        ? "CommentBlock"
        : "FencedCode";
  return { node: node(name, blockFrom, blockTo, children), next: i };
}

/** `:PROPERTIES:` / `:LOGBOOK:` style drawers, parsed so they stay out of paragraphs. */
function parseDrawer(
  cx: BlockContext,
  start: number,
  to: number,
): { node: OrgNode; next: number } | null {
  const line = cx.lines[start];
  const begin = drawerBeginRegex.exec(line.text);
  if (!begin || drawerEndRegex.test(line.text)) {
    return null;
  }
  let i = start + 1;
  let endLine: Line | undefined;
  while (i < to) {
    if (drawerEndRegex.test(cx.lines[i].text)) {
      endLine = cx.lines[i];
      i++;
      break;
    }
    // An unterminated drawer is not a drawer: bail out and let the caller
    // re-read these lines as ordinary blocks.
    if (headlineMatch(cx.lines[i]) || isBlank(cx.lines[i])) {
      return null;
    }
    i++;
  }
  if (!endLine) {
    return null;
  }
  const children: OrgNode[] = [
    node("OrgDrawerMark", line.from + begin[1].length, lineEnd(line)),
  ];
  for (let j = start + 1; j < i - 1; j++) {
    const property = propertyRegex.exec(cx.lines[j].text);
    if (!property) {
      continue;
    }
    const [, indent, openColon, name, closeColon, gap, value] = property;
    let at = cx.lines[j].from + indent.length;
    const propertyChildren = [
      node("OrgDrawerMark", at, at + openColon.length),
      node(
        "OrgPropertyName",
        at + openColon.length,
        at + openColon.length + name.length,
      ),
    ];
    at += openColon.length + name.length;
    propertyChildren.push(node("OrgDrawerMark", at, at + closeColon.length));
    at += closeColon.length + gap.length;
    if (value) {
      propertyChildren.push(node("OrgPropertyValue", at, at + value.length));
    }
    children.push(
      node(
        "OrgProperty",
        cx.lines[j].from + indent.length,
        lineEnd(cx.lines[j]),
        propertyChildren,
      ),
    );
  }
  children.push(
    node("OrgDrawerMark", endLine.from + indentOf(endLine), lineEnd(endLine)),
  );
  return {
    node: node(
      "OrgDrawer",
      line.from + begin[1].length,
      lineEnd(endLine),
      children,
    ),
    next: i,
  };
}

function parseTable(
  cx: BlockContext,
  start: number,
  to: number,
): { node: OrgNode; next: number } {
  let i = start;
  const rows: OrgNode[] = [];
  const headerRow =
    start + 1 < to && tableSeparatorRegex.test(cx.lines[start + 1].text);
  while (i < to && tableRowRegex.test(cx.lines[i].text)) {
    const line = cx.lines[i];
    if (tableSeparatorRegex.test(line.text)) {
      rows.push(
        node("TableDelimiter", line.from + indentOf(line), lineEnd(line)),
      );
      i++;
      continue;
    }
    rows.push(
      parseTableRow(
        line,
        headerRow && i === start ? "TableHeader" : "TableRow",
      ),
    );
    i++;
  }
  return {
    node: node(
      "Table",
      cx.lines[start].from + indentOf(cx.lines[start]),
      lineEnd(cx.lines[i - 1]),
      rows,
    ),
    next: i,
  };
}

function parseTableRow(line: Line, name: string): OrgNode {
  const children: OrgNode[] = [];
  const indent = indentOf(line);
  let cellStart = -1;
  for (let i = indent; i < line.text.length; i++) {
    if (line.text[i] !== "|") {
      if (cellStart === -1) {
        cellStart = i;
      }
      continue;
    }
    if (cellStart !== -1) {
      const raw = line.text.slice(cellStart, i);
      const trimmedStart = cellStart + (raw.length - raw.trimStart().length);
      const trimmedEnd = i - (raw.length - raw.trimEnd().length);
      if (trimmedEnd > trimmedStart) {
        children.push(
          node(
            "TableCell",
            line.from + trimmedStart,
            line.from + trimmedEnd,
            parseOrgInline(
              line.text.slice(trimmedStart, trimmedEnd),
              line.from + trimmedStart,
            ),
          ),
        );
      }
      cellStart = -1;
    }
    children.push(node("TableDelimiter", line.from + i, line.from + i + 1));
  }
  return node(name, line.from + indent, lineEnd(line), children);
}

function parseList(
  cx: BlockContext,
  start: number,
  to: number,
  indent: number,
): { node: OrgNode; next: number } {
  const first = listMarkMatch(cx.lines[start])!;
  const items: OrgNode[] = [];
  let i = start;
  while (i < to) {
    if (isBlank(cx.lines[i])) {
      // A single blank line still belongs to the list; two end it.
      if (i + 1 >= to || isBlank(cx.lines[i + 1])) break;
      const following = listMarkMatch(cx.lines[i + 1]);
      if (
        (!following || following.indent !== indent) &&
        indentOf(cx.lines[i + 1]) <= indent
      ) {
        break;
      }
      i++;
      continue;
    }
    const mark = listMarkMatch(cx.lines[i]);
    if (!mark || mark.indent !== indent || mark.ordered !== first.ordered) {
      break;
    }
    const item = parseListItem(cx, i, to, mark);
    items.push(item.node);
    i = item.next;
  }
  return {
    node: node(
      first.ordered ? "OrderedList" : "BulletList",
      items[0].from,
      items[items.length - 1].to,
      items,
    ),
    next: i,
  };
}

function parseListItem(
  cx: BlockContext,
  start: number,
  to: number,
  mark: ListMarkMatch,
): { node: OrgNode; next: number } {
  const contentIndent = mark.contentFrom - cx.lines[start].from;
  let i = start + 1;
  while (i < to) {
    const line = cx.lines[i];
    if (isBlank(line)) {
      if (
        i + 1 < to &&
        !isBlank(cx.lines[i + 1]) &&
        indentOf(cx.lines[i + 1]) >= contentIndent
      ) {
        i += 2;
        continue;
      }
      break;
    }
    if (headlineMatch(line) || indentOf(line) < contentIndent) {
      break;
    }
    i++;
  }

  // The item's own text starts after the bullet, so the first line is re-based
  // to that column before the block parser sees it.
  const itemLines = cx.lines.slice(start, i);
  itemLines[0] = {
    text:
      " ".repeat(contentIndent) +
      cx.source.slice(mark.contentFrom, lineEnd(cx.lines[start])),
    from: cx.lines[start].from,
  };
  const itemCx: BlockContext = {
    ...cx,
    lines: itemLines,
    minIndent: contentIndent,
  };
  const children: OrgNode[] = [node("ListMark", mark.markFrom, mark.markTo)];
  children.push(...parseBlocks(itemCx, 0, itemLines.length, true));
  const lastLine = cx.lines[i - 1];
  return {
    node: node(
      "ListItem",
      cx.lines[start].from + mark.indent,
      lineEnd(lastLine),
      children,
    ),
    next: i,
  };
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

export function parseOrgToNode(text: string): OrgNode {
  const cx: BlockContext = {
    source: text,
    lines: splitLines(text),
    minIndent: 0,
  };
  return node("Document", 0, text.length, parseBlocks(cx, 0, cx.lines.length));
}

function toLezerTree(orgNode: OrgNode): Tree {
  const children: Tree[] = [];
  const positions: number[] = [];
  for (const child of orgNode.children) {
    children.push(toLezerTree(child));
    positions.push(child.from - orgNode.from);
  }
  return new Tree(
    orgNodeSet.types[orgNodeType(orgNode.name).id],
    children,
    positions,
    orgNode.to - orgNode.from,
  );
}

export function orgTextToTree(text: string): Tree {
  return toLezerTree(parseOrgToNode(text));
}

class OrgParser extends Parser {
  constructor(private wrapper?: ParseWrapper) {
    super();
  }

  createParse(
    input: Input,
    fragments: readonly TreeFragment[],
    ranges: readonly { from: number; to: number }[],
  ): PartialParse {
    const parse = this.createOrgParse(input, ranges);
    return this.wrapper ? this.wrapper(parse, input, fragments, ranges) : parse;
  }

  private createOrgParse(
    input: Input,
    ranges: readonly { from: number; to: number }[],
  ): PartialParse {
    const from = ranges.length ? ranges[0].from : 0;
    const to = ranges.length ? ranges[ranges.length - 1].to : input.length;
    let stoppedAt: number | null = null;
    let parsedPos = from;
    return {
      get parsedPos() {
        return parsedPos;
      },
      get stoppedAt() {
        return stoppedAt;
      },
      stopAt(pos: number) {
        stoppedAt = pos;
      },
      advance() {
        const end =
          stoppedAt === null ? to : Math.min(to, Math.max(from, stoppedAt));
        parsedPos = end;
        // Mixed parsing can hand us a discontinuous document (an Org block
        // nested inside another language). Reading across the gaps would
        // misplace every offset, so leave those spans unstructured.
        if (ranges.length > 1) {
          return new Tree(
            orgNodeSet.types[orgNodeType("Document").id],
            [],
            [],
            end - from,
          );
        }
        return orgTextToTree(input.read(from, end));
      },
    };
  }
}

export const orgParser = new OrgParser();

/**
 * Folds a headline's whole subtree — the outline fold Org users expect, which
 * `foldNodeProp` can't express because a headline node covers only its own line.
 */
const orgHeadlineFolding = foldService.of((state, lineStart, lineEnd) => {
  const tree = syntaxTree(state);
  // resolveInner lands on the innermost node — the HeaderMark — so climb to
  // the headline that starts on this line.
  let headline: SyntaxNode | null = tree.resolveInner(lineStart, 1);
  while (headline && !/^ATXHeading\d$/.test(headline.name)) {
    headline = headline.parent;
  }
  const match = headline && /^ATXHeading(\d)$/.exec(headline.name);
  if (!headline || !match || headline.from !== lineStart) {
    return null;
  }
  const level = +match[1];
  let end = state.doc.length;
  const cursor = tree.cursorAt(headline.to, 1);
  do {
    const next = /^ATXHeading(\d)$/.exec(cursor.name);
    if (next && cursor.from > headline.from && +next[1] <= level) {
      end = cursor.from - 1;
      break;
    }
  } while (cursor.next());
  return end > lineEnd ? { from: lineEnd, to: end } : null;
});

/**
 * Builds the Org language.
 *
 * `nestedParserFor` optionally supplies a parser for the body of a
 * `#+BEGIN_SRC <lang>` block, keyed by the block's language. It mirrors what
 * `markdown({ codeLanguages })` does for fenced code, and is left out for the
 * plain {@link orgLanguage} so `parseOrg` yields a tree of Org nodes only —
 * which is what the indexers want.
 */
export function buildOrgLanguage(
  nestedParserFor?: (info: string) => Parser | null,
): Language {
  const parser = nestedParserFor
    ? new OrgParser(
        parseMixed((node, input) => {
          if (node.name !== "FencedCode") {
            return null;
          }
          const fence = node.node;
          const info = fence.getChild("CodeInfo");
          const body = fence.getChild("CodeText");
          if (!info || !body) {
            return null;
          }
          const nested = nestedParserFor(
            input.read(info.from, info.to).split(/\s+/)[0],
          );
          return nested
            ? { parser: nested, overlay: [{ from: body.from, to: body.to }] }
            : null;
        }),
      )
    : orgParser;
  return new Language(orgLanguageFacet, parser, [orgHeadlineFolding], "org");
}

export const orgLanguage = buildOrgLanguage();

/** Parses Org text into the same {@link ParseTree} shape as `parseMarkdown`. */
export function parseOrg(text: string, offset?: number): ParseTree {
  text = text.replaceAll("\r", "");
  return lezerToParseTree(text, orgTextToTree(text).topNode, offset);
}
