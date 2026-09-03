import {
  getPathExtension,
  type Path,
} from "@silverbulletmd/silverbullet/lib/ref";
import type { ParseTree } from "@silverbulletmd/silverbullet/lib/tree";
import { parseMarkdown } from "./markdown_parser/parser.ts";
import { parseOrg } from "./org_parser/parser.ts";

/**
 * Parses page text with the parser belonging to its file extension. Both
 * parsers produce the same {@link ParseTree} node vocabulary, so callers can
 * treat the result identically.
 */
export function parsePage(
  path: Path,
  text: string,
  offset?: number,
): ParseTree {
  return getPathExtension(path) === "org"
    ? parseOrg(text, offset)
    : parseMarkdown(text, offset);
}
