import { expect, test } from "vitest";
import { parseOrg } from "../../client/org_parser/parser.ts";
import {
  compileDblockRegexp,
  emacsRegexpToJs,
  parseDblockParams,
} from "@silverbulletmd/silverbullet/lib/denote";
import {
  type DenoteNoteSummary,
  findDynamicBlocks,
  renderDenoteLinksBlock,
} from "./denote.ts";

// Verbatim from github.com/l-o-l-h/law.
const BLOCK = `* Court Costs

#+BEGIN: denote-links :regexp "_costs" :sort-by-component nil :reverse-sort nil :id-only nil
- [[denote:20240125T164237][1a  Court Costs Relating to Evictions]]
#+END:
`;

const NOTES: DenoteNoteSummary[] = [
  {
    name: "20240125T164237==1a--court-costs-relating-to-evictions__costs.org",
    identifier: "20240125T164237",
    title: "Court Costs Relating to Evictions",
    signature: "1a",
    keywords: ["costs"],
  },
  {
    name: "20250422T092357--items-awarded-as-costs__costs.org",
    identifier: "20250422T092357",
    title: "Items Awarded as Costs",
    keywords: ["costs"],
  },
  {
    name: "20240203T105326==cr=41--cr-41-dismissal__cr.org",
    identifier: "20240203T105326",
    title: "CR 41 Dismissal of Actions",
    signature: "cr=41",
    keywords: ["cr"],
  },
];

test("A dynamic block's parameters parse as an elisp plist", () => {
  expect(
    parseDblockParams(
      ':regexp "_costs" :sort-by-component nil :reverse-sort nil :id-only nil',
    ),
  ).toEqual({
    regexp: "_costs",
    "sort-by-component": null,
    "reverse-sort": null,
    "id-only": null,
  });
  // `t` is elisp's true; a bare word stays a string.
  expect(parseDblockParams(":id-only t :sort-by-component title")).toEqual({
    "id-only": true,
    "sort-by-component": "title",
  });
});

test("Emacs POSIX character classes are translated", () => {
  // `[[:alpha:]]` is *legal* JavaScript meaning something else, so it fails
  // silently rather than throwing — which quietly drops notes from a block.
  expect(emacsRegexpToJs("==31[[:alpha:]].*--")).toEqual("==31[a-zA-Z].*--");
  expect(
    compileDblockRegexp("==31[[:alpha:]].*--")(
      "20251204T164954==31a--x__k.org",
    ),
  ).toBe(true);
  expect(
    compileDblockRegexp("==31[[:alpha:]].*--")(
      "20251204T164954==310--x__k.org",
    ),
  ).toBe(false);
});

test("An uncompilable regexp falls back to a literal match", () => {
  expect(compileDblockRegexp("a[b")("xa[bz")).toBe(true);
});

test("A dynamic block is parsed with its type, params and body range", () => {
  const blocks = findDynamicBlocks(parseOrg(BLOCK));
  expect(blocks.length).toEqual(1);
  expect(blocks[0].type).toEqual("denote-links");
  expect(blocks[0].params.regexp).toEqual("_costs");
});

test("denote-links matches the regexp against the file name", () => {
  // Which is why a keyword (`_costs`) or a signature (`==6`) works as a filter.
  expect(
    renderDenoteLinksBlock({ regexp: "_costs" }, NOTES, "Other.org"),
  ).toEqual(
    "- [[denote:20240125T164237][1a  Court Costs Relating to Evictions]]\n" +
      "- [[denote:20250422T092357][Items Awarded as Costs]]",
  );
});

test("A block never links to its own note", () => {
  expect(
    renderDenoteLinksBlock(
      { regexp: "_costs" },
      NOTES,
      "20240125T164237==1a--court-costs-relating-to-evictions__costs.org",
    ),
  ).toEqual("- [[denote:20250422T092357][Items Awarded as Costs]]");
});

test("id-only, include-date, not-regexp and sorting are honoured", () => {
  expect(
    renderDenoteLinksBlock({ regexp: "_costs", "id-only": true }, NOTES, ""),
  ).toEqual(
    "- [[denote:20240125T164237][20240125T164237]]\n" +
      "- [[denote:20250422T092357][20250422T092357]]",
  );
  expect(
    renderDenoteLinksBlock(
      { regexp: "_costs", "include-date": true },
      NOTES,
      "",
    ),
  ).toContain("(2024-01-25)");
  expect(
    renderDenoteLinksBlock(
      { regexp: "_costs", "not-regexp": "items-awarded" },
      NOTES,
      "",
    ),
  ).toEqual(
    "- [[denote:20240125T164237][1a  Court Costs Relating to Evictions]]",
  );
  // Locale collation, as Emacs's `string-collate-lessp` does: "Court" sorts
  // before "CR" because `co` < `cr`.
  expect(
    renderDenoteLinksBlock(
      { regexp: "costs|cr", "sort-by-component": "title" },
      NOTES,
      "",
    )
      .split("\n")
      .map((line) => /\]\[(.*)\]\]/.exec(line)![1]),
  ).toEqual([
    "1a  Court Costs Relating to Evictions",
    "cr=41  CR 41 Dismissal of Actions",
    "Items Awarded as Costs",
  ]);
});

test("The description is signature and title, two spaces apart", () => {
  // Denote's default `denote-link-description-with-signature-and-title`.
  const one = renderDenoteLinksBlock({ regexp: "cr-41" }, NOTES, "");
  expect(one).toEqual(
    "- [[denote:20240203T105326][cr=41  CR 41 Dismissal of Actions]]",
  );
});
