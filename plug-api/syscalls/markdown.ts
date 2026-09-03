import { syscall } from "../syscall.ts";
import type { ParseTree } from "../lib/tree.ts";

/**
 * Parses a piece of markdown text into a ParseTree.
 * @param text the markdown text to parse
 * @returns a ParseTree representation of the markdown text
 */
export function parseMarkdown(text: string): Promise<ParseTree> {
  return syscall("markdown.parseMarkdown", text);
}

/**
 * Parses page text into a ParseTree using the parser that matches the page's
 * file extension (Markdown for `.md`, Org for `.org`).
 * @param path the path of the page, e.g. `Notes.org`
 * @param text the page text to parse
 */
export function parsePage(path: string, text: string): Promise<ParseTree> {
  return syscall("markdown.parsePage", path, text);
}

/**
 * Renders a ParseTree to markdown.
 * @param tree the parse tree
 * @returns the rendered markdown of a passed parse tree
 */
export function renderParseTree(tree: ParseTree): Promise<string> {
  return syscall("markdown.renderParseTree", tree);
}

/**
 * Expands custom markdown Lua directives and transclusions into plain markdown
 * @param tree the parse tree
 * @returns the expaneded markdown
 */
export function expandMarkdown(tree: ParseTree): Promise<ParseTree> {
  return syscall("markdown.expandMarkdown", tree);
}

/**
 * Renders markdown text to HTML.
 * @param markdownText the markdown text to render
 * @returns HTML representation of the markdown
 */
export function markdownToHtml(markdownText: string): Promise<string> {
  return syscall("markdown.markdownToHtml", markdownText);
}
