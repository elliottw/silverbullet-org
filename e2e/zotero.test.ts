import { expect, gotoSilverBulletPage, test } from "./fixtures.ts";

// A Better BibTeX export, as written: braces, escapes, storage paths.
const BIB = String.raw`
@book{graham2004hackers,
  title = {Hackers \& Painters},
  author = {Graham, Paul},
  year = {2004},
  keywords = {essays},
  file = {/Users/elliott/Zotero/storage/PSKBJDH2/hackers-and-painters.pdf}
}

@article{brown2007moral,
  title = {Moral Capital},
  author = {Brown, Christopher Leslie},
  year = {2007},
  journal = {Some Journal}
}
`;

const NOTE = `#+title:      Reading
#+identifier: 20260914T120000

Start with [cite:@graham2004hackers], then [cite:see @brown2007moral p. 3].
And the file itself: [[zotero:PSKBJDH2]] or [[zotero:PSKBJDH2][the PDF]].
`;

const REFERENCE = `#+title:      Hackers and Painters
#+identifier: 20260914T130000
#+reference:  graham2004hackers
#+filetags:   :bib:

Notes on the book.
`;

test.describe("Zotero", () => {
  test.use({
    spaceFiles: {
      "index.md": "# Home\n",
      "zotero.bib": BIB,
      "CONFIG.md":
        '```space-lua\nconfig.set("zotero", { username = "elliottwilliams" })\n```\n',
      "Reading.org": NOTE,
      "20260914T130000--hackers-and-painters__bib.org": REFERENCE,
    },
  });

  const lua = (page: any, s: string) =>
    page.evaluate(
      (s: string) => (globalThis as any).sbRuntime.evalLuaScript(s),
      s,
    );

  test("a citation reads as author and year, and links to zotero.org", async ({
    sbPage,
    sbServer,
  }) => {
    await gotoSilverBulletPage(sbPage, sbServer, "Reading.org");
    const editor = sbPage.locator("#sb-editor .cm-content");
    await expect(editor).toContainText("Graham 2004", { timeout: 20_000 });
    await expect(editor).toContainText("Brown 2007");
    await expect(editor).not.toContainText("[cite:");

    const cite = editor.locator("a.sb-zotero-citation").first();
    await expect(cite).toHaveAttribute(
      "href",
      "https://www.zotero.org/elliottwilliams/items/PSKBJDH2",
    );
    // No file for Brown: the desktop app is the only place it can open.
    await expect(editor.locator("a.sb-zotero-citation").nth(1)).toHaveAttribute(
      "href",
      "zotero://select/items/@brown2007moral",
    );
  });

  test("a bare zotero: link reads as the item's title; a described one keeps its text", async ({
    sbPage,
    sbServer,
  }) => {
    await gotoSilverBulletPage(sbPage, sbServer, "Reading.org");
    const editor = sbPage.locator("#sb-editor .cm-content");
    await expect(editor).toContainText("Hackers & Painters", {
      timeout: 20_000,
    });
    await expect(editor).toContainText("the PDF");
    await expect(editor).not.toContainText("zotero:PSKBJDH2");
  });

  test("the bibliography is indexed, and citations and references are relations", async ({
    sbPage,
    sbServer,
  }) => {
    await gotoSilverBulletPage(sbPage, sbServer, "Reading.org");
    await sbPage.waitForTimeout(3000);
    await expect
      .poll(
        () =>
          lua(
            sbPage,
            "return #query[[from z = index.tag('zotero') select z.citekey]]",
          ),
        { timeout: 30_000 },
      )
      .toEqual(2);
    const graham = await lua(
      sbPage,
      "return (query[[from z = index.tag('zotero') where z.citekey == 'graham2004hackers' select z]])[1]",
    );
    expect(graham.title).toEqual("Hackers & Painters");
    expect(graham.short).toEqual("Graham 2004");
    expect(graham.attachments).toEqual(["PSKBJDH2"]);

    // Two `[cite:]` keys plus two `[[zotero:…]]` links cite Graham: 3 for
    // Graham (one cite + two links), 1 for Brown.
    await expect
      .poll(
        () =>
          lua(
            sbPage,
            "return #query[[from r = index.tag('relation') where r.kind == 'citation' and r.to == 'graham2004hackers' select r.ref]]",
          ),
        { timeout: 30_000 },
      )
      .toEqual(3);
    // The reference note points at its item.
    expect(
      await lua(
        sbPage,
        "return (query[[from r = index.tag('relation') where r.kind == 'reference' select r.from]])[1]",
      ),
    ).toEqual("20260914T130000--hackers-and-painters__bib.org");
  });

  test("Zotero: New Reference Note writes a citar-denote note", async ({
    sbPage,
    sbServer,
  }) => {
    await gotoSilverBulletPage(sbPage, sbServer, "Reading.org");
    await sbPage.waitForTimeout(2000);
    await sbPage.evaluate(() => {
      void (globalThis as any).sbRuntime.evalLuaScript(
        'editor.invokeCommand("Zotero: New Reference Note")',
      );
    });
    const filter = sbPage
      .locator(".sb-modal-box input, .sb-modal input")
      .first();
    await expect(filter).toBeVisible({ timeout: 20_000 });
    await filter.fill("Moral");
    await expect(
      sbPage.locator(".sb-result-list .sb-name").first(),
    ).toContainText("Moral Capital", { timeout: 10_000 });
    await filter.press("Enter");

    await expect(sbPage.locator("#sb-current-page input.sb-input")).toHaveValue(
      /^\d{8}T\d{6}--moral-capital__bib\.org$/,
      { timeout: 20_000 },
    );
    const text: string = await lua(sbPage, "return editor.getText()");
    expect(text).toMatch(/^#\+reference:\s+brown2007moral$/m);
    expect(text).toContain("#+filetags:   :bib:");
    expect(text).toContain("[cite:@brown2007moral]");
  });
});
