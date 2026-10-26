import { editor, space, system } from "@silverbulletmd/silverbullet/syscalls";
import {
  defaultLinkStyle,
  maximumDocumentSize,
} from "@silverbulletmd/silverbullet/constants";
import { resolveMarkdownLink } from "@silverbulletmd/silverbullet/lib/resolve";
import {
  documentLink,
  linkSyntaxFor,
} from "@silverbulletmd/silverbullet/lib/link_syntax";
import {
  encodePageURI,
  isValidPath,
} from "@silverbulletmd/silverbullet/lib/ref";
import type { UploadFile } from "@silverbulletmd/silverbullet/type/client";

/**
 * The Denote name a document should land under, from the index plug.
 *
 * Naming lives there because an identifier has to be unique across the whole
 * library, and that is the plug holding the file list. Both this command and
 * the editor's paste handler go through it, so the two agree.
 *
 * Note: duplicate any modifications here to client/codemirror/editor_paste.ts
 */
async function denoteName(file: UploadFile): Promise<string | undefined> {
  const name: string = await system.invokeFunction(
    "index.denoteAttachmentPath",
    { name: file.name },
  );
  if (!isValidPath(name)) {
    void editor.flashNotification(
      `Could not build a valid file name for ${file.name}`,
      "error",
    );
    return undefined;
  }
  return name;
}

export type SaveOptions = {
  /**
   * Keep the file beside the note even when it is the sort of document that
   * would otherwise go to Zotero. A scan of a receipt is part of the note;
   * it is not a work to cite.
   */
  keepLocal?: boolean;
};

export async function saveFile(file: UploadFile, options: SaveOptions = {}) {
  const maxSize = await system.getConfig<number>(
    "maximumDocumentSize",
    maximumDocumentSize,
  );

  if (typeof maxSize !== "number") {
    await editor.flashNotification(
      "The setting 'maximumDocumentSize' must be a number",
      "error",
    );
  }
  if (file.content.length > maxSize * 1024 * 1024) {
    void editor.flashNotification(
      `Document is too large, maximum is ${maxSize}MiB`,
      "error",
    );
    return;
  }

  // A document goes to Zotero when that is set up; an image stays beside the
  // note, where it can be shown inline.
  if (
    !options.keepLocal &&
    !file.contentType.startsWith("image/") &&
    (await system.invokeFunction("index.zoteroCanAddFiles"))
  ) {
    let key: string;
    try {
      key = await system.invokeFunction(
        "index.zoteroAdd",
        file.name,
        file.contentType,
        file.content,
      );
    } catch (e: any) {
      if (!/Cancelled/.test(String(e.message))) throw e;
      return;
    }
    if ((await editor.getCurrentEditor()) === "page") {
      const link: string = await system.invokeFunction(
        "index.zoteroLinkForItem",
        key,
        file.name,
        await editor.getCurrentPage(),
      );
      await editor.insertAtCursor(link);
    }
    return;
  }

  const name = await denoteName(file);
  if (name === undefined) {
    return;
  }
  // No clobber check: the name leads with an identifier no other file in the
  // library holds, so there is nothing there to overwrite.
  const finalFilePath = resolveMarkdownLink(
    await editor.getCurrentPath(),
    name,
  );

  await space.writeDocument(finalFilePath, file.content);

  if ((await editor.getCurrentEditor()) === "page") {
    const path = await editor.getCurrentPath();
    const isImage = file.contentType.startsWith("image/");
    // An Org page gets an Org link. `![[…]]` is Markdown transclusion, which
    // Org has no syntax for, so an image inserted here used to arrive as text
    // Org could not draw -- the paste handler already knew this and this path
    // did not.
    const syntax = linkSyntaxFor(path);
    let documentMarkdown: string;
    if (syntax === "org") {
      documentMarkdown = documentLink(syntax, finalFilePath as any, isImage);
    } else {
      const linkStyle = await system.getConfig(
        "defaultLinkStyle",
        defaultLinkStyle,
      );
      documentMarkdown =
        linkStyle === "wikilink"
          ? `[[${finalFilePath}]]`
          : `[${finalFilePath}](${encodePageURI(finalFilePath)})`;
      if (isImage) {
        documentMarkdown = `!${documentMarkdown}`;
      }
    }
    void editor.insertAtCursor(documentMarkdown);
  }
}

/**
 * `Upload: File` and the camera/scan commands.
 *
 * A command carries its own `accept`, `capture` and `keepLocal` in the
 * manifest -- the same trick `Text: Bold` uses for its `wrapper` -- so the
 * three share one implementation and differ only in what they ask the OS for.
 */
export async function uploadFile(
  cmdDef: any,
  accept?: string,
  capture?: string,
) {
  const uploadFile = await editor.uploadFile(
    accept ?? cmdDef?.accept,
    capture ?? cmdDef?.capture,
  );
  await saveFile(uploadFile, { keepLocal: !!cmdDef?.keepLocal });
}
