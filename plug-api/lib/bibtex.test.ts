import { expect, test } from "vitest";
import { citekeysIn, parseBibtex, shortCitation } from "./bibtex.ts";

// Verbatim from a Better BibTeX export: the shapes it actually writes.
const bib = String.raw`
@book{0051092hackersPaintersbigideasfromthecomgrahampaul,
  title = {005.1092-Hackers-\&-Painters-Big-Ideas-from-the-Com-Graham-Paul.Pdf},
  file = {/Users/elliott/Zotero/storage/PSKBJDH2/005.1092-hackers-&-painters-big-ideas-from-the-com-graham-paul.pdf}
}

@article{brown2007abolitionism,
  title = {01 {{Neena Hagen Denial}}},
  author = {{Pittsburgh Land Bank Task Force} and Brown, Christopher Leslie},
  year = {2007},
  journal = {Some Journal},
  doi = {10.1000/xyz},
  keywords = {hr, race},
  file = {/Users/elliott/Zotero/storage/RPDL64JJ/AFFIDAVIT OF MARRIAGE_DOMESTIC PARTNERSHIP.pdf;/Users/elliott/Zotero/storage/UWSS567G/deck.pptx}
}

@misc{nofile2020,
  title = {No File Here},
  year = 2020,
  urldate = {2020-01-01}
}
`;

test("Entries, fields, and the attachment keys hidden in file paths", () => {
  const entries = parseBibtex(bib);
  expect(entries.map((e) => e.citekey)).toEqual([
    "0051092hackersPaintersbigideasfromthecomgrahampaul",
    "brown2007abolitionism",
    "nofile2020",
  ]);
  const [graham, brown, nofile] = entries;
  // `\&` unescaped, case-protecting braces gone.
  expect(graham.title).toEqual(
    "005.1092-Hackers-&-Painters-Big-Ideas-from-the-Com-Graham-Paul.Pdf",
  );
  expect(graham.attachments).toEqual([
    { key: "PSKBJDH2", name: "005.1092-hackers-&-painters-big-ideas-from-the-com-graham-paul.pdf" },
  ]);
  expect(brown.title).toEqual("01 Neena Hagen Denial");
  expect(brown.authors).toEqual(["Pittsburgh Land Bank Task Force", "Brown, Christopher Leslie"]);
  expect(brown.year).toEqual("2007");
  expect(brown.doi).toEqual("10.1000/xyz");
  expect(brown.keywords).toEqual(["hr", "race"]);
  // Two files, split on `;`, each with its own key.
  expect(brown.attachments.map((a) => a.key)).toEqual(["RPDL64JJ", "UWSS567G"]);
  expect(nofile.attachments).toEqual([]);
  // A bare number is a value too.
  expect(nofile.year).toEqual("2020");
});

test("A short citation is surname and year, falling back to the citekey", () => {
  const [graham, brown, nofile] = parseBibtex(bib);
  expect(shortCitation(brown)).toEqual("Pittsburgh Land Bank Task Force 2007");
  expect(shortCitation(nofile)).toEqual("2020");
  expect(shortCitation(graham)).toEqual(graham.citekey);
});

test("Citekeys are pulled out of an org-cite body whatever surrounds them", () => {
  expect(citekeysIn("@brown2007abolitionism")).toEqual(["brown2007abolitionism"]);
  expect(citekeysIn("see @a;@b p. 3")).toEqual(["a", "b"]);
  expect(citekeysIn("@graham2004hackers:painters")).toEqual(["graham2004hackers:painters"]);
});
