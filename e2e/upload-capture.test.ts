import { expect, gotoSilverBulletPage, test } from "./fixtures.ts";

// A photo or a scan has to land in the note it was taken for -- as an Org
// link on an Org page, and beside the note rather than in the reference
// library, whatever its file type.
const ORG = `#+title:      Receipts
#+identifier: 20261026T150000

Before.
`;

test.describe("Taking a photo and scanning into a note", () => {
  test.use({
    spaceFiles: {
      "index.md": "# Home\n",
      "20261026T150000--receipts.org": ORG,
      "Notes.md": "# Notes\n\nBefore.\n",
    },
  });

  /** What the command asks the OS for, which is the whole phone story. */
  const commandDef = (page: any, name: string) =>
    page.evaluate((commandName: string) => {
      const cmd =
        (globalThis as any).client.clientSystem.commandHook
          .buildAllCommands()
          .get(commandName) ??
        (globalThis as any).client.ui.viewState.commands.get(commandName);
      const def = cmd?.command ?? cmd;
      return def
        ? {
            accept: def.accept,
            capture: def.capture,
            keepLocal: def.keepLocal,
          }
        : null;
    }, name);

  test("the camera command asks for the camera, the scan command does not", async ({
    sbPage,
    sbServer,
  }) => {
    await gotoSilverBulletPage(
      sbPage,
      sbServer,
      "20261026T150000--receipts.org",
    );
    await expect(sbPage.locator("#sb-editor .cm-content")).toContainText(
      "Before.",
      { timeout: 20_000 },
    );
    // `capture` is what turns a file input into a viewfinder on a phone.
    expect(await commandDef(sbPage, "Upload: Take Photo")).toEqual({
      accept: "image/*",
      capture: "environment",
      keepLocal: true,
    });
    // The scan deliberately has no `capture`, so the picker offers Files --
    // where iOS keeps Scan Documents.
    expect(await commandDef(sbPage, "Upload: Scan Document")).toEqual({
      accept: "image/*,application/pdf",
      capture: undefined,
      keepLocal: true,
    });
  });

  test("an image saved into an Org page is linked as Org, not Markdown", async ({
    sbPage,
    sbServer,
  }) => {
    await gotoSilverBulletPage(
      sbPage,
      sbServer,
      "20261026T150000--receipts.org",
    );
    await expect(sbPage.locator("#sb-editor .cm-content")).toContainText(
      "Before.",
      { timeout: 20_000 },
    );
    await sbPage.evaluate(() => {
      void (globalThis as any).sbRuntime.evalLuaScript(`
        editor.moveCursor(string.len(editor.getText()))
      `);
    });
    // Drive saveFile directly: the picker itself is the OS's, not ours.
    await sbPage.evaluate(() =>
      (globalThis as any).client.clientSystem.system.invokeFunction(
        "editor.saveUploadedFile",
        [
          {
            name: "receipt.png",
            contentType: "image/png",
            content: new Uint8Array([137, 80, 78, 71]),
          },
        ],
      ),
    );
    await expect
      .poll(
        () =>
          sbPage.evaluate(() =>
            (globalThis as any).sbRuntime.evalLuaScript(
              "return editor.getText()",
            ),
          ),
        { timeout: 20_000 },
      )
      // `![[…]]` is Markdown transclusion, which Org cannot draw.
      .toMatch(/\[\[file:[^\]]*receipt\.png\]\]/);
  });

  test("a Markdown page still gets Markdown", async ({ sbPage, sbServer }) => {
    await gotoSilverBulletPage(sbPage, sbServer, "Notes.md");
    await expect(sbPage.locator("#sb-editor .cm-content")).toContainText(
      "Before.",
      { timeout: 20_000 },
    );
    await sbPage.evaluate(() => {
      void (globalThis as any).sbRuntime.evalLuaScript(`
        editor.moveCursor(string.len(editor.getText()))
      `);
    });
    await sbPage.evaluate(() =>
      (globalThis as any).client.clientSystem.system.invokeFunction(
        "editor.saveUploadedFile",
        [
          {
            name: "shot.png",
            contentType: "image/png",
            content: new Uint8Array([137, 80, 78, 71]),
          },
        ],
      ),
    );
    await expect
      .poll(
        () =>
          sbPage.evaluate(() =>
            (globalThis as any).sbRuntime.evalLuaScript(
              "return editor.getText()",
            ),
          ),
        { timeout: 20_000 },
      )
      .toMatch(/!\[\[[^\]]*shot\.png\]\]/);
  });
});
