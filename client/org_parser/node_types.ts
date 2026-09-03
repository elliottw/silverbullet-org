import {
  defineLanguageFacet,
  foldNodeProp,
  languageDataProp,
} from "@codemirror/language";
import { NodeSet, NodeType } from "@lezer/common";
import { styleTags, Tag, tags as t } from "@lezer/highlight";
import * as ct from "../markdown_parser/customtags.ts";

/** Org's `_underline_` has no Markdown equivalent, so it gets its own tag. */
export const OrgUnderlineTag = Tag.define();

export const orgLanguageFacet = defineLanguageFacet({
  commentTokens: { line: "#" },
});

/**
 * Every node the Org parser can emit.
 *
 * Names are deliberately shared with SilverBullet's Markdown tree wherever the
 * two languages mean the same thing (`ATXHeading1`, `ListItem`, `Task`, ...).
 * That is what lets the indexers in `plugs/index` and the live-preview
 * decorations in `client/codemirror` work on Org pages without knowing Org
 * exists. Org-only constructs get an `Org` prefix.
 */
export const orgNodeNames = [
  "Document",
  "ATXHeading1",
  "ATXHeading2",
  "ATXHeading3",
  "ATXHeading4",
  "ATXHeading5",
  "ATXHeading6",
  "HeaderMark",
  "Paragraph",
  "BulletList",
  "OrderedList",
  "ListItem",
  "ListMark",
  "Task",
  "TaskState",
  "TaskMark",
  "FencedCode",
  "CodeMark",
  "CodeInfo",
  "CodeText",
  "Blockquote",
  "QuoteMark",
  "CommentBlock",
  "CommentMarker",
  "HorizontalRule",
  "Table",
  "TableHeader",
  "TableRow",
  "TableCell",
  "TableDelimiter",
  "OrgDynamicBlock",
  "OrgDynamicBlockMark",
  "OrgDynamicBlockType",
  "OrgDynamicBlockParams",
  "OrgKeyword",
  "OrgKeywordMark",
  "OrgKeywordName",
  "OrgKeywordValue",
  "OrgDrawer",
  "OrgDrawerMark",
  "OrgProperty",
  "OrgPropertyName",
  "OrgPropertyValue",
  "LuaDirective",
  "LuaExpressionDirective",
  "LuaDirectiveMark",
  "OrgLink",
  "OrgLinkMark",
  "OrgLinkTarget",
  "OrgLinkDescription",
  "DenoteLink",
  "DenoteLinkTarget",
  "Emphasis",
  "StrongEmphasis",
  "OrgUnderline",
  "Strikethrough",
  "StrikethroughMark",
  "EmphasisMark",
  "InlineCode",
] as const;

export type OrgNodeName = (typeof orgNodeNames)[number];

const nodeTypes: NodeType[] = [NodeType.none];
const nodeTypeByName = new Map<string, NodeType>();

for (const name of orgNodeNames) {
  const type = NodeType.define({
    id: nodeTypes.length,
    name,
    top: name === "Document",
    props:
      name === "Document" ? [[languageDataProp, orgLanguageFacet]] : undefined,
  });
  nodeTypes.push(type);
  nodeTypeByName.set(name, type);
}

export const orgNodeSet = new NodeSet(nodeTypes).extend(
  styleTags({
    "ATXHeading1/...": t.heading1,
    "ATXHeading2/...": t.heading2,
    "ATXHeading3/...": t.heading3,
    "ATXHeading4/...": t.heading4,
    "ATXHeading5/...": t.heading5,
    "ATXHeading6/...": t.heading6,
    HeaderMark: t.processingInstruction,
    ListMark: t.processingInstruction,
    Task: ct.TaskTag,
    TaskMark: ct.TaskMarkTag,
    TaskState: ct.TaskStateTag,
    CodeMark: t.processingInstruction,
    CodeInfo: ct.CodeInfoTag,
    CodeText: t.monospace,
    "InlineCode/...": t.monospace,
    "Blockquote/...": t.quote,
    QuoteMark: t.processingInstruction,
    "CommentBlock/...": ct.CommentTag,
    CommentMarker: ct.CommentMarkerTag,
    HorizontalRule: ct.HorizontalRuleTag,
    "TableHeader/...": t.heading,
    TableCell: t.content,
    TableDelimiter: t.processingInstruction,
    OrgDynamicBlockMark: t.processingInstruction,
    OrgDynamicBlockType: ct.CodeInfoTag,
    OrgDynamicBlockParams: ct.AttributeValueTag,
    "OrgKeyword/...": ct.AttributeTag,
    OrgKeywordMark: t.processingInstruction,
    OrgKeywordName: ct.AttributeNameTag,
    OrgKeywordValue: ct.AttributeValueTag,
    "OrgDrawer/...": ct.AttributeTag,
    OrgDrawerMark: t.processingInstruction,
    OrgPropertyName: ct.AttributeNameTag,
    OrgPropertyValue: ct.AttributeValueTag,
    LuaDirectiveMark: ct.DirectiveMarkTag,
    "LuaDirective/...": ct.DirectiveTag,
    OrgLinkMark: t.processingInstruction,
    OrgLinkTarget: t.url,
    "OrgLinkDescription/...": t.link,
    // A Denote link points at an identifier, not a path, so it is styled like
    // a wiki link rather than a URL.
    DenoteLinkTarget: ct.WikiLinkPartTag,
    "DenoteLink/OrgLinkDescription/...": ct.WikiLinkPartTag,
    "Emphasis/...": t.emphasis,
    "StrongEmphasis/...": t.strong,
    "OrgUnderline/...": OrgUnderlineTag,
    "Strikethrough/...": t.strikethrough,
    EmphasisMark: t.processingInstruction,
    StrikethroughMark: t.processingInstruction,
  }),
  foldNodeProp.add({
    // Headlines span only their own line (as in Markdown), so outline folding
    // is a fold *service* over the tree rather than a per-node range; see
    // `orgHeadlineFolding` in parser.ts.
    ListItem: (node: any, state: any) => ({
      from: state.doc.lineAt(node.from).to,
      to: node.to,
    }),
    FencedCode: (node: any) => ({ from: node.from, to: node.to }),
    OrgDrawer: (node: any) => ({ from: node.from, to: node.to }),
  }),
);

export function orgNodeType(name: string): NodeType {
  const type = nodeTypeByName.get(name);
  if (!type) {
    throw new Error(`Unknown Org node type: ${name}`);
  }
  return type;
}
