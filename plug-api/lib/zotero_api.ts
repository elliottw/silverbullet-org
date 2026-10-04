/**
 * Zotero's Web API file upload, as a function of a key and some bytes.
 *
 * This is Zotero's own four-step protocol: create the attachment item; ask
 * for upload authorisation with the file's md5, size and mtime; send the
 * bytes where it says, wrapped as it says; register the upload. Kept apart
 * from the plug so it can be exercised outside the sandbox with a real key.
 */
import { md5Hex } from "./md5.ts";

export const zoteroApi = "https://api.zotero.org";

export type ZoteroCredentials = {
  userId: string;
  apiKey: string;
  /** The API's base URL; anything but the real one is a test double. */
  api?: string;
};

export type UploadOptions = {
  /** Collection keys the item is filed under. */
  collections?: string[];
  /** Defaults to the file name without its extension. */
  title?: string;
  tags?: string[];
  /**
   * The item this file belongs to. A bare attachment cannot be cited; a
   * child of a regular item can, through the parent's citekey. A child has
   * no collections of its own -- the parent's are what count.
   */
  parentItem?: string;
  fetchFn?: typeof fetch;
};

export type ParentItemSpec = {
  /** `document` by default; `webpage`, `book`, `journalArticle`… when known. */
  itemType?: string;
  title: string;
  url?: string;
  date?: string;
  creators?: {
    creatorType: string;
    firstName?: string;
    lastName?: string;
    name?: string;
  }[];
  collections?: string[];
  tags?: string[];
  /** Any further Zotero fields for the type, e.g. `publicationTitle`. */
  fields?: Record<string, string>;
};

/**
 * Creates the regular item a file hangs from, and returns its key.
 *
 * This is what makes a file *reference* material: Better BibTeX gives the
 * parent a citekey, and `[cite:@key]` follows from there.
 */
export async function createParentItem(
  { userId, apiKey, api = zoteroApi }: ZoteroCredentials,
  spec: ParentItemSpec,
  fetchFn: typeof fetch = fetch,
): Promise<string> {
  const res = await fetchFn(`${api}/users/${userId}/items`, {
    method: "POST",
    headers: {
      "Zotero-API-Key": apiKey,
      "Zotero-API-Version": "3",
      "Content-Type": "application/json",
    },
    body: JSON.stringify([
      {
        itemType: spec.itemType ?? "document",
        title: spec.title,
        ...(spec.url ? { url: spec.url } : {}),
        ...(spec.date ? { date: spec.date } : {}),
        creators: spec.creators ?? [],
        tags: (spec.tags ?? []).map((tag) => ({ tag })),
        collections: spec.collections ?? [],
        ...(spec.fields ?? {}),
      },
    ]),
  });
  const json = await res.json();
  const key: string | undefined = json?.successful?.["0"]?.key;
  if (!res.ok || !key) {
    throw new Error(
      `Zotero would not create the item: ${res.status} ${JSON.stringify(json?.failed ?? json)}`,
    );
  }
  return key;
}

export type ZoteroCollection = {
  key: string;
  name: string;
  parent: string | null;
};

/** Every collection in the library, one page at a time. */
export async function listCollections(
  { userId, apiKey, api = zoteroApi }: ZoteroCredentials,
  fetchFn: typeof fetch = fetch,
): Promise<ZoteroCollection[]> {
  const out: ZoteroCollection[] = [];
  for (let start = 0; ; start += 100) {
    const res = await fetchFn(
      `${api}/users/${userId}/collections?limit=100&start=${start}`,
      { headers: { "Zotero-API-Key": apiKey, "Zotero-API-Version": "3" } },
    );
    const page = (await res.json()) as {
      key: string;
      data: { name: string; parentCollection: string | false };
    }[];
    for (const c of page) {
      out.push({
        key: c.key,
        name: c.data.name,
        parent: c.data.parentCollection || null,
      });
    }
    const total = Number(res.headers.get("Total-Results") ?? out.length);
    if (page.length === 0 || out.length >= total) return out;
  }
}

/** `2026 / 21 iteam / 14 landslide mediation` for each collection, by key. */
export function collectionPaths(
  collections: ZoteroCollection[],
): Map<string, string> {
  const byKey = new Map(collections.map((c) => [c.key, c]));
  const paths = new Map<string, string>();
  for (const c of collections) {
    const parts: string[] = [];
    let x: ZoteroCollection | undefined = c;
    while (x) {
      parts.unshift(x.name);
      x = x.parent ? byKey.get(x.parent) : undefined;
    }
    paths.set(c.key, parts.join(" / "));
  }
  return paths;
}

export async function uploadToZotero(
  { userId, apiKey, api = zoteroApi }: ZoteroCredentials,
  name: string,
  contentType: string,
  content: Uint8Array,
  options: UploadOptions = {},
): Promise<string> {
  const fetchFn = options.fetchFn ?? fetch;
  const headers = { "Zotero-API-Key": apiKey, "Zotero-API-Version": "3" };
  const items = `${api}/users/${userId}/items`;
  const form = (fields: Record<string, string>) =>
    Object.entries(fields)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join("&");

  // 1. The attachment item.
  const created = await fetchFn(items, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify([
      {
        itemType: "attachment",
        linkMode: "imported_file",
        title: options.title ?? name.replace(/\.[^.]+$/, ""),
        filename: name,
        contentType,
        tags: (options.tags ?? []).map((tag) => ({ tag })),
        // A child attachment carries no collections; the parent does.
        ...(options.parentItem
          ? { parentItem: options.parentItem }
          : { collections: options.collections ?? [] }),
      },
    ]),
  });
  const createdJson = await created.json();
  const key: string | undefined = createdJson?.successful?.["0"]?.key;
  if (!created.ok || !key) {
    throw new Error(
      `Zotero would not create the item: ${created.status} ${JSON.stringify(createdJson?.failed ?? createdJson)}`,
    );
  }

  // 2. Authorisation.
  const auth = await fetchFn(`${items}/${key}/file`, {
    method: "POST",
    headers: {
      ...headers,
      "Content-Type": "application/x-www-form-urlencoded",
      "If-None-Match": "*",
    },
    body: form({
      md5: md5Hex(content),
      filename: name,
      filesize: String(content.length),
      mtime: String(Date.now()),
    }),
  });
  const authJson = await auth.json();
  if (!auth.ok) {
    throw new Error(
      `Zotero refused the upload: ${auth.status} ${JSON.stringify(authJson)}`,
    );
  }
  if (authJson.exists) {
    return key; // Zotero already holds identical bytes.
  }

  // 3. The bytes, wrapped as instructed.
  const enc = new TextEncoder();
  const prefix = enc.encode(authJson.prefix);
  const suffix = enc.encode(authJson.suffix);
  const body = new Uint8Array(prefix.length + content.length + suffix.length);
  body.set(prefix, 0);
  body.set(content, prefix.length);
  body.set(suffix, prefix.length + content.length);
  const upload = await fetchFn(authJson.url, {
    method: "POST",
    headers: { "Content-Type": authJson.contentType },
    body,
  });
  if (!upload.ok && upload.status !== 201) {
    throw new Error(`The file store refused the bytes: ${upload.status}`);
  }

  // 4. Registration.
  const registered = await fetchFn(`${items}/${key}/file`, {
    method: "POST",
    headers: {
      ...headers,
      "Content-Type": "application/x-www-form-urlencoded",
      "If-None-Match": "*",
    },
    body: form({ upload: authJson.uploadKey }),
  });
  if (registered.status !== 204) {
    throw new Error(
      `Zotero would not register the upload: ${registered.status}`,
    );
  }
  return key;
}

/** Removes an item -- used to clean up after a test upload. */
export async function deleteZoteroItem(
  { userId, apiKey, api = zoteroApi }: ZoteroCredentials,
  key: string,
  fetchFn: typeof fetch = fetch,
): Promise<boolean> {
  const item = await fetchFn(`${api}/users/${userId}/items/${key}`, {
    headers: { "Zotero-API-Key": apiKey, "Zotero-API-Version": "3" },
  });
  const version = item.headers.get("Last-Modified-Version") ?? "";
  const res = await fetchFn(`${api}/users/${userId}/items/${key}`, {
    method: "DELETE",
    headers: {
      "Zotero-API-Key": apiKey,
      "Zotero-API-Version": "3",
      "If-Unmodified-Since-Version": version,
    },
  });
  return res.status === 204;
}

export type ZoteroItem = {
  key: string;
  version: number;
  itemType: string;
  title?: string;
  parentItem?: string;
  tags: { tag: string; type?: number }[];
};

/** One item, as the API has it. Undefined when there is no such item. */
export async function getZoteroItem(
  { userId, apiKey, api = zoteroApi }: ZoteroCredentials,
  key: string,
  fetchFn: typeof fetch = fetch,
): Promise<ZoteroItem | undefined> {
  const res = await fetchFn(`${api}/users/${userId}/items/${key}`, {
    headers: { "Zotero-API-Key": apiKey, "Zotero-API-Version": "3" },
  });
  if (!res.ok) return undefined;
  const body = (await res.json()) as { data?: Partial<ZoteroItem> };
  const data = body.data ?? {};
  return {
    key: data.key ?? key,
    version: data.version ?? Number(res.headers.get("Last-Modified-Version")),
    itemType: data.itemType ?? "",
    title: data.title,
    parentItem: data.parentItem,
    tags: data.tags ?? [],
  };
}

/**
 * Replaces an item's tags, leaving every other field as it is.
 *
 * A PATCH with `If-Unmodified-Since-Version` is how Zotero wants a partial
 * write: the version is what makes it refuse rather than clobber a change
 * made elsewhere since. Returns false on such a conflict, so a caller can
 * re-read and decide.
 */
export async function setZoteroItemTags(
  { userId, apiKey, api = zoteroApi }: ZoteroCredentials,
  key: string,
  tags: string[],
  version: number,
  fetchFn: typeof fetch = fetch,
): Promise<boolean> {
  const res = await fetchFn(`${api}/users/${userId}/items/${key}`, {
    method: "PATCH",
    headers: {
      "Zotero-API-Key": apiKey,
      "Zotero-API-Version": "3",
      "Content-Type": "application/json",
      "If-Unmodified-Since-Version": String(version),
    },
    body: JSON.stringify({ tags: tags.map((tag) => ({ tag })) }),
  });
  return res.ok;
}

export type ZoteroListPage = {
  items: Record<string, unknown>[];
  /** The library version the response was generated against. */
  version: number;
  /** How many items the query matches in total, on the first page. */
  total?: number;
};

/**
 * One page of the library. `since` makes it incremental: Zotero answers with
 * the items changed after that library version, which is how a whole library
 * is kept current in one request per change rather than thousands.
 */
export async function listZoteroItems(
  { userId, apiKey, api = zoteroApi }: ZoteroCredentials,
  options: { since?: number; start?: number; limit?: number } = {},
  fetchFn: typeof fetch = fetch,
): Promise<ZoteroListPage> {
  const params = new URLSearchParams({
    limit: String(options.limit ?? 100),
    start: String(options.start ?? 0),
  });
  if (options.since !== undefined) params.set("since", String(options.since));
  const res = await fetchFn(`${api}/users/${userId}/items?${params}`, {
    headers: { "Zotero-API-Key": apiKey, "Zotero-API-Version": "3" },
  });
  if (!res.ok) {
    throw new Error(`Zotero: could not list items (${res.status})`);
  }
  const body = (await res.json()) as { data?: Record<string, unknown> }[];
  const total = res.headers.get("Total-Results");
  return {
    items: body.map((entry) => entry.data ?? {}),
    version: Number(res.headers.get("Last-Modified-Version") ?? 0),
    ...(total ? { total: Number(total) } : {}),
  };
}

/** The keys of items deleted since a library version. */
export async function listDeletedZoteroItems(
  { userId, apiKey, api = zoteroApi }: ZoteroCredentials,
  since: number,
  fetchFn: typeof fetch = fetch,
): Promise<string[]> {
  const res = await fetchFn(`${api}/users/${userId}/deleted?since=${since}`, {
    headers: { "Zotero-API-Key": apiKey, "Zotero-API-Version": "3" },
  });
  if (!res.ok) return [];
  const body = (await res.json()) as { items?: string[] };
  return body.items ?? [];
}
