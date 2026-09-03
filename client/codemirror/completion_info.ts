import {
  type Completion,
  snippet as applySnippet,
} from "@codemirror/autocomplete";
import { parseMarkdown } from "../markdown_parser/parser.ts";
import { renderMarkdownToHtml } from "../markdown_renderer/markdown_render.ts";

export type DocumentedCompletion = Completion & {
  documentation?: string;
  snippet?: string;
  /**
   * A plug function that answers this completion itself, instead of the
   * completion inserting text.
   *
   * A function cannot cross the plug boundary, so its name does and the
   * `apply` is built on this side -- the same arrangement slash commands use.
   * It exists for a completion whose text is not known until something has
   * happened: creating a Denote note has to mint the note before it can name
   * the identifier a link to it addresses.
   */
  invoke?: string;
};

export function renderCompletionDocumentation(markdown: string): HTMLElement {
  const dom = document.createElement("div");
  dom.className = "sb-completion-documentation";
  dom.innerHTML = renderMarkdownToHtml(parseMarkdown(markdown));
  return dom;
}

export function withCompletionInfo(
  completion: DocumentedCompletion,
): Completion {
  const {
    documentation,
    snippet: snippetTemplate,
    ...codeMirrorCompletion
  } = completion;
  let adaptedCompletion = codeMirrorCompletion;
  if (snippetTemplate && typeof adaptedCompletion.apply !== "function") {
    adaptedCompletion = {
      ...adaptedCompletion,
      apply: applySnippet(snippetTemplate),
    };
  }
  if (!documentation || adaptedCompletion.info) {
    return adaptedCompletion;
  }
  return {
    ...adaptedCompletion,
    info: () => renderCompletionDocumentation(documentation),
  };
}
