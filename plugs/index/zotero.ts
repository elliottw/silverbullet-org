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
  setZoteroItemTags,
  uploadToZotero,
  type ZoteroCredentials,
} from "@silverbulletmd/silverbullet/lib/zotero_api";
import {
  mergeTags,
  slugifyTag,
} from "@silverbulletmd/silverbullet/lib/zotero_sync";
import {
  denoteFileType,
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

const itemLine = /^#\+zotero:\s*(.+)$/im;
const syncedLine = /^#\+zotero_tags:\s*(.*)$/im;

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
  const note = await createReferenceNote({
    title,
    item: parent,
    attachment,
    fileName: name,
  });
  await editor.flashNotification(`Reference note: ${title}`);
  return linkFor(linkSyntaxFor(page), `denote:${note.identifier}`, title);
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
  const page = await createDenoteNote({
    title: spec.title,
    keywords,
    fileType: "org",
  });
  let text = await space.readPage(page);
  if (spec.citekey) text = setLine(text, "reference", spec.citekey);
  if (spec.item) text = setLine(text, "zotero", spec.item);
  text = setLine(
    text,
    "zotero_tags",
    (spec.keywords ?? []).map(slugifyTag).join(" "),
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
function setLine(text: string, key: string, value: string): string {
  const line = new RegExp(`^#\\+${key}:.*$`, "im");
  if (!value) {
    return text.replace(new RegExp(`^#\\+${key}:.*\\n?`, "im"), "");
  }
  const pad = " ".repeat(Math.max(1, 13 - key.length - 2));
  const rendered = `#+${key}:${pad}${value}`;
  if (line.test(text)) return text.replace(line, rendered);
  return text.replace(/^(#\+identifier:.*)$/m, `$1\n${rendered}`);
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
  let text: string;
  try {
    text = await space.readPage(page);
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
  if (!entry) return;

  const parsed = parseDenoteFrontMatter(text, denoteFileType(".org", text));
  const noteKeywords = (parsed.keywords as string[]).filter(
    (k) => k !== referenceKeyword,
  );
  const shadow = syncedTagsOf(text);
  const firstContact = !syncedLine.test(text);
  const canPush =
    syncKeywords === "both" &&
    !!userId &&
    !!apiKey &&
    (!firstContact || options.firstContactPush === true);

  // Nothing to reconcile: the note, the shadow and the bibliography all say
  // the same, and the citekey is in place. Returning here is what keeps
  // opening a reference note from costing a request.
  const agrees = (a: string[], b: string[]) =>
    a.length === b.length &&
    [...a].sort().every((x, i) => x === [...b].sort()[i]);
  const bibTags = entry.keywords.map(slugifyTag).filter(Boolean);
  if (citekey && agrees(noteKeywords, shadow) && agrees(shadow, bibTags)) {
    return { note: false, zotero: false };
  }

  // Zotero's own tags, from the API: the bibliography is Better BibTeX's
  // export and lags a change by however long until its next write, so a tag
  // pushed a moment ago would read back as one Zotero had dropped. The export
  // stays the authority on the citekey, which is BBT's to mint.
  const item = itemOf(text) ?? (await parentOf(attachment));
  const creds: ZoteroCredentials | undefined =
    userId && apiKey ? { userId, apiKey, api } : undefined;
  const current = creds && item ? await getZoteroItem(creds, item) : undefined;
  const zoteroTags = current ? current.tags.map((t) => t.tag) : entry.keywords;
  const push = canPush && !!current;
  const merged = mergeTags({ noteKeywords, zoteroTags, shadow, push });

  // Zotero first: a failed write must not leave the note claiming agreement.
  let zoteroWritten = false;
  if (merged.zoteroChanged && push && current) {
    zoteroWritten = await setZoteroItemTags(
      creds!,
      current.key,
      merged.tags,
      current.version,
    );
  }
  if (zoteroWritten && item && !itemOf(text)) {
    text = setLine(text, "zotero", item);
  }

  let updated = text;
  if (!citekey) updated = setLine(updated, "reference", entry.citekey);
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
  updated = setLine(updated, "zotero_tags", agreed.join(" "));

  if (updated === (await space.readPage(page))) {
    return { note: false, zotero: zoteroWritten };
  }
  syncing = true;
  try {
    // The page the editor is showing belongs to the editor: writing it
    // underneath would be overwritten by the next save. Its own save then
    // brings the file name in line (`renameFromFrontMatterOnSave`).
    if ((await currentPage()) === page) {
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
