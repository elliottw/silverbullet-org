import { expect, test } from "vitest";
import { denoteNameFromFrontMatter } from "./denote.ts";

const NAME = "20240125T164237==1a--court-costs__costs.org";

function fm(fields: string): string {
  return `${fields}\n\n* Body\n`;
}

test("A changed title rewrites the file name, keeping the identifier", () => {
  expect(
    denoteNameFromFrontMatter(
      NAME,
      fm("#+title:      Court Costs & Waivers\n#+filetags:   :costs:"),
    ),
    // The identifier is identity — every inbound link resolves against it —
    // so it is never taken from the front matter.
  ).toEqual("20240125T164237==1a--court-costs-waivers__costs.org");
});

test("Changed keywords rewrite the file name, sluggified and sorted", () => {
  // Org filetags cannot contain a space, so `Case Law` is two keywords — the
  // same split `denote-extract-keywords-from-front-matter` makes. Keywords
  // from the front matter are sorted, as `denote--rename-file` does.
  expect(
    denoteNameFromFrontMatter(
      NAME,
      fm("#+title:      Court Costs\n#+filetags:   :costs:Case Law:"),
    ),
  ).toEqual("20240125T164237==1a--court-costs__case_costs_law.org");
});

test("A changed signature rewrites the file name", () => {
  expect(
    denoteNameFromFrontMatter(
      NAME,
      fm(
        "#+title:      Court Costs\n#+filetags:   :costs:\n#+signature:  coa div1",
      ),
    ),
  ).toEqual("20240125T164237==coa=div1--court-costs__costs.org");
});

test("An empty filetags line clears the keywords", () => {
  expect(
    denoteNameFromFrontMatter(
      NAME,
      fm("#+title:      Court Costs\n#+filetags:"),
    ),
  ).toEqual("20240125T164237==1a--court-costs.org");
});

test("An absent filetags line keeps the file name's keywords", () => {
  // Absent means "unknown", not "none" — dropping them would lose data the
  // author never touched.
  expect(
    denoteNameFromFrontMatter(NAME, fm("#+title:      Court Costs")),
  ).toEqual(null);
  expect(denoteNameFromFrontMatter(NAME, fm("#+title:      Renamed"))).toEqual(
    "20240125T164237==1a--renamed__costs.org",
  );
});

test("A name that already matches needs no rename", () => {
  expect(
    denoteNameFromFrontMatter(
      NAME,
      fm("#+title:      Court Costs\n#+filetags:   :costs:\n#+signature:  1a"),
    ),
  ).toBeNull();
});

test("A note with no title in its front matter is left alone", () => {
  expect(denoteNameFromFrontMatter(NAME, "* Just a body\n")).toBeNull();
});

test("A non-Denote page is left alone", () => {
  expect(
    denoteNameFromFrontMatter("Some Page.md", "---\ntitle: Hi\n---\n"),
  ).toBeNull();
});

test("Markdown and plain text notes work too", () => {
  expect(
    denoteNameFromFrontMatter(
      "20240125T164237--old-title__a.md",
      '---\ntitle: "New Title"\ntags: ["b"]\n---\n',
    ),
  ).toEqual("20240125T164237--new-title__b.md");
});
