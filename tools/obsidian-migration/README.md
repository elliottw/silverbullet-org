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

**The folder tree becomes signatures.** The library is flat; a note that sat
in `20-29 Missions/21 iteam/14 landslide mediation/` is signed `21=14` — the
category number and the numbered sub-folder, the two levels Johnny Decimal
addresses. A deeper or unnumbered folder is not given a number: it survives as
a section in the category's hub note. The area folder (`20-29 Missions`) is
implied by the number and dropped; `assets/` folders dissolve.

**Hub notes.** Each category gets a note at `NN=00` — the vault's own
`NN.00` note if it had one, otherwise a new one identified `00000000T0000NN`
— listing the category's notes by the folder they came from: a pre-filled
`denote-links` block per signature (`==21=14--`), a plain list for a folder
that had no number, and a catch-all `==21[=-]` block last. Home's numbered
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
