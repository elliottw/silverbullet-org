/**
 * Re-derives each migrated note's signature with the manifest's current
 * rules and, where it changed, renames the note in the library in place --
 * same identifier, new signature, `#+signature:` rewritten -- and updates
 * the manifest to match. For rules learned after the cutover (a Johnny
 * Decimal ID written as a suffix, a folder note taking its folder's
 * address). Links address the identifier, so none break; hub blocks pick
 * the note up under its new address when they next refresh.
 *
 *     npx tsx tools/obsidian-migration/fixup-signatures.ts            # dry run
 *     npx tsx tools/obsidian-migration/fixup-signatures.ts --apply
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  denoteFileType,
  formatDenoteName,
  parseDenoteName,
  rewriteDenoteFrontMatter,
  sluggify,
} from "../../plug-api/lib/denote.ts";
import { config } from "./config.ts";
import {
  type Entry,
  folderNoteId,
  jdIdOf,
  type Manifest,
  place,
} from "./manifest.ts";

const apply = process.argv.includes("--apply");
const numberedDir = /^(\d{2}) (.+)$/;

/** The signature the current rules give a vault note, and the section it lists under. */
function signatureFor(e: Entry): { signature?: string; section?: string } {
  const stem = e.source.split("/").pop()!.replace(/\.md$/i, "");
  const placement = place(e.source);
  const jd = jdIdOf(stem);
  let signature = jd ? `${jd.category}=${jd.id}` : placement.signature;
  let section = placement.section;
  const cat = placement.category && numberedDir.exec(placement.category);
  const folderNote =
    cat && !jd && !section
      ? folderNoteId(dirname(join(config.vault, e.source)), stem)
      : undefined;
  if (folderNote) {
    signature = `${cat![1]}=${folderNote.id}`;
    section = folderNote.folder;
  }
  if (
    cat &&
    (!section || /^00 /.test(section)) &&
    (jd?.id === "00" ||
      sluggify("title", e.title) === sluggify("title", cat[2]))
  ) {
    signature = `${cat[1]}=00`;
  }
  return { signature, section };
}

function main() {
  const manifestPath = join(config.out, "manifest.json");
  const manifest: Manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  let changed = 0;
  let renamed = 0;
  let missing = 0;
  for (const e of manifest.entries) {
    if (e.kind !== "note" || !e.target) continue;
    const { signature, section } = signatureFor(e);
    if (signature === e.signature) continue;
    const parsed = parseDenoteName(e.target)!;
    const target = formatDenoteName({
      identifier: parsed.identifier,
      signature,
      title: parsed.title ?? "",
      keywords: parsed.keywords,
      extension: parsed.extension,
    });
    changed++;
    console.log(`${e.signature ?? "-"} → ${signature ?? "-"}  ${e.source}`);
    const oldPath = join(config.library, e.target);
    if (!existsSync(oldPath)) {
      // Dropped or merged into a library note at the cutover; nothing to rename.
      missing++;
    } else if (apply) {
      const text = readFileSync(oldPath, "utf8");
      writeFileSync(
        join(config.library, target),
        rewriteDenoteFrontMatter(text, denoteFileType(parsed.extension), {
          signature: signature ?? "",
        }),
      );
      renameSync(oldPath, oldPath + ".migrated-away");
      renamed++;
    }
    if (apply) {
      e.signature = signature;
      e.section = section;
      manifest.links[e.source.replace(/\.md$/i, "")] = target;
      const stem = e.source.split("/").pop()!.replace(/\.md$/i, "");
      if (manifest.links[stem] === e.target) manifest.links[stem] = target;
      e.target = target;
    }
  }
  if (apply) {
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 1));
  }
  console.log(
    `\n${changed} notes change signature; ${apply ? `${renamed} renamed` : "dry run"}; ${missing} not in the library (merged or dropped)`,
  );
}

main();
