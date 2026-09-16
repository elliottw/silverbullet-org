import { syntaxTree } from "@codemirror/language";
import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { EditorSelection, Transaction } from "@codemirror/state";
import type { Client } from "../client.ts";

import { lezerToParseTree } from "../markdown_parser/parse_tree.ts";
import {
  addParentPointers,
  findParentMatching,
  nodeAtPos,
} from "@silverbulletmd/silverbullet/lib/tree";
import { maximumDocumentSize } from "@silverbulletmd/silverbullet/constants";
import { safeRun } from "@silverbulletmd/silverbullet/lib/async";
import { resolveMarkdownLink } from "@silverbulletmd/silverbullet/lib/resolve";
import type { UploadFile } from "@silverbulletmd/silverbullet/type/client";
import { isValidPath, type Path } from "@silverbulletmd/silverbullet/lib/ref";
import {
  documentLink,
  linkSyntaxFor,
  urlLink,
} from "@silverbulletmd/silverbullet/lib/link_syntax";
import TurndownService from "turndown";
// @ts-expect-error - No type definitions available for this package
import { tables, taskListItems } from "@joplin/turndown-plugin-gfm";

const turndownService = new TurndownService({
  hr: "---",
  codeBlockStyle: "fenced",
  headingStyle: "atx",
  emDelimiter: "*",
  bulletListMarker: "*", // Duh!
  strongDelimiter: "**",
  linkStyle: "inlined",
});
turndownService.use(taskListItems);
turndownService.use(tables);

function striptHtmlComments(s: string): string {
  return s.replace(/<!--[\s\S]*?-->/g, "");
}

const urlRegexp =
  /^https?:\/\/[-a-zA-Z0-9@:%._+~#=]{1,256}([-a-zA-Z0-9()@:%_+.~#?&//=]*)/;

// Safari/WebKit only: after a paste that triggers a decoration-driven DOM
// rebuild (e.g. pasting a URL inside `[text]()` to complete a markdown link),
// WebKit leaves the contentEditable typing caret at the *pre-paste* position.
// `document.getSelection()` reports the correct post-paste position, so
// CodeMirror thinks the DOM selection is already in sync and skips re-writing
// it — and the next keystroke gets inserted at the stale caret. Forcing
// CodeMirror to actually perform a DOM selection write makes WebKit re-resolve
// its caret. We do that by briefly nudging the selection and restoring it once
// the paste (and its decoration rebuild) has settled.
const isWebKit =
  typeof navigator !== "undefined" && /Apple Computer/.test(navigator.vendor);

function fixupWebKitCaretAfterPaste(view: EditorView): void {
  if (!isWebKit) return;
  // Run after the synchronous paste handling + decoration rebuild have
  // settled, but before the user's next keystroke.
  queueMicrotask(() => {
    const sel = view.state.selection;
    const head = sel.main.head;
    const docLen = view.state.doc.length;
    // Pick a different position to force a real DOM selection write.
    const bump = head > 0 ? head - 1 : docLen > 0 ? head + 1 : head;
    if (bump === head) return; // empty document, nothing to re-resolve
    const noHistory = Transaction.addToHistory.of(false);
    view.dispatch({
      selection: EditorSelection.cursor(bump),
      annotations: noHistory,
    });
    // Restore the exact original selection (preserves multi-cursor ranges).
    view.dispatch({ selection: sel, annotations: noHistory });
  });
}

// Known iOS Safari paste issue (unrelated to this implementation): https://voxpelli.com/2015/03/ios-safari-url-copy-paste-bug/
export const pasteLinkExtension = ViewPlugin.fromClass(
  class {
    update(update: ViewUpdate): void {
      update.transactions.forEach((tr) => {
        if (tr.isUserEvent("input.paste")) {
          const pastedText: string[] = [];
          let from = 0;
          let to = 0;
          tr.changes.iterChanges((fromA, _toA, _fromB, toB, inserted) => {
            pastedText.push(inserted.sliceString(0));
            from = fromA;
            to = toB;
          });
          const pastedString = pastedText.join("");
          if (pastedString.match(urlRegexp)) {
            const selection = update.startState.selection.main;
            if (!selection.empty) {
              setTimeout(() => {
                update.view.dispatch({
                  changes: [
                    {
                      from: from,
                      to: to,
                      insert: urlLink(
                        linkSyntaxFor(client.currentPath()),
                        pastedString,
                        update.startState.sliceDoc(
                          selection.from,
                          selection.to,
                        ),
                      ),
                    },
                  ],
                });
              });
            }
          }
        }
      });
    }
  },
);

export function documentExtension(editor: Client) {
  let shiftDown = false;

  // Public embedder API: dispatch a `silverbullet:upload-files` CustomEvent
  // on `document` with `{ files: File[] }` in `detail` to hand the editor
  // a list of files. A bit hacky but required for correct Tauri operation.
  document.addEventListener("silverbullet:upload-files", (event) => {
    const files = (event as CustomEvent<{ files?: File[] }>).detail?.files;
    if (!files?.length) return;
    safeRun(async () => {
      await processFileTransfer(files);
    });
  });

  return EditorView.domEventHandlers({
    dragover: (event) => {
      event.preventDefault();
    },
    keydown: (event) => {
      if (event.key === "Shift") {
        shiftDown = true;
      }
      return false;
    },
    keyup: (event) => {
      if (event.key === "Shift") {
        shiftDown = false;
      }
      return false;
    },
    drop: (event: DragEvent) => {
      // TODO: This doesn't take into account the target cursor position,
      // it just drops the document wherever the cursor was last.
      if (event.dataTransfer) {
        const payload = [...event.dataTransfer.files];
        if (!payload.length) {
          return;
        }
        // Without this the browser falls through to its default action
        // (navigating to the dropped file)
        event.preventDefault();
        safeRun(async () => {
          await processFileTransfer(payload);
        });
      }
    },
    paste: (event: ClipboardEvent) => {
      // Schedule a WebKit caret re-sync regardless of which paste path runs
      // below (or CodeMirror's own default paste handling, which fires after
      // this handler returns a falsy value).
      fixupWebKitCaretAfterPaste(editor.editorView);

      const payload = [...event.clipboardData!.items];
      const richText = event.clipboardData?.getData("text/html");

      // Rich text is converted with turndown, which only speaks Markdown, so
      // an Org page must not take this branch: it would write Markdown into an
      // Org file. It matters most for an image, whose clipboard payload
      // carries `text/html` *beside* the file -- taking the HTML would paste a
      // Markdown `![](…)` pointing at wherever the image came from, instead of
      // uploading it and writing an Org link. Falling through reaches the file
      // handler, and plain text pastes as text.
      const richTextAllowed = linkSyntaxFor(editor.currentPath()) !== "org";

      // Only do rich text paste if shift is NOT down
      if (richText && !shiftDown && richTextAllowed) {
        // Are we in a fenced code block?
        const editorText = editor.editorView.state.sliceDoc();
        const tree = lezerToParseTree(
          editorText,
          syntaxTree(editor.editorView.state).topNode,
        );
        addParentPointers(tree);
        const currentNode = nodeAtPos(
          tree,
          editor.editorView.state.selection.main.from,
        );
        if (currentNode) {
          const fencedParentNode = findParentMatching(currentNode, (t) =>
            ["FrontMatter", "FencedCode"].includes(t.type!),
          );
          if (
            fencedParentNode ||
            ["FrontMatter", "FencedCode"].includes(currentNode.type!)
          ) {
            console.log("Inside of fenced code block, not pasting rich text");
            return false;
          }
        }

        event.preventDefault();
        const markdown = striptHtmlComments(
          turndownService.turndown(richText),
        ).trim();
        const view = editor.editorView;
        const selection = view.state.selection.main;
        view.dispatch({
          changes: [
            {
              from: selection.from,
              to: selection.to,
              insert: markdown,
            },
          ],
          selection: {
            anchor: selection.from + markdown.length,
          },
          scrollIntoView: true,
        });
        return true;
      }
      if (!payload.length || payload.length === 0) {
        return false;
      }
      safeRun(async () => {
        await processItemTransfer(payload);
      });
    },
  });

  async function processFileTransfer(payload: File[]) {
    const data = await payload[0].arrayBuffer();
    // data.byteLength > maximumDocumentSize;
    const fileData: UploadFile = {
      name: payload[0].name,
      contentType: payload[0].type,
      content: new Uint8Array(data),
    };
    await saveFile(fileData);
  }

  async function processItemTransfer(payload: DataTransferItem[]) {
    const file = payload.find((item) => item.kind === "file");
    if (!file) {
      return false;
    }
    const fileType = file.type;
    const data = await file!.getAsFile()?.arrayBuffer();
    if (!data) {
      return false;
    }
    // A clipboard image carries no name worth keeping (`image.png`), so the
    // identifier names it. A pasted document does have one -- `paper.pdf` --
    // and it is what the note should call it.
    const fileData: UploadFile = {
      name: fileType.startsWith("image/") ? "" : (file.getAsFile()?.name ?? ""),
      contentType: fileType,
      content: new Uint8Array(data),
    };
    // An unrecognised clipboard type leaves the file extensionless rather than
    // naming it `.undefined`.
    const subtype = fileType.split("/")[1];
    await saveFile(fileData, subtype ? `.${subtype}` : "");
  }

  /**
   * Writes a pasted or dropped document into the space under a Denote name.
   *
   * The name is issued by the index plug rather than derived here, because an
   * identifier has to be unique across the whole library and that is the plug
   * holding the file list. `plugs/editor/upload.ts` takes the same route, so
   * pasting and uploading name a document identically.
   *
   * @param fallbackExtension extension, dot included, for a clipboard item,
   *   which arrives with no name to take one from
   */
  async function saveFile(file: UploadFile, fallbackExtension = "") {
    // The same setting the upload command honours; a paste is an upload.
    const configured = editor.config.get<unknown>(
      "maximumDocumentSize",
      maximumDocumentSize,
    );
    const maxSize =
      typeof configured === "number" ? configured : maximumDocumentSize;

    if (file.content.length > maxSize * 1024 * 1024) {
      editor.ui.flashNotification(
        `Document is too large, maximum is ${maxSize}MiB`,
        "error",
      );
      return;
    }

    // A document goes to Zotero when that is set up; an image stays beside
    // the note, where it can be shown inline. Reference material has a
    // library of its own; a screenshot is part of the note.
    const isImage = file.contentType.startsWith("image/");
    const invoke = (name: string, args: unknown[]) =>
      editor.clientSystem.localSyscall("system.invokeFunction", [
        name,
        ...args,
      ]);
    if (!isImage && (await invoke("index.zoteroCanAddFiles", []))) {
      const name = file.name || `pasted-${Date.now()}${fallbackExtension}`;
      try {
        const key: string = await invoke("index.zoteroAdd", [
          name,
          file.contentType,
          file.content,
        ]);
        const link: string = await invoke("index.zoteroLinkForItem", [
          key,
          name,
          editor.currentPath(),
        ]);
        editor.editorView.dispatch({
          changes: {
            insert: link,
            from: editor.editorView.state.selection.main.from,
          },
        });
      } catch (e: any) {
        if (!/Cancelled/.test(String(e.message))) {
          editor.ui.flashNotification(
            `Could not add to Zotero: ${e.message}`,
            "error",
          );
        }
      }
      return;
    }

    const name: string = await editor.clientSystem.localSyscall(
      "system.invokeFunction",
      [
        "index.denoteAttachmentPath",
        { name: file.name, extension: fallbackExtension },
      ],
    );
    if (!isValidPath(name)) {
      editor.ui.flashNotification(
        `Could not build a valid file name for ${file.name || "the pasted document"}`,
        "error",
      );
      return;
    }
    // No clobber check: the name leads with an identifier no other file in the
    // library holds, so there is nothing there to overwrite.
    const finalFilePath = resolveMarkdownLink(editor.currentPath(), name);

    await editor.space.writeDocument(finalFilePath, file.content);
    const documentMarkdown = documentLink(
      linkSyntaxFor(editor.currentPath()),
      finalFilePath as Path,
      file.contentType.startsWith("image/"),
    );
    editor.editorView.dispatch({
      changes: [
        {
          insert: documentMarkdown,
          from: editor.editorView.state.selection.main.from,
        },
      ],
    });
  }
}
