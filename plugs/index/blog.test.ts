import { expect, test } from "vitest";
import { hugoDate, slugFor, toPost } from "./blog.ts";

test("an Org date becomes the date Hugo wants", () => {
  expect(hugoDate("[2026-05-30 Sat 09:46]")).toEqual("2026-05-30");
  expect(hugoDate("2026-05-30")).toEqual("2026-05-30");
  expect(hugoDate(undefined)).toEqual("");
  expect(hugoDate("no date here")).toEqual("");
});

test("a post's directory is its title, since it is a URL", () => {
  expect(slugFor("On Civic Design", "20261109T094102")).toEqual(
    "on-civic-design",
  );
  // A note with no usable title still has to land somewhere.
  expect(slugFor("", "20261109T094102")).toEqual("20261109T094102");
});

test("front matter is translated and the library's own keys are left behind", () => {
  const note = [
    "#+title:      On Civic Design",
    "#+date:       [2026-05-30 Sat 09:46]",
    "#+filetags:   :elliottwgithubio:design:",
    "#+identifier: 20261109T094102",
    "#+signature:  21=04",
    "#+description: A short blurb.",
    "",
    "* A section",
    "Prose with a [[denote:20240125T164237][link]].",
    "",
  ].join("\n");

  const post = toPost(note, { categories: ["design"], draft: false });

  expect(post).toContain("#+title:  On Civic Design");
  expect(post).toContain("#+date:   2026-05-30");
  expect(post).toContain("#+categories: design");
  expect(post).toContain("#+description: A short blurb.");
  expect(post).toContain("#+draft:  false");
  // How the *library* addresses a note means nothing to a reader.
  expect(post).not.toContain("#+identifier:");
  expect(post).not.toContain("#+signature:");
  expect(post).not.toContain("#+filetags:");
  // The body is already Org and is carried across as it stands, links and all
  // -- rewriting prose is not the exporter's business.
  expect(post).toContain("* A section");
  expect(post).toContain("[[denote:20240125T164237][link]]");
});

test("a draft says so in the word Hugo reads", () => {
  const note = "#+title:      Half done\n#+draft:      true\n\nNot ready.\n";
  const post = toPost(note, { categories: [], draft: true });
  expect(post).toContain("#+draft:  true");
  expect(post).toContain("Not ready.");
});

test("a note with no categories gets no categories line", () => {
  const post = toPost("#+title:      Bare\n\nBody.\n", {
    categories: [],
    draft: false,
  });
  expect(post).not.toContain("#+categories:");
  expect(post).toContain("#+title:  Bare");
});
