---
references:
- client/org_parser/parser.ts
- client/org_parser/node_types.ts
- plug-api/lib/ref.ts
---
> **warning** Proof of concept
> Org Mode support is experimental and covers Org's *core structure* only. See [[#What is not supported yet]].

SilverBullet keeps your space as plain text files. Historically those files were always [[Markdown]]. Files ending in `.org` are now a second kind of **page**: SilverBullet parses them with an [Org Mode](https://orgmode.org/) parser, edits them in the same live-preview editor, and indexes them into the same [[Object]] database — so [[Space Lua/Lua Integrated Query]] queries see Org content next to Markdown content.

# Pages, not documents
An Org file is a page, not a [[Document]]. The difference matters: documents are opaque blobs handed to a document editor, while pages are parsed, indexed, linkable and queryable.

Unlike Markdown, an Org page keeps its extension in its name. `Notes.md` is the page `Notes`; `Notes.org` is the page `Notes.org`. That is what lets the two live side by side without colliding, and it means you link to an Org page by writing its full name:

    [[Notes.org]]

To create one, navigate to a name ending in `.org` — the page picker and `Ctrl-k` work as they do for Markdown.

# Supported syntax
```org
#+TITLE: Project notes

* Headline
Paragraph text with *bold*, /italic/, _underline_, +strikethrough+,
=verbatim= and ~code~.

** Sub-headline
- a plain list item
  - nested by indentation
- [ ] an open task
- [X] a finished task
1. an ordered item

:PROPERTIES:
:COST: 250
:END:

#+BEGIN_SRC lua
print("hello")
#+END_SRC

#+BEGIN_QUOTE
A quotation.
#+END_QUOTE

| name | cost |
|------+------|
| bolt |   10 |

# a comment line
-----
```

Headlines nest up to six levels (Org allows more; deeper ones are treated as level six). A `*` in column 0 is always a headline, so `*` only starts a list item when it is indented. A headline folds its whole subtree, and the body of a `#+BEGIN_SRC <language>` block is syntax highlighted with the same languages [[Markdown/Syntax Highlighting]] offers for fenced code.

# How it works
The Org parser lives in `client/org_parser/` and produces the *same node vocabulary* as SilverBullet's Markdown parser: an Org headline becomes an `ATXHeading1`…`ATXHeading6`, a checkbox item becomes a `ListItem` containing a `Task`, a source block becomes a `FencedCode`, and so on.

That single decision is what makes the feature small. Everything downstream — the header, item, task and paragraph indexers in `plugs/index/`, and the live-preview decorations in `client/codemirror/` — reads node names, not file extensions, so they work on Org pages without knowing Org exists. `plugs/index/org.test.ts` pins that down.

The set of page extensions is `pageExtensions` in `plug-api/lib/ref.ts`; `isPagePath()` is the predicate the client uses to decide "parse and index this" versus "hand this to a document editor".

# What is not supported yet
These are deliberate omissions in the proof of concept, not obstacles — the parser has a place for each of them:

* **Links.** `[[target][description]]` is not yet mapped onto SilverBullet's wiki links, so Org links are inert text.
* **Tags.** Org's `:tag:list:` on a headline is not mapped onto [[Markdown/Hashtags]].
* **TODO keywords.** `* TODO Write the spec` is a plain headline; only checkbox items (`- [ ]`) index as [[Object/task]]s. Priorities (`[#A]`) and `SCHEDULED:`/`DEADLINE:` timestamps are likewise unparsed.
* **Property drawers as attributes.** `:PROPERTIES:` drawers are parsed into their own nodes and stay out of your prose, but their keys do not yet become attributes on the enclosing headline, and `#+TITLE:` style keywords do not become page frontmatter.
* **Footnotes, macros, `#+INCLUDE:`, timestamps and inline LaTeX** are unparsed.
* **Emphasis across more than one line** is not recognised.
* **Org syntax inside a Markdown fenced code block** is not highlighted; the nesting only goes the other way.
