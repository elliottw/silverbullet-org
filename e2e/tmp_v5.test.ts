import { expect, gotoSilverBulletPage, test } from "./fixtures.ts";

const PAGE = `#+title: Home

* Work
- [[denote:20240125T164237][upmc community paramedic]]
- [[https://example.com][an external one]]
- plain item with no link
`;

test.use({ spaceFiles: { "index.md": "# Home\n", "Home.org": PAGE } });

async function enableVim(page: any) {
  await page.evaluate(() =>
    (globalThis as any).sbRuntime.evalLuaScript(
      'editor.invokeCommand("Editor: Toggle Vim Mode")',
    ),
  );
  await expect(page.locator(".cm-vim-panel")).toHaveCount(1, { timeout: 10_000 });
}

for (const lead of ["- [[denote:", "- [[https://"]) {
  test(`bullet, cursor at line start, A: ${lead}`, async ({ sbPage, sbServer }) => {
    await gotoSilverBulletPage(sbPage, sbServer, "Home.org");
    await expect(sbPage.locator("#sb-editor .cm-content")).toContainText("upmc");
    await enableVim(sbPage);

    const read = () =>
      sbPage.evaluate(() =>
        (globalThis as any).sbRuntime.evalLuaScript("return editor.getText()"),
      );
    const text: string = await read();
    const lineStart = text.indexOf(lead);

    // Cursor at the very beginning of the line, as reported.
    await sbPage.evaluate(
      (p: number) =>
        (globalThis as any).sbRuntime.evalLuaScript(`editor.moveCursor(${p})`),
      lineStart,
    );
    await sbPage.waitForTimeout(400);
    await sbPage.keyboard.press("Escape");
    await sbPage.waitForTimeout(300);
    const at = await sbPage.evaluate(() =>
      (globalThis as any).sbRuntime.evalLuaScript("return editor.getCursor()"),
    );
    await sbPage.keyboard.press("Shift+A");
    await sbPage.waitForTimeout(300);
    const afterA = await sbPage.evaluate(() =>
      (globalThis as any).sbRuntime.evalLuaScript("return editor.getCursor()"),
    );
    await sbPage.keyboard.type("XX");
    await sbPage.waitForTimeout(500);
    const line = (await read()).split("\n").find((l) => l.startsWith(lead));
    const bad = line?.includes("XX]]");
    console.log(
      `${lead}: cursor=${at} afterA=${afterA} ${bad ? "REPRODUCED" : "ok"}\n  => ${JSON.stringify(line)}`,
    );
    expect(true).toBe(true);
  });
}
