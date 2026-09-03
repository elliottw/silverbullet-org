import { expect, test } from "vitest";
import {
  documentLink,
  hasLinkScheme,
  innerPageLink,
  linkSyntaxFor,
  orgLinkTarget,
  pageLink,
  urlLink,
} from "./link_syntax.ts";

const NOTE =
  "20240125T164237==1a--court-costs-relating-to-evictions__costs.org";

test("The page's extension decides the link syntax", () => {
  expect(linkSyntaxFor(NOTE)).toEqual("org");
  expect(linkSyntaxFor("Notes.org")).toEqual("org");
  expect(linkSyntaxFor("Some Page")).toEqual("markdown");
  expect(linkSyntaxFor("Some Page.md")).toEqual("markdown");
});

test("An Org link to a Denote note addresses its identifier, not its name", () => {
  // This is the whole point of Denote's scheme: the note can be renamed — and
  // renaming is routine, since the title and keywords live in the file name —
  // without breaking anything pointing at it.
  expect(orgLinkTarget(NOTE)).toEqual("denote:20240125T164237");
  expect(orgLinkTarget("Plain Note.org")).toEqual("Plain Note.org");
});

test("Completion fills the middle of an already-typed [[ ]]", () => {
  // Markdown separates the alias with `|`; Org closes the target and opens a
  // description with `][`.
  expect(innerPageLink("markdown", "Some Page", "Alias")).toEqual(
    "Some Page|Alias",
  );
  expect(innerPageLink("org", NOTE, "Court Costs")).toEqual(
    "denote:20240125T164237][Court Costs",
  );
  expect(innerPageLink("org", NOTE)).toEqual("denote:20240125T164237");
  expect(innerPageLink("markdown", "Some Page")).toEqual("Some Page");
});

test("A whole page link brackets correctly in both syntaxes", () => {
  expect(pageLink("org", NOTE, "Court Costs")).toEqual(
    "[[denote:20240125T164237][Court Costs]]",
  );
  expect(pageLink("markdown", "Some Page", "Alias")).toEqual(
    "[[Some Page|Alias]]",
  );
});

test("URL links follow the page's syntax", () => {
  expect(urlLink("markdown", "https://example.com", "Example")).toEqual(
    "[Example](https://example.com)",
  );
  expect(urlLink("org", "https://example.com", "Example")).toEqual(
    "[[https://example.com][Example]]",
  );
});

test("Document links follow the page's syntax", () => {
  // Org has no `![[…]]` transclusion, so an image is a plain file link.
  expect(documentLink("markdown", "photo.png", true)).toEqual("![[photo.png]]");
  expect(documentLink("markdown", "doc.pdf", false)).toEqual("[[doc.pdf]]");
  expect(documentLink("org", "photo.png", true)).toEqual("[[file:photo.png]]");
});

test("Link schemes are recognised so bare targets can be treated as pages", () => {
  expect(hasLinkScheme("https://example.com")).toBe(true);
  expect(hasLinkScheme("denote:20240125T164237")).toBe(true);
  expect(hasLinkScheme("file:a.org")).toBe(true);
  expect(hasLinkScheme("mailto:a@b.c")).toBe(true);
  expect(hasLinkScheme("Some Page.org")).toBe(false);
  expect(hasLinkScheme("20240125T164237==1a--x__k.org")).toBe(false);
});
