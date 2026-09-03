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

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `denote.fileType` | `org` | Format new notes are written in |
| `denote.renameOnSave` | `true` | Rename the file when its front matter changes |
| `denote.updateDblocksOnSave` | `true` | Regenerate dynamic blocks on save |

If you keep the library in Emacs, exclude its droppings — otherwise 1,000+
`.org~` backups are indexed as attachments:

```
SB_SPACE_IGNORE='*~
\#*#
*.sync-conflict-*'
```

The `\#` escape matters: gitignore reads a leading `#` as a comment, so an
unescaped `#*#` is silently discarded.

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
