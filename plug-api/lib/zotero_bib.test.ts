import { expect, test } from "vitest";
import { parseBibtex } from "./bibtex.ts";
import {
  detectStoragePath,
  renderBibtex,
  zoteroItemToEntry,
} from "./zotero_bib.ts";

const article = {
  key: "ITEM0001",
  itemType: "journalArticle",
  citationKey: "graham2004hackers",
  title: "Hackers & Painters",
  creators: [
    { creatorType: "author", firstName: "Paul", lastName: "Graham" },
    { creatorType: "editor", firstName: "Ann", lastName: "Editor" },
  ],
  date: "2004-05-01",
  publicationTitle: "Some Journal",
  volume: "3",
  pages: "10-20",
  DOI: "10.1/abc",
  tags: [{ tag: "essays" }, { tag: "Land Bank" }],
};

const attachment = {
  key: "PSKBJDH2",
  itemType: "attachment",
  parentItem: "ITEM0001",
  filename: "hackers.pdf",
  linkMode: "imported_file",
};

test("an item becomes an entry with Zotero's own citekey", () => {
  const entry = zoteroItemToEntry(
    article,
    [attachment],
    "/Users/e/Zotero/storage",
  );
  expect(entry.citekey).toBe("graham2004hackers");
  expect(entry.type).toBe("article");
  expect(entry.authors).toEqual(["Graham, Paul"]);
  expect(entry.year).toBe("2004");
  expect(entry.keywords).toEqual(["essays", "Land Bank"]);
  expect(entry.fields.journal).toBe("Some Journal");
  expect(entry.fields.editor).toBe("Editor, Ann");
  expect(entry.fields.file).toBe(
    "/Users/e/Zotero/storage/PSKBJDH2/hackers.pdf",
  );
  expect(entry.attachments).toEqual([{ key: "PSKBJDH2", name: "hackers.pdf" }]);
});

test("a chapter's container is a booktitle, a document is misc", () => {
  const chapter = zoteroItemToEntry({
    key: "I2",
    itemType: "bookSection",
    citationKey: "k2",
    publicationTitle: "The Book",
  });
  expect(chapter.type).toBe("incollection");
  expect(chapter.fields.booktitle).toBe("The Book");
  expect(
    zoteroItemToEntry({ key: "I3", itemType: "document", citationKey: "k3" })
      .type,
  ).toBe("misc");
});

test("what is written parses back to what went in", () => {
  const entries = [
    zoteroItemToEntry(article, [attachment], "/Users/e/Zotero/storage"),
    zoteroItemToEntry({
      key: "I4",
      itemType: "book",
      citationKey: "abook",
      title: "A Book",
      creators: [{ creatorType: "author", name: "An Institution" }],
      date: "1999",
    }),
  ];
  const text = renderBibtex(entries);
  // Sorted by citekey, so the file only changes when the library does.
  expect(text.indexOf("@book{abook")).toBeLessThan(
    text.indexOf("@article{graham2004hackers"),
  );
  const parsed = parseBibtex(text);
  expect(parsed.map((e) => e.citekey)).toEqual(["abook", "graham2004hackers"]);
  const back = parsed[1];
  // The parser undoes the escaping, so the round trip is clean.
  expect(back.title).toBe("Hackers & Painters");
  expect(back.authors).toEqual(["Graham, Paul"]);
  expect(back.year).toBe("2004");
  expect(back.keywords).toEqual(["essays", "Land Bank"]);
  // The path survives verbatim -- an escaped path is a path that cannot open.
  expect(back.attachments).toEqual([{ key: "PSKBJDH2", name: "hackers.pdf" }]);
  expect(text).toContain(
    "file = {/Users/e/Zotero/storage/PSKBJDH2/hackers.pdf}",
  );
});

test("an item with no citekey is left out: it cannot be cited", () => {
  const text = renderBibtex([
    zoteroItemToEntry({ key: "I5", itemType: "document", title: "No key" }),
  ]);
  expect(text).not.toContain("No key");
});

test("the storage path is learned from a bibliography already in the space", () => {
  expect(
    detectStoragePath(
      "@misc{a,\n  file = {/Users/elliott/Zotero/storage/N3CSWYJG/01 Neena.pdf}\n}",
    ),
  ).toBe("/Users/elliott/Zotero/storage");
  expect(
    detectStoragePath("@misc{a,\n  title = {No files}\n}"),
  ).toBeUndefined();
});

test("an item with nothing but a key is still a valid entry", () => {
  const text = renderBibtex([
    zoteroItemToEntry({ key: "I6", itemType: "document", citationKey: "bare" }),
    zoteroItemToEntry({
      key: "I7",
      itemType: "book",
      citationKey: "next",
      title: "Next",
    }),
  ]);
  expect(text).toContain("@misc{bare\n}");
  // It does not swallow what follows it. (Our own reader skips an entry with
  // no fields -- there is nothing to show for it -- which is also what it has
  // always done with Better BibTeX's output for the same items.)
  expect(parseBibtex(text).map((e) => e.citekey)).toEqual(["next"]);
});

test("the small conventions: en dash, language name, date not timestamp", () => {
  const entry = zoteroItemToEntry({
    key: "I8",
    itemType: "journalArticle",
    citationKey: "conv",
    title: "Conventions",
    pages: "471-489",
    language: "en",
    accessDate: "2024-09-02T20:15:19Z",
    date: "23/1994",
    rights: "All rights reserved",
    abstractNote: "First line\n            second line",
  });
  expect(entry.fields.pages).toBe("471--489");
  expect(entry.fields.langid).toBe("english");
  expect(entry.fields.urldate).toBe("2024-09-02");
  // A year can be read out of it, but `23/1994` is not a date.
  expect(entry.fields.year).toBe("1994");
  expect(entry.fields.date).toBeUndefined();
  expect(entry.fields.copyright).toBe("All rights reserved");
  // One field, one line.
  const text = renderBibtex([entry]);
  expect(text).toContain("abstract = {First line second line}");
});
