---
references:
- plug-api/lib/denote.ts
- plugs/index/denote.ts
- client/codemirror/denote_link.ts
---
> **warning** Proof of concept
> Denote support covers the naming scheme, keywords and linking. See [[#What is not supported yet]].

[Denote](https://protesilaos.com/emacs/denote) is Protesilaos Stavrou's Emacs note-taking package. Its defining idea is that **a note's metadata lives in its file name**, so a note is self-describing on any filesystem, with no database and no application required to read it:

    20240322T131856==1a--some-title__topic1_topic2.org
    └ identifier ─┘  └sig┘ └ title ┘  └── keywords ──┘

SilverBullet reads a Denote library directly. Point it at your `denote-directory` and every note becomes a page: its keywords become [[Markdown/Hashtags|tags]], its `#+title:` becomes its title, and its `denote:` links resolve and become bidirectional.

# The naming scheme
Each component is introduced by a doubled delimiter — `@@` identifier, `==` signature, `--` title, `__` keywords — and the components never contain one, because Denote's sluggification collapses runs of those characters. A leading `YYYYMMDDTHHMMSS` identifier needs no `@@` marker, which is what nearly every real library uses.

Every component except the extension is optional, so `ID.org`, `ID--TITLE.org` and `ID__KEYWORDS.org` are all valid names.

Sluggification follows `denote.el` exactly, and differs per component — which is why the same words produce different slugs:

| component | `Court Costs v. Smith` becomes |
|---|---|
| title | `court-costs-v-smith` |
| keyword | `courtcostsvsmith` (separators removed — `_` separates keywords) |
| signature | `court=costs=v=smith` |

# Front matter
All four `denote-file-types` are read — Org, Markdown (YAML and TOML) and plain text:

```org
#+title:      Court Costs Relating to Evictions
#+date:       [2024-01-25 Thu 16:42]
#+filetags:   :costs:law:
#+identifier: 20240125T164237
#+signature:  1a
```

The file name and the front matter can disagree — they do in about 4% of the notes in real libraries, because editing one does not rewrite the other outside of `denote-rename-file`. SilverBullet resolves that the way Denote's design implies: **the file name wins** for anything identity-bearing (identifier, signature, keywords), since that is what links resolve against, and the **front matter wins for the title**, because it holds the only un-sluggified copy of it.

# Keywords
A note's keywords become SilverBullet tags, so an ordinary [[Space Lua/Lua Integrated Query]] finds notes by keyword with no Denote-specific syntax:

    ${query[[from p = tags.costs order by p.title]]}

Notes are also indexed as `denote` objects carrying their identifier, title, keywords, signature and date:

    ${query[[
      from d = tags.denote
      where table.includes(d.keywords, "case")
      order by d.identifier
    ]]}

# Linking
A Denote link addresses a note by **identifier**, never by path — that is what lets a note be renamed (which Denote encourages, since the title and keywords live *in* the name) without breaking anything that points at it:

    [[denote:20240125T164237][Court Costs Relating to Evictions]]

SilverBullet renders such a link as its description alone, resolves the identifier against the space, and navigates on click. A link whose identifier no note carries is shown as a dangling link rather than silently rendered as working. Links are indexed as `relation` objects with `kind = "denote-link"`, so backlinks work in both directions.

Resolution uses the file list rather than the index, because every note's name begins with its own identifier. That keeps it free of ordering problems during a full reindex, and means a link resolves as soon as its target file exists.

# Creating notes
**Denote: New Note** prompts for a title and keywords, then writes a correctly named file with front matter into the space root — what `denote-directory` means, since Denote keeps a flat library and relies on keywords rather than folders. **Denote: New Note with Signature** additionally prompts for the signature.

Keywords are chosen from a picker that completes over every keyword already in the library, showing how many notes carry each — keeping a library's vocabulary consistent is most of what completion is for. Pick as many as you like; **Escape** ends the prompt, as an empty answer does in Denote. A keyword not yet in use is entered through the **New keyword** row.

Typed keywords are separated by **commas**, matching Denote's `completing-read-multiple`. Whitespace does *not* separate them: `Genuine Issue Trial` is one keyword, sluggified to `genuineissuetrial`. That is exactly why keyword sluggification joins words instead of hyphenating them.

The identifier is the creation time to the second, bumped forward if a note already holds it — an identifier is a note's identity, so a duplicate would break every inbound link that resolves against it.

Set `denote.fileType` to `org` (the default), `markdown-yaml`, `markdown-toml` or `text` to choose the format new notes are written in.

# Open or create, link or create
Typing a name the space does not hold and taking the page picker's **Create**
row is `denote-open-or-create`: from a Denote note, what you typed becomes the
*title* of a new note and the keyword prompt follows, exactly as Denote uses
the text typed at its file prompt as the default title.

Creating from an ordinary page still makes an ordinary page, and a phrase
carrying a path or an extension is read as a file name rather than a title. A
space holding both formats keeps working, and a stock Markdown space is
unaffected.

Typing `[[` and naming a note that does not exist offers a **Create "…" as a
Denote note** row, which is `denote-link-or-create`. It mints the note and
writes a link to it by identifier, leaving you where you were writing — Denote
creates the note `:in-background` for the same reason.

This has to create the note up front, because a Denote link addresses a note by
**identifier** and an identifier exists only once the file does. Markdown's
arrangement — write `[[Some Note]]` now, create the page by following it — has
no Denote equivalent: the bare name resolves to nothing, and following it would
make a note outside the naming scheme.

The row sorts below every real match and is never the default selection, since
Denote's own prompt creates on *no* match. **Denote: Link or Create** does the
same thing from the command palette, picking from the library first.

A bare `[[Notebook]]` in an Org note — one written by hand, with no `denote:`
identifier — resolves to `Notebook.org`, and creates it as an Org file if there
is none. An existing Markdown page of that name is still reached as written.
Such a note is Org but *not* Denote: it has no identifier, so nothing can link
to it by one. The completion row above is the route that keeps a library
consistent.

# Backlinks
The **Linked Mentions** panel below a note is `denote-backlinks` with
`denote-backlinks-show-context`: every note linking here, with the line its
link sits on. **Navigate: Linked Mentions** opens it, and it docks wherever you
put it.

A backlink is listed by its **title**, not its file name — a Denote file name
is a slug of the title with the identifier and keywords attached, so the raw
name tells a reader less than the title does. Org link markup in the context
line is reduced to the text Org itself shows: rendered as Markdown,
`[[target][description]]` would otherwise come apart, because Markdown reads
its `[[target]` as a wiki link of its own.

# Keeping the file name in step
Because a note's title and keywords live *in* its file name, editing the front
matter makes the two disagree. SilverBullet renames the file to match on save,
which is `denote-rename-file-using-front-matter` happening by itself.

This runs the opposite way round from indexing, and deliberately so. Reading a
note, the **file name wins** — that is what links resolve against. Renaming,
the **front matter wins** — that is what you just edited. The identifier is
never taken from the front matter: it is the note's identity.

Doing this automatically is only reasonable because Denote links address notes
by identifier, so no inbound link is ever invalidated by a rename. Set
`denote.renameOnSave` to `false` to make it manual; **Denote: Rename File from
Front Matter** does it on demand either way.

An absent `#+filetags:` line means "unknown", not "none" — the file name keeps
the keywords it has, rather than silently losing them. An empty one clears
them. Keywords taken from the front matter are sorted, per
`denote-sort-keywords`.

# Browsing
The page picker shows a Denote note by its **title**, with its keywords beside
it. Keywords are drawn bare rather than as `#hashtags`, because Org writes them
`:like:this:`. The file name is not shown — for a Denote note it is a slug of
the title that is already on the row.

A note is still findable by any of the three: title, file name, or keyword.

# Dynamic blocks
An Org dynamic block — `#+BEGIN: denote-links :regexp "_costs"` … `#+END:` — is
generated content held in the file. Its body is ordinary Org, so the links it
holds render and resolve like any other.

Blocks refresh **on save**, so a block is never stale while you are reading it.
Only the page open in the editor is rewritten — a save arriving from sync
belongs to a buffer this does not own — and the rewrite is a no-op once
nothing changes, so it settles after one pass. The delimiters are left intact,
so the file stays a valid Org dynamic block for Emacs. Set
`denote.updateDblocksOnSave` to `false` to make it manual; **Denote: Update
Dynamic Blocks** does it on demand either way.

`:regexp` is matched against the whole **file name**, which is why a keyword
(`_costs`) or a signature (`==6`) works as a filter. `:not-regexp`,
`:id-only`, `:include-date`, `:sort-by-component` and `:reverse-sort` are
honoured, a block never links to its own note, and descriptions follow
Denote's default of signature and title two spaces apart.

Two details worth knowing. Emacs POSIX character classes such as
`[[:alpha:]]` are translated: they are *legal* JavaScript meaning something
else, so left alone they would silently drop notes. And `.txt` notes count —
Denote treats `.org`, `.md` and `.txt` alike, but only the first two are
SilverBullet pages, so `.txt` notes are read separately rather than missed.

Only `denote-links` is generated. The other block types
(`denote-backlinks`, `denote-missing-links`, `denote-files`,
`denote-files-as-headings`) are left untouched rather than emptied.

# Images and files
Dropping or pasting a file into an Org page uploads it and writes an Org link:
`[[file:picture.png]]`, not Markdown's `![[picture.png]]`.

An image is shown inline exactly when Org shows one — for a link with **no
description**. `[[file:shot.png]]` is the picture; `[[file:shot.png][a
screenshot]]` is the words. `#+ATTR_ORG: :width 300` on the line above sizes
it, and `#+ATTR_HTML:` is read the same way.

# Keywords and SilverBullet's reserved tags
A Denote keyword becomes a SilverBullet tag, and two tag names mean something
to SilverBullet: `meta` and `template` mark a page as *infrastructure*, which
hides it from the page picker's default segment and from `[[` completion.

`meta` is also an ordinary Denote keyword — real libraries use it freely for
notes *about* the library. A Denote note is therefore never treated as
infrastructure, whatever its keywords: it is content, and stays findable.

# Roadmap

Denote has ~50 interactive commands. The grouping below is by how much daily
work each one carries, not by how hard it is.

## 1. Daily drivers
The commands a Denote user reaches for constantly, and typically binds to a
single key. Open-or-create, link-or-create and backlinks are built; see the
sections above.

* **Search the library** (`denote-grep`, `consult-denote-grep`) — full-text
  search scoped to the Denote directory. SilverBullet has no full-text search
  of its own, so this is a view to build rather than one to reach: the
  substrate is there, since every paragraph is already indexed.

## 2. Keyword-centric browsing
Denote deliberately has no folders: keywords *are* the organisation, so
browsing by keyword is the main way around a library.

* A **keyword browser**: every keyword with its note count, plus *All* and
  *Untagged*, sortable alphabetically, by count, or by recency.
* A **note list** filtered to the selected keyword, sortable by date modified
  or by title.
* **Rename a keyword** across every note that carries it — in both file names
  and front matter.
* **Remove a keyword** across every note.
* **Add/remove keywords in bulk** for a selected set
  (`denote-dired-rename-marked-files-add-keywords` and its counterpart).

## 3. Renaming and hygiene
Renaming is routine in Denote, because the title and keywords live *in* the
file name. These keep a library consistent.

* **Rename with prompts** (`denote-rename-file`) — title, keywords and
  signature in one pass. The targeted variants (`denote-rename-file-title`,
  `-keywords`, `-signature`, `-date`) have nothing left to do here: editing the
  front matter *is* the rename, and it happens on save.
* **Change file type** (`denote-change-file-type-and-front-matter`) — convert a
  note between Org, Markdown and plain text, rewriting its front matter.

## 4. Beyond the core package
Each is a separate Emacs package; each maps onto something SilverBullet
already does well.

* **Journal** (`denote-journal`) — today's entry, created on demand, plus a
  calendar view. SilverBullet's daily-note machinery is the obvious host.
* **Sequence notes** (`denote-sequence`) — Luhmann-style hierarchical
  signatures (`1a`, `1a1`, `1b`). The signature component is already parsed
  and indexed.
* **The other dynamic block types** — `denote-backlinks`,
  `denote-missing-links`, `denote-files` and `denote-files-as-headings`.
* **Silos** (`denote-silo`) — several independent Denote directories.
* **Explore** (`denote-explore`) — library statistics and link graphs, which
  the existing object-graph plug could render.
* **Bibliography** (`citar-denote`) — notes attached to bibliography entries.

## 5. Smaller conveniences
`denote-region` (make a note from the selected text), `denote-template`,
`denote-type`, `denote-date`, `denote-subdirectory`, and the query-filter
commands (`denote-query-*`).

# Known gaps
* **Titles in the top bar.** The picker, fuzzy search and link completion all
  show and search a note's title, but the top bar still shows the raw file
  name, because that field is also the rename editor.
* **`@@`-prefixed identifiers** parse, but a `@` is not currently valid in a
  SilverBullet page name, so such a note cannot be opened. No real library
  observed uses them.
