# Obsidian → Denote migration

Moves a [Johnny Decimal](https://johnnydecimal.com) Obsidian vault into a flat
Denote library of Org notes, with documents in Zotero. Written for one vault,
but every decision is in `config.ts` or in one function, and nothing here
writes into the vault or into the library until the last step.

```
manifest.ts        what every file becomes            → manifest.json, report.md
zotero-import.ts   documents → Zotero, tree mirrored  → zotero-map.json
zotero-parents.ts  a citable parent item per document
zotero-file.ts     file items by their vault folder
zotero-projects.ts maker projects → one parent per folder
convert.ts         the library, staged                → staging/, staging-code/
```

Each phase is `npx tsx tools/obsidian-migration/<phase>.ts`; the Zotero ones
are dry runs without `--apply`. Output goes to `config.out`
(`~/org-migration`), never to the library.

## What a vault becomes

**Notes** become Denote Org files: `IDENTIFIER==SIGNATURE--title__keywords.org`.
The identifier comes from front-matter `created`, else a date in the file
name, else the file's birth time, bumped by a second on collision with
anything in the library. Obsidian tags become keywords (`type/Log` → `log`).
Pandoc does the Markdown → Org conversion (`gfm-gfm_auto_identifiers…`, wrap
preserved); links are tokenised out first and written back as `denote:`,
`file:`, `zotero:` or bare Org links, so a link never depends on what pandoc
makes of it.

**The folder tree becomes signatures — on the IDs, not their contents.** The
library is flat. In Johnny Decimal an address belongs to an *ID*: a numbered
folder, or a note that names one. So a signature goes only to the category's
own note (`21.00 iteam` → `21=00`), a note carrying an ID in its name before
or after the title (`25.03 Acorn Medic Branding`, `adrianna 61.54`), and a
folder note — the note named like its numbered folder, inside it
(`02 howm/Howm.md` → `92=02`) or beside it (`existential.md` next to
`02 existential/` → `51=02`). Every other note, including everything else in
an ID's folder, carries none: it is the ID's contents, reached through the
ID's note. The area folder (`20-29 Missions`) is implied by the number and
dropped; `assets/` folders dissolve.

**Hub notes and ID notes.** Each category gets a hub at `NN=00` — the
vault's own note where it had one, else a new one identified
`00000000T00NN00` — listing the notes loose in the category, then its IDs in
a `denote-links` block on `==NN=[0-9][0-9]--`, which *is* the category's index
and refreshes itself, then any unnumbered folders as plain lists. Each ID
gets a note at `NN=MM` — the folder's own note, else a new one identified
`00000000T00NNMM` and titled after the folder — listing the folder's
contents by the folders below it. A library note that turns out to be an ID's
own (a vault stub `Cherise Green 61.46` duplicating the library's
`cherise-green` note) is renamed to carry the address. Home's numbered
category lines get their hub linked in place.

**Documents** — PDF, EPUB, HTML, DOCX and the rest — go to Zotero
(`zotero-import.ts`), under a collection tree that mirrors the vault's
folders exactly, every folder, empty or not; each gets a parent item so it
can be cited (`zotero-parents.ts`: title from DOI/ISBN lookup, embedded
metadata, the link text that pointed at it, or a cleaned file name, in that
order). Notes link them as `[[zotero:KEY]]`, the attachment key, which the
fork renders as the item's title from the Better BibTeX export. **Images stay
beside the notes**, Denote-named, so they show inline.

**The perpetual calendar** (`✱/days`, a page per day-of-year with a section
per year) is split on its year headings into `denote-journal` entries.
Scanned PDFs there are rendered to JPEG pages (`pdftoppm`, 150 dpi) and
embedded where the scan was linked; a scan nothing links to is appended to
its day.

**Folders that are not notes** are decided by hand in `config.folders`:
`code` (copied to `~/code`, linked as absolute `file:` links), `zoteroProjects`
(each sub-folder one Zotero parent item with the folder's files),
`drop`. There are no heuristics left: everything else in the vault is a note
or a file.

**Notes the library already has** (by title) are compared by word-bag
similarity: the same note is dropped and its links redirected to the library
copy; a stub on either side is appended to the library note, which keeps its
name and identifier; a different note under the same title is kept and
listed in `conversion.md`.

## Verifying

`convert.ts` writes `conversion.md` with counts and the lists that need eyes.
A real check is a real index: copy `~/org` and the staging over it to a
scratch space, run a second SilverBullet instance on it, open `/?headless`,
wait for `sbRuntime.ready`, and query `index.tag "relation"` for
`denote-link` relations whose `toTag` is `denote-identifier` — the dangling
ones. The number to reach is *zero from migrated content*; a library's own
older dangling links are its own.

## Running it again after the cutover

The pipeline is repeatable against a cut-over library. `manifest.ts` keeps
every identifier from the previous `manifest.json`, reads the library minus
the migration's own output, and the converter starts each library note from
the original the cutover kept under `replaced/`. `convert.ts` rotates the
last output to `staging-previous/`, and `reconcile.ts` applies the
difference three-way — previous staging, new staging, the library as it is —
replacing only files the library still holds as the previous run wrote them
(dynamic-block bodies aside, since opening a hub refreshes those), renaming
by identifier where a name changed, updating just the front matter of a
note edited meanwhile, and listing everything it left alone.

```sh
npx tsx tools/obsidian-migration/manifest.ts
npx tsx tools/obsidian-migration/convert.ts
npx tsx tools/obsidian-migration/reconcile.ts          # dry run, read the lists
npx tsx tools/obsidian-migration/reconcile.ts --apply
```

## Cutover

Regenerate first — the staging folds in the library's *current* home page
and the notes it appends to — then:

```sh
tar -czf ~/org-migration/org-before-cutover.tar.gz -C ~ org   # the way back
rsync -a ~/org-migration/staging/ ~/org/                       # no --delete
rsync -a ~/org-migration/staging-code/ ~/code/
```

`~/org-migration/revert-cutover.sh` removes every file the cutover added and
puts back the ones it replaced, from the lists `cutover-added.txt` and
`cutover-replaced.txt` written beforehand.

Afterwards, in SilverBullet, `denote/health` lists what is left to look at.
