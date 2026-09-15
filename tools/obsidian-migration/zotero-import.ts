/**
 * Obsidian → Zotero: the vault's documents into the Zotero library, and the
 * vault's folder tree, faithfully, as collections under `2026`.
 *
 * Every folder becomes a collection, empty or not -- the tree is the point,
 * and a folder that holds only notes still has a place in it. The only
 * folders left out are code: a repository's `.git`, a `.nosync` project, a
 * scripts folder. Those were the earlier mirror's mistake.
 *
 * Documents only. An image stays beside its note, where it is shown inline;
 * everything else that is not a note -- PDFs, office files, scans, saved web
 * pages, videos -- goes in as a standalone attachment titled after its file,
 * in the collection of its folder. A file the library already holds
 * (matched by md5) is filed, not uploaded again. A file filed under the
 * wrong collection by an earlier run is moved.
 *
 *     npx tsx tools/obsidian-migration/zotero-import.ts            # dry run: the plan
 *     npx tsx tools/obsidian-migration/zotero-import.ts --apply    # do it (resumable)
 *     npx tsx tools/obsidian-migration/zotero-import.ts --cleanup  # delete empty collections under 2026
 *
 * Writes `zotero-map.json` beside the manifest: vault path → item key, which
 * the converter reads to write `[[zotero:KEY][name]]` in place of a file link.
 */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { md5Hex } from "../../plug-api/lib/md5.ts";
import {
  uploadToZotero,
  type ZoteroCredentials,
} from "../../plug-api/lib/zotero_api.ts";
import { config } from "./config.ts";
import type { Manifest } from "./manifest.ts";

const apply = process.argv.includes("--apply");
const cleanup = process.argv.includes("--cleanup");
const only = process.argv.includes("--only")
  ? process.argv[process.argv.indexOf("--only") + 1]
  : undefined;

const ROOT_COLLECTION = "2026";
const api = "https://api.zotero.org";

// ---------------------------------------------------------------------------
// Credentials and the API
// ---------------------------------------------------------------------------

function credentials(): ZoteroCredentials {
  const home = process.env.HOME!;
  const apiKey = readFileSync(
    join(home, ".config/silverbullet/zotero.env"),
    "utf8",
  )
    .trim()
    .split("=")[1];
  const userId = readFileSync(
    join(home, ".config/silverbullet/zotero.userid"),
    "utf8",
  )
    .trim()
    .split("=")[1];
  return { userId, apiKey };
}
const creds = credentials();
const headers = { "Zotero-API-Key": creds.apiKey, "Zotero-API-Version": "3" };
const base = `${api}/users/${creds.userId}`;

/** A request that honours Zotero's backoff and retries on a rate limit. */
async function zfetch(path: string, init: RequestInit = {}): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(path.startsWith("http") ? path : `${base}${path}`, {
      ...init,
      headers: { ...headers, ...(init.headers as Record<string, string>) },
    });
    const backoff =
      res.headers.get("Backoff") ?? res.headers.get("Retry-After");
    if (res.status === 429 || (res.status >= 500 && attempt < 5)) {
      const wait = Math.max(2, Number(backoff) || 2 ** attempt) * 1000;
      console.log(`  (${res.status}; waiting ${wait / 1000}s)`);
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    if (backoff)
      await new Promise((r) => setTimeout(r, Number(backoff) * 1000));
    return res;
  }
}

async function all<T>(path: string): Promise<T[]> {
  const out: T[] = [];
  for (let start = 0; ; start += 100) {
    const res = await zfetch(
      `${path}${path.includes("?") ? "&" : "?"}limit=100&start=${start}`,
    );
    const page = (await res.json()) as T[];
    out.push(...page);
    const total = Number(res.headers.get("Total-Results") ?? out.length);
    if (page.length === 0 || out.length >= total) return out;
  }
}

// ---------------------------------------------------------------------------
// What is in the library
// ---------------------------------------------------------------------------

type Collection = {
  key: string;
  version: number;
  data: { name: string; parentCollection: string | false };
  meta: { numItems: number; numCollections: number };
};
type Attachment = {
  key: string;
  version: number;
  data: {
    itemType: string;
    md5?: string;
    parentItem?: string;
    collections?: string[];
    filename?: string;
  };
};

async function loadLibrary() {
  const collections = await all<Collection>("/collections");
  const attachments = (
    await all<Attachment>("/items?itemType=attachment")
  ).filter((a) => a.data.md5);
  const byMd5 = new Map<string, Attachment>();
  for (const a of attachments) byMd5.set(a.data.md5!, a);
  return { collections, byMd5 };
}

/**
 * Collection key for a path of names under the root, creating as needed.
 *
 * A folder's collection may already exist somewhere else: an earlier run
 * filed it two levels deep, or it was moved by hand. `owners` says which
 * collection holds a vault folder's files; such a collection is moved under
 * its rightful parent rather than duplicated. Only that exact match moves a
 * collection -- many folders share a name (`assets`, `00 meta`).
 */
function collectionResolver(
  collections: Collection[],
  owners: Map<string, string>,
) {
  const byParentName = new Map<string, Collection>();
  const byKey = new Map<string, Collection>();
  const keyOf = (c: Collection) =>
    `${c.data.parentCollection || ""}/${c.data.name}`;
  for (const c of collections) {
    byParentName.set(keyOf(c), c);
    byKey.set(c.key, c);
  }
  const created: string[] = [];
  const moved: string[] = [];
  let fakes = 0;
  return {
    created,
    moved,
    async resolve(path: string[]): Promise<string> {
      let parent: string | false = false;
      for (let i = 0; i < path.length; i++) {
        const name = path[i];
        const existing = byParentName.get(`${parent || ""}/${name}`);
        if (existing) {
          parent = existing.key;
          continue;
        }
        const vaultDir = path.slice(1, i + 1).join("/");
        const ownerKey = owners.get(vaultDir);
        const owner = ownerKey ? byKey.get(ownerKey) : undefined;
        if (
          owner &&
          owner.data.name === name &&
          owner.data.parentCollection !== parent
        ) {
          // The collection exists under the wrong parent: move it.
          if (apply) {
            const res = await zfetch(`/collections/${owner.key}`, {
              method: "PATCH",
              headers: {
                "Content-Type": "application/json",
                "If-Unmodified-Since-Version": String(owner.version),
              },
              body: JSON.stringify({ parentCollection: parent }),
            });
            if (res.status !== 204) {
              throw new Error(
                `Could not move ${name}: ${res.status} ${await res.text()}`,
              );
            }
            owner.version = Number(
              res.headers.get("Last-Modified-Version") ?? owner.version,
            );
          }
          byParentName.delete(keyOf(owner));
          owner.data.parentCollection = parent;
          byParentName.set(keyOf(owner), owner);
          moved.push(path.slice(0, i + 1).join(" / "));
          parent = owner.key;
          continue;
        }
        let key: string;
        if (apply) {
          const res = await zfetch("/collections", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify([{ name, parentCollection: parent }]),
          });
          const json = await res.json();
          key = json?.successful?.["0"]?.key;
          if (!key) {
            throw new Error(
              `Could not create collection ${name}: ${res.status} ${JSON.stringify(json)}`,
            );
          }
        } else {
          key = `NEW:${++fakes}`;
        }
        const c: Collection = {
          key,
          version: 0,
          data: { name, parentCollection: parent },
          meta: { numItems: 0, numCollections: 0 },
        };
        byParentName.set(keyOf(c), c);
        byKey.set(key, c);
        created.push(path.slice(0, i + 1).join(" / "));
        parent = key;
      }
      return parent as string;
    },
  };
}

// ---------------------------------------------------------------------------
// What goes in
// ---------------------------------------------------------------------------

const imageExt = /\.(png|jpe?g|gif|webp|svg|bmp|tiff?|heic|ico|icns)$/i;
const codeMarkers =
  /\.(py|js|ts|jsx|tsx|rs|swift|sh|go|rb|c|h|cpp|scad|ino|css|scss|json|lock|toml|yaml|yml|dxf)$/i;
const skipFile =
  /^(\.DS_Store|\.gitkeep|\.gitignore|LICENSE(\.txt)?|README\.md)$/;

type Planned = {
  source: string; // vault-relative
  name: string;
  collectionPath: string[];
  md5: string;
  size: number;
  contentType: string;
  action: "exists" | "upload";
  existingKey?: string;
};

function contentTypeOf(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return (
    (
      {
        pdf: "application/pdf",
        html: "text/html",
        htm: "text/html",
        txt: "text/plain",
        md: "text/markdown",
        epub: "application/epub+zip",
        docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        csv: "text/csv",
        mp4: "video/mp4",
        mov: "video/quicktime",
        mkv: "video/x-matroska",
        m4a: "audio/mp4",
        mp3: "audio/mpeg",
        zip: "application/zip",
        numbers: "application/vnd.apple.numbers",
        pages: "application/vnd.apple.pages",
        key: "application/vnd.apple.keynote",
        odt: "application/vnd.oasis.opendocument.text",
        tex: "text/x-tex",
        ai: "application/postscript",
        afdesign: "application/octet-stream",
        mbox: "application/mbox",
      } as Record<string, string>
    )[ext] ?? "application/octet-stream"
  );
}

/** The collection path for a vault folder, verbatim: `2026 / 20-29 Missions / 21 iteam / …`. */
function collectionPathFor(vaultDir: string): string[] {
  const parts = vaultDir.split("/").filter(Boolean);
  return [ROOT_COLLECTION, ...parts];
}

const skipDirs = [
  /^\.obsidian/,
  /^\.trash$/,
  /^\.claude$/,
  /^reMarkable$/,
  /^\.git$/,
  /\.nosync$/,
  /\.icon$/,
];
const projectMarkers = [
  ".git",
  "package.json",
  "Cargo.toml",
  "pyproject.toml",
  "requirements.txt",
  "go.mod",
];

/** Whether a vault folder is code, and so no part of the tree. */
function isCodeDir(abs: string, name: string): boolean {
  if (skipDirs.some((r) => r.test(name))) return true;
  const names = readdirSync(abs);
  // A JD category that happens to be a repository (the Pittsburgh book is)
  // is still a place; only a project *inside* the tree is code.
  const numbered = /^\d{2}(\.\d{2})? |^\d+-\d+ /.test(name);
  if (!numbered && names.some((n) => projectMarkers.includes(n))) return true;
  return !numbered && names.filter((n) => codeMarkers.test(n)).length >= 3;
}

/** Every folder in the vault that belongs in the tree, as vault-relative paths. */
function* vaultDirs(dir: string, rel = ""): Generator<string> {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const abs = join(dir, e.name);
    if (isCodeDir(abs, e.name)) continue;
    const r = rel ? `${rel}/${e.name}` : e.name;
    yield r;
    yield* vaultDirs(abs, r);
  }
}

function* filesOf(dir: string, rel = ""): Generator<string> {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) yield* filesOf(join(dir, e.name), r);
    else yield r;
  }
}

function plan(
  manifest: Manifest,
  byMd5: Map<string, Attachment>,
): { planned: Planned[]; skipped: Record<string, number> } {
  const planned: Planned[] = [];
  const skipped: Record<string, number> = {};
  const skip = (why: string) => {
    skipped[why] = (skipped[why] ?? 0) + 1;
  };
  const candidates: [string, string][] = [];
  const consider = (source: string, targetPath: string) => {
    const name = source.split("/").pop()!;
    if (skipFile.test(name)) return skip("housekeeping file");
    if (imageExt.test(name)) return skip("image (stays beside the note)");
    if (codeMarkers.test(name)) return skip("code");
    candidates.push([source, targetPath]);
  };
  const place = () => {
    for (const [source] of candidates) {
      const name = source.split("/").pop()!;
      const abs = join(manifest.vault, source);
      const size = statSync(abs).size;
      if (size === 0) {
        skip("empty");
        continue;
      }
      const md5 = md5Hex(new Uint8Array(readFileSync(abs)));
      const existing = byMd5.get(md5);
      const vaultDir = source.split("/").slice(0, -1).join("/");
      planned.push({
        source,
        name,
        collectionPath: collectionPathFor(vaultDir),
        md5,
        size,
        contentType: contentTypeOf(name),
        action: existing ? "exists" : "upload",
        existingKey: existing?.data.parentItem ?? existing?.key,
      });
    }
  };
  for (const e of manifest.entries) {
    if (!e.target) continue;
    if (only && !e.source.includes(only)) continue;
    if (e.kind === "attachment" || e.kind === "journal-attachment") {
      consider(e.source, e.target);
    } else if (e.kind === "verbatim") {
      const abs = join(manifest.vault, e.source);
      const name = e.source.split("/").pop()!;
      // A repository or code project stays a folder; a dump or a saved page
      // is documents.
      // A repository's internals are not documents, and carry no marker of
      // their own to say so.
      if (name === ".git" || e.source.includes("/.git/")) {
        skip("code folder");
        continue;
      }
      const names = existsSync(abs) ? readdirSync(abs) : [];
      if (
        /\.nosync$/.test(name) ||
        names.some((n) =>
          [
            ".git",
            "package.json",
            "Cargo.toml",
            "pyproject.toml",
            "requirements.txt",
            "go.mod",
          ].includes(n),
        ) ||
        names.filter((n) => codeMarkers.test(n)).length >= 3
      ) {
        skip("code folder");
        continue;
      }
      if (/\.icon$/.test(name)) {
        skip("macOS bundle");
        continue;
      }
      for (const inner of filesOf(abs))
        consider(`${e.source}/${inner}`, `${e.target}/${inner}`);
    }
  }
  place();
  return { planned, skipped };
}

// ---------------------------------------------------------------------------
// Doing it
// ---------------------------------------------------------------------------

type ZoteroMap = Record<string, { key: string; collection: string }>;

async function fileExisting(
  item: Attachment | undefined,
  key: string,
  collection: string,
) {
  // An attachment under a parent is filed via its parent.
  const res = await zfetch(`/items/${key}`);
  const item2 = await res.json();
  const version = res.headers.get("Last-Modified-Version") ?? "";
  const target = item2.data.parentItem ? item2.data.parentItem : key;
  const tRes = target === key ? res : await zfetch(`/items/${target}`);
  const tJson = target === key ? item2 : await tRes.json();
  const tVersion =
    target === key
      ? version
      : (tRes.headers.get("Last-Modified-Version") ?? "");
  const current: string[] = tJson.data.collections ?? [];
  if (current.includes(collection)) return target;
  const patch = await zfetch(`/items/${target}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      "If-Unmodified-Since-Version": tVersion,
    },
    body: JSON.stringify({ collections: [...current, collection] }),
  });
  if (patch.status !== 204)
    throw new Error(
      `Could not file ${target}: ${patch.status} ${await patch.text()}`,
    );
  void item;
  return target;
}

async function main() {
  const manifest: Manifest = JSON.parse(
    readFileSync(join(config.out, "manifest.json"), "utf8"),
  );
  const mapPath = join(config.out, "zotero-map.json");
  const map: ZoteroMap = existsSync(mapPath)
    ? JSON.parse(readFileSync(mapPath, "utf8"))
    : {};

  console.log("Reading the library…");
  const { collections, byMd5 } = await loadLibrary();
  console.log(
    `  ${collections.length} collections, ${byMd5.size} attachments with md5`,
  );

  if (cleanup) return deleteEmptyCollections(collections, manifest.vault);

  const { planned, skipped } = plan(manifest, byMd5);
  // Which collection currently holds each vault folder's files, per the map.
  const owners = new Map<string, string>();
  const tally = new Map<string, Map<string, number>>();
  for (const [source, { collection }] of Object.entries(map)) {
    const dir = source.split("/").slice(0, -1).join("/");
    const t = tally.get(dir) ?? new Map<string, number>();
    t.set(collection, (t.get(collection) ?? 0) + 1);
    tally.set(dir, t);
  }
  for (const [dir, t] of tally) {
    owners.set(dir, [...t].sort((a, b) => b[1] - a[1])[0][0]);
  }
  const resolver = collectionResolver(collections, owners);

  // The whole tree first, parents before children, empty folders included.
  const dirs = [...vaultDirs(manifest.vault)].sort();
  for (const dir of dirs) await resolver.resolve(collectionPathFor(dir));
  console.log(
    `tree: ${dirs.length} folders; ${resolver.created.length} collections to create, ${resolver.moved.length} to move`,
  );
  const bytes = planned
    .filter((p) => p.action === "upload")
    .reduce((n, p) => n + p.size, 0);
  const already = planned.filter((p) => map[p.source]).length;

  // The plan, as a tree of counts.
  const perCollection = new Map<string, { exists: number; upload: number }>();
  for (const p of planned) {
    const k = p.collectionPath.join(" / ");
    const c = perCollection.get(k) ?? { exists: 0, upload: 0 };
    c[p.action]++;
    perCollection.set(k, c);
  }
  const lines = [
    `# Zotero import plan — ${new Date().toISOString().slice(0, 16).replace("T", " ")}`,
    "",
    `| | count |`,
    `|---|---|`,
    `| documents to file | ${planned.length} |`,
    `| already in the library (md5 match) → filed, not uploaded | ${planned.filter((p) => p.action === "exists").length} |`,
    `| to upload | ${planned.filter((p) => p.action === "upload").length} (${(bytes / 1e9).toFixed(2)} GB) |`,
    `| done on a previous run | ${already} |`,
    `| collections | ${perCollection.size} |`,
    "",
    "## Skipped",
    "",
    ...Object.entries(skipped).map(([k, v]) => `- ${v} × ${k}`),
    "",
    "## Collections (exists / upload)",
    "",
    ...[...perCollection]
      .sort()
      .map(([k, c]) => `- ${k}  — ${c.exists} / ${c.upload}`),
    "",
  ];
  writeFileSync(join(config.out, "zotero-plan.md"), lines.join("\n"));
  console.log(lines.slice(0, 12).join("\n"));
  console.log(`\nFull plan in ${join(config.out, "zotero-plan.md")}`);
  // Files an earlier run put in the wrong collection move to the right one.
  let refiled = 0;
  for (const p of planned) {
    const entry = map[p.source];
    if (!entry) continue;
    const exact = await resolver.resolve(p.collectionPath);
    if (entry.collection === exact) continue;
    refiled++;
    if (!apply) continue;
    const res = await zfetch(`/items/${entry.key}`);
    const item = await res.json();
    const version = res.headers.get("Last-Modified-Version") ?? "";
    const current: string[] = item.data.collections ?? [];
    const next = [...current.filter((c) => c !== entry.collection), exact];
    const patch = await zfetch(`/items/${entry.key}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "If-Unmodified-Since-Version": version,
      },
      body: JSON.stringify({ collections: next }),
    });
    if (patch.status !== 204) {
      console.log(
        `  FAILED to refile ${p.source}: ${patch.status} ${await patch.text()}`,
      );
      continue;
    }
    entry.collection = exact;
    console.log(`  refiled ${entry.key}  ${p.source}`);
  }
  console.log(`${refiled} files ${apply ? "refiled" : "to refile"}`);
  if (apply) writeFileSync(mapPath, JSON.stringify(map, null, 1));

  if (!apply) {
    console.log(
      `Would create ${resolver.created.length} and move ${resolver.moved.length} collections. Dry run; pass --apply to write.`,
    );
    return;
  }

  let n = 0;
  for (const p of planned) {
    if (map[p.source]) continue;
    const collection = await resolver.resolve(p.collectionPath);
    try {
      let key: string;
      if (p.action === "exists") {
        key = await fileExisting(byMd5.get(p.md5), p.existingKey!, collection);
      } else {
        const content = new Uint8Array(
          readFileSync(join(manifest.vault, p.source)),
        );
        key = await uploadToZotero(creds, p.name, p.contentType, content, {
          collections: [collection],
          title: p.name.replace(/\.[^.]+$/, ""),
        });
      }
      map[p.source] = { key, collection };
      if (++n % 10 === 0) writeFileSync(mapPath, JSON.stringify(map, null, 1));
      console.log(
        `  ${p.action === "exists" ? "filed   " : "uploaded"} ${key}  ${p.source}`,
      );
    } catch (e: any) {
      console.log(`  FAILED ${p.source}: ${e.message}`);
    }
  }
  writeFileSync(mapPath, JSON.stringify(map, null, 1));
  console.log(
    `\n${Object.keys(map).length} files mapped in ${mapPath}; ${resolver.created.length} collections created.`,
  );
}

/**
 * Removes collections under the root that hold nothing *and* answer to no
 * folder in the vault -- an earlier run's leftovers. An empty collection
 * that is a vault folder stays: the tree is the point.
 */
async function deleteEmptyCollections(
  collections: Collection[],
  vault: string,
) {
  const root = collections.find(
    (c) => c.data.name === ROOT_COLLECTION && !c.data.parentCollection,
  );
  if (!root) return console.log("no root collection");
  const wanted = new Set([...vaultDirs(vault)]);
  const byKey = new Map(collections.map((c) => [c.key, c]));
  const pathOf = (c: Collection): string => {
    const parts: string[] = [];
    let x: Collection | undefined = c;
    while (x && x.key !== root.key) {
      parts.unshift(x.data.name);
      x = x.data.parentCollection
        ? byKey.get(x.data.parentCollection)
        : undefined;
    }
    return parts.join("/");
  };
  const children = new Map<string, Collection[]>();
  for (const c of collections) {
    const p = c.data.parentCollection || "";
    children.set(p, [...(children.get(p) ?? []), c]);
  }
  // Post-order: a parent is empty only once its empty children are gone.
  const toDelete: Collection[] = [];
  const visit = (c: Collection): boolean => {
    const kids = children.get(c.key) ?? [];
    const allKidsGone = kids.map(visit).every(Boolean);
    const empty = c.meta.numItems === 0 && allKidsGone;
    const unwanted = empty && !wanted.has(pathOf(c));
    if (unwanted && c.key !== root.key) toDelete.push(c);
    // A wanted empty folder is kept, and keeps its parent.
    return unwanted;
  };
  visit(root);
  console.log(
    `${toDelete.length} empty collections under ${ROOT_COLLECTION} that are not vault folders`,
  );
  for (const c of toDelete.slice(0, 40)) console.log(`  - ${pathOf(c)}`);
  if (!apply)
    return console.log("Dry run; pass --apply --cleanup to delete them.");
  // In batches of 50 keys. The precondition is the *library* version --
  // items count too -- read fresh for each batch, since each delete moves it.
  const keys = toDelete.map((c) => c.key);
  for (let i = 0; i < keys.length; i += 50) {
    const probe = await zfetch("/collections?limit=1");
    const version = probe.headers.get("Last-Modified-Version") ?? "";
    const res = await zfetch(
      `/collections?collectionKey=${keys.slice(i, i + 50).join(",")}`,
      { method: "DELETE", headers: { "If-Unmodified-Since-Version": version } },
    );
    console.log(
      `  deleted ${Math.min(i + 50, keys.length)}/${keys.length}: ${res.status}`,
    );
    if (res.status !== 204) console.log(await res.text());
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
