import { expect, gotoSilverBulletPage, test } from "./fixtures.ts";

// A file is a candidate only when no note mentions it -- and "mentions"
// deliberately means anywhere in the text, not only inside link syntax,
// because the cost of being wrong is a deleted file.
const note = (id: string, title: string, body: string) =>
  `#+title:      ${title}\n#+identifier: ${id}\n\n${body}\n`;

test.describe("Unlinked files", () => {
  test.use({
    spaceFiles: {
      "index.md": "# Home\n",
      "20261110T100000--uses-things.org": note(
        "20261110T100000",
        "Uses things",
        "Inline: [[file:kept-inline.png]]\n" +
          "Linked: [[file:kept-linked.pdf]]\n" +
          "Mentioned without a link: orphan-by-mention.pdf is on my desk.\n",
      ),
      "kept-inline.png": "PNG",
      "kept-linked.pdf": "%PDF linked",
      "orphan-by-mention.pdf": "%PDF mentioned",
      // Nothing refers to these two.
      "truly-orphan.pdf": "%PDF nobody wants",
      "truly-orphan.png": "PNG nobody wants",
      // Generated or reserved: never candidates.
      "zotero.bib": "@book{x, title = {Y}}\n",
    },
  });

  const unlinked = (page: any, includeImages: boolean) =>
    page.evaluate(
      (withImages: boolean) =>
        (globalThis as any).client.clientSystem.system.invokeFunction(
          "index.orphans",
          [withImages],
        ),
      includeImages,
    );

  test("a file mentioned in prose is not unlinked", async ({
    sbPage,
    sbServer,
  }) => {
    await gotoSilverBulletPage(sbPage, sbServer, "index");
    await sbPage.waitForTimeout(3500);

    const docs = await unlinked(sbPage, false);
    const paths = (docs as any[]).map((d) => d.path).sort();
    // Only the one nothing says anything about.
    expect(paths).toEqual(["truly-orphan.pdf"]);
    // Named in a sentence without a link: still referenced.
    expect(paths).not.toContain("orphan-by-mention.pdf");
    // Generated, so never a candidate.
    expect(paths).not.toContain("zotero.bib");
  });

  test("images are opt-in, and come with their own", async ({
    sbPage,
    sbServer,
  }) => {
    await gotoSilverBulletPage(sbPage, sbServer, "index");
    await sbPage.waitForTimeout(3500);
    const withImages = (await unlinked(sbPage, true)) as any[];
    const paths = withImages.map((d) => d.path).sort();
    expect(paths).toEqual(["truly-orphan.pdf", "truly-orphan.png"]);
    // An image shown inline by a note is kept.
    expect(paths).not.toContain("kept-inline.png");
    // Largest first, so the report leads with what matters.
    expect(withImages[0].size).toBeGreaterThanOrEqual(withImages[1].size);
  });
});
