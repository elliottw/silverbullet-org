# SilverBullet, with Org mode and Denote

A fork of [SilverBullet](https://github.com/silverbulletmd/silverbullet) that
makes **`.org` a first-class page type** and teaches it
[Denote](https://protesilaos.com/emacs/denote), Protesilaos Stavrou's Emacs
note-taking scheme.

The goal is a **web interface to a Denote library**: point it at your
`denote-directory` and every note becomes a page — its `#+title:` becomes the
title, its keywords become tags, and its `denote:` links resolve and become
bidirectional. Nothing is converted or imported; the files on disk stay exactly
what Emacs wrote, and Emacs can keep editing them.

Upstream's own README is kept as [README-upstream.md](README-upstream.md).

> **Proof of concept.** It reads and edits a real library, but see
> [What is not supported yet](docs/Org%20Mode.md#what-is-not-supported-yet) and
> the [Denote roadmap](docs/Denote.md#roadmap).

## Why a fork and not a plug

SilverBullet is extensible through plugs, and the Denote half of this
(`plugs/index/denote.ts`) is plug-shaped. The Org half is not, for two reasons
a sandboxed plug cannot get around:

* A plug cannot register a **CodeMirror language**, and Org needs a parser.
* `.org` has to be in `pageExtensions` (`plug-api/lib/ref.ts`) for refs to
  resolve to it. That is core, and everything that parses a ref reads it.

So this modifies ~48 files upstream owns. If Org support ever landed upstream,
Denote could be extracted into a plug.

**The trick that keeps the diff small:** the Org parser emits *Markdown's own
node vocabulary* — `ATXHeadingN`, `ListItem`, `Task`, `FencedCode`, `Table`.
Every existing indexer and live-preview decoration dispatches on node names
rather than on file type, so tasks, tables, outlines, backlinks and queries all
work on Org without knowing Org exists.

## Keybindings

Org outline motions follow `evil-org`, and folding follows `org-cycle`.

| Key | Does | Emacs equivalent |
|---|---|---|
| `Tab` | Fold cycle on a headline: FOLDED → CHILDREN → SUBTREE | `org-cycle` |
| `Shift-Tab` | Whole buffer: OVERVIEW → CONTENTS → SHOW ALL | `org-shifttab` |
| `Alt-j` / `Alt-k` | Move item down / up | `org-metadown` / `org-metaup` |
| `Alt-l` / `Alt-h` | Indent / outdent item | `org-metaright` / `org-metaleft` |
| `Alt-i` | Insert a link, or edit the one at the cursor | `denote-link-or-create` / `org-insert-link` |
| `Return` | Follow the link under the cursor (vim normal mode) | `org-return-follows-link` |

`Alt-<letter>` needs a workaround on macOS: Option composes characters (`⌥J`
arrives as `∆`) and CodeMirror deliberately will not fall back to the base
layout. These bindings are matched on `event.code`, the physical key. `Mod-. j`
and the arrow-key forms work everywhere.

## Commands

| Command | Emacs equivalent |
|---|---|
| `Denote: New Note` | `denote` |
| `Denote: New Note with Signature` | `denote-signature` |
| `Denote: Insert or Edit Link` (`Alt-i`) | `denote-link-or-create`, `org-insert-link` |
| `Zotero: Insert Citation` | `citar-insert-citation` |
| `Zotero: New Reference Note` | `citar-denote-create-note` |
| `Zotero: Add File` | — |
| `Zotero: Sync Reference Notes` | — |
| `Zotero: Sync Library`, `Zotero: Resync Library` | — |
| `Denote: Toggle Link Display` | `org-toggle-link-display` |
| `Denote: Rename File from Front Matter` | `denote-rename-file-using-front-matter` |
| `Denote: Rename` | `denote-rename-file` |
| `Denote: Add Keywords` / `Remove Keywords` | `denote-keywords-add` / `-remove` |
| `Denote: Set Signature` | `denote-rename-file-signature` |
| `Denote: Browse by Signature` | `denote-sort-dired` |
| `Denote: Signature Parent` / `Children` / `Siblings` / `Next` / `Previous` | `denote-sequence-find` |
| `Denote: New Child Note` / `New Sibling Note` | `denote-sequence-new-child-of-current` / `-sibling-of-current` |
| `Denote: Find Link` / `Find Backlink` | `denote-find-link` / `denote-find-backlink` |
| `Denote: Random Note` | `denote-explore-random-note` |
| `Denote: Signatures Page`, `Keywords Page`, `Library Health` | `denote-sequence-dired`, `denote-explore-*` |
| `Denote: Journal Calendar` / `Journal Open Date` | `denote-journal-calendar` |
| `Denote: Update Dynamic Blocks` | `org-update-all-dblocks` |
| `Denote: Insert Links Block` and three siblings | `denote-org-extras-dblock-insert-*` |

The signature, keyword and journal commands are described in
[docs/Denote.md](docs/Denote.md#signatures-as-sequences); the generated pages
under `denote/` (`denote/signatures`, `denote/keywords`, `denote/calendar`,
`denote/health`) in [Generated pages](docs/Denote.md#generated-pages).

Two more are reached without the palette:

* **The page picker's create row** is `denote-open-or-create` — type a title
  that does not exist, and it mints a properly named Denote note.
* **`[[` on a Denote note** offers a *Create "…" as a Denote note* row. A
  Denote link addresses a note by identifier, and an identifier only exists
  once the file does, so the note is created first and linked afterwards.

Backlinks are the **Linked Mentions** panel (`Navigate: Linked Mentions`,
docked under the page; its × remembers), shown the way org-roam's backlink
buffer shows them: the note's title, the outline path the link sits under
(`Monday 20 August › Site visit`), and the whole paragraph around it, so a
person's page reads as what was said about them without opening each day.
Below the backlinks, **Unlinked mentions** lists the pages that say this
note's title without linking it; `Denote: Link Mentions` picks one and
makes the link. (Every paragraph and list item is indexed for this —
`index.paragraph.all` is on in this fork.)

## First launch

A new space is seeded with an Org home page,
`00000000T000000--home.org`, and that is also where **Home** goes — the house
icon, `Cmd-Shift-h`, and anything else that navigates home.

The all-zero identifier is deliberate: it marks the page as shipped rather than
authored, and it sorts before every real note in a Denote library. Rename it,
retitle it or delete it; nothing depends on it existing.

Upstream seeds `index.md`, which in an Org-only library is a stray Markdown
file you did not ask for. `SB_INDEX_PAGE` still overrides the name, and a space
whose index page does not end in `.org` still gets the Markdown template — so
pointing this build at a Markdown space behaves as upstream does.

An existing space is never seeded. If you are attaching this to a library that
already has notes and you want the home page, copy it in yourself:

```sh
cp bin/silverbullet/space_template/00000000T000000--home.org "$SB_FOLDER/"
```

## Links

An Org link reads as its **description** with the cursor away, the same as a
Denote link does — the target is machinery, not prose:

| Written | Shown |
|---|---|
| `[[denote:20240125T164237][Court Costs]]` | Court Costs |
| `[[https://example.com][a site]]` | a site |
| `[[https://example.com]]` | https://example.com |
| `[[file:shot.png]]` | the image |
| `[[file:shot.png][a screenshot]]` | the words |

A link to another note carries a faint background tint that a link out of the
space does not, which is what tells the two apart.

A **described** link keeps reading as its description with the cursor on it,
which is `org-link-descriptive` and unlike every other live-preview decoration
here. Only the machinery is hidden: the description underneath stays real,
editable text, so the cursor has somewhere to land and the arrow keys step over
the `[[…][` and `]]` rather than through them. Clicking an external link opens
it in a new tab.

A link with no description *yet* is the one being typed, and shows its source —
auto-close turns `[[` into a complete but empty link node straight away, and
there is nothing to draw in its place. That is also what keeps the inline `[[`
completion usable.

Which is why editing a link is a command, the way `org-insert-link` is. `Alt-i`
reads the cursor:

* **On a link** it is `org-insert-link` — the target and the description, both
  offered as they stand. Emptying the target unlinks, leaving the words behind.
* **Off a link** it is `denote-link-or-create` — pick a note, mint one that
  does not exist yet, or link somewhere outside the space. A selection becomes
  the description, as an active region does in Emacs; a selected URL is taken
  as the target instead.

`Denote: Toggle Link Display` (`org-toggle-link-display`) turns the rendering
off for the session, so every link reads as its source — for repairing link
syntax by hand.

In vim's **normal mode**, `Return` follows the link under the cursor —
`org-return-follows-link`. Anywhere else it stays vim's own `<CR>`, which is
`j^`: down a line, to its first non-blank character. Insert mode is unchanged.

Two things make that binding more than a one-liner. Vim swallows every key in
normal mode, unmapped ones included, so the handler has to sit at
`Prec.highest` — ahead of vim's keymap — rather than behind it; and a vim-side
`mapCommand` on `<CR>` never fires, because the built-in `keyToKey` entry for
it claims the key first. Whether there is a link to follow is therefore decided
here, synchronously against the syntax tree, so the key can be accepted or
declined at once.

## Attachments and Zotero

Two kinds of file, two homes.

**An image is part of the note.** Pasted, dropped or uploaded, it is saved
beside the note under a Denote name, with no prompt, and shown inline:

    Screenshot 2026-08-25 at 3.16.23 PM.png
    -> 20260905T082013--screenshot-2026-08-25-at-31623-pm.png

`denote-rename-file` renames any file, note or not — the scheme *is* the name.
A clipboard image, having no name of its own, is named by its identifier alone.

**A document is reference material, and lives in Zotero.** A pasted, dropped
or uploaded PDF — anything that is not an image — goes into the Zotero library
through its Web API: you are asked for a title (the file's own name, or a PDF's
embedded one, offered first) and a collection, exactly as the browser connector
asks. Without Zotero configured, documents are saved beside the note like
images.

What lands in the note is a link to a **reference note** for the item, written
where you dropped it — not a link to the file. That is the point of it: a
citation then has a note of its own to live in, which is where notes about a
source belong. The reference note is an ordinary Denote note carrying the `bib`
keyword, a link to the file, and three lines:

    #+reference:   graham2004hackers   the citekey, which is Zotero's
    #+zotero:      P6F9ZMNS            the item itself
    #+zotero_tags: landbank rtk        what note and library last agreed on

`zotero.referenceNoteOnAdd = false` goes back to linking the file directly.

### The library, and who owns the bibliography

**SilverBullet keeps the library in its own index, synced from the Zotero
API, and writes `zotero.bib` from it.** Turn Better BibTeX's *Keep updated*
export off: there is one writer, and this is it.

That inversion is the point of the arrangement. BBT's export only refreshes
while a Mac is awake with Zotero running, so a PDF dropped from a phone was
not citable in Emacs until the laptop next ran. Written from the API by
whichever device is open, the file is current within a minute of the drop.

What comes from where:

| | Source | Why |
|---|---|---|
| citekeys | Zotero's `citationKey` (Better BibTeX's own) | keys must not change: SilverBullet never invents one |
| titles, authors, dates, tags | the API | fresh, and tags arrive without a per-note request |
| item and attachment keys | the API | the export does not carry them |
| `file` paths in the `.bib` | the storage path already in your bibliography | it is the one `citar-file-open` on that machine opens files with |

Zotero versions its library, so keeping up is cheap — but the first read is
not. `Zotero: Sync Library` is the command that does it, because it is
thousands of items over tens of requests: a real library of 4,582 items and
4,633 attachments took **77 requests and about 150 seconds**. Highlights and
standalone notes are left out of the query (3,219 of them here, none citable),
which is most of what makes that bearable.

Every pass after the first asks only what changed since the version the index
holds: **one request when nothing has**, about five seconds. So a page load
refreshes a library older than `zotero.syncEvery` minutes, and adding a
document syncs at once, so its citekey is there to write into the reference
note rather than filled in later. A page load never starts the *first* pass —
two silent minutes is not something a page load should do. `Zotero: Resync
Library` reads everything again.

Three guards, because this writes the file Emacs cites from. The bibliography
is only written after a pass that read the library completely, so a device that
has just arrived cannot truncate what it has not finished reading. It is never
written when that would drop more than a tenth of its entries — `Zotero: Resync
Library` is the deliberate way past that. And a library that answers with
nothing (a key without access, a wrong user id) leaves the file, and the index
built from it, alone. An item Zotero has no citekey for stays in the index but
is left out of the file: it cannot be cited.

Two things to know. A device with **no API key** reads the `.bib` instead —
citations, titles and the pickers all still work, which is what keeps a
locked-down phone or an offline laptop useful. And the writer here is modest:
it escapes what TeX needs escaped and no more. For LaTeX-grade output (name
transliteration, journal abbreviations, pinned keys) Better BibTeX's own
export is better than anything in this repository — turn it back on for that,
pointed somewhere else.

### Keywords and tags, kept in step

A reference note's keywords and its Zotero item's tags are the same list in
two places, so they are reconciled rather than copied: `#+zotero_tags:` records
what the two last agreed on, which is what tells a keyword you added here from
a tag that was removed there. Opening a reference note syncs it; `Zotero: Sync
Reference Notes` does the library.

| What happened | What follows |
|---|---|
| a tag added in Zotero | it arrives as a keyword (and the file is renamed, since keywords live in the name) |
| a tag removed in Zotero | the keyword goes |
| a keyword added here | it is pushed up as a tag |
| a keyword removed here | the tag goes |
| a keyword Zotero never had | it stays local — only what both sides hold is recorded as agreed |

A note that has never been synced does not push: its keywords predate the
arrangement, and sending a library's worth of them to Zotero unasked is not
this feature's business. Run `Zotero: Sync Reference Notes` to do that
deliberately. `zotero.syncKeywords` is `both`, `fromZotero` (never write to
the library) or `off`.

### Citing

| Written | Shown | Opens |
|---|---|---|
| `[cite:@graham2004hackers]` | Graham 2004 | the item's file at zotero.org |
| `[cite/t:see @a;@b p. 3]` | A 2001; B 2002 | the first item |
| `[[zotero:PSKBJDH2]]` | the item's title | that attachment at zotero.org |
| `[[zotero:PSKBJDH2][the PDF]]` | the PDF | that attachment at zotero.org |

zotero.org's reader opens a file on a machine with nothing installed. On a
device that has the app, `Zotero: Toggle Open in Desktop App` sends
citations there instead — a per-device preference, since the same space is
read from a Mac with Zotero and a work machine without one. An item with no
file only opens in the app.

`Zotero: Insert Citation` (also a row in `Alt-i`) picks from the library.
`Zotero: New Reference Note` creates a Denote note about an item, carrying
`#+reference: citekey` and the `bib` keyword — the `citar-denote` convention,
so `citar-denote-open-note` in Emacs finds the same note. Citations and
`#+reference:` lines are indexed as relations, which is what gives a reference
note its "cited in" list.

### Configuration

```lua
config.set("zotero", {
  username = "yourname",      -- for zotero.org URLs
  userId = "1234567",         -- from zotero.org/settings/keys
  apiKey = "…",               -- write + file access
  bibliography = "zotero.bib",-- written from the API; one writer, this one
  referenceKeyword = "bib",
  referenceNoteOnAdd = true,  -- a dropped document gets a reference note
  syncKeywords = "both",      -- or "fromZotero", or "off"
  syncEvery = 15,             -- minutes before a page load refreshes the library
  -- storagePath = "/Users/you/Zotero/storage",  -- learned from the .bib if unset
})
```

With no `userId`/`apiKey` the fork reads the `.bib` and nothing else: no
syncing, no adding, no tag reconciliation. That is a supported way to run it.

On the Emacs side nothing changes — `citar` reads the same file it always did,
from `citar-bibliography`. A `zotero:` link wants one line:

```elisp
(org-link-set-parameters "zotero" :follow
  (lambda (key) (browse-url (concat "zotero://select/library/items/" key))))
```

To open the PDF in Emacs instead of handing the item to Zotero, follow the
key into Zotero's storage directory:

```elisp
(org-link-set-parameters "zotero" :follow
  (lambda (key)
    (let ((file (car (file-expand-wildcards
                      (expand-file-name (concat key "/*")
                                        "~/Zotero/storage")))))
      (if file (find-file file)
        (browse-url (concat "zotero://select/library/items/" key))))))
```

## A flat library, and where the structure went

Denote keeps every note in one directory and puts the metadata in the file
name. That is also how this fork expects a library: no folder tree, apart from
the journal's own directory. What a tree would say with paths goes into three
Denote-native places:

* **The signature** is the address. A Johnny Decimal `21.14` is `==21=14` in
  the file name — sortable in Dired, matched by a dynamic block's `:regexp`,
  and there for any tool that lists files. `Denote: Browse by Signature` and
  the parent/children/siblings commands walk it; `denote/signatures` draws
  it as a tree.
* **Keywords** cut across it.
* **Hub notes** carry the curated part. One note per category, addressed
  `NN=00`, with a few hand-picked links at the top and `denote-links` blocks
  below — one per signature the category uses, and a catch-all `==NN[=-]`
  last. Home links the hubs, a hub links its notes: two hops to anything, and
  the hub is content you edit rather than structure you maintain. Blocks
  refresh when the hub is opened, so it reads true.

Documents that are not notes — PDFs, papers, scans, project files — live in
Zotero and are linked by `zotero:` (see [Attachments and
Zotero](#attachments-and-zotero)); images stay beside the notes that show
them. `tools/obsidian-migration/` is the tool that moved a Johnny Decimal
Obsidian vault into this shape, and its
[README](tools/obsidian-migration/README.md) records the decisions.

## Journal

The `Journal:` commands are `denote-journal`. `Journal: Today` (`Ctrl-q j`)
opens today's entry or creates it; Previous and Next walk the entries. There is
one journal system, not two — the commands and keys are unchanged, but an entry
is a Denote note Emacs also recognises as one.

An entry lives in `denote.journalDirectory`, carries `denote.journalKeyword`,
and is titled with the date. Which day an entry belongs to is decided by its
**identifier**, not its front-matter date — the same thing denote-journal
matches on. An entry written up after the fact is stamped with the day it is
for, so the day finds it again.

**`Denote: Journal Calendar`** opens `denote/calendar`, a year of the journal
laid out month by month. A day with an entry links to it; a day without is a
faint `journal:YYYY-MM-DD` link that creates the entry when followed — the
same gesture as picking a date in Emacs's calendar, and the usual way to fill
in a past day. `journal:` links work in any note, and `Denote: Journal Open
Date` takes a date from a prompt.

| Key | Default | Mirrors |
|---|---|---|
| `denote.journalDirectory` | `journal` | `denote-journal-directory` |
| `denote.journalKeyword` | `journal` | `denote-journal-keyword` |
| `denote.journalTitleFormat` | `day-date-month-year-24h` | `denote-journal-title-format` |

The title format takes the same four symbols Emacs does — `day`,
`day-date-month-year`, `day-date-month-year-24h`, `day-date-month-year-12h` —
or a literal `format-time-string` pattern. A specifier that is not implemented
is left visible in the title rather than silently dropped.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `denote.fileType` | `org` | Format new notes are written in |
| `denote.renameOnSave` | `true` | Rename the file when its front matter changes |
| `denote.updateDblocksOnSave` | `true` | Regenerate dynamic blocks on save |
| `denote.updateDblocksOnOpen` | `true` | Regenerate dynamic blocks when a note is opened |

If you keep the library in Emacs, exclude its droppings — otherwise a backup
per note is indexed as an attachment:

```
SB_SPACE_IGNORE='*~
\#*#
*.sync-conflict-*'
```

The `\#` escape matters: gitignore reads a leading `#` as a comment, so an
unescaped `#*#` is silently discarded.

### Service workers, and why a deploy looks like it did nothing

SilverBullet is a PWA. Its service worker serves the client and the plugs from
cache, and it answers *before* the network does — so after deploying a new
build the browser keeps running the old one, and a new command simply is not in
the palette. A hard reload does not dislodge it.

While you are actively deploying, set:

```
SB_DISABLE_SERVICE_WORKER=1
```

That does more than skip registration: the client tears down any worker already
installed and flushes its caches on the next load. You lose offline use and gain
"what I deployed is what I see", which is the better trade while the code is
moving. Unset it when you want offline back.

Without it, the fix is manual, per browser: DevTools → Application → Service
Workers → Unregister, then reload.

To tell the two apart before reaching for either, check the server rather than
the browser — fetch `/.fs/Library/Std/Plugs/index.plug.js` and grep it for the
symbol you expect. If it is there, the deploy worked and the browser is stale.

### Syncing a library with Syncthing

Syncthing works well here — SilverBullet keeps **no database in the space**, so
there is nothing to corrupt the way a live SQLite file would be. The index
lives in each browser and is rebuilt from the files.

Two things must not sync. Put them in `.stignore` on **every** device, since
Syncthing ignore lists are per-device:

```
// Comments are "//" here -- unlike gitignore, "#" means nothing special.

// The JWT signing secret. Syncing it copies a credential to every device,
// and logs you out as it round-trips.
.silverbullet.auth.json
.silverbullet.session.json

// Emacs droppings -- churn nothing reads.
*~
#*#
.#*

// Never sync a git dir two ways; it corrupts.
.git
```

Leave `*.sync-conflict-*` **out** of that list: you want conflict copies to
reach you. `SB_SPACE_IGNORE` already keeps them out of the page picker, which
is the right place for that.

For a first sync of an irreplaceable library, set the source device to **Send
Only** until the other side is populated, so an empty folder can never
propagate deletions back. And do not point Syncthing at a directory another
sync engine also manages — iCloud Drive, in particular, can evict files to
placeholders and rewrite them underneath Syncthing.

## Known gaps

* **A bare Org link produces no backlink.** `[[Some Note]]` is not indexed as a
  relation — only `denote:` links are — so it does not appear under Linked
  Mentions. Linking by identifier, which is what the `[[` completion writes,
  does.

## Documentation

* **[docs/Denote.md](docs/Denote.md)** — the naming scheme, front matter,
  linking, dynamic blocks, and a roadmap of the ~50 `denote-*` commands
* **[docs/Org Mode.md](docs/Org%20Mode.md)** — supported syntax and how the
  parser works

## Keeping up with upstream

```sh
git remote add upstream https://github.com/silverbulletmd/silverbullet.git
git fetch upstream && git rebase upstream/main
```

## Development

Same as upstream: `npm ci`, then `npm run build` and `cargo build --release -p
silverbullet`. Tests are `npx vitest run` (2,360) and `npx playwright test
--project=chromium` — `e2e/denote.test.ts` holds 32 Denote/Org end-to-end
tests, whose fixtures are three real notes from the public
[l-o-l-h/law](https://github.com/l-o-l-h/law) library.

The parser was validated against all 457 notes in that library: 456 parsed, 0
missing identifiers, 0 signature mismatches.
