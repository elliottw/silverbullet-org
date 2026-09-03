import { expect, test } from "vitest";
import { denoteFrontMatter, denoteMetadata } from "./denote.ts";

const note = `#+title:      Court Costs Relating to Evictions
#+date:       [2024-01-25 Thu 16:42]
#+filetags:   :costs:
#+identifier: 20240125T164238

* Body
`;

test("Denote metadata merges the file name with the front matter", () => {
  const meta = denoteMetadata(
    "20240125T164237==1a--court-costs-relating-to-evictions__costs.org",
    note,
  )!;
  // The identifier comes from the file name even though the front matter
  // disagrees by a second — this exact drift occurs in the real library, and
  // the file name is what inbound links resolve against.
  expect(meta.identifier).toEqual("20240125T164237");
  // The title comes from the front matter: it is the only un-sluggified copy.
  expect(meta.title).toEqual("Court Costs Relating to Evictions");
  expect(meta.keywords).toEqual(["costs"]);
  expect(meta.signature).toEqual("1a");
  expect(meta.date).toEqual("[2024-01-25 Thu 16:42]");
});

test("File-name keywords win over front matter ones", () => {
  // Also real drift: the file name lists three keywords, the front matter one.
  const meta = denoteMetadata(
    "20240328T000000==coa=div3--heston-v-christensen__attyfees_case_soid.org",
    "#+title: Heston\n#+filetags: :case:\n",
  )!;
  expect(meta.keywords).toEqual(["attyfees", "case", "soid"]);
  expect(meta.signature).toEqual("coa=div3");
});

test("A note with no front matter falls back to its file name", () => {
  const meta = denoteMetadata("20240322T131856--some-title__a_b.org", "")!;
  expect(meta.title).toEqual("Some title");
  expect(meta.keywords).toEqual(["a", "b"]);
});

test("A non-Denote page has no Denote metadata", () => {
  expect(denoteMetadata("Some Page.md", "# Hi\n")).toBeNull();
  expect(denoteFrontMatter("Some Page.md", "# Hi\n")).toBeNull();
});

test("Denote metadata is exposed as front matter so tags and titles flow on", () => {
  const frontMatter = denoteFrontMatter(
    "20240125T164237==1a--court-costs__costs_law.org",
    note,
  )!;
  // Keywords become SilverBullet tags, which is what makes an ordinary tag
  // query find a note by its Denote keyword.
  expect(frontMatter.tags).toEqual(["costs", "law"]);
  expect(frontMatter.title).toEqual("Court Costs Relating to Evictions");
  // Also exposed as displayName, which is what makes the note findable by
  // title in the page picker and in link completion.
  expect(frontMatter.displayName).toEqual("Court Costs Relating to Evictions");
  expect(frontMatter.identifier).toEqual("20240125T164237");
  expect(frontMatter.signature).toEqual("1a");
});
