import { editor, space, system } from "@silverbulletmd/silverbullet/syscalls";
import { uploadToZotero } from "@silverbulletmd/silverbullet/lib/zotero_api";

/**
 * Moving attachments nothing points at into Zotero.
 *
 * The library has grown a long tail of files no note refers to any more --
 * leftovers from the Obsidian migration, screenshots that outlived their
 * paragraph. Zotero is already the document store, so that is where they
 * belong, tagged for a later look rather than deleted on a guess.
 *
 * Deliberately cautious about what "nothing points at" means: a file counts
 * as referenced if its name appears *anywhere* in any note, not only inside
 * link syntax. A paragraph that names a file without linking it is still a
 * reference, and the cost of being wrong here is a deleted file.
 */

/** Rendered inline, so worth keeping beside the note that shows it. */
const inlineImage = /\.(png|jpe?g|gif|webp|heic|svg|bmp|tiff?)$/i;

/** Never candidates: SilverBullet's own, and files it generates. */
const reserved = [
  /^_/, // the Hugo export
  /^\./, // dotfiles and dot-directories
  /(^|\/)zotero\.bib$/,
  /\.plug\.js$/,
  /^Library\//,
];

export type Orphan = {
  path: string;
  size: number;
  image: boolean;
};

/**
 * Attachments no note mentions.
 *
 * @param includeImages images are referenced far more often than documents
 *   and are cheap to keep, so they are opt-in.
 */
export async function orphans(includeImages: boolean): Promise<Orphan[]> {
  const documents = await space.listDocuments();
  const pages = await space.listPages();

  // Every file name any note mentions, however it mentions it.
  const mentioned = new Set<string>();
  for (const page of pages) {
    let text: string;
    try {
      text = await space.readPage(page.name);
    } catch {
      continue;
    }
    for (const document of documents) {
      const leaf = document.name.slice(document.name.lastIndexOf("/") + 1);
      if (!mentioned.has(leaf) && text.includes(leaf)) {
        mentioned.add(leaf);
      }
    }
  }

  const out: Orphan[] = [];
  for (const document of documents) {
    const leaf = document.name.slice(document.name.lastIndexOf("/") + 1);
    if (mentioned.has(leaf)) continue;
    if (reserved.some((pattern) => pattern.test(document.name))) continue;
    const image = inlineImage.test(document.name);
    if (image && !includeImages) continue;
    out.push({ path: document.name, size: document.size ?? 0, image });
  }
  return out.sort((a, b) => b.size - a.size);
}

const mib = (bytes: number) => `${(bytes / 1048576).toFixed(1)} MiB`;

function contentTypeOf(name: string): string {
  const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  const types: Record<string, string> = {
    pdf: "application/pdf",
    mov: "video/quicktime",
    mp4: "video/mp4",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    heic: "image/heic",
    svg: "image/svg+xml",
    html: "text/html",
    json: "application/json",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  };
  return types[ext] ?? "application/octet-stream";
}

/**
 * `Zotero: Archive Unlinked Files` -- reports by default, moves on request.
 *
 * Each file is uploaded and *then* deleted, one at a time: a failed upload
 * leaves the file where it was, and a run that dies halfway has moved exactly
 * what it uploaded. Nothing is deleted on the strength of a batch.
 */
export async function archiveOrphansCommand(): Promise<void> {
  const { userId, apiKey, api, archiveTag } = await system.getConfig<{
    userId?: string;
    apiKey?: string;
    api?: string;
    archiveTag?: string;
  }>("zotero", {});
  if (!userId || !apiKey) {
    await editor.flashNotification(
      "Set zotero.userId and zotero.apiKey first",
      "error",
    );
    return;
  }
  const tag = archiveTag ?? "inbox";

  const includeImages = await editor.confirm(
    "Include images that no note mentions?\n\n" +
      "OK: every unlinked file.    Cancel: documents only.",
  );
  const found = await orphans(includeImages);
  if (found.length === 0) {
    await editor.flashNotification("Every file is referenced by a note");
    return;
  }
  const total = found.reduce((sum, o) => sum + o.size, 0);
  const shown = found
    .slice(0, 15)
    .map((o) => `  ${mib(o.size).padStart(10)}  ${o.path}`)
    .join("\n");
  const more = found.length > 15 ? `\n  …and ${found.length - 15} more` : "";

  const go = await editor.confirm(
    `${found.length} files, ${mib(total)}, that no note mentions:\n\n` +
      `${shown}${more}\n\n` +
      `Upload each to Zotero tagged "${tag}" and delete it here?\n` +
      `A file is deleted only after its own upload succeeds.`,
  );
  if (!go) return;

  let moved = 0;
  let movedBytes = 0;
  const failures: string[] = [];
  for (const orphan of found) {
    try {
      const content = await space.readDocument(orphan.path);
      const leaf = orphan.path.slice(orphan.path.lastIndexOf("/") + 1);
      await uploadToZotero(
        { userId, apiKey, api },
        leaf,
        contentTypeOf(leaf),
        content,
        { tags: [tag] },
      );
      // Only now: the file exists in two places, so losing this one is safe.
      await space.deleteDocument(orphan.path);
      moved++;
      movedBytes += orphan.size;
      if (moved % 10 === 0) {
        await editor.flashNotification(`${moved} of ${found.length} moved…`);
      }
    } catch (e: any) {
      failures.push(`${orphan.path}: ${e.message}`);
    }
  }
  if (failures.length) {
    console.warn("[archive] left in place:", failures);
  }
  await editor.flashNotification(
    `Moved ${moved} files (${mib(movedBytes)}) to Zotero tagged "${tag}"` +
      (failures.length ? `; ${failures.length} left in place` : ""),
  );
}

/** `Zotero: List Unlinked Files` -- the report on its own. */
export async function listOrphansCommand(): Promise<void> {
  const found = await orphans(true);
  const total = found.reduce((sum, o) => sum + o.size, 0);
  const images = found.filter((o) => o.image);
  await editor.flashNotification(
    `${found.length} unlinked files, ${mib(total)} ` +
      `(${images.length} images, ${found.length - images.length} documents)`,
  );
  console.log(
    "[archive] unlinked files, largest first:",
    found.map((o) => `${mib(o.size)}\t${o.path}`),
  );
}
