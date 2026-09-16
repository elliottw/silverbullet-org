/**
 * The maker projects go to Zotero: every folder under
 * `config.folders.zoteroProjects` that is not code becomes one parent item
 * (a `document` titled after the folder, dated from its prefix) with the
 * folder's files -- cut files, CAD, photos, notes-to-self -- as its
 * attachments, filed in the collection that matches the vault folder. The
 * result is appended to `zotero-map.json`, so the converter links the files
 * and leaves them out of the library.
 *
 *     npx tsx tools/obsidian-migration/zotero-projects.ts            # dry run
 *     npx tsx tools/obsidian-migration/zotero-projects.ts --apply
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  collectionPaths,
  createParentItem,
  listCollections,
  uploadToZotero,
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

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/&/g, "_")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

const contentTypes: Record<string, string> = {
  svg: "image/svg+xml",
  dxf: "image/vnd.dxf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
};

function* files(dir: string, rel = ""): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const r = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) yield* files(join(dir, entry.name), r);
    else if (entry.name !== ".DS_Store") yield r;
  }
}

async function main() {
  const mapPath = join(config.out, "zotero-map.json");
  const map: Record<
    string,
    { key: string; collection: string; parent?: string }
  > = JSON.parse(readFileSync(mapPath, "utf8"));
  const paths = collectionPaths(await listCollections(creds));
  const byNormPath = new Map([...paths].map(([k, p]) => [norm(p), k]));
  const code = new Set(Object.keys(config.folders.code));

  for (const projectsDir of config.folders.zoteroProjects) {
    const collection = byNormPath.get(
      norm([ROOT, ...projectsDir.split("/")].join(" / ")),
    );
    if (!collection) throw new Error(`no collection for ${projectsDir}`);
    for (const entry of readdirSync(join(config.vault, projectsDir), {
      withFileTypes: true,
    }).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = entry.name;
      const rel = `${projectsDir}/${name}`;
      const abs = join(config.vault, rel);
      if (!entry.isDirectory() || code.has(rel)) continue;
      const list = [...files(abs)].filter((f) => !map[`${rel}/${f}`]);
      if (!list.length) continue;
      const dated = /^(\d{4}-\d{2}-\d{2}) (.+)$/.exec(name);
      const title = dated ? dated[2] : name;
      console.log(
        `${apply ? "creating" : "would create"} "${title}"${dated ? ` (${dated[1]})` : ""} → ${paths.get(collection)} with ${list.length} files`,
      );
      if (!apply) continue;
      const parent = await createParentItem(creds, {
        itemType: "document",
        title,
        date: dated?.[1],
        collections: [collection],
        tags: ["mxg", "project"],
      });
      for (const f of list) {
        const ext = f.split(".").pop()!.toLowerCase();
        const key = await uploadToZotero(
          creds,
          f.split("/").pop()!,
          contentTypes[ext] ?? "application/octet-stream",
          new Uint8Array(readFileSync(join(abs, f))),
          { parentItem: parent, title: f },
        );
        map[`${rel}/${f}`] = { key, collection, parent };
        console.log(`  ${f} → ${key}`);
        writeFileSync(mapPath, JSON.stringify(map, null, 1));
      }
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
