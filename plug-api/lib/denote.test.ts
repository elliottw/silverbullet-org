import { expect, test } from "vitest";
import {
  denoteDate,
  denoteExtension,
  denoteFileType,
  denoteIdentifier,
  denoteIdentifierToDate,
  denoteOrgTimestamp,
  extractDenoteKeywords,
  formatDenoteFrontMatter,
  formatDenoteName,
  isDenotePath,
  parseDenoteFrontMatter,
  parseDenoteName,
  sluggify,
} from "./denote.ts";

// The file names below are taken verbatim from two real, public Denote
// libraries: github.com/l-o-l-h/law (a law student's notes, which lean on
// signatures) and github.com/Spike-Leung/taxodium (a blog, which has CJK
// titles). The parser was validated against all 457 files of the former.

test("A full Denote file name splits into its four components", () => {
  const name = parseDenoteName(
    "19700209T000000==coa=div1--diel-v-beekman-1-wn-app-874-465-p2d-212-1970__case_evidence_law_parol_resulting_trust.org",
  )!;
  expect(name.identifier).toEqual("19700209T000000");
  // A signature keeps single `=` inside it; `==` is only the delimiter.
  expect(name.signature).toEqual("coa=div1");
  expect(name.title).toEqual("diel-v-beekman-1-wn-app-874-465-p2d-212-1970");
  expect(name.keywords).toEqual([
    "case",
    "evidence",
    "law",
    "parol",
    "resulting",
    "trust",
  ]);
  expect(name.extension).toEqual(".org");
});

test("Components are all optional", () => {
  expect(parseDenoteName("20240322T131856.org")).toEqual({
    identifier: "20240322T131856",
    keywords: [],
    extension: ".org",
  });
  expect(parseDenoteName("20240322T131856--just-a-title.org")?.title).toEqual(
    "just-a-title",
  );
  expect(
    parseDenoteName("20240322T131856__only_keywords.org")?.keywords,
  ).toEqual(["only", "keywords"]);
  expect(
    parseDenoteName("20241030T084015--docker-singularity.html")?.extension,
  ).toEqual(".html");
});

test("A non-Denote file name does not parse", () => {
  expect(parseDenoteName("notes.org")).toBeNull();
  expect(parseDenoteName("Some Page.md")).toBeNull();
  expect(isDenotePath("20240322T131856--x.org")).toBe(true);
  expect(isDenotePath("notes.org")).toBe(false);
});

test("An explicit @@ identifier is honoured, and paths are reduced to their basename", () => {
  const name = parseDenoteName("sub/dir/@@custom-id--a-title__k.org")!;
  expect(name.identifier).toEqual("custom-id");
  expect(name.title).toEqual("a-title");
});

test("Non-ASCII titles survive sluggification", () => {
  const name = parseDenoteName(
    "20200218T150054--制作-svg-地图轮廓__map_published_svg.org",
  )!;
  expect(name.title).toEqual("制作-svg-地图轮廓");
  expect(name.keywords).toEqual(["map", "published", "svg"]);
  // Denote only strips punctuation and lowercases; it does not transliterate.
  expect(sluggify("title", "制作 SVG 地图轮廓")).toEqual("制作-svg-地图轮廓");
});

test("Sluggification follows denote.el's per-component rules", () => {
  // Title: punctuation removed, spaces/underscores hyphenated, lowercased.
  expect(sluggify("title", "Kiemle & Hagood Company v. Daniels")).toEqual(
    "kiemle-hagood-company-v-daniels",
  );
  expect(sluggify("title", "131 Wash.App. 1035")).toEqual("131-washapp-1035");
  // Keyword: separators are removed outright, joining the words, because `_`
  // separates keywords from each other in the file name.
  expect(sluggify("keyword", "genuine issue trial")).toEqual(
    "genuineissuetrial",
  );
  expect(sluggify("keyword", "long-term_care")).toEqual("longtermcare");
  // Signature: words joined with `=`, which is why `coa div1` becomes coa=div1.
  expect(sluggify("signature", "coa div1")).toEqual("coa=div1");
  expect(sluggify("signature", "COA_div1")).toEqual("coa=div1");
});

test("Formatting a name is the inverse of parsing an already-slugged one", () => {
  for (const fileName of [
    "19700209T000000==coa=div1--diel-v-beekman-1-wn-app-874-465-p2d-212-1970__case_evidence_law_parol_resulting_trust.org",
    "20260123T152537--account-action-on__law.org",
    "20240125T164237==1a--court-costs-relating-to-evictions__costs.org",
    "20200218T150054--制作-svg-地图轮廓__map_published_svg.org",
    "20240322T131856.org",
  ]) {
    expect(formatDenoteName(parseDenoteName(fileName)!)).toEqual(fileName);
  }
});

test("Formatting sluggifies raw components", () => {
  expect(
    formatDenoteName({
      identifier: "20240322T131856",
      signature: "COA div1",
      title: "Kiemle & Hagood Company v. Daniels",
      keywords: ["Case Law", "trust"],
      extension: ".org",
    }),
  ).toEqual(
    "20240322T131856==coa=div1--kiemle-hagood-company-v-daniels__caselaw_trust.org",
  );
  // A non-timestamp identifier keeps its `@@` marker.
  expect(
    formatDenoteName({
      identifier: "custom",
      title: "x",
      keywords: [],
      extension: ".org",
    }),
  ).toEqual("@@custom--x.org");
});

test("Org front matter round-trips", () => {
  const text = `#+title:      Diel v. Beekman, 1 Wn. App. 874, 465 P.2d 212 (1970)
#+date:       [1970-02-09 Mon 00:00]
#+filetags:   :case:evidence:law:parol:resulting:trust:
#+identifier: 19700209T000000
#+signature:  coa=div1

* Some heading
`;
  const fm = parseDenoteFrontMatter(text, "org");
  expect(fm.title).toEqual(
    "Diel v. Beekman, 1 Wn. App. 874, 465 P.2d 212 (1970)",
  );
  expect(fm.date).toEqual("[1970-02-09 Mon 00:00]");
  expect(fm.keywords).toEqual([
    "case",
    "evidence",
    "law",
    "parol",
    "resulting",
    "trust",
  ]);
  expect(fm.identifier).toEqual("19700209T000000");
  expect(fm.signature).toEqual("coa=div1");

  expect(formatDenoteFrontMatter(fm, "org")).toEqual(
    `#+title:      ${fm.title}\n` +
      `#+date:       [1970-02-09 Mon 00:00]\n` +
      `#+filetags:   :case:evidence:law:parol:resulting:trust:\n` +
      `#+identifier: 19700209T000000\n` +
      `#+signature:  coa=div1\n\n`,
  );
});

test("Every file type's front matter is understood", () => {
  expect(denoteFileType(".org")).toEqual("org");
  expect(denoteFileType(".txt")).toEqual("text");
  expect(denoteFileType(".md")).toEqual("markdown-yaml");
  expect(denoteFileType(".md", "+++\ntitle = ...")).toEqual("markdown-toml");

  const yaml = parseDenoteFrontMatter(
    `---\ntitle:      "A note"\ndate:       "2024-03-22T13:18:56+01:00"\ntags:       ["one", "two"]\nidentifier: "20240322T131856"\n---\n`,
    "markdown-yaml",
  );
  expect(yaml.title).toEqual("A note");
  expect(yaml.keywords).toEqual(["one", "two"]);
  expect(yaml.identifier).toEqual("20240322T131856");

  const toml = parseDenoteFrontMatter(
    `+++\ntitle      = "A note"\ntags       = ["one", "two"]\nidentifier = "20240322T131856"\n+++\n`,
    "markdown-toml",
  );
  expect(toml.title).toEqual("A note");
  expect(toml.keywords).toEqual(["one", "two"]);

  const txt = parseDenoteFrontMatter(
    `title:      A note\ntags:       one  two\nidentifier: 20240322T131856\n---------------------------\n`,
    "text",
  );
  expect(txt.title).toEqual("A note");
  expect(txt.keywords).toEqual(["one", "two"]);
});

test("Keyword extraction handles each type's separators", () => {
  expect(extractDenoteKeywords(":case:law:")).toEqual(["case", "law"]);
  expect(extractDenoteKeywords(`["one", "two"]`)).toEqual(["one", "two"]);
  expect(extractDenoteKeywords("one  two")).toEqual(["one", "two"]);
  expect(extractDenoteKeywords("")).toEqual([]);
});

test("Only the first line matching a key counts", () => {
  const fm = parseDenoteFrontMatter(
    "#+title:      Real title\n#+identifier: 20240322T131856\n\n* Body\n#+title: not the title\n",
    "org",
  );
  expect(fm.title).toEqual("Real title");
});

test("Identifiers convert to and from dates", () => {
  const date = new Date(2024, 2, 22, 13, 18, 56);
  expect(denoteIdentifier(date)).toEqual("20240322T131856");
  expect(denoteIdentifierToDate("20240322T131856")).toEqual(date);
  expect(denoteIdentifierToDate("nope")).toBeNull();
  expect(denoteOrgTimestamp(date)).toEqual("[2024-03-22 Fri 13:18]");
});

test("Dates are written in each file type's own notation", () => {
  const date = new Date(2024, 2, 22, 13, 18, 56);
  expect(denoteDate(date, "org")).toEqual("[2024-03-22 Fri 13:18]");
  expect(denoteDate(date, "text")).toEqual("2024-03-22");
  expect(denoteDate(date, "markdown-yaml")).toMatch(
    /^2024-03-22T13:18:56[+-]\d{2}:\d{2}$/,
  );
});

test("Each file type has its extension", () => {
  expect(denoteExtension("org")).toEqual(".org");
  expect(denoteExtension("text")).toEqual(".txt");
  expect(denoteExtension("markdown-yaml")).toEqual(".md");
});

test("an empty signature line is dropped, as denote.el drops it", () => {
  // `denote-front-matter-components-present-even-if-empty-value` defaults to
  // (title keywords date identifier) -- signature is deliberately absent, so
  // a note without one has no `#+signature:` line at all.
  const org = formatDenoteFrontMatter(
    {
      title: "Court Costs",
      date: "[2024-01-25 Thu 16:42]",
      keywords: ["costs"],
      hasKeywords: true,
      identifier: "20240125T164237",
    },
    "org",
  );
  expect(org).not.toContain("#+signature");
  expect(org).toContain("#+title:      Court Costs");
  // The components Denote keeps even when empty are still written.
  expect(org).toContain("#+identifier: 20240125T164237");

  // A signature that exists is written as before.
  const signed = formatDenoteFrontMatter(
    {
      title: "Court Costs",
      date: "[2024-01-25 Thu 16:42]",
      keywords: ["costs"],
      hasKeywords: true,
      identifier: "20240125T164237",
      signature: "1a",
    },
    "org",
  );
  expect(signed).toContain("#+signature:  1a");
});
