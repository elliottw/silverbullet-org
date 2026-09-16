/**
 * File each migrated item in the collection its Obsidian folder names --
 * against the tree as it stands in Zotero, which is the source of truth.
 *
 * No collection is created or moved here. The vault folder a file came from
 * is turned into a path under `2026` and matched to an existing collection,
 * tolerantly (case, `&` written `_`, doubled spaces); if that exact folder
 * is gone -- merged away by hand -- the nearest ancestor that exists is
 * used, and the file is listed so the choice can be checked. An item that
 * is already in some collection under the root is left where it is: it may
 * have been placed by hand.
 *
 *     npx tsx tools/obsidian-migration/zotero-file.ts            # dry run
 *     npx tsx tools/obsidian-migration/zotero-file.ts --apply
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  collectionPaths,
  listCollections,
  type ZoteroCredentials,
} from "../../plug-api/lib/zotero_api.ts";
import { config } from "./config.ts";

const apply = process.argv.includes("--apply");
const ROOT = "2026";

const home = process.env.HOME!;
const creds: ZoteroCredentials = {
  apiKey: readFileSync(join(home, ".config/silverbullet/zotero.env"), "utf8")
    .trim()
    .split("=")[1],
  userId: readFileSync(join(home, ".config/silverbullet/zotero.userid"), "utf8")
    .trim()
    .split("=")[1],
};
const headers = { "Zotero-API-Key": creds.apiKey, "Zotero-API-Version": "3" };
const base = `https://api.zotero.org/users/${creds.userId}`;

async function zfetch(path: string, init: RequestInit = {}): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${base}${path}`, {
      ...init,
      headers: { ...headers, ...(init.headers as Record<string, string>) },
    });
    const backoff =
      res.headers.get("Backoff") ?? res.headers.get("Retry-After");
    if (res.status === 429 || (res.status >= 500 && attempt < 5)) {
      await new Promise((r) =>
        setTimeout(r, Math.max(2, Number(backoff) || 2 ** attempt) * 1000),
      );
      continue;
    }
    if (backoff)
      await new Promise((r) => setTimeout(r, Number(backoff) * 1000));
    return res;
  }
}

/** A path as it would be typed by someone not fussy about case or `&`. */
const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/&/g, "_")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

type MapEntry = {
  key: string;
  collection: string;
  parent?: string;
  filed?: string;
};

async function main() {
  const mapPath = join(config.out, "zotero-map.json");
  const map: Record<string, MapEntry> = JSON.parse(
    readFileSync(mapPath, "utf8"),
  );
  const collections = await listCollections(creds);
  const paths = collectionPaths(collections);
  const byNormPath = new Map<string, string>();
  for (const [key, path] of paths) byNormPath.set(norm(path), key);
  const underRoot = new Set(
    [...paths]
      .filter(([, p]) => p === ROOT || p.startsWith(`${ROOT} / `))
      .map(([k]) => k),
  );

  const tally: Record<string, number> = {};
  const count = (k: string) => {
    tally[k] = (tally[k] ?? 0) + 1;
  };
  const fallbacks: string[] = [];
  const unplaced: string[] = [];
  const toFile: {
    source: string;
    parent: string;
    collection: string;
    path: string;
  }[] = [];

  for (const [source, entry] of Object.entries(map)) {
    const parent = entry.parent ?? entry.key;
    const dir = source.split("/").slice(0, -1);
    const wanted = [ROOT, ...dir];
    // The deepest prefix of the wanted path that exists in the tree.
    let matched: string | undefined;
    let depth = wanted.length;
    for (; depth >= 1; depth--) {
      matched = byNormPath.get(norm(wanted.slice(0, depth).join(" / ")));
      if (matched) break;
    }
    if (!matched || depth === 1) {
      unplaced.push(source);
      count("no collection for its folder");
      continue;
    }
    if (depth < wanted.length)
      fallbacks.push(`${source}  →  ${paths.get(matched)}`);
    toFile.push({
      source,
      parent,
      collection: matched,
      path: paths.get(matched)!,
    });
  }

  console.log(
    `${Object.keys(map).length} items; ${toFile.length} have a matching collection (${fallbacks.length} by nearest ancestor), ${unplaced.length} none`,
  );
  if (fallbacks.length) {
    console.log("\nFiled under the nearest existing ancestor:");
    for (const f of fallbacks.slice(0, 40)) console.log(`  ${f}`);
    if (fallbacks.length > 40) console.log(`  … ${fallbacks.length - 40} more`);
  }
  if (unplaced.length) {
    console.log("\nNo collection at all for:");
    for (const u of unplaced.slice(0, 20)) console.log(`  ${u}`);
  }

  // What each parent is in now.
  let placed = 0;
  let already = 0;
  let left = 0;
  for (const f of toFile) {
    const res = await zfetch(`/items/${f.parent}`);
    if (res.status === 404) {
      count("parent gone");
      continue;
    }
    const item = await res.json();
    const current: string[] = item.data.collections ?? [];
    if (current.includes(f.collection)) {
      already++;
      continue;
    }
    if (current.some((c) => underRoot.has(c))) {
      // Placed under the root by hand, or by an earlier pass: leave it.
      left++;
      continue;
    }
    placed++;
    if (!apply) continue;
    const patch = await zfetch(`/items/${f.parent}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "If-Unmodified-Since-Version":
          res.headers.get("Last-Modified-Version") ?? "",
      },
      body: JSON.stringify({ collections: [...current, f.collection] }),
    });
    if (patch.status !== 204)
      console.log(
        `  FAILED ${f.source}: ${patch.status} ${await patch.text()}`,
      );
    else map[f.source].filed = f.collection;
  }
  console.log(
    `\nalready in its folder's collection: ${already}; in another collection under ${ROOT}, left alone: ${left}; ${apply ? "filed" : "to file"}: ${placed}`,
  );
  if (apply) writeFileSync(mapPath, JSON.stringify(map, null, 1));
  else console.log("Dry run; pass --apply to file them.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
