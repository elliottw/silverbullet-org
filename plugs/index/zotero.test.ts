import { expect, test } from "vitest";
import { stripTemplateResidue } from "./zotero.ts";

// The old template opened a reference note with a citation of the work the
// note is about and a link to its file. Both are facts about the item, so
// they moved into the front matter -- but a note's own body is the thing the
// note is for, and the pass that clears the residue must not touch it.
test("stripTemplateResidue clears the template's lines and nothing else", () => {
  const note = [
    "#+title:      AMRG",
    "#+identifier: 20250203T120134",
    "#+reference:  AMRGOpsManual",
    "",
    "[cite:@AMRGOpsManual]",
    "[[zotero:T6ZDEHXQ][ops-manual.pdf]]",
    "",
    "** sign off sheets",
    "Litter, knots, semi tech.",
    "Compare [cite:@brown2007moral] on the same point.",
    "",
  ].join("\n");

  const out = stripTemplateResidue(note, "AMRGOpsManual");

  // Its own citation and its own file link are gone from the body.
  expect(out).not.toContain("[cite:@AMRGOpsManual]");
  expect(out).not.toMatch(/^\[\[zotero:T6ZDEHXQ\]/m);
  // The file moved up, below what identifies the note.
  expect(out).toMatch(
    /^#\+file:\s+\[\[zotero:T6ZDEHXQ\]\[ops-manual\.pdf\]\]$/m,
  );
  // Everything the author wrote survives, including a citation of another work.
  expect(out).toContain("** sign off sheets");
  expect(out).toContain("Litter, knots, semi tech.");
  expect(out).toContain("[cite:@brown2007moral]");
});

test("stripTemplateResidue leaves a note that has no residue alone", () => {
  const note = [
    "#+title:      Already clean",
    "#+identifier: 20260101T000000",
    "#+reference:  smith2020",
    "",
    "Only my own words here.",
    "",
  ].join("\n");
  expect(stripTemplateResidue(note, "smith2020")).toContain(
    "Only my own words here.",
  );
  expect(stripTemplateResidue(note, "smith2020")).not.toContain("#+file:");
});
