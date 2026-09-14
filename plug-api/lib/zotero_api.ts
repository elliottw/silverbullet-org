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

export async function uploadToZotero(
  { userId, apiKey, api = zoteroApi }: ZoteroCredentials,
  name: string,
  contentType: string,
  content: Uint8Array,
  fetchFn: typeof fetch = fetch,
): Promise<string> {
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
        title: name.replace(/\.[^.]+$/, ""),
        filename: name,
        contentType,
        tags: [],
        collections: [],
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
