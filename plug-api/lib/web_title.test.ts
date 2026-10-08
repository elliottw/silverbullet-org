import { expect, test } from "vitest";
import { normalizeWebUrl, titleFromHtml } from "./web_title.ts";

test("A bare host becomes an https URL; a scheme is left alone", () => {
  expect(normalizeWebUrl("example.com/x?y=1")).toEqual(
    "https://example.com/x?y=1",
  );
  expect(normalizeWebUrl("  example.com  ")).toEqual("https://example.com");
  expect(normalizeWebUrl("localhost:3000/x")).toEqual("localhost:3000/x");
  expect(normalizeWebUrl("//cdn.example.com/x")).toEqual(
    "https://cdn.example.com/x",
  );
  expect(normalizeWebUrl("http://example.com")).toEqual("http://example.com");
  expect(normalizeWebUrl("mailto:a@b.co")).toEqual("mailto:a@b.co");
  expect(normalizeWebUrl("denote:20240125T164237")).toEqual(
    "denote:20240125T164237",
  );
  expect(normalizeWebUrl("   ")).toEqual("");
});

test("The title is the tab's text, whitespace collapsed and entities decoded", () => {
  expect(
    titleFromHtml(
      `<html><head><title>\n  Hackers &amp; Painters &mdash; Paul\n  Graham\n</title></head>`,
    ),
  ).toEqual("Hackers & Painters — Paul Graham");
  expect(titleFromHtml(`<TITLE lang="en">Caps &#8212; fine</TITLE>`)).toEqual(
    "Caps — fine",
  );
  expect(titleFromHtml(`<title><span>Nested</span> markup</title>`)).toEqual(
    "Nested markup",
  );
});

test("og:title stands in where there is no title tag, in either attribute order", () => {
  expect(
    titleFromHtml(`<meta property="og:title" content="An Open Graph title">`),
  ).toEqual("An Open Graph title");
  expect(titleFromHtml(`<meta content="Reversed" name="og:title">`)).toEqual(
    "Reversed",
  );
});

test("Nothing worth offering reads as nothing", () => {
  expect(
    titleFromHtml("<html><body>No head at all</body></html>"),
  ).toBeUndefined();
  expect(titleFromHtml("<title>   </title>")).toBeUndefined();
  // A page that answers with its whole novel does not become the description.
  const long = titleFromHtml(`<title>${"word ".repeat(200)}</title>`)!;
  expect(long.length).toBeLessThanOrEqual(301);
  expect(long.endsWith("…")).toBe(true);
});
