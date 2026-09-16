/**
 * Brings a cut-over library up to date with a regenerated staging, touching
 * only what the migration itself wrote and has since changed.
 *
 * Three-way: the previous staging (what the cutover installed), the new
 * staging, and the library as it is now. A file the two stagings agree on is
 * left alone. One they differ on is replaced only if the library still holds
 * exactly what the previous staging put there -- otherwise it has been
 * edited since, and it is listed rather than touched. A note whose *name*
 * changed (a signature gained or dropped) is found by its identifier and
 * renamed; if it was edited meanwhile, only its front matter is updated. A
 * note the new staging no longer makes is removed if unedited.
 *
 *     npx tsx tools/obsidian-migration/reconcile.ts            # dry run
 *     npx tsx tools/obsidian-migration/reconcile.ts --apply
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  denoteFileType,
  parseDenoteFrontMatter,
  parseDenoteName,
  rewriteDenoteFrontMatter,
} from "../../plug-api/lib/denote.ts";
import { config } from "./config.ts";

const apply = process.argv.includes("--apply");
const previous = join(config.out, "staging-previous");
const next = join(config.out, "staging");

function* files(dir: string, rel = ""): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const r = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) yield* files(join(dir, entry.name), r);
    else yield r;
  }
}

const read = (root: string, rel: string): Buffer | undefined =>
  existsSync(join(root, rel)) ? readFileSync(join(root, rel)) : undefined;
/**
 * Whether two files are the same, ignoring what dynamic blocks hold: opening
 * a hub in SilverBullet refreshes its blocks and saves, and that is not an
 * edit of the user's -- the block bodies are regenerated anyway.
 */
const same = (a?: Buffer, b?: Buffer, rel = "") =>
  !!a &&
  !!b &&
  (a.equals(b) ||
    (rel.endsWith(".org") &&
      withoutBlockBodies(a.toString("utf8")) ===
        withoutBlockBodies(b.toString("utf8"))));
const withoutBlockBodies = (text: string) =>
  text.replace(/^(#\+BEGIN:[^\n]*\n)[\s\S]*?(?=^#\+END:)/gm, "$1");
const idOf = (rel: string) => parseDenoteName(rel)?.identifier;

const tally: Record<string, string[]> = {};
const note = (what: string, rel: string) => {
  (tally[what] ??= []).push(rel);
};

function put(rel: string, content: Buffer) {
  if (!apply) return;
  mkdirSync(dirname(join(config.library, rel)), { recursive: true });
  writeFileSync(join(config.library, rel), content);
}

/** The new front matter's title and signature, applied to text kept as edited. */
function refreshFrontMatter(
  edited: Buffer,
  fresh: Buffer,
  rel: string,
): Buffer {
  const parsed = parseDenoteName(rel);
  if (!parsed || !rel.endsWith(".org")) return edited;
  const fm = parseDenoteFrontMatter(fresh.toString("utf8"), "org");
  return Buffer.from(
    rewriteDenoteFrontMatter(edited.toString("utf8"), denoteFileType(".org"), {
      title: fm.title,
      signature: fm.signature ?? "",
    }),
  );
}

function main() {
  if (!existsSync(previous)) {
    console.error(`no ${previous}: nothing to compare against`);
    process.exit(1);
  }
  const oldFiles = new Set(files(previous));
  const newFiles = new Set(files(next));
  const newById = new Map<string, string>();
  for (const rel of newFiles) {
    const id = idOf(rel);
    if (id) newById.set(id, rel);
  }
  // The library's own notes by identifier: one of them may have gained an
  // address, which is a rename of a file the stagings never held.
  const libById = new Map<string, string[]>();
  for (const rel of files(config.library)) {
    if (rel.endsWith("~") || rel.startsWith(".")) continue;
    const id = idOf(rel);
    if (id) libById.set(id, [...(libById.get(id) ?? []), rel]);
  }
  /**
   * What a file held before this run, where that is known: the previous
   * staging's copy, or the original the cutover replaced. A library file
   * the migration never wrote has no "before" -- it is its own.
   */
  const before = (rel: string): Buffer | undefined =>
    read(previous, rel) ?? read(join(config.out, "replaced"), rel);
  /**
   * Whether `other` is the old name of the note now at `rel`: a Denote note,
   * and everything it held past its front matter is in the new file. A
   * backup or a stray copy sharing the identifier is neither, and is left.
   */
  const supersededBy = (other: string, fresh: Buffer): boolean => {
    if (!other.endsWith(".org")) return false;
    const body = (b: Buffer) =>
      b
        .toString("utf8")
        .replace(/^(#\+[^\n]*\n)+/, "")
        .trim();
    return fresh.toString("utf8").includes(body(read(config.library, other)!));
  };

  for (const rel of [...newFiles].sort()) {
    const fresh = read(next, rel)!;
    const id = idOf(rel);
    const current = read(config.library, rel);
    // Whatever else, another library file with this identifier under a name
    // the new staging does not make is the old name of this note.
    const stale = (id ? (libById.get(id) ?? []) : []).filter(
      (other) => other !== rel && !newFiles.has(other),
    );
    if (current && same(current, fresh, rel)) {
      for (const other of stale) {
        if (supersededBy(other, fresh)) {
          note("leftover of a rename; removed", other);
          if (apply) rmSync(join(config.library, other));
        } else {
          note("another file carries this identifier; left alone", other);
        }
      }
      continue;
    }
    if (current) {
      // Same name, different content.
      if (same(current, before(rel), rel)) {
        note("updated", rel);
        put(rel, fresh);
      } else if (oldFiles.has(rel)) {
        note(
          "edited since the cutover; left alone (see staging/ for the new version)",
          rel,
        );
      } else {
        note("a library file of this name exists and differs; left alone", rel);
      }
      continue;
    }
    // New name. The same identifier under another name is a rename.
    const was = stale.find((other) => other.endsWith(".org"));
    if (was) {
      const had = read(config.library, was)!;
      // A note the stagings never held is its own original.
      if (!before(was) || same(had, before(was), was)) {
        note("renamed and updated", `${was} → ${rel}`);
        if (apply) {
          renameSync(join(config.library, was), join(config.library, rel));
          put(rel, fresh);
        }
      } else {
        note(
          "renamed; edited since the cutover, so only its front matter was updated",
          `${was} → ${rel}`,
        );
        if (apply) {
          renameSync(join(config.library, was), join(config.library, rel));
          put(rel, refreshFrontMatter(had, fresh, rel));
        }
      }
      for (const other of stale.filter((o) => o !== was)) {
        note("another file carries this identifier; left alone", other);
      }
      continue;
    }
    note(
      oldFiles.has(rel) ? "gone from the library; written afresh" : "added",
      rel,
    );
    put(rel, fresh);
  }

  for (const rel of [...oldFiles].sort()) {
    if (newFiles.has(rel)) continue;
    const id = idOf(rel);
    if (id && newById.has(id)) continue; // handled as a rename above
    const current = read(config.library, rel);
    if (!current) continue;
    if (same(current, read(previous, rel), rel)) {
      note("no longer made; removed", rel);
      if (apply) rmSync(join(config.library, rel));
    } else {
      note("no longer made, but edited since the cutover; left alone", rel);
    }
  }

  for (const [what, list] of Object.entries(tally).sort()) {
    console.log(`\n${list.length} ${what}`);
    for (const rel of list.slice(0, 15)) console.log(`  ${rel}`);
    if (list.length > 15) console.log(`  … ${list.length - 15} more`);
  }
  console.log(apply ? "\napplied" : "\ndry run: nothing written");
}

main();
