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

`Alt-<letter>` needs a workaround on macOS: Option composes characters (`⌥J`
arrives as `∆`) and CodeMirror deliberately will not fall back to the base
layout. These bindings are matched on `event.code`, the physical key. `Mod-. j`
and the arrow-key forms work everywhere.

## Commands

| Command | Emacs equivalent |
|---|---|
| `Denote: New Note` | `denote` |
| `Denote: New Note with Signature` | `denote-signature` |
| `Denote: Link or Create` | `denote-link-or-create` |
| `Denote: Rename File from Front Matter` | `denote-rename-file-using-front-matter` |
| `Denote: Update Dynamic Blocks` | `org-update-all-dblocks` |
| `Denote: Insert Links Block` and three siblings | `denote-org-extras-dblock-insert-*` |

Two more are reached without the palette:

* **The page picker's create row** is `denote-open-or-create` — type a title
  that does not exist, and it mints a properly named Denote note.
* **`[[` on a Denote note** offers a *Create "…" as a Denote note* row. A
  Denote link addresses a note by identifier, and an identifier only exists
  once the file does, so the note is created first and linked afterwards.

Backlinks are the stock **Linked Mentions** panel (`Navigate: Linked
Mentions`), which lists notes by title with the context line.

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
| `[[https://example.com][a site]]` | a site ↗ |
| `[[https://example.com]]` | https://example.com ↗ |
| `[[file:shot.png]]` | the image |
| `[[file:shot.png][a screenshot]]` | the words |

A link to somewhere outside the space carries an **↗**, because otherwise
nothing distinguishes it from a link to another note. The arrow is drawn in
CSS, so it never lands in a selection or in copied text.

Putting the cursor on a link shows its source, as every live-preview
decoration does. Clicking an external link opens it in a new tab.

## Journal

The `Journal:` commands are `denote-journal`. `Journal: Today` (`Ctrl-q j`)
opens today's entry or creates it; Previous and Next walk the entries. There is
one journal system, not two — the commands and keys are unchanged, but an entry
is a Denote note Emacs also recognises as one.

An entry lives in `denote.journalDirectory`, carries `denote.journalKeyword`,
and is titled with the date. Which day an entry belongs to is decided by its
**identifier**, not its front-matter date — the same thing denote-journal
matches on.

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
