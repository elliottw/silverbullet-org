import {
  denoteDate,
  denoteExtension,
  denoteFileType,
  type DenoteFileType,
  denoteIdentifier,
  denoteIdentifierDate,
  denoteLinkDescription,
  journalDateStamp,
  journalTitle,
  parseLocalDate,
  compileDblockRegexp,
  type DblockParams,
  parseDblockParams,
  formatDenoteFrontMatter,
  formatDenoteName,
  parseDenoteFrontMatter,
  parseDenoteName,
  sluggify,
} from "@silverbulletmd/silverbullet/lib/denote";
import {
  collectNodesOfType,
  type ParseTree,
  renderToText,
} from "@silverbulletmd/silverbullet/lib/tree";
import {
  editor,
  index,
  lua,
  markdown,
  space,
  system,
} from "@silverbulletmd/silverbullet/syscalls";
import type { FilterOption } from "@silverbulletmd/silverbullet/type/client";
import type {
  ObjectValue,
  PageMeta,
} from "@silverbulletmd/silverbullet/type/index";
import {
  innerPageLink,
  linkSyntaxFor,
  urlLink,
} from "@silverbulletmd/silverbullet/lib/link_syntax";
import { pathFromPageName } from "@silverbulletmd/silverbullet/lib/ref";
import type { FrontMatter } from "./frontmatter.ts";
import { batchRenameFiles } from "./refactor.ts";
import type { RelationObject } from "./relation.ts";
import { buildLineIndex, extractSnippet } from "./snippet.ts";

export type DenoteObject = ObjectValue<{
  tag: "denote";
  /** The Denote identifier, which is also this object's ref. */
  identifier: string;
  title: string;
  keywords: string[];
  signature?: string;
  /** The `#+date:` value, verbatim in the file's own notation. */
  date?: string;
  page: string;
  extension: string;
  pageLastModified: string;
}>;

export type DenoteMetadata = {
  identifier: string;
  title: string;
  keywords: string[];
  signature?: string;
  date?: string;
  extension: string;
};

/** Turns a file-name title slug back into something readable. */
function unslugTitle(slug: string): string {
  const spaced = slug.replaceAll("-", " ").trim();
  return spaced ? spaced[0].toUpperCase() + spaced.slice(1) : spaced;
}

/**
 * The Denote metadata for a page, or null when its name does not follow the
 * scheme.
 *
 * The file name and the front matter can disagree — they do in ~4% of the
 * notes in the real libraries this was tested against, because editing one
 * does not rewrite the other outside of `denote-rename-file`. The file name
 * wins for anything identity-bearing (identifier, signature, keywords), since
 * that is what Denote's design makes authoritative and what links resolve
 * against. The front matter wins for the title, which is the only place the
 * un-sluggified, human version of it exists.
 */
export function denoteMetadata(
  pageName: string,
  text: string,
): DenoteMetadata | null {
  const name = parseDenoteName(pageName);
  if (!name?.identifier) {
    return null;
  }
  const frontMatter = parseDenoteFrontMatter(
    text,
    denoteFileType(name.extension, text),
  );
  return {
    identifier: name.identifier,
    title:
      frontMatter.title ??
      (name.title ? unslugTitle(name.title) : name.identifier),
    keywords: name.keywords.length ? name.keywords : frontMatter.keywords,
    signature: name.signature,
    date: frontMatter.date,
    extension: name.extension,
  };
}

/**
 * Denote metadata shaped as SilverBullet front matter, so a Denote note's
 * title and keywords flow into the page object and the tag index the same way
 * a Markdown page's YAML front matter does.
 */
export function denoteFrontMatter(
  pageName: string,
  text: string,
): FrontMatter | null {
  const metadata = denoteMetadata(pageName, text);
  if (!metadata) {
    return null;
  }
  return {
    title: metadata.title,
    // `displayName` is what the page picker, the fuzzy matcher and link
    // completion search alongside the file name — which is how a note becomes
    // findable by its human title rather than only by its slug.
    displayName: metadata.title,
    tags: metadata.keywords,
    identifier: metadata.identifier,
    ...(metadata.signature ? { signature: metadata.signature } : {}),
    ...(metadata.date ? { date: metadata.date } : {}),
  };
}

// A Denote link names an identifier, never a path — that is what lets a note be
// renamed without breaking inbound links — so resolving one needs the whole
// file list. Every page name starts with its own identifier, so the map is
// built from names alone and needs no index lookups, which keeps it free of
// ordering problems during a full reindex.
let identifierMap: Map<string, string> | undefined;
let identifierMapBuiltAt = 0;
const identifierMapTtl = 5000;

/** Drops the cached identifier map; call when the file list changes. */
export function invalidateDenoteIdentifiers() {
  identifierMap = undefined;
}

async function denoteIdentifierMap(): Promise<Map<string, string>> {
  if (identifierMap && Date.now() - identifierMapBuiltAt < identifierMapTtl) {
    return identifierMap;
  }
  const map = new Map<string, string>();
  for (const page of await space.listPages()) {
    const identifier = parseDenoteName(page.name)?.identifier;
    // First one wins, so a duplicated identifier resolves deterministically.
    if (identifier && !map.has(identifier)) {
      map.set(identifier, page.name);
    }
  }
  identifierMap = map;
  identifierMapBuiltAt = Date.now();
  return map;
}

/** The page a Denote identifier refers to, if any note carries it. */
export async function resolveDenoteIdentifier(
  identifier: string,
): Promise<string | undefined> {
  return (await denoteIdentifierMap()).get(identifier);
}

const denoteTargetRegex = /^denote:([^:\s]+)(?:::(.*))?$/;

export async function indexDenote(
  pageMeta: PageMeta,
  _frontmatter: FrontMatter,
  tree: ParseTree,
  text: string,
): Promise<ObjectValue<any>[]> {
  const metadata = denoteMetadata(pageMeta.name, text);
  if (!metadata) {
    return [];
  }

  const objects: ObjectValue<any>[] = [
    {
      tag: "denote",
      ref: metadata.identifier,
      identifier: metadata.identifier,
      title: metadata.title,
      keywords: metadata.keywords,
      ...(metadata.signature ? { signature: metadata.signature } : {}),
      ...(metadata.date ? { date: metadata.date } : {}),
      page: pageMeta.name,
      extension: metadata.extension,
      pageLastModified: pageMeta.lastModified,
    } satisfies DenoteObject,
  ];

  const links = collectNodesOfType(tree, "DenoteLink");
  if (links.length === 0) {
    return objects;
  }
  const lineIndex = buildLineIndex(text);
  for (const link of links) {
    const targetNode = link.children?.find(
      (n) => n.type === "DenoteLinkTarget",
    );
    const target = targetNode ? renderToText(targetNode) : "";
    const match = denoteTargetRegex.exec(target);
    if (!match) {
      continue;
    }
    const identifier = match[1];
    const toPage = await resolveDenoteIdentifier(identifier);
    const descriptionNode = link.children?.find(
      (n) => n.type === "OrgLinkDescription",
    );
    const relation: RelationObject = {
      ref: `${pageMeta.name}@${link.from}`,
      tag: "relation",
      kind: "denote-link",
      from: pageMeta.name,
      fromTag: "page",
      // An unresolved identifier is kept as the target so a dangling link is
      // visible in the index rather than silently dropped.
      to: toPage ?? identifier,
      toTag: toPage ? "page" : "denote-identifier",
      page: pageMeta.name,
      range: [link.from!, link.to!],
      snippet: extractSnippet(pageMeta.name, lineIndex, link.from!),
      pageLastModified: pageMeta.lastModified,
    };
    if (descriptionNode) {
      relation.alias = renderToText(descriptionNode);
    }
    objects.push(relation);
  }
  return objects;
}

// ---------------------------------------------------------------------------
// Creating notes
// ---------------------------------------------------------------------------

/**
 * Splits a keyword prompt's answer the way Denote's own does.
 *
 * Denote prompts with `completing-read-multiple`, whose separator is a comma —
 * *not* whitespace. That is what makes a multi-word keyword possible, and it
 * is the reason keyword sluggification joins words instead of hyphenating
 * them: `Genuine Issue Trial` is one keyword, `genuineissuetrial`. Keywords
 * are sorted, per `denote-sort-keywords`.
 */
export function parseKeywordInput(input: string): string[] {
  return [
    ...new Set(
      input
        .split(",")
        .map((keyword) => sluggify("keyword", keyword))
        .filter(Boolean),
    ),
  ].sort();
}

/**
 * An identifier for `date` that no note in the space is using yet.
 *
 * Denote identifiers have one-second resolution, so two notes created in the
 * same second would collide — and an identifier is a note's identity, the
 * thing every inbound link resolves against, so a duplicate is not a cosmetic
 * problem. Denote bumps the second; so do we.
 */
export async function freeIdentifier(date: Date): Promise<string> {
  const taken = await denoteIdentifierMap();
  const candidate = new Date(date.getTime());
  for (let attempt = 0; attempt < 60; attempt++) {
    const identifier = denoteIdentifier(candidate);
    if (!taken.has(identifier)) {
      return identifier;
    }
    candidate.setSeconds(candidate.getSeconds() + 1);
  }
  throw new Error("Could not find a free Denote identifier");
}

export type NewNoteSpec = {
  title: string;
  keywords: string[];
  signature?: string;
  fileType?: DenoteFileType;
  /**
   * A subdirectory to write into, as `denote-journal-directory` is one.
   * Denote's library is otherwise flat: keywords are the organisation.
   */
  directory?: string;
};

/**
 * Creates a Denote note and returns its page name.
 *
 * The note lands in the space root, which is what `denote-directory` means —
 * Denote keeps a flat library and relies on keywords, not folders.
 */
export async function createDenoteNote(spec: NewNoteSpec): Promise<string> {
  const fileType =
    spec.fileType ??
    ((await system.getConfig("denote.fileType", "org")) as DenoteFileType);
  const now = new Date();
  const identifier = await freeIdentifier(now);
  // The signature is sluggified once and used for both the file name and the
  // front matter, so the two agree — as they do in real Denote notes. Only the
  // title differs between them: the front matter keeps the un-sluggified one,
  // because that is the only place it survives.
  const signature = spec.signature
    ? sluggify("signature", spec.signature)
    : undefined;
  const name = formatDenoteName({
    identifier,
    title: spec.title,
    keywords: spec.keywords,
    signature,
    extension: denoteExtension(fileType),
  });
  const pageName = spec.directory ? `${spec.directory}/${name}` : name;
  const frontMatter = formatDenoteFrontMatter(
    {
      title: spec.title,
      date: denoteDate(now, fileType),
      keywords: spec.keywords,
      hasKeywords: spec.keywords.length > 0,
      identifier,
      signature,
    },
    fileType,
  );
  await space.writePage(pageName, frontMatter);
  // The new note has to be resolvable by the links that will point at it.
  invalidateDenoteIdentifiers();
  return pageName;
}

/** Every keyword in the library, with how many notes carry it. */
export async function denoteKeywordCounts(): Promise<[string, number][]> {
  const notes = await index.queryLuaObjects<DenoteObject>("denote", {});
  const counts = new Map<string, number>();
  for (const note of notes) {
    for (const keyword of note.keywords ?? []) {
      counts.set(keyword, (counts.get(keyword) ?? 0) + 1);
    }
  }
  // Most-used first, then alphabetically: in a library with hundreds of
  // keywords the common ones are what you almost always want, and the filter
  // box searches the rest.
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

const doneOption = "\u2713  Done";
const newKeywordOption = "\uFF0B  New keyword\u2026";

/**
 * Denote's keyword prompt with completion over the library's existing
 * keywords.
 *
 * Denote uses `completing-read-multiple`, which both completes what is already
 * in use and accepts something new. A filter box only picks from its list, so
 * new keywords get their own row rather than being unreachable — keeping a
 * library's keyword vocabulary consistent is most of the point of completing
 * them at all.
 *
 * @returns the chosen keywords, or undefined if the prompt was abandoned
 */
export async function promptForKeywords(): Promise<string[] | undefined> {
  const counts = await denoteKeywordCounts();
  const selected: string[] = [];
  for (;;) {
    const options: FilterOption[] = [
      {
        name: doneOption,
        description: selected.length
          ? selected.join(", ")
          : "no keywords on this note",
        orderId: -2,
      },
      {
        name: newKeywordOption,
        description: "a keyword not yet used in this space",
        orderId: -1,
      },
      ...counts
        .filter(([keyword]) => !selected.includes(keyword))
        .map(([keyword, count]) => ({
          name: keyword,
          description: `${count} note${count === 1 ? "" : "s"}`,
        })),
    ];
    const choice = await editor.filterBox(
      "Keyword",
      options,
      selected.length
        ? `Selected: ${selected.join(", ")} — Enter to add another, Escape when done`
        : "Pick a keyword, or Escape for none",
    );
    // Escape means "that is all", as an empty answer does in Denote.
    if (!choice || choice.name === doneOption) {
      return selected.sort();
    }
    if (choice.name === newKeywordOption) {
      const typed = await editor.prompt("New keyword(s), comma separated:", "");
      if (typed !== undefined) {
        for (const keyword of parseKeywordInput(typed)) {
          if (!selected.includes(keyword)) {
            selected.push(keyword);
          }
        }
      }
      continue;
    }
    selected.push(choice.name);
  }
}

/** A note the prompts below just made, in the shape a link to it needs. */
type CreatedNote = {
  name: string;
  identifier: string;
  title: string;
  signature?: string;
};

/**
 * Denote's note-creation prompts: title, then keywords, then optionally a
 * signature, per `denote-prompts`.
 *
 * `defaultTitle` is what `denote-open-or-create` and `denote-link-or-create`
 * pass along — both use whatever was typed at the file prompt as the default
 * value of the title prompt, rather than making you type it twice.
 *
 * Returns undefined when any prompt is cancelled, which aborts the whole
 * thing: an empty answer to Denote's title prompt is not a note.
 */
async function promptForNewNote(
  withSignature: boolean,
  defaultTitle?: string,
): Promise<CreatedNote | undefined> {
  const title = await editor.prompt("Title:", defaultTitle);
  if (title === undefined) {
    return;
  }
  if (!title.trim()) {
    await editor.flashNotification("A note needs a title", "error");
    return;
  }
  const keywords = await promptForKeywords();
  if (keywords === undefined) {
    return;
  }
  let signature: string | undefined;
  if (withSignature) {
    const answer = await editor.prompt("Signature:", "");
    if (answer === undefined) {
      return;
    }
    signature = answer.trim() || undefined;
  }
  const name = await createDenoteNote({
    title: title.trim(),
    keywords,
    signature,
  });
  const parsed = parseDenoteName(name);
  return {
    name,
    // `createDenoteNote` just minted the name, so it always parses.
    identifier: parsed?.identifier ?? "",
    title: title.trim(),
    signature: parsed?.signature,
  };
}

/** Opens a newly created note with the cursor in the body, not the front matter. */
async function openNewNote(name: string): Promise<void> {
  const text = await space.readPage(name);
  await editor.navigate({
    path: name as `${string}.${string}`,
    details: { type: "position", pos: text.length },
  });
}

async function promptForNote(withSignature: boolean): Promise<void> {
  const created = await promptForNewNote(withSignature);
  if (created) {
    await openNewNote(created.name);
  }
}

export function newDenoteNoteCommand(): Promise<void> {
  return promptForNote(false);
}

export function newDenoteNoteWithSignatureCommand(): Promise<void> {
  return promptForNote(true);
}

// ---------------------------------------------------------------------------
// Open or create, link or create
// ---------------------------------------------------------------------------

/**
 * Whether a phrase names a file rather than titling a note.
 *
 * Denote keeps a flat library and derives the file name from the title, so a
 * phrase carrying a path or a note extension was meant literally and is passed
 * through untouched.
 */
function namesAFile(phrase: string): boolean {
  return phrase.includes("/") || /\.(md|org|txt)$/i.test(phrase);
}

/**
 * Whether creating `phrase` from `currentPage` should mint a Denote note.
 *
 * Denote's commands only ever make Denote notes, because in Emacs you are
 * inside `denote-directory`. The nearest thing to being inside it here is the
 * note you are reading: creating from a Denote note stays in the library,
 * creating from an ordinary page does not. That keeps a mixed space working
 * and leaves a stock Markdown space alone.
 */
export function createsDenoteNote(
  phrase: string,
  currentPage: string,
): boolean {
  const title = phrase.trim();
  if (!title || namesAFile(title)) {
    return false;
  }
  return !!parseDenoteName(currentPage)?.identifier;
}

/**
 * `denote-open-or-create`, which is what the page picker's create row does.
 *
 * Denote uses the text typed at the file prompt as the *title* of the note it
 * then creates, so that is what the phrase means here too. In a Denote library
 * the alternative is silently wrong: navigating to the phrase would mint
 * `Some New Note.md`, a file with no identifier, outside the naming scheme and
 * unreachable by every `denote:` link.
 */
export async function denoteOpenOrCreate(phrase: string): Promise<void> {
  const currentPage = await editor.getCurrentPage();
  if (!createsDenoteNote(phrase, currentPage)) {
    await editor.navigate(phrase);
    return;
  }
  const created = await promptForNewNote(false, phrase.trim());
  if (created) {
    await openNewNote(created.name);
  }
}

/**
 * The `[[` completion's create row: mints the note and writes the link to it.
 *
 * This is `denote-link-or-create` reached the way a writer actually reaches it
 * -- mid-sentence, with the title already typed. The client has cleared what
 * was typed and left the cursor between the brackets, so what goes in is the
 * *inner* link text, the same as every other page completion inserts.
 */
export async function denoteCreateFromLink(option: {
  title?: string;
}): Promise<void> {
  const title = (option.title ?? "").trim();
  if (!title) {
    return;
  }
  const created = await promptForNewNote(false, title);
  if (!created) {
    // Cancelled: put back what was typed, so nothing is silently lost.
    await editor.insertAtCursor(title);
    return;
  }
  const currentPage = await editor.getCurrentPage();
  await editor.insertAtCursor(
    innerPageLink(
      linkSyntaxFor(currentPage),
      created.name,
      denoteLinkDescription(created),
    ),
  );
}

const createNoteOption = "\uFF0B  Create note\u2026";

/**
 * `denote-link-or-create`: link to a note, making it first if it does not
 * exist yet.
 *
 * `[[` completion can only offer notes that already exist, and with Denote it
 * could not do otherwise — a link addresses a note by identifier, and an
 * identifier only exists once the file does. So the note is created first and
 * the link written to it afterwards. Denote creates it `:in-background`,
 * staying in the note you are writing, and so does this.
 */
export async function denoteLinkOrCreateCommand(): Promise<void> {
  const [notes, current] = await Promise.all([
    denoteNotes(),
    editor.getCurrentPage(),
  ]);
  const choice = await editor.filterBox(
    "Link",
    [
      {
        name: createNoteOption,
        description: "a note that does not exist yet",
        orderId: -1,
      },
      // A note never links to itself.
      ...notes
        .filter((note) => note.name !== current)
        .map((note) => ({
          name: denoteLinkDescription(note),
          description: note.keywords.join(", "),
          identifier: note.identifier,
        })),
    ],
    "Select a note to link to, or create one",
  );
  if (!choice) {
    return;
  }

  let identifier: string;
  let description: string;
  if (choice.name === createNoteOption) {
    const created = await promptForNewNote(false);
    if (!created) {
      return;
    }
    identifier = created.identifier;
    description = denoteLinkDescription(created);
  } else {
    identifier = choice.identifier;
    description = choice.name;
  }
  await editor.insertAtCursor(
    urlLink(linkSyntaxFor(current), `denote:${identifier}`, description),
  );
}

// ---------------------------------------------------------------------------
// Keeping the file name in step with the front matter
// ---------------------------------------------------------------------------

/**
 * The file name a note's own front matter says it should have, or null when
 * the name is already right (or there is nothing to go on).
 *
 * This is `denote-rename-file-using-front-matter`, and it runs the opposite
 * way round from indexing: reading a note, the *file name* is authoritative,
 * because that is what links resolve against. Renaming, the *front matter* is,
 * because that is what the author just edited. The identifier is never taken
 * from the front matter — it is the note's identity, and every inbound link
 * resolves against it.
 */
export function denoteNameFromFrontMatter(
  pageName: string,
  text: string,
): string | null {
  const name = parseDenoteName(pageName);
  if (!name?.identifier) {
    return null;
  }
  const frontMatter = parseDenoteFrontMatter(
    text,
    denoteFileType(name.extension, text),
  );
  if (frontMatter.title === undefined) {
    // No title to rebuild the name from; leave the file alone.
    return null;
  }
  // Denote's library is flat, but not everything in it is: a journal lives in
  // `denote-journal-directory`, and a silo is its own folder. The front matter
  // describes the *note*, never where it sits, so the folder is carried across
  // -- rebuilding from the front matter alone would quietly move the file to
  // the space root and break the rename into a relocation.
  const slash = pageName.lastIndexOf("/");
  const folder = slash === -1 ? "" : pageName.slice(0, slash + 1);
  const renamed =
    folder +
    formatDenoteName({
      identifier: name.identifier,
      title: frontMatter.title,
      // An absent keywords line means "unknown", not "none": keep what the file
      // name already carries rather than silently dropping it. Keywords taken
      // from the front matter are sorted, as `denote--rename-file` does; the
      // file name's existing ones are left as they are, so a note is never
      // renamed purely to reorder them.
      keywords: frontMatter.hasKeywords
        ? frontMatter.keywords
            .map((keyword) => sluggify("keyword", keyword))
            .filter(Boolean)
            .sort()
        : name.keywords,
      signature: frontMatter.signature ?? name.signature,
      extension: name.extension,
    });
  return renamed === pageName ? null : renamed;
}

/** Guards against the rename's own save re-entering this. */
let renaming = false;

/**
 * Renames `pageName` to match its front matter, if they disagree.
 * @returns the new page name, or undefined if nothing changed
 */
export async function renameFromFrontMatter(
  pageName: string,
): Promise<string | undefined> {
  if (renaming) {
    return undefined;
  }
  const text = await space.readPage(pageName);
  const renamed = denoteNameFromFrontMatter(pageName, text);
  if (!renamed) {
    return undefined;
  }
  renaming = true;
  try {
    await batchRenameFiles([
      [pathFromPageName(pageName), pathFromPageName(renamed)],
    ]);
  } finally {
    renaming = false;
  }
  invalidateDenoteIdentifiers();
  return renamed;
}

export async function renameFromFrontMatterCommand() {
  const pageName = await editor.getCurrentPage();
  const renamed = await renameFromFrontMatter(pageName);
  await editor.flashNotification(
    renamed
      ? `Renamed to ${renamed}`
      : "File name already matches front matter",
  );
}

/**
 * Keeps the file name in step as the front matter is edited.
 *
 * Denote links address notes by identifier, so a rename never invalidates one
 * — which is what makes doing this automatically reasonable rather than
 * reckless. Set `denote.renameOnSave` to false to make it manual.
 */
export async function renameFromFrontMatterOnSave(pageName: string) {
  if (!(await system.getConfig("denote.renameOnSave", true))) {
    return;
  }
  try {
    await renameFromFrontMatter(pageName);
  } catch (e: any) {
    console.warn("[denote] could not rename from front matter", e.message);
  }
}

// ---------------------------------------------------------------------------
// Dynamic blocks
// ---------------------------------------------------------------------------

export type DenoteNoteSummary = {
  name: string;
  identifier: string;
  title: string;
  signature?: string;
  keywords: string[];
};

/**
 * Every Denote note in the space, in file-name order — Denote's own order.
 *
 * Denote counts `.org`, `.md` *and* `.txt` as notes. Only the first two are
 * SilverBullet pages, so a `.txt` note never reaches the index; those are
 * picked up from the document list and read directly, because their front
 * matter holds the only properly-cased copy of their title.
 */
export async function denoteNotes(): Promise<DenoteNoteSummary[]> {
  const [indexed, documents] = await Promise.all([
    index.queryLuaObjects<DenoteObject>("denote", {}),
    space.listDocuments(),
  ]);
  const notes: DenoteNoteSummary[] = indexed.map((note) => ({
    name: note.page,
    identifier: note.identifier,
    title: note.title,
    signature: note.signature,
    keywords: note.keywords ?? [],
  }));
  const seen = new Set(notes.map((note) => note.identifier));

  const decoder = new TextDecoder();
  for (const document of documents) {
    const parsed = parseDenoteName(document.name);
    if (!parsed?.identifier || seen.has(parsed.identifier)) {
      continue;
    }
    let title = parsed.title ? unslugTitle(parsed.title) : parsed.identifier;
    try {
      const text = decoder.decode(await space.readDocument(document.name));
      const frontMatter = parseDenoteFrontMatter(
        text,
        denoteFileType(parsed.extension, text),
      );
      if (frontMatter.title) {
        title = frontMatter.title;
      }
    } catch {
      // Unreadable: the file-name title is still better than dropping the note.
    }
    notes.push({
      name: document.name,
      identifier: parsed.identifier,
      title,
      signature: parsed.signature,
      keywords: parsed.keywords,
    });
  }
  return notes.sort((a, b) => a.name.localeCompare(b.name));
}

const sortKey: Record<string, (n: DenoteNoteSummary) => string> = {
  title: (n) => n.title,
  keywords: (n) => n.keywords.join("_"),
  signature: (n) => n.signature ?? "",
  identifier: (n) => n.identifier,
};

/** Formats a note list as Org links, honouring :id-only and :include-date. */
function renderLinkList(
  notes: DenoteNoteSummary[],
  params: DblockParams,
): string {
  return notes
    .map((note) => {
      const description = params["id-only"]
        ? note.identifier
        : denoteLinkDescription(note);
      const dated = params["include-date"]
        ? `${description} (${denoteIdentifierDate(note.identifier)})`
        : description;
      return `- [[denote:${note.identifier}][${dated}]]`;
    })
    .join("\n");
}

/** Applies :sort-by-component and :reverse-sort. */
function applySorting(
  notes: DenoteNoteSummary[],
  params: DblockParams,
): DenoteNoteSummary[] {
  let sorted = notes;
  const component = params["sort-by-component"];
  if (typeof component === "string" && sortKey[component]) {
    const key = sortKey[component];
    sorted = [...sorted].sort((a, b) => key(a).localeCompare(key(b)));
  }
  return params["reverse-sort"] ? [...sorted].reverse() : sorted;
}

/** The notes a `:regexp`/`:not-regexp` pair selects, minus the current note. */
function selectByRegexp(
  params: DblockParams,
  notes: DenoteNoteSummary[],
  currentPage: string,
): DenoteNoteSummary[] {
  const pattern = params.regexp;
  const matches = compileDblockRegexp(
    typeof pattern === "string" ? pattern : "",
  );
  const excludes =
    typeof params["not-regexp"] === "string"
      ? compileDblockRegexp(params["not-regexp"])
      : undefined;
  return notes.filter(
    // Denote passes :omit-current, so a block never links to its own note.
    (note) =>
      note.name !== currentPage && matches(note.name) && !excludes?.(note.name),
  );
}

/**
 * `denote-backlinks`: the notes that link *to* this one.
 *
 * `:this-heading-only` is not supported — a link is indexed against its page,
 * not the heading it sits under — so such a block is left alone rather than
 * silently answered with the whole page's backlinks.
 */
export function renderDenoteBacklinksBlock(
  params: DblockParams,
  notes: DenoteNoteSummary[],
  backlinkPages: Set<string>,
): string | null {
  if (params["this-heading-only"]) {
    return null;
  }
  const excludes =
    typeof params["not-regexp"] === "string"
      ? compileDblockRegexp(params["not-regexp"])
      : undefined;
  return renderLinkList(
    applySorting(
      notes.filter(
        (note) => backlinkPages.has(note.name) && !excludes?.(note.name),
      ),
      params,
    ),
    params,
  );
}

/** `denote-missing-links`: notes matching the regexp this page does *not* link to. */
export function renderDenoteMissingLinksBlock(
  params: DblockParams,
  notes: DenoteNoteSummary[],
  currentPage: string,
  linkedIdentifiers: Set<string>,
): string {
  return renderLinkList(
    applySorting(
      selectByRegexp(params, notes, currentPage).filter(
        (note) => !linkedIdentifiers.has(note.identifier),
      ),
      params,
    ),
    params,
  );
}

/**
 * The body of a `denote-links` dynamic block: one Org link per matching note.
 *
 * Denote matches `:regexp` against the *file name*, which is why a keyword
 * (`_costs`) or a signature (`==6`) works as a filter — they are literally
 * substrings of the name.
 */
export function renderDenoteLinksBlock(
  params: DblockParams,
  notes: DenoteNoteSummary[],
  currentPage: string,
): string {
  return renderLinkList(
    applySorting(selectByRegexp(params, notes, currentPage), params),
    params,
  );
}

/** A dynamic block found in a page's text. */
type DynamicBlock = {
  type: string;
  params: DblockParams;
  /** Range of the generated body, between the two delimiter lines. */
  bodyFrom: number;
  bodyTo: number;
};

export function findDynamicBlocks(tree: ParseTree): DynamicBlock[] {
  return collectNodesOfType(tree, "OrgDynamicBlock").flatMap((block) => {
    const children = block.children ?? [];
    const marks = children.filter((n) => n.type === "OrgDynamicBlockMark");
    const type = children.find((n) => n.type === "OrgDynamicBlockType");
    if (marks.length < 2 || !type) {
      return [];
    }
    const params = children.find((n) => n.type === "OrgDynamicBlockParams");
    return [
      {
        type: renderToText(type),
        params: params ? parseDblockParams(renderToText(params)) : {},
        // From just after the opening line to the start of `#+END:`.
        bodyFrom: marks[0].to! + (params ? 0 : 0),
        bodyTo: marks[marks.length - 1].from!,
      },
    ];
  });
}

/** Pages holding a `denote:` link to `pageName`. */
async function backlinkPagesFor(pageName: string): Promise<Set<string>> {
  const relations = await index.queryLuaObjects<any>(
    "relation",
    {
      objectVariable: "_",
      where: await lua.parseExpression(
        `_.kind == "denote-link" and _.to == target`,
      ),
    },
    { target: pageName },
  );
  return new Set(relations.map((relation) => relation.page));
}

/** Identifiers this page already links to. */
function linkedIdentifiers(tree: ParseTree): Set<string> {
  const identifiers = new Set<string>();
  for (const link of collectNodesOfType(tree, "DenoteLink")) {
    const target = link.children?.find((n) => n.type === "DenoteLinkTarget");
    const match = target && denoteTargetRegex.exec(renderToText(target));
    if (match) {
      identifiers.add(match[1]);
    }
  }
  return identifiers;
}

/** Guards against the rewrite's own save re-entering this. */
let updatingDblocks = false;

/**
 * Regenerates every `denote-links` block in the page open in the editor, as
 * `org-dblock-update` does. Other block types are left alone rather than
 * emptied.
 *
 * @returns how many blocks changed, or -1 if the page holds none
 */
export async function updateDynamicBlocks(): Promise<number> {
  if (updatingDblocks) {
    return 0;
  }
  const pageName = await editor.getCurrentPage();
  const text = await editor.getText();
  const tree = await markdown.parsePage(await editor.getCurrentPath(), text);
  const generated = new Set([
    "denote-links",
    "denote-backlinks",
    "denote-missing-links",
  ]);
  const blocks = findDynamicBlocks(tree).filter((block) =>
    generated.has(block.type.toLowerCase()),
  );
  if (blocks.length === 0) {
    return -1;
  }
  const notes = await denoteNotes();
  // Only fetched when a block actually needs them.
  let backlinks: Set<string> | undefined;
  let linked: Set<string> | undefined;
  let updated = text;
  let changed = 0;
  // Back to front, so each replacement leaves earlier offsets valid.
  for (const block of [...blocks].reverse()) {
    const type = block.type.toLowerCase();
    let body: string | null;
    if (type === "denote-backlinks") {
      backlinks ??= await backlinkPagesFor(pageName);
      body = renderDenoteBacklinksBlock(block.params, notes, backlinks);
    } else if (type === "denote-missing-links") {
      linked ??= linkedIdentifiers(tree);
      body = renderDenoteMissingLinksBlock(
        block.params,
        notes,
        pageName,
        linked,
      );
    } else {
      body = renderDenoteLinksBlock(block.params, notes, pageName);
    }
    // A block this cannot generate keeps whatever it already holds.
    if (body === null) {
      continue;
    }
    // The body sits between the opening line's newline and the `#+END:` line.
    const from = updated.indexOf("\n", block.bodyFrom) + 1;
    const replacement = body ? `${body}\n` : "";
    if (updated.slice(from, block.bodyTo) !== replacement) {
      changed++;
    }
    updated =
      updated.slice(0, from) + replacement + updated.slice(block.bodyTo);
  }
  if (updated === text) {
    return 0;
  }
  updatingDblocks = true;
  try {
    await editor.setText(updated);
  } finally {
    updatingDblocks = false;
  }
  return changed;
}

export async function updateDynamicBlocksCommand() {
  const changed = await updateDynamicBlocks();
  await editor.flashNotification(
    changed === -1
      ? "No denote-links blocks on this page"
      : changed > 0
        ? `Updated ${changed} dynamic block${changed === 1 ? "" : "s"}`
        : "Dynamic blocks already up to date",
  );
}

/**
 * Keeps dynamic blocks current as a note is edited.
 *
 * Only the page open in the editor is touched: a save arriving from sync or a
 * background write belongs to a buffer this does not own, and rewriting it
 * through the editor would land the text on the wrong page. The rewrite is a
 * no-op once nothing changes, so it settles after one pass.
 *
 * Set `denote.updateDblocksOnSave` to false to make it manual.
 */
export async function updateDynamicBlocksOnSave(pageName: string) {
  if (!(await system.getConfig("denote.updateDblocksOnSave", true))) {
    return;
  }
  try {
    if ((await editor.getCurrentPage()) !== pageName) {
      return;
    }
    await updateDynamicBlocks();
  } catch (e: any) {
    console.warn("[denote] could not update dynamic blocks", e.message);
  }
}

/**
 * Inserts a dynamic block at the cursor and fills it in, as
 * `denote-org-dblock-insert-*` do. The parameter list mirrors what Denote
 * writes, so a block created here is one Emacs recognises.
 */
async function insertDblock(name: string, params: string) {
  const pos = await editor.getCursor();
  await editor.insertAtPos(`#+BEGIN: ${name} ${params}\n#+END:\n`, pos);
  await updateDynamicBlocks();
}

export async function insertLinksDblockCommand() {
  const regexp = await editor.prompt("Files matching regexp:", "");
  if (regexp === undefined) {
    return;
  }
  await insertDblock(
    "denote-links",
    `:regexp ${JSON.stringify(regexp)} :not-regexp nil :excluded-dirs-regexp nil ` +
      `:sort-by-component nil :reverse-sort nil :id-only nil :include-date nil`,
  );
}

export async function insertBacklinksDblockCommand() {
  await insertDblock(
    "denote-backlinks",
    `:excluded-dirs-regexp nil :sort-by-component nil :reverse-sort nil ` +
      `:id-only nil :this-heading-only nil :include-date nil`,
  );
}

export async function insertMissingLinksDblockCommand() {
  const regexp = await editor.prompt("Files matching regexp:", "");
  if (regexp === undefined) {
    return;
  }
  await insertDblock(
    "denote-missing-links",
    `:regexp ${JSON.stringify(regexp)} :not-regexp nil :excluded-dirs-regexp nil ` +
      `:sort-by-component nil :reverse-sort nil :id-only nil`,
  );
}

/**
 * A links block scoped to today, which is a common enough thing to want that
 * it is worth its own command rather than typing the date into a prompt.
 */
export async function insertTodaysLinksDblockCommand() {
  const today = denoteIdentifier(new Date()).slice(0, 8);
  await insertDblock(
    "denote-links",
    `:regexp ${JSON.stringify(today)} :not-regexp nil :excluded-dirs-regexp nil ` +
      `:sort-by-component nil :reverse-sort nil :id-only nil :include-date nil`,
  );
}

// ---------------------------------------------------------------------------
// denote-journal
// ---------------------------------------------------------------------------

type JournalConfig = {
  /** `denote-journal-directory`, relative to the space. */
  directory: string;
  /** `denote-journal-keyword`. */
  keyword: string;
  /** `denote-journal-title-format`. */
  titleFormat: string;
};

async function journalConfig(): Promise<JournalConfig> {
  return {
    directory: (await system.getConfig(
      "denote.journalDirectory",
      "journal",
    )) as string,
    keyword: (await system.getConfig(
      "denote.journalKeyword",
      "journal",
    )) as string,
    titleFormat: (await system.getConfig(
      "denote.journalTitleFormat",
      "day-date-month-year-24h",
    )) as string,
  };
}

/**
 * Whether a note is a journal entry for the day `stamp` names.
 *
 * This is `denote-journal--filename-regexp` and `--keyword-regex` together: an
 * entry lives in the journal directory, its identifier is stamped with that
 * day, and it carries the journal keyword. The identifier is what decides the
 * day — not the front matter date, which a user may have edited.
 */
function isJournalEntryFor(
  note: DenoteNoteSummary,
  stamp: string,
  config: JournalConfig,
): boolean {
  const inDirectory = config.directory
    ? note.name.startsWith(`${config.directory}/`)
    : true;
  return (
    inDirectory &&
    note.identifier.startsWith(stamp) &&
    note.keywords.includes(config.keyword)
  );
}

/** Every journal entry, newest first. */
export async function denoteJournalEntries(): Promise<DenoteNoteSummary[]> {
  const config = await journalConfig();
  const notes = await denoteNotes();
  return notes
    .filter(
      (note) =>
        (config.directory
          ? note.name.startsWith(`${config.directory}/`)
          : true) && note.keywords.includes(config.keyword),
    )
    .sort((a, b) => b.identifier.localeCompare(a.identifier));
}

/**
 * `denote-journal-new-or-existing-entry`: open today's entry, creating it if
 * there is none.
 *
 * Denote prompts when a day has more than one entry; the newest is taken here
 * instead, since the picker is a keystroke away and a prompt on a key you
 * press every day gets old.
 */
export async function denoteJournalOpenOrCreate(
  dateStr?: string,
): Promise<void> {
  const config = await journalConfig();
  const now = new Date();
  let when = dateStr ? parseLocalDate(dateStr) : now;
  if (Number.isNaN(when.getTime())) {
    await editor.flashNotification(`Not a date: ${dateStr}`, "error");
    return;
  }
  // A date string carries no time, but the default title format ends in
  // `%H:%M` -- denote-journal stamps an entry with the moment it was written.
  // For today that moment is now; for an explicit past date there is no such
  // moment, and midnight is the honest answer.
  if (journalDateStamp(when) === journalDateStamp(now)) {
    when = now;
  }
  const stamp = journalDateStamp(when);
  const existing = (await denoteJournalEntries()).filter((note) =>
    isJournalEntryFor(note, stamp, config),
  );
  if (existing.length > 0) {
    await editor.navigate(pathFromPageName(existing[0].name) as any);
    return;
  }
  const pageName = await createDenoteNote({
    title: journalTitle(when, config.titleFormat),
    keywords: [config.keyword],
    directory: config.directory,
  });
  const text = await space.readPage(pageName);
  await editor.navigate({
    path: pageName as `${string}.${string}`,
    details: { type: "position", pos: text.length },
  });
}

/**
 * The entry before or after the one being read, by identifier.
 *
 * Ordering on the identifier rather than the front-matter date keeps this
 * agreeing with which day an entry *is*, which is the same thing
 * `denote-journal` matches on.
 */
export async function denoteJournalNeighbor(
  direction: "previous" | "next",
): Promise<void> {
  const entries = await denoteJournalEntries();
  if (entries.length === 0) {
    await editor.flashNotification("No journal entries yet", "error");
    return;
  }
  const current = await editor.getCurrentPage();
  const index = entries.findIndex((note) => note.name === current);
  // Reading something that is not an entry, "previous" means the latest one.
  const target =
    index === -1
      ? direction === "previous"
        ? entries[0]
        : undefined
      : direction === "previous"
        ? entries[index + 1]
        : entries[index - 1];
  if (!target) {
    await editor.flashNotification(
      direction === "previous"
        ? "No earlier journal entries"
        : "No later journal entries",
      "error",
    );
    return;
  }
  await editor.navigate(pathFromPageName(target.name) as any);
}

export function denoteJournalTodayCommand(): Promise<void> {
  return denoteJournalOpenOrCreate();
}

export function denoteJournalPreviousCommand(): Promise<void> {
  return denoteJournalNeighbor("previous");
}

export function denoteJournalNextCommand(): Promise<void> {
  return denoteJournalNeighbor("next");
}
