import { expect, gotoSilverBulletPage, test } from "./fixtures.ts";

const NOTE = `#+title:      Outline test
#+identifier: 20260101T000000

* Alpha
- one
- two
- three
`;

/** The document text, not the rendered view: live preview replaces bullets. */
async function bodyOf(page: any): Promise<string> {
  return await page.evaluate(() =>
    (globalThis as any).sbRuntime.evalLuaScript("return editor.getText()"),
  );
}

// A real Mac composes a character from Option+letter: ⌥J arrives as "∆" with
// code "KeyJ". Playwright's `keyboard.press("Alt+j")` sends key "j", which no
// Mac ever produces — so pressing these through CDP with the composed
// character is the only way this test means anything.
const optionChars: Record<string, string> = {
  KeyH: "\u02D9",
  KeyJ: "\u2206",
  KeyK: "\u02DA",
  KeyL: "\u00AC",
};

async function pressOption(page: any, code: string) {
  const cdp = await page.context().newCDPSession(page);
  const shared = {
    key: optionChars[code],
    code,
    windowsVirtualKeyCode: code.charCodeAt(3),
    nativeVirtualKeyCode: code.charCodeAt(3),
    modifiers: 1, // Alt
  };
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    text: optionChars[code],
    ...shared,
  });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...shared });
  await cdp.detach();
  await page.waitForTimeout(500);
}

/** Puts the cursor at the start of the line containing `needle`. */
async function cursorOnLine(page: any, needle: string) {
  await page.evaluate(
    (text: string) =>
      (globalThis as any).sbRuntime.evalLuaScript(`
        local body = editor.getText()
        local pos = string.find(body, "${text}", 1, true)
        editor.moveCursor(pos + 2)
      `),
    needle,
  );
  await page.waitForTimeout(300);
}

test.describe("Org outline ergonomics", () => {
  test.use({
    spaceFiles: { "index.md": "# Index\n", "Outline.org": NOTE },
  });

  // evil-org's `additional` key theme binds M-h/j/k/l to outdent, move down,
  // move up and indent. These are the same commands SilverBullet already had;
  // they only ever parsed the page as Markdown.
  test("Alt-j and Alt-k move a list item down and up", async ({
    sbPage,
    sbServer,
  }) => {
    await gotoSilverBulletPage(sbPage, sbServer, "Outline.org");
    await expect(sbPage.locator("#sb-editor .cm-content")).toContainText("one");

    await cursorOnLine(sbPage, "- one");
    await pressOption(sbPage, "KeyJ");
    expect(await bodyOf(sbPage)).toContain("- two\n- one\n- three");

    await pressOption(sbPage, "KeyK");
    expect(await bodyOf(sbPage)).toContain("- one\n- two\n- three");
  });

  test("Alt-l and Alt-h indent and outdent a list item", async ({
    sbPage,
    sbServer,
  }) => {
    await gotoSilverBulletPage(sbPage, sbServer, "Outline.org");
    await cursorOnLine(sbPage, "- two");
    await pressOption(sbPage, "KeyL");
    // The nested item renders with a deeper bullet; check the file itself.
    const saved = await sbPage.evaluate(() =>
      (globalThis as any).sbRuntime.evalLuaScript("return editor.getText()"),
    );
    expect(saved).toContain("- one\n  - two\n");

    await pressOption(sbPage, "KeyH");
    const back = await sbPage.evaluate(() =>
      (globalThis as any).sbRuntime.evalLuaScript("return editor.getText()"),
    );
    expect(back).toContain("- one\n- two\n");
  });

  test("Alt-l on a headline adds a star, not a hash", async ({
    sbPage,
    sbServer,
  }) => {
    await gotoSilverBulletPage(sbPage, sbServer, "Outline.org");
    await cursorOnLine(sbPage, "* Alpha");
    await pressOption(sbPage, "KeyL");
    const saved = await sbPage.evaluate(() =>
      (globalThis as any).sbRuntime.evalLuaScript("return editor.getText()"),
    );
    expect(saved).toContain("** Alpha");
    expect(saved).not.toContain("#* Alpha");
  });

  test("the bindings still work in vim mode", async ({ sbPage, sbServer }) => {
    await gotoSilverBulletPage(sbPage, sbServer, "Outline.org");
    await sbPage.evaluate(() =>
      (globalThis as any).sbRuntime.evalLuaScript(
        'editor.invokeCommand("Editor: Toggle Vim Mode")',
      ),
    );
    await expect(sbPage.locator(".cm-vim-panel")).toHaveCount(1, {
      timeout: 10_000,
    });
    await cursorOnLine(sbPage, "- one");
    await pressOption(sbPage, "KeyJ");
    const saved = await sbPage.evaluate(() =>
      (globalThis as any).sbRuntime.evalLuaScript("return editor.getText()"),
    );
    expect(saved).toContain("- two\n- one\n");
  });
});
