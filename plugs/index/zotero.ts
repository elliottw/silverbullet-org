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
import {
  collectionPaths,
  createParentItem,
  getZoteroItem,
  listCollections,
  listDeletedZoteroItems,
  listZoteroItems,
  setZoteroItemTags,
  uploadToZotero,
  type ZoteroCredentials,
} from "@silverbulletmd/silverbullet/lib/zotero_api";
import {
  detectStoragePath,
  renderBibtex,
  zoteroItemToEntry,
  type ZoteroApiItem,
} from "@silverbulletmd/silverbullet/lib/zotero_bib";
import {
  mergeTags,
  slugifyTag,
} from "@silverbulletmd/silverbullet/lib/zotero_sync";
import {
  denoteFileType,
  isDenoteNoteFile,
  parseDenoteFrontMatter,
  parseDenoteName,
  rewriteDenoteFrontMatter,
} from "@silverbulletmd/silverbullet/lib/denote";
import {
  createDenoteNote,
  invalidateDenoteIdentifiers,
  linkFor,
  renameFromFrontMatter,
} from "./denote.ts";
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
  /** The Zotero item key, when the library came from the API. */
  item?: string;
  /** Bibliography fields, for writing the `.bib` back out. */
  fields?: Record<string, string>;
}>;

/** Where the library sync got to, so the next one can be incremental. */
export type ZoteroSyncObject = ObjectValue<{
  tag: "zotero-sync";
  /** The library version the index is current with. */
  version: number;
  /** Whether a full pass has ever completed; an incremental sync needs one. */
  complete: boolean;
  items: number;
  at: string;
}>;

/** The pseudo-file API-sourced items are indexed under. */
const libraryOwner = "zotero-library";

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
  /** The API's base URL. Only a test has a reason to change it. */
  api?: string;
  /** The collection the picker is scoped to, by name; all of them if unset. */
  rootCollection?: string;
  /** Keyword a reference note carries; `citar-denote` uses `bib`. */
  referenceKeyword: string;
  /**
   * Whether adding a document to Zotero also makes a reference note and
   * links that, rather than linking the file itself. On by default: a
   * citation then has somewhere to live.
   */
  referenceNoteOnAdd: boolean;
  /**
   * How a reference note's keywords and its item's tags are kept in step:
   * `both` (two-way), `fromZotero` (tags arrive, nothing is written to the
   * library), or `off`.
   */
  syncKeywords: "both" | "fromZotero" | "off";
  /**
   * Where Zotero keeps its files on the machine that reads the bibliography,
   * for the `file` lines `citar-file-open` follows. Learned from a
   * bibliography already in the space when unset.
   */
  storagePath?: string;
  /** How stale the library may get before a page load refreshes it, in minutes. */
  syncEvery: number;
};

export async function zoteroConfig(): Promise<ZoteroConfig> {
  const cfg = (await system.getConfig("zotero", {})) as Partial<ZoteroConfig>;
  return {
    bibliography: cfg.bibliography ?? "zotero.bib",
    username: cfg.username,
    userId: cfg.userId,
    apiKey: cfg.apiKey,
    api: cfg.api,
    rootCollection: cfg.rootCollection,
    referenceKeyword: cfg.referenceKeyword ?? "bib",
    referenceNoteOnAdd: cfg.referenceNoteOnAdd ?? true,
    syncKeywords: cfg.syncKeywords ?? "both",
    storagePath: cfg.storagePath,
    syncEvery: cfg.syncEvery ?? 15,
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

/**
 * Every item the library holds, as bibliography entries.
 *
 * The index is the library when the API has been synced into it -- fresh,
 * with tags and item keys the export does not carry. The parsed `.bib` is the
 * fallback: a device with no API key, or one that has never synced, still
 * reads citations and titles from the file.
 */
export async function entries(): Promise<BibEntry[]> {
  const objects = await index.queryLuaObjects<ZoteroObject>("zotero", {});
  const fromApi = objects.filter((o) => o.item);
  if (fromApi.length === 0) {
    return bibliography();
  }
  return fromApi.map(objectToEntry);
}

function objectToEntry(o: ZoteroObject): BibEntry {
  return {
    citekey: o.citekey,
    type: o.type,
    title: o.title,
    authors: o.authors ?? [],
    ...(o.year ? { year: o.year } : {}),
    keywords: o.keywords ?? [],
    attachments: (o.attachments ?? []).map((key, i) => ({
      key,
      name: (o.attachmentNames ?? [])[i] ?? key,
    })),
    fields: o.fields ?? {},
  };
}

export async function entryByCitekey(
  citekey: string,
): Promise<BibEntry | undefined> {
  return (await entries()).find((e) => e.citekey === citekey);
}

/** The entry owning an attachment key, for `[[zotero:KEY]]` links. */
export async function entryByItemKey(
  key: string,
): Promise<BibEntry | undefined> {
  return (await entries()).find((e) =>
    e.attachments.some((a) => a.key === key),
  );
}

/** The item key a citekey names, for writing tags back. */
export async function itemKeyForCitekey(
  citekey: string,
): Promise<string | undefined> {
  const objects = await index.queryLuaObjects<ZoteroObject>("zotero", {});
  return objects.find((o) => o.citekey === citekey)?.item;
}

/**
 * Indexes the bibliography whenever the file is (re)indexed as a document.
 *
 * Only when the API is not the source: with a synced library the file is
 * SilverBullet's own output, and re-indexing it would replace items that
 * carry their Zotero key and fields with poorer copies parsed back out of
 * what we just wrote.
 */
export async function indexBibliography(name: string) {
  const { bibliography: bibName } = await zoteroConfig();
  if (name !== bibName) {
    return;
  }
  cache = undefined;
  if (await librarySynced()) {
    return;
  }
  const parsed = await bibliography();
  await index.indexObjects<ZoteroObject>(
    name,
    parsed.map((e) => ({
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
      fields: e.fields,
    })),
  );
}

/**
 * Whether the API is the library on this device: a full sync has completed
 * *and* found something. An empty answer -- a key without access, the wrong
 * user id -- must not take a hand-kept bibliography out of service.
 */
async function librarySynced(): Promise<boolean> {
  const state = await syncState();
  return !!state?.complete && state.items > 0;
}

async function syncState(): Promise<ZoteroSyncObject | undefined> {
  const states = await index.queryLuaObjects<ZoteroSyncObject>(
    "zotero-sync",
    {},
  );
  return states[0];
}

// ---------------------------------------------------------------------------
// Citations and references in notes
// ---------------------------------------------------------------------------

// `[ \t]*`, not `\s*`: `\s` matches a newline, so an empty line here would
// capture whatever came next -- the body of the note -- as its value.
const referenceLine = /^#\+reference:[ \t]*(.+)$/im;

/** The citekey a reference note is about, from its `#+reference:` line. */
export function referenceOf(text: string): string | undefined {
  return referenceLine.exec(text)?.[1].trim().replace(/^@/, "");
}

const itemLine = /^#\+zotero:[ \t]*(.+)$/im;
const syncedLine = /^#\+zotero_tags:[ \t]*(.*)$/im;

/** The Zotero item a reference note is about, from its `#+zotero:` line. */
export function itemOf(text: string): string | undefined {
  return itemLine.exec(text)?.[1].trim() || undefined;
}

/** The tag slugs the last sync left this note and its item agreeing on. */
export function syncedTagsOf(text: string): string[] {
  const raw = syncedLine.exec(text)?.[1] ?? "";
  return raw
    .split(/[\s,:]+/)
    .map(slugifyTag)
    .filter(Boolean);
}

/** The first `[[zotero:KEY]]` in a note -- the file it is about. */
function attachmentOf(text: string): string | undefined {
  return /\[\[zotero:([A-Z0-9]{8})\]/.exec(text)?.[1];
}

/**
 * A reference note, as the sync pass needs it: which item it is about, and
 * the two tag lists to reconcile. Indexed so the pass is a query rather than
 * a walk over every note in the library.
 */
export type ZoteroNoteObject = ObjectValue<{
  tag: "zotero-note";
  page: string;
  citekey?: string;
  item?: string;
  attachment?: string;
  keywords: string[];
  synced: string[];
  pageLastModified: string;
}>;

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
  const item = itemOf(text);
  const attachment = attachmentOf(text);
  const { referenceKeyword } = await zoteroConfig();
  const parsed = parseDenoteFrontMatter(
    text,
    denoteFileType(pageMeta.name.endsWith(".org") ? ".org" : ".md", text),
  );
  const isReferenceNote =
    !!reference ||
    !!item ||
    (parsed.keywords.includes(referenceKeyword) && !!attachment);
  const extra: ObjectValue<any>[] = isReferenceNote
    ? [
        {
          ref: pageMeta.name,
          tag: "zotero-note",
          page: pageMeta.name,
          ...(reference ? { citekey: reference } : {}),
          ...(item ? { item } : {}),
          ...(attachment ? { attachment } : {}),
          keywords: parsed.keywords as string[],
          synced: syncedTagsOf(text),
          pageLastModified: pageMeta.lastModified,
        } satisfies ZoteroNoteObject,
      ]
    : [];
  return [...objects, ...extra];
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
  const note = await createReferenceNote({
    title: entry.title,
    citekey: entry.citekey,
    keywords: entry.keywords,
    attachment: entry.attachments[0]?.key,
    fileName: entry.attachments[0]?.name,
  });
  await editor.navigate({ path: note.page as any });
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
): Promise<{ attachment: string; parent: string; title: string }> {
  const { userId, apiKey, api } = await zoteroConfig();
  if (!userId || !apiKey) {
    throw new Error(
      "Set zotero.userId and zotero.apiKey to add files to Zotero",
    );
  }
  const creds = { userId, apiKey, api };

  // What it is called. The file's own name is the honest default -- this is
  // not a paper library, and a title in the first pages is the exception --
  // and Enter accepts it.
  const proposed = titleFor(name, content);
  const title = await editor.prompt("Title:", proposed);
  if (title === undefined) {
    throw new Error("Cancelled");
  }

  // Where it goes, the way the connector's save dialog asks: the tree,
  // searchable, the last choice first.
  const collection = await pickCollection(creds);
  if (collection === undefined) {
    throw new Error("Cancelled");
  }

  // A regular item to cite, with the file as its child.
  const parent = await createParentItem(creds, {
    itemType: /\.html?$/i.test(name) ? "webpage" : "document",
    title: title.trim() || proposed,
    collections: collection ? [collection] : [],
  });
  const attachment = await uploadToZotero(creds, name, contentType, content, {
    parentItem: parent,
  });
  return { attachment, parent, title: title.trim() || proposed };
}

/**
 * Adding a document, the whole gesture: the file goes to Zotero, a reference
 * note is made for the item it hangs from, and what comes back is the link to
 * write where the drop happened. A citation then has somewhere to live -- the
 * note -- rather than pointing at a PDF.
 *
 * Set `zotero.referenceNoteOnAdd` to false to link the file itself instead.
 */
export async function addDocument(
  name: string,
  contentType: string,
  content: Uint8Array,
  page: string,
): Promise<string> {
  const { referenceNoteOnAdd } = await zoteroConfig();
  const { attachment, parent, title } = await addFile(
    name,
    contentType,
    content,
  );
  if (!referenceNoteOnAdd) {
    return linkForItem(attachment, name, page);
  }
  // The note first, and the link back to the caller: a drop must show its
  // result at once. The library gained an item, and the citekey Zotero mints
  // for it follows -- but only when that is a quick incremental sync. Reading
  // a whole library takes minutes, and a drop is not the moment for it.
  const note = await createReferenceNote({
    title,
    item: parent,
    attachment,
    fileName: name,
  });
  await editor.flashNotification(`Reference note: ${title}`);
  void fillInCitekey(note.page, attachment);
  return linkFor(linkSyntaxFor(page), `denote:${note.identifier}`, title);
}

/**
 * Brings the new item's citekey into its reference note, once the library
 * knows about it. Deliberately not awaited by the drop: it is a network
 * round trip, and nothing the writer is waiting on.
 */
async function fillInCitekey(page: string, attachment: string) {
  try {
    const state = await syncState();
    if (!state?.complete) {
      // Nothing synced on this device yet, and reading the library is a
      // two-minute job: `Zotero: Sync Library` is where that belongs. The
      // note carries the item key, so the citekey arrives with the next one.
      return;
    }
    await syncLibrary();
    const citekey = (await entryByItemKey(attachment))?.citekey;
    if (citekey) await syncReferenceNote(page);
  } catch (e: any) {
    console.warn("[zotero] could not fetch the citekey", e.message);
  }
}

/**
 * The reference note for an item: a Denote note carrying the reference
 * keyword, a link to the file, and the item's key.
 *
 * `#+reference:` is what `citar-denote` looks for, and it holds Better
 * BibTeX's citekey -- which does not exist yet for an item created moments
 * ago, since BBT writes it on its next export. So the note records the item
 * key in `#+zotero:` and the next sync fills the citekey in.
 */
export async function createReferenceNote(spec: {
  title: string;
  item?: string;
  attachment?: string;
  fileName?: string;
  citekey?: string;
  keywords?: string[];
}): Promise<{ page: string; identifier: string }> {
  const { referenceKeyword } = await zoteroConfig();
  const keywords = [
    ...new Set([referenceKeyword, ...(spec.keywords ?? []).map(slugifyTag)]),
  ]
    .filter(Boolean)
    .sort();
  // The note is written twice -- once by `createDenoteNote`, once with the
  // reference lines added -- and in between it carries the marker without a
  // reference yet. The keeper of the marker must not act on that half-state
  // and rename the file out from under the second write.
  marking = true;
  try {
    return await writeReferenceNote(spec, keywords);
  } finally {
    marking = false;
  }
}

async function writeReferenceNote(
  spec: {
    title: string;
    item?: string;
    attachment?: string;
    fileName?: string;
    citekey?: string;
    keywords?: string[];
  },
  keywords: string[],
): Promise<{ page: string; identifier: string }> {
  const page = await createDenoteNote({
    title: spec.title,
    keywords,
    fileType: "org",
  });
  let text = await space.readPage(page);
  if (spec.citekey) text = setLine(text, "reference", spec.citekey);
  if (spec.item) text = setLine(text, "zotero", spec.item);
  // Always, even with nothing in it: this note and the item it is about agree
  // on an empty set of tags, and recording that is what tells a later sync
  // that the note is not one that predates the arrangement. Without the line
  // a keyword added here would never be pushed.
  text = setLine(
    text,
    "zotero_tags",
    (spec.keywords ?? []).map(slugifyTag).join(" "),
    { keepEmpty: true },
  );
  const body = [
    spec.citekey ? `[cite:@${spec.citekey}]` : "",
    spec.attachment
      ? `[[zotero:${spec.attachment}][${spec.fileName ?? "the file"}]]`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
  await space.writePage(page, `${text.trimEnd()}\n\n${body}\n`);
  invalidateDenoteIdentifiers();
  const identifier = parseDenoteName(page)?.identifier ?? "";
  return { page, identifier };
}

/**
 * Sets a `#+key:` line in a note's front matter, after `#+identifier:` where
 * there is none yet -- the place `citar-denote` writes `#+reference:`. An
 * empty value removes the line.
 */
function setLine(
  text: string,
  key: string,
  value: string,
  options: { keepEmpty?: boolean } = {},
): string {
  const line = new RegExp(`^#\\+${key}:.*$`, "im");
  if (!value && !options.keepEmpty) {
    return text.replace(new RegExp(`^#\\+${key}:.*\\n?`, "im"), "");
  }
  const pad = " ".repeat(Math.max(1, 13 - key.length - 2));
  const rendered = `#+${key}:${pad}${value}`;
  if (line.test(text)) return text.replace(line, rendered);
  // A new line goes after the last one that belongs above it, so the front
  // matter reads in a stable order however the lines arrived.
  const order = [
    "title",
    "date",
    "filetags",
    "identifier",
    "signature",
    "reference",
    "zotero",
    "zotero_tags",
  ];
  const above = order.slice(0, Math.max(1, order.indexOf(key))).reverse();
  for (const before of above) {
    const anchor = new RegExp(`^#\\+${before}:.*$`, "im");
    if (anchor.test(text)) {
      return text.replace(anchor, (found) => `${found}\n${rendered}`);
    }
  }
  return `${rendered}\n${text}`;
}

/** The best title on offer for a file about to be added. */
function titleFor(name: string, content: Uint8Array): string {
  // A PDF's embedded title, when its Info dictionary is in the clear and a
  // scanner or word processor did not write it.
  if (/\.pdf$/i.test(name)) {
    const head = new TextDecoder("latin1").decode(content.subarray(0, 65536));
    const m = /\/Title\s*\(((?:\\.|[^)\\]){4,200})\)/.exec(head);
    const embedded = m?.[1].replace(/\\([()\\])/g, "$1").trim();
    if (
      embedded &&
      !/^(microsoft word|untitled|document\d*|scan|scanned|img_|dsc_|print|slide ?\d*)/i.test(
        embedded,
      ) &&
      !/\.(docx?|pdf|pptx?|xlsx?)$/i.test(embedded) &&
      !/[^\x20-\x7e\u00a0-\uffff]/.test(embedded)
    ) {
      return embedded;
    }
  }
  const stem = name
    .replace(/\.[^.]+$/, "")
    .replace(/\s+/g, " ")
    .trim();
  // Already words? Keep them. A slug gets its separators back.
  if (/\s/.test(stem) && /[a-z]/.test(stem) && /[A-Z]/.test(stem)) return stem;
  return stem
    .replace(/[_-]+/g, " ")
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * A picker over the library's collections, as paths, scoped to
 * `zotero.rootCollection` when set. The last choice is offered first, and
 * "no collection" is always available. Returns a key, "" for none, or
 * undefined when cancelled.
 */
async function pickCollection(
  creds: ZoteroCredentials,
): Promise<string | "" | undefined> {
  const { rootCollection } = await zoteroConfig();
  const collections = await listCollections(creds);
  const paths = collectionPaths(collections);
  const last = (await clientStore.get("zotero.lastCollection")) as
    | string
    | undefined;
  const options = [...paths]
    .filter(
      ([, path]) =>
        !rootCollection ||
        path.startsWith(`${rootCollection} / `) ||
        path === rootCollection,
    )
    .map(([key, path]) => ({
      name: path,
      description: key === last ? "last used" : "",
      key,
      orderId: key === last ? -1 : 0,
    }))
    .sort((a, b) => a.orderId - b.orderId || a.name.localeCompare(b.name));
  const choice = await editor.filterBox(
    "Collection",
    [
      ...options,
      { name: "(no collection)", description: "unfiled", key: "", orderId: 1 },
    ],
    "Where in Zotero the item is filed",
  );
  if (!choice) return undefined;
  if (choice.key) await clientStore.set("zotero.lastCollection", choice.key);
  return choice.key as string;
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
  const page = await editor.getCurrentPage();
  let link: string;
  try {
    link = await addDocument(file.name, file.contentType, file.content, page);
  } catch (e: any) {
    if (/Cancelled/.test(String(e.message))) return;
    throw e;
  }
  await editor.insertAtCursor(link);
}

// ---------------------------------------------------------------------------
// Keeping keywords and tags in step
// ---------------------------------------------------------------------------

/** Guards against the sync's own writes re-entering it. */
let syncing = false;

/** Guards the marker's own writes. */
let marking = false;

/**
 * Keeps the reference keyword in step with the front matter.
 *
 * `bib` is not a subject -- it is how Emacs finds these notes:
 * `citar-denote--get-notes` globs the *file names* for `_bib`, which is what
 * Denote's "metadata in the name" buys. So the marker has to be in the name,
 * but it is derived from `#+reference:` or `#+zotero:` rather than typed:
 * added when a note gains one, removed when it loses the last. citar-denote
 * maintains it the same way, so neither side surprises the other.
 */
export async function maintainReferenceKeyword(page: string): Promise<boolean> {
  const { referenceKeyword } = await zoteroConfig();
  if (!referenceKeyword || marking || syncing) return false;
  const parsedName = parseDenoteName(page);
  if (!parsedName?.identifier || !isDenoteNoteFile(page)) return false;
  const open = (await currentPage()) === page;
  let text: string;
  try {
    text = open ? await editor.getText() : await space.readPage(page);
  } catch {
    return false;
  }
  const fileType = denoteFileType(parsedName.extension, text);
  const parsed = parseDenoteFrontMatter(text, fileType);
  const keywords =
    (parsed.hasKeywords
      ? (parsed.keywords as string[])
      : parsedName.keywords) ?? [];
  const isReference = !!referenceOf(text) || !!itemOf(text);
  const marked = keywords.includes(referenceKeyword);
  if (isReference === marked) return false;
  const updated = rewriteDenoteFrontMatter(text, fileType, {
    keywords: (isReference
      ? [...new Set([...keywords, referenceKeyword])]
      : keywords.filter((k) => k !== referenceKeyword)
    ).sort(),
  });
  if (updated === text) return false;
  marking = true;
  try {
    if (open) {
      if ((await editor.getText()) !== text) return false;
      await editor.setText(updated);
      await editor.save();
    } else {
      await space.writePage(page, updated);
      await renameFromFrontMatter(page);
    }
  } finally {
    marking = false;
  }
  return true;
}

/** `page:saved`: the marker follows the front matter, quietly. */
export async function maintainReferenceKeywordOnSave(page: string) {
  try {
    await maintainReferenceKeyword(page);
  } catch (e: any) {
    console.warn("[zotero] could not update the reference keyword", e.message);
  }
}

/**
 * Reconciles one reference note with its Zotero item: the citekey, once
 * Better BibTeX has minted one, and the keywords against the item's tags.
 *
 * The note keeps the last agreed tag set in `#+zotero_tags:`, so a keyword
 * added here and a tag added there are told apart rather than fought over --
 * see `mergeTags`. Returns what it changed, for the command's report.
 */
export async function syncReferenceNote(
  page: string,
  options: {
    /**
     * Whether a note that has never been synced may push its keywords up as
     * tags. Opening a note does not: its keywords predate the arrangement,
     * and sending a library's worth of them to Zotero is not something to do
     * behind someone's back. `Zotero: Sync Reference Notes` does.
     */
    firstContactPush?: boolean;
  } = {},
): Promise<{ note: boolean; zotero: boolean } | undefined> {
  const { syncKeywords, referenceKeyword, userId, apiKey, api } =
    await zoteroConfig();
  if (syncKeywords === "off" || syncing) return;
  // For the page the editor is showing, the editor is what it says it is:
  // reading the file instead would hand back a version from before the last
  // keystroke, and writing that back would undo it.
  const open = (await currentPage()) === page;
  let text: string;
  try {
    text = open ? await editor.getText() : await space.readPage(page);
  } catch {
    return;
  }
  const citekey = referenceOf(text);
  const attachment = /\[\[zotero:([A-Z0-9]{8})\]/.exec(text)?.[1];
  const entry = citekey
    ? await entryByCitekey(citekey)
    : attachment
      ? await entryByItemKey(attachment)
      : undefined;

  const parsed = parseDenoteFrontMatter(text, denoteFileType(".org", text));
  const noteKeywords = (parsed.keywords as string[]).filter(
    (k) => k !== referenceKeyword,
  );
  const shadow = syncedTagsOf(text);
  // First contact is for a note that predates this arrangement. A note
  // carrying `#+zotero:` was written by SilverBullet against a real item, so
  // its keywords are ours to push even before the first sync records a shadow.
  const firstContact = !syncedLine.test(text) && !itemLine.test(text);
  const canPush =
    syncKeywords === "both" &&
    !!userId &&
    !!apiKey &&
    (!firstContact || options.firstContactPush === true);

  // Nothing to reconcile: the note, the shadow and what the library says all
  // agree, and the citekey is in place. Returning here is what keeps opening a
  // reference note from costing a request.
  const agrees = (a: string[], b: string[]) =>
    a.length === b.length &&
    [...a].sort().every((x, i) => x === [...b].sort()[i]);
  const bibTags = (entry?.keywords ?? []).map(slugifyTag).filter(Boolean);
  if (
    entry &&
    citekey &&
    agrees(noteKeywords, shadow) &&
    agrees(shadow, bibTags)
  ) {
    return { note: false, zotero: false };
  }

  // Which item this note is about. `#+zotero:` is what SilverBullet wrote when
  // it made the note; the other two are for a note that came from a picker.
  const item =
    itemOf(text) ??
    (entry ? await itemKeyForCitekey(entry.citekey) : undefined) ??
    (await parentOf(attachment));
  const creds: ZoteroCredentials | undefined =
    userId && apiKey ? { userId, apiKey, api } : undefined;
  // The item itself, when we know which it is: its tags are authoritative, it
  // carries the citekey Zotero minted, and writing needs its version. This is
  // also what makes a note work on a device whose library has not been synced
  // -- which is every device, the first time a drop makes a note.
  const current = creds && item ? await getZoteroItem(creds, item) : undefined;
  if (!entry && !current) return;
  // Only tags somebody chose. Zotero's *automatic* tags come from importers --
  // a journal article can arrive with twenty -- and these keywords end up in
  // the note's file name. They are left exactly as they are: read past here,
  // and written back untouched on a push.
  const automatic = (current?.tags ?? []).filter((x) => x.type === 1);
  const zoteroTags = current
    ? current.tags.filter((x) => x.type !== 1).map((x) => x.tag)
    : (entry?.keywords ?? []);
  const push = canPush && !!current;
  const merged = mergeTags({ noteKeywords, zoteroTags, shadow, push });

  // Zotero first: a failed write must not leave the note claiming agreement.
  let zoteroWritten = false;
  if (merged.zoteroChanged && push && current) {
    zoteroWritten = await setZoteroItemTags(
      creds!,
      current.key,
      [...merged.tags.map((tag) => ({ tag })), ...automatic],
      current.version,
    );
  }
  if (zoteroWritten && item && !itemOf(text)) {
    text = setLine(text, "zotero", item);
  }

  let updated = text;
  // The citekey: Zotero's own, from the item or from the bibliography.
  const resolved = citekey ?? current?.citationKey ?? entry?.citekey;
  if (!citekey && resolved) {
    updated = setLine(updated, "reference", resolved);
  }
  if (merged.noteChanged) {
    updated = rewriteDenoteFrontMatter(updated, "org", {
      keywords: [...new Set([referenceKeyword, ...merged.keywords])]
        .filter(Boolean)
        .sort(),
    });
  }
  // The shadow records only what both sides really hold: when a push failed,
  // what the note last agreed on stands.
  const agreed =
    merged.zoteroChanged && push && !zoteroWritten ? shadow : merged.shadow;
  updated = setLine(updated, "zotero_tags", agreed.join(" "), {
    keepEmpty: true,
  });

  if (
    updated === (open ? await editor.getText() : await space.readPage(page))
  ) {
    return { note: false, zotero: zoteroWritten };
  }
  syncing = true;
  try {
    // The page the editor is showing belongs to the editor: writing it
    // underneath would be overwritten by the next save. Its own save then
    // brings the file name in line (`renameFromFrontMatterOnSave`).
    if (open) {
      // Someone typed while this was deciding: their keystrokes win, and the
      // next open syncs what they left.
      if ((await editor.getText()) !== text) {
        return { note: false, zotero: zoteroWritten };
      }
      await editor.setText(updated);
      await editor.save();
    } else {
      await space.writePage(page, updated);
      // Keywords live in the file name too.
      await renameFromFrontMatter(page);
    }
  } finally {
    syncing = false;
  }
  return { note: true, zotero: zoteroWritten };
}

/** The page the editor is showing, or undefined outside one. */
async function currentPage(): Promise<string | undefined> {
  try {
    return await editor.getCurrentPage();
  } catch {
    return undefined;
  }
}

/** The item an attachment hangs from, asked of the API. */
async function parentOf(attachment?: string): Promise<string | undefined> {
  if (!attachment) return undefined;
  const { userId, apiKey, api } = await zoteroConfig();
  if (!userId || !apiKey) return undefined;
  const item = await getZoteroItem({ userId, apiKey, api }, attachment);
  return item?.parentItem;
}

/** Syncs the reference note being opened, if that is what it is. */
export async function syncReferenceNoteOnOpen(page: string) {
  try {
    await syncReferenceNote(page, { firstContactPush: false });
  } catch (e: any) {
    console.warn("[zotero] could not sync", page, e.message);
  }
}

/** `Zotero: Sync Reference Notes` -- every reference note in the library. */
export async function syncReferenceNotesCommand() {
  const { syncKeywords } = await zoteroConfig();
  if (syncKeywords === "off") {
    await editor.flashNotification("zotero.syncKeywords is off", "error");
    return;
  }
  const notes = await index.queryLuaObjects<ZoteroNoteObject>(
    "zotero-note",
    {},
  );
  let noteChanges = 0;
  let zoteroChanges = 0;
  for (const note of notes) {
    const result = await syncReferenceNote(note.page, {
      firstContactPush: true,
    });
    if (result?.note) noteChanges++;
    if (result?.zotero) zoteroChanges++;
  }
  await editor.flashNotification(
    `${notes.length} reference notes: ${noteChanges} updated here, ${zoteroChanges} in Zotero`,
  );
}

// ---------------------------------------------------------------------------
// The library, from the API
// ---------------------------------------------------------------------------

/** Guards against two syncs at once -- a page load and a command, say. */
let synchronising = false;

/**
 * Brings the index up to date with the Zotero library, and writes the
 * bibliography out.
 *
 * Zotero versions its library, so this is one request per change rather than
 * a download of everything: the first pass pages through the whole library,
 * every later one asks only for what changed since the version the index
 * holds. Items the API lists without a citekey (Zotero's `citationKey`, which
 * is Better BibTeX's) are kept in the index but left out of the `.bib`: they
 * cannot be cited.
 *
 * The file is only written after a pass that left the index complete, so a
 * device that has just arrived cannot truncate a bibliography it has not
 * finished reading.
 */
export async function syncLibrary(
  options: { full?: boolean; force?: boolean } = {},
): Promise<
  | {
      items: number;
      version: number;
      wrote: boolean;
      incremental: boolean;
      fetched: number;
    }
  | undefined
> {
  const { userId, apiKey, api, bibliography: bibName } = await zoteroConfig();
  if (!userId || !apiKey || synchronising) return;
  const creds: ZoteroCredentials = { userId, apiKey, api };
  synchronising = true;
  try {
    const state = await syncState();
    // What the index already holds, by item key, so an incremental pass can
    // merge rather than replace.
    const held = new Map<string, ZoteroObject>();
    for (const o of await index.queryLuaObjects<ZoteroObject>("zotero", {})) {
      if (o.item) held.set(o.item, o);
    }
    // Incremental only against something: an index that was cleared (a
    // reindex, a new browser) has nothing to merge into, and asking only for
    // what changed since would leave it thin for ever.
    const incremental = !options.full && !!state?.complete && held.size > 0;
    const since = incremental ? state!.version : undefined;
    const items = new Map<string, ZoteroApiItem>();
    const children = new Map<string, ZoteroApiItem[]>();
    let version = state?.version ?? 0;
    let total: number | undefined;
    let fetched = 0;
    // Highlights and standalone notes are the bulk of a library that has been
    // read in, and none of them can be cited: leaving them out of the query
    // is most of what makes a full pass bearable.
    const itemType = "-annotation || note";
    for (let start = 0; ; start += 100) {
      const page = await listZoteroItems(creds, {
        since,
        start,
        limit: 100,
        itemType,
      });
      version = Math.max(version, page.version);
      total ??= page.total;
      fetched += page.items.length;
      for (const raw of page.items) {
        const item = raw as unknown as ZoteroApiItem;
        if (!item.key) continue;
        if (item.itemType === "annotation" || item.itemType === "note") {
          continue;
        }
        if (item.parentItem) {
          children.set(item.parentItem, [
            ...(children.get(item.parentItem) ?? []),
            item,
          ]);
        } else {
          items.set(item.key, item);
        }
      }
      if (page.items.length < 100) break;
      if (start > 0 && start % 1000 === 0) {
        console.log(
          `[zotero] ${fetched}${total ? ` of ${total}` : ""} objects read`,
        );
      }
    }

    // An attachment that changed on its own: its parent has to be rewritten
    // with it, and an incremental pass did not list the parent.
    const orphanParents = [...children.keys()].filter((k) => !items.has(k));
    for (const key of orphanParents) {
      const parent = await getZoteroItem(creds, key);
      if (!parent) continue;
      const kept = held.get(key);
      items.set(key, {
        key,
        itemType: parent.itemType,
        citationKey: kept?.citekey,
        title: parent.title,
        tags: parent.tags,
      } as ZoteroApiItem);
    }

    const storagePath = await storagePathFor(bibName);
    const updated: ZoteroObject[] = [];
    for (const [key, item] of items) {
      const kids = children.get(key) ?? [];
      // An incremental pass lists a parent without its unchanged children, so
      // the attachments already on record stand unless new ones arrived.
      const kept = held.get(key);
      const entry = zoteroItemToEntry(item, kids, storagePath);
      const attachments: { key: string; name: string }[] = kids.length
        ? entry.attachments
        : (kept?.attachments ?? []).map((k: string, i: number) => ({
            key: k,
            name: (kept?.attachmentNames ?? [])[i] ?? k,
          }));
      if (!kids.length && attachments.length) {
        entry.attachments = attachments;
        entry.fields.file = attachments
          .map(
            (a: { key: string; name: string }) =>
              `${storagePath}/${a.key}/${a.name}`,
          )
          .join(";");
      }
      updated.push({
        ref: item.key,
        tag: "zotero",
        item: item.key,
        citekey: entry.citekey,
        type: entry.type,
        title: entry.title,
        authors: entry.authors,
        ...(entry.year ? { year: entry.year } : {}),
        short: shortCitation(entry),
        keywords: entry.keywords,
        attachments: entry.attachments.map(
          (a: { key: string; name: string }) => a.key,
        ),
        attachmentNames: entry.attachments.map(
          (a: { key: string; name: string }) => a.name,
        ),
        fields: entry.fields,
      });
    }

    const deleted =
      since !== undefined ? await listDeletedZoteroItems(creds, since) : [];
    const byKey = new Map(held);
    for (const key of deleted) byKey.delete(key);
    for (const o of updated) byKey.set(o.item!, o);

    // Everything in one batch under a name of its own: the bibliography file
    // is indexed separately, and must not clear these when it is written.
    await index.indexObjects<ZoteroObject | ZoteroSyncObject>(libraryOwner, [
      ...byKey.values(),
      {
        ref: "library",
        tag: "zotero-sync",
        version,
        complete: true,
        items: byKey.size,
        at: new Date().toISOString(),
      },
    ]);
    cache = undefined;

    // The guard against writing a bibliography out of a half-read library:
    // what the query said it would answer with, against what arrived --
    // parents *and* their attachments, which is what was asked for.
    const consistent = incremental || total === undefined || fetched >= total;
    let wrote = false;
    if (consistent) {
      wrote = await writeBibliography([...byKey.values()].map(objectToEntry), {
        force: options.force,
      });
    }
    return { items: byKey.size, version, wrote, incremental, fetched };
  } finally {
    synchronising = false;
  }
}

/** Where the `file` lines should point, configured or learned from the file. */
async function storagePathFor(bibName: string): Promise<string> {
  const { storagePath } = await zoteroConfig();
  if (storagePath) return storagePath;
  try {
    const text = new TextDecoder().decode(await space.readDocument(bibName));
    const found = detectStoragePath(text);
    if (found) return found;
  } catch {
    // No bibliography yet.
  }
  return "~/Zotero/storage";
}

/**
 * Writes the bibliography, and says whether it changed.
 *
 * It refuses to make the file dramatically smaller than it is. The library is
 * read over a network from an index that a device may hold only part of, and
 * the failure to avoid at all costs is a sync that answers with little or
 * nothing and takes a bibliography -- the file Emacs cites from -- with it.
 * A deletion in Zotero of more than a tenth of the library is rare enough to
 * be worth confirming with `Zotero: Resync Library`, which bypasses this.
 */
async function writeBibliography(
  list: BibEntry[],
  options: { force?: boolean } = {},
): Promise<boolean> {
  const { bibliography: bibName } = await zoteroConfig();
  const rendered = renderBibtex(list);
  let current = "";
  try {
    current = new TextDecoder().decode(await space.readDocument(bibName));
  } catch {
    // Not there yet.
  }
  if (current === rendered) return false;
  const had = (current.match(/^@/gm) ?? []).length;
  const has = (rendered.match(/^@/gm) ?? []).length;
  if (!options.force && had > 0 && has < had * 0.9) {
    console.warn(
      `[zotero] not writing ${bibName}: ${has} entries would replace ${had}`,
    );
    return false;
  }
  await space.writeDocument(bibName, new TextEncoder().encode(rendered));
  return true;
}

/** `Zotero: Sync Library` -- the whole library, on demand. */
export async function syncLibraryCommand() {
  if (!(await canAddFiles())) {
    await editor.flashNotification(
      "Set zotero.userId and zotero.apiKey to sync the library",
      "error",
    );
    return;
  }
  await editor.flashNotification("Syncing the Zotero library…");
  const result = await syncLibrary();
  if (!result) {
    await editor.flashNotification("A sync is already running", "error");
    return;
  }
  await editor.flashNotification(
    `${result.incremental ? "Refreshed" : "Read the library"}: ` +
      `${result.fetched} changed, ${result.items} items, v${result.version}` +
      (result.wrote ? "; bibliography written" : "; bibliography unchanged"),
  );
}

/** `Zotero: Resync Library` -- from scratch, when the index looks wrong. */
export async function resyncLibraryCommand() {
  await editor.flashNotification("Reading the whole Zotero library…");
  const result = await syncLibrary({ full: true, force: true });
  await editor.flashNotification(
    result
      ? `Read the library: ${result.items} items, v${result.version}` +
          (result.wrote ? "; bibliography written" : "; bibliography unchanged")
      : "A sync is already running",
  );
}

/**
 * Keeps a synced library fresh without a timer: a page load refreshes it when
 * it is older than `zotero.syncEvery` minutes, which costs one request when
 * nothing has changed.
 *
 * The *first* pass is not done here. Reading a whole library is thousands of
 * items over tens of requests, and that belongs to a command you ran, with a
 * notification -- not to a page load that happens to be the first one.
 */
export async function syncLibraryWhenStale() {
  const { userId, apiKey, syncEvery } = await zoteroConfig();
  if (!userId || !apiKey) return;
  const state = await syncState();
  if (!state?.complete) return;
  const age = state?.at ? Date.now() - new Date(state.at).getTime() : Infinity;
  if (age < syncEvery * 60_000) return;
  try {
    await syncLibrary();
  } catch (e: any) {
    console.warn("[zotero] could not sync the library", e.message);
  }
}

/**
 * The keyword that marks a reference note, which is maintained rather than
 * chosen -- see `maintainReferenceKeyword`. Exported so the keyword pickers
 * and the keyword views can leave it out of what they offer and count.
 */
export async function referenceKeywordName(): Promise<string> {
  const { referenceKeyword } = await zoteroConfig();
  return referenceKeyword;
}
