import { expect, gotoSilverBulletPage, test } from "./fixtures.ts";

const PAGE = `# Alpha

alpha body one
alpha body two

# Beta

* parent item
  * child one

Final line.
`;

const FAT_CURSOR = ".cm-fat-cursor.cm-cursor-primary";

async function enableVim(page: any) {
  await page.evaluate(() =>
    (globalThis as any).sbRuntime.evalLuaScript(
      'editor.invokeCommand("Editor: Toggle Vim Mode")',
    ),
  );
  await expect(page.locator(".cm-vim-panel")).toHaveCount(1, {
    timeout: 10_000,
  });
}

/** How the block cursor is actually painted, not merely whether it exists. */
async function cursorPaint(page: any) {
  return await page.evaluate((sel: string) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const cs = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    const transparent = (c: string) =>
      c === "transparent" || /rgba\(\s*0,\s*0,\s*0,\s*0\s*\)/.test(c);
    return {
      sized: rect.width > 0 && rect.height > 0,
      filled: !transparent(cs.backgroundColor),
      outlined: cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) > 0,
    };
  }, FAT_CURSOR);
}

test.describe("Vim block cursor", () => {
  test.use({ spaceFiles: { "index.md": PAGE } });

  test("stays visible while moving through the document", async ({
    sbPage,
    sbServer,
  }) => {
    await gotoSilverBulletPage(sbPage, sbServer, "index");
    await enableVim(sbPage);
    await sbPage.locator("#sb-editor .cm-content").click();
    await sbPage.evaluate(() =>
      (globalThis as any).sbRuntime.evalLuaScript("editor.moveCursor(0)"),
    );
    await sbPage.waitForTimeout(400);

    for (let i = 0; i < PAGE.split("\n").length; i++) {
      const paint = await cursorPaint(sbPage);
      expect(paint, `line ${i + 1}`).not.toBeNull();
      expect(paint!.sized, `line ${i + 1} has size`).toBe(true);
      expect(paint!.filled, `line ${i + 1} is painted`).toBe(true);
      await sbPage.keyboard.press("j");
      await sbPage.waitForTimeout(180);
    }
  });

  test("stays visible when the editor loses focus", async ({
    sbPage,
    sbServer,
  }) => {
    await gotoSilverBulletPage(sbPage, sbServer, "index");
    await enableVim(sbPage);
    await sbPage.locator("#sb-editor .cm-content").click();
    await sbPage.waitForTimeout(400);
    expect((await cursorPaint(sbPage))!.filled).toBe(true);

    await sbPage.evaluate(() => {
      (document.activeElement as HTMLElement | null)?.blur();
    });
    await sbPage.waitForTimeout(500);
    expect(
      await sbPage.locator(".cm-editor.cm-focused").count(),
      "editor is blurred",
    ).toBe(0);

    // Unfocused, codemirror-vim draws the block hollow. It must still be
    // drawn *somehow*: a cursor that is present but painted entirely in
    // transparent is the bug this guards.
    const paint = (await cursorPaint(sbPage))!;
    expect(paint.sized).toBe(true);
    expect(paint.filled || paint.outlined, "visible when unfocused").toBe(true);
  });
});
