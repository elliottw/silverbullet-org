/**
 * Zotero, the way Denote is: a bibliography is a library the notes point
 * into, addressed by citekey rather than by path.
 *
 * The source of truth is Better BibTeX's export of the Zotero library, a
 * `.bib` file kept in the space (`zotero.bibliography`, default `zotero.bib`)
 * and refreshed by BBT whenever the library changes. It is indexed as
 * `zotero` objects, one per item, so pickers and queries never re-parse it.
 * A `[cite:@key]` in a note and a `#+reference:` in its front matter are
 * indexed as relations to the item, which is what gives a reference note its
 * "cited in" list -- the `citar-denote` convention, so Emacs sees the same
 * note.
 */
import {
  type BibEntry,
  citekeysIn,
  parseBibtex,
  shortCitation,
  zoteroSelectUrl,
  zoteroWebUrl,
} from "@silverbulletmd/silverbullet/lib/bibtex";
import {
  collectNodesOfType,
  type ParseTree,
  renderToText,
} from "@silverbulletmd/silverbullet/lib/tree";
import {
  clientStore,
  editor,
  index,
  space,
  system,
} from "@silverbulletmd/silverbullet/syscalls";
import type {
  ObjectValue,
  PageMeta,
} from "@silverbulletmd/silverbullet/type/index";
import { linkSyntaxFor } from "@silverbulletmd/silverbullet/lib/link_syntax";
import { uploadToZotero } from "@silverbulletmd/silverbullet/lib/zotero_api";
import { createDenoteNote, invalidateDenoteIdentifiers } from "./denote.ts";
import type { FrontMatter } from "./frontmatter.ts";
import type { RelationObject } from "./relation.ts";
import { buildLineIndex, extractSnippet } from "./snippet.ts";

export type ZoteroObject = ObjectValue<{
  tag: "zotero";
  citekey: string;
  type: string;
  title: string;
  authors: string[];
  year?: string;
  short: string;
  keywords: string[];
  /** Attachment item keys, the ones a zotero.org URL takes. */
  attachments: string[];
  attachmentNames: string[];
}>;

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export type ZoteroConfig = {
  /** Path of the Better BibTeX export inside the space. */
  bibliography: string;
  /** zotero.org username, for web links. */
  username?: string;
  /** Numeric user ID and an API key with write and file access, for adding. */
  userId?: string;
  apiKey?: string;
  /** Keyword a reference note carries; `citar-denote` uses `bib`. */
  referenceKeyword: string;
};

export async function zoteroConfig(): Promise<ZoteroConfig> {
  const cfg = (await system.getConfig("zotero", {})) as Partial<ZoteroConfig>;
  return {
    bibliography: cfg.bibliography ?? "zotero.bib",
    username: cfg.username,
    userId: cfg.userId,
    apiKey: cfg.apiKey,
    referenceKeyword: cfg.referenceKeyword ?? "bib",
  };
}

// ---------------------------------------------------------------------------
// The bibliography
// ---------------------------------------------------------------------------

let cache: { name: string; entries: BibEntry[]; at: number } | undefined;

/** The parsed bibliography, re-read when it is more than a few seconds old. */
export async function bibliography(): Promise<BibEntry[]> {
  const { bibliography: name } = await zoteroConfig();
  if (cache && cache.name === name && Date.now() - cache.at < 10_000) {
    return cache.entries;
  }
  let entries: BibEntry[] = [];
  try {
    const bytes = await space.readDocument(name);
    entries = parseBibtex(new TextDecoder().decode(bytes));
  } catch {
    // No bibliography in the space: every lookup misses, nothing breaks.
  }
  cache = { name, entries, at: Date.now() };
  return entries;
}

export async function entryByCitekey(
  citekey: string,
): Promise<BibEntry | undefined> {
  return (await bibliography()).find((e) => e.citekey === citekey);
}

/** The entry owning an attachment key, for `[[zotero:KEY]]` links. */
export async function entryByItemKey(
  key: string,
): Promise<BibEntry | undefined> {
  return (await bibliography()).find((e) =>
    e.attachments.some((a) => a.key === key),
  );
}

/** Indexes the bibliography whenever the file is (re)indexed as a document. */
export async function indexBibliography(name: string) {
  const { bibliography: bibName } = await zoteroConfig();
  if (name !== bibName) {
    return;
  }
  cache = undefined;
  const entries = await bibliography();
  await index.indexObjects<ZoteroObject>(
    name,
    entries.map((e) => ({
      ref: e.citekey,
      tag: "zotero",
      citekey: e.citekey,
      type: e.type,
      title: e.title,
      authors: e.authors,
      ...(e.year ? { year: e.year } : {}),
      short: shortCitation(e),
      keywords: e.keywords,
      attachments: e.attachments.map((a) => a.key),
      attachmentNames: e.attachments.map((a) => a.name),
    })),
  );
}

// ---------------------------------------------------------------------------
// Citations and references in notes
// ---------------------------------------------------------------------------

const referenceLine = /^#\+reference:\s*(.+)$/im;

/** The citekey a reference note is about, from its `#+reference:` line. */
export function referenceOf(text: string): string | undefined {
  return referenceLine.exec(text)?.[1].trim().replace(/^@/, "");
}

/**
 * Relations from a note to the items it cites (`citation`) and, for a
 * reference note, to the item it is about (`reference`).
 */
export async function indexCitations(
  pageMeta: PageMeta,
  _frontmatter: FrontMatter,
  tree: ParseTree,
  text: string,
): Promise<ObjectValue<any>[]> {
  const objects: RelationObject[] = [];
  const lineIndex = buildLineIndex(text);
  const relation = (
    kind: "citation" | "reference",
    citekey: string,
    range?: [number, number],
  ): RelationObject => ({
    ref: `${pageMeta.name}@${range ? range[0] : kind}:${citekey}`,
    tag: "relation",
    kind,
    from: pageMeta.name,
    fromTag: "page",
    to: citekey,
    toTag: "zotero",
    page: pageMeta.name,
    ...(range
      ? { range, snippet: extractSnippet(pageMeta.name, lineIndex, range[0]) }
      : {}),
    pageLastModified: pageMeta.lastModified,
  });

  for (const key of collectNodesOfType(tree, "OrgCitationKey")) {
    const citekey = renderToText(key).replace(/^@/, "");
    objects.push(relation("citation", citekey, [key.from!, key.to!]));
  }
  // `[[zotero:KEY]]` names an attachment; index it against its citekey when
  // the bibliography knows it, so it counts as a citation of the item.
  for (const link of collectNodesOfType(tree, "OrgLink")) {
    const target = renderToText(
      link.children?.find((n) => n.type === "OrgLinkTarget"),
    );
    const m = /^zotero:([A-Z0-9]{8})$/.exec(target);
    if (!m) continue;
    const entry = await entryByItemKey(m[1]);
    if (entry) {
      objects.push(relation("citation", entry.citekey, [link.from!, link.to!]));
    }
  }
  const reference = referenceOf(text);
  if (reference) {
    objects.push(relation("reference", reference));
  }
  return objects;
}

// ---------------------------------------------------------------------------
// Opening
// ---------------------------------------------------------------------------

/**
 * Where a citation goes: zotero.org, whose reader opens the file on any
 * machine, or the desktop app on a device that has it.
 *
 * Whether *this* device has Zotero is a per-device preference, not a space
 * setting: the same space is read from a Mac with Zotero and a work machine
 * without one.
 */
export async function openCitekey(citekey: string): Promise<void> {
  const entry = await entryByCitekey(citekey);
  if (!entry) {
    await editor.flashNotification(
      `No bibliography entry for @${citekey}`,
      "error",
    );
    return;
  }
  await openEntry(entry, entry.attachments[0]?.key);
}

export async function openItemKey(key: string): Promise<void> {
  const entry = await entryByItemKey(key);
  await openEntry(entry, key);
}

async function openEntry(entry: BibEntry | undefined, itemKey?: string) {
  const { username } = await zoteroConfig();
  const desktop = await clientStore.get("zotero.desktop");
  if (desktop && entry) {
    // Better BibTeX registers `zotero://select/items/@citekey`; an attachment
    // key is a plain Zotero URL.
    await editor.openUrl(
      itemKey && !entry.attachments.length
        ? zoteroSelectUrl(itemKey)
        : `zotero://select/items/@${entry.citekey}`,
    );
    return;
  }
  if (itemKey && username) {
    await editor.openUrl(zoteroWebUrl(username, itemKey));
    return;
  }
  if (!username) {
    await editor.flashNotification(
      "Set zotero.username to open items at zotero.org",
      "error",
    );
    return;
  }
  await editor.flashNotification(
    `@${entry?.citekey ?? itemKey} has no file at zotero.org; open it in Zotero`,
    "info",
  );
}

export async function toggleDesktopCommand() {
  const now = !(await clientStore.get("zotero.desktop"));
  await clientStore.set("zotero.desktop", now);
  await editor.flashNotification(
    now
      ? "Citations open in the Zotero app on this device"
      : "Citations open at zotero.org on this device",
    "info",
  );
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/** A picker over the bibliography; returns the chosen entry. */
export async function pickEntry(
  label = "Cite",
  help = "Select a Zotero item",
): Promise<BibEntry | undefined> {
  const entries = await bibliography();
  if (!entries.length) {
    await editor.flashNotification(
      `No bibliography found; export one from Zotero to ${(await zoteroConfig()).bibliography}`,
      "error",
    );
    return;
  }
  const choice = await editor.filterBox(
    label,
    entries.map((e) => ({
      name: e.title,
      description: [shortCitation(e), e.type, e.citekey].join(" · "),
      citekey: e.citekey,
    })),
    help,
  );
  return choice && entries.find((e) => e.citekey === choice.citekey);
}

/** `Zotero: Insert Citation` — `[cite:@key]` at the cursor. */
export async function insertCitationCommand() {
  const entry = await pickEntry();
  if (!entry) return;
  const page = await editor.getCurrentPage();
  await editor.insertAtCursor(
    linkSyntaxFor(page) === "org"
      ? `[cite:@${entry.citekey}]`
      : `[@${entry.citekey}]`,
  );
}

/**
 * `Zotero: New Reference Note` — a Denote note about an item, carrying
 * `#+reference: citekey` as `citar-denote` writes it, so `citar-denote-open-note`
 * in Emacs finds the same note.
 */
export async function newReferenceNoteCommand() {
  const entry = await pickEntry(
    "Reference note",
    "Select the item the note is about",
  );
  if (!entry) return;
  const { referenceKeyword } = await zoteroConfig();
  const keywords = [
    ...new Set([referenceKeyword, ...entry.keywords.map(sluggifyKeyword)]),
  ]
    .filter(Boolean)
    .sort();
  const name = await createDenoteNote({
    title: entry.title,
    keywords,
    fileType: "org",
  });
  // Slip the reference line in after the identifier, where citar-denote puts it.
  const text = await space.readPage(name);
  const withReference = text.replace(
    /^(#\+identifier:.*)$/m,
    `$1\n#+reference:  ${entry.citekey}`,
  );
  await space.writePage(name, `${withReference}\n[cite:@${entry.citekey}]\n`);
  invalidateDenoteIdentifiers();
  await editor.navigate({ path: name as any });
}

function sluggifyKeyword(keyword: string): string {
  return keyword.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/** `Zotero: Open` — the citation or `zotero:` link under the cursor. */
export async function openUnderCursorCommand() {
  const text = await editor.getText();
  const pos = await editor.getCursor();
  const before = text.lastIndexOf("[", pos);
  const after = text.indexOf("]", pos);
  const around =
    before !== -1 && after !== -1 ? text.slice(before, after + 1) : "";
  const cite = /^\[cite[^:]*:(.*)\]$/.exec(around);
  if (cite) {
    const keys = citekeysIn(cite[1]);
    if (keys.length) return openCitekey(keys[0]);
  }
  const link = /zotero:([A-Z0-9]{8})/.exec(around);
  if (link) return openItemKey(link[1]);
  await editor.flashNotification("No citation under the cursor", "info");
}

// ---------------------------------------------------------------------------
// Adding a file
// ---------------------------------------------------------------------------

/**
 * Puts a file into the Zotero library as a standalone attachment and returns
 * its item key -- the key a `[[zotero:KEY]]` link takes, and the one the
 * zotero.org reader opens. The desktop app then syncs the item down like any
 * other; metadata retrieval for a PDF is a right-click there when it suits.
 *
 * The fetch is the plug sandbox's, which the server proxies -- no CORS.
 */
export async function addFile(
  name: string,
  contentType: string,
  content: Uint8Array,
): Promise<string> {
  const { userId, apiKey } = await zoteroConfig();
  if (!userId || !apiKey) {
    throw new Error(
      "Set zotero.userId and zotero.apiKey to add files to Zotero",
    );
  }
  return uploadToZotero({ userId, apiKey }, name, contentType, content);
}

/** Whether adding to Zotero is configured at all. */
export async function canAddFiles(): Promise<boolean> {
  const { userId, apiKey } = await zoteroConfig();
  return !!(userId && apiKey);
}

/** The link to write into a note for an item just added. */
export async function linkForItem(
  key: string,
  name: string,
  page: string,
): Promise<string> {
  const { username } = await zoteroConfig();
  if (linkSyntaxFor(page) === "org") {
    return `[[zotero:${key}][${name}]]`;
  }
  return username
    ? `[${name}](${zoteroWebUrl(username, key)})`
    : `[${name}](${zoteroSelectUrl(key)})`;
}

/** `Zotero: Add File` — the upload dialog, into Zotero, a link at the cursor. */
export async function addFileCommand() {
  if (!(await canAddFiles())) {
    await editor.flashNotification(
      "Set zotero.userId and zotero.apiKey to add files to Zotero",
      "error",
    );
    return;
  }
  const file = await editor.uploadFile();
  await editor.flashNotification(`Adding ${file.name} to Zotero…`, "info");
  const key = await addFile(file.name, file.contentType, file.content);
  const page = await editor.getCurrentPage();
  await editor.insertAtCursor(await linkForItem(key, file.name, page));
}
