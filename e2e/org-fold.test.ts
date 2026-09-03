import { expect, gotoSilverBulletPage, test } from "./fixtures.ts";

const NOTE = `#+title:      Fold test
#+identifier: 20260101T000000

* Alpha
alpha body
** Alpha one
alpha one body
** Alpha two
alpha two body
* Beta
beta body
`;

/** What the editor actually shows; folded text is absent from the DOM. */
async function visible(page: any): Promise<string> {
  return await page.locator("#sb-editor .cm-content").innerText();
}

async function cursorOn(page: any, needle: string) {
  await page.evaluate(
    (text: string) =>
      (globalThis as any).sbRuntime.evalLuaScript(`
        local body = editor.getText()
        local pos = string.find(body, "${text}", 1, true)
        editor.moveCursor(pos + 1)
      `),
    needle,
  );
  await page.waitForTimeout(300);
}

async function tab(page: any, shift = false) {
  await page.keyboard.press(shift ? "Shift+Tab" : "Tab");
  await page.waitForTimeout(500);
}

test.describe("Org TAB folding", () => {
  test.use({ spaceFiles: { "index.md": "# Index\n", "Fold.org": NOTE } });

  test("TAB on a headline cycles folded, children, subtree", async ({
    sbPage,
    sbServer,
  }) => {
    await gotoSilverBulletPage(sbPage, sbServer, "Fold.org");
    await expect(sbPage.locator("#sb-editor .cm-content")).toContainText(
      "alpha body",
    );
    await cursorOn(sbPage, "* Alpha");

    // FOLDED: the whole subtree disappears, later headlines stay.
    await tab(sbPage);
    let text = await visible(sbPage);
    expect(text).not.toContain("alpha body");
    expect(text).not.toContain("Alpha one");
    expect(text).toContain("Beta");

    // CHILDREN: child headlines are back, their bodies are not.
    await tab(sbPage);
    text = await visible(sbPage);
    expect(text).toContain("Alpha one");
    expect(text).toContain("Alpha two");
    expect(text).not.toContain("alpha one body");

    // SUBTREE: everything.
    await tab(sbPage);
    text = await visible(sbPage);
    expect(text).toContain("alpha one body");
    expect(text).toContain("alpha two body");

    // And back round to folded.
    await tab(sbPage);
    expect(await visible(sbPage)).not.toContain("Alpha one");
  });

  test("Shift-TAB cycles the whole document", async ({ sbPage, sbServer }) => {
    await gotoSilverBulletPage(sbPage, sbServer, "Fold.org");
    await cursorOn(sbPage, "beta body");

    // OVERVIEW: top-level headlines only.
    await tab(sbPage, true);
    let text = await visible(sbPage);
    expect(text).toContain("Alpha");
    expect(text).toContain("Beta");
    expect(text).not.toContain("alpha body");
    expect(text).not.toContain("Alpha one");

    // CONTENTS: every headline, no bodies.
    await tab(sbPage, true);
    text = await visible(sbPage);
    expect(text).toContain("Alpha one");
    expect(text).toContain("Alpha two");
    expect(text).not.toContain("alpha one body");

    // SHOW ALL.
    await tab(sbPage, true);
    text = await visible(sbPage);
    expect(text).toContain("alpha one body");
    expect(text).toContain("beta body");
  });

  test("TAB still indents when the cursor is not on something foldable", async ({
    sbPage,
    sbServer,
  }) => {
    await gotoSilverBulletPage(sbPage, sbServer, "Fold.org");
    await cursorOn(sbPage, "alpha body");
    await sbPage.keyboard.press("End");
    await sbPage.keyboard.press("Enter");
    await sbPage.keyboard.type("plain");
    await sbPage.keyboard.press("Home");
    await tab(sbPage);
    const saved = await sbPage.evaluate(() =>
      (globalThis as any).sbRuntime.evalLuaScript("return editor.getText()"),
    );
    // TAB inserted indentation rather than folding anything.
    expect(saved).toMatch(/\n\s+plain/);
  });
});
