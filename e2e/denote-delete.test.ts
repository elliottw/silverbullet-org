import { expect, gotoSilverBulletPage, test } from "./fixtures.ts";

// Deleting a note that is linked to is the one deletion that cannot be
// undone by renaming: a `denote:` link finds its note by identifier.
const org = (id: string, title: string, body = "") =>
  `#+title:      ${title}\n#+identifier: ${id}\n\n${body}`;
const TARGET = "20250101T100000--the-target.org";
const LINKER = "20250101T100001--one-that-links.org";
const OTHER = "20250101T100002--another-that-links.org";
const LONELY = "20250101T100003--nothing-links-here.org";

test.describe("Deleting a linked note", () => {
  test.use({
    spaceFiles: {
      "index.md": "# x\n",
      [TARGET]: org("20250101T100000", "The Target", "Body.\n"),
      [LINKER]: org(
        "20250101T100001",
        "One that links",
        "See [[denote:20250101T100000][the target]] and again [[denote:20250101T100000][here]].\n",
      ),
      [OTHER]: org(
        "20250101T100002",
        "Another that links",
        "Also [[denote:20250101T100000][the target]].\n",
      ),
      [LONELY]: org("20250101T100003", "Nothing links here", "Body.\n"),
    },
  });

  test("says how many links break and where, before asking", async ({
    sbPage,
    sbServer,
  }) => {
    await gotoSilverBulletPage(sbPage, sbServer, TARGET);
    await expect(sbPage.locator("#sb-editor .cm-content")).toContainText(
      "Body.",
      { timeout: 20_000 },
    );
    // Let the index catch up with the links.
    await sbPage.waitForTimeout(3000);
    await sbPage.evaluate(() => {
      void (globalThis as any).sbRuntime.evalLuaScript(
        'editor.invokeCommand("Page: Delete")',
      );
    });
    const dialog = sbPage.locator(".sb-prompt");
    await expect(dialog).toBeVisible({ timeout: 20_000 });
    await expect(dialog).toContainText("3 links point here, from 2 notes");
    await expect(dialog).toContainText("One that links (2 links)");
    await expect(dialog).toContainText("Another that links");
    await expect(dialog).toContainText("They will break");
    // Escape means no, and the note is still there.
    await sbPage.keyboard.press("Escape");
    await sbPage.waitForTimeout(1000);
    const listing = await (
      await fetch(`${sbServer.url}/.fs/`, { headers: { "X-Sync-Mode": "true" } })
    ).text();
    expect(listing).toContain("the-target.org");
  });

  test("says so plainly when nothing links to it", async ({
    sbPage,
    sbServer,
  }) => {
    await gotoSilverBulletPage(sbPage, sbServer, LONELY);
    await expect(sbPage.locator("#sb-editor .cm-content")).toContainText(
      "Body.",
      { timeout: 20_000 },
    );
    await sbPage.waitForTimeout(3000);
    await sbPage.evaluate(() => {
      void (globalThis as any).sbRuntime.evalLuaScript(
        'editor.invokeCommand("Page: Delete")',
      );
    });
    const dialog = sbPage.locator(".sb-prompt");
    await expect(dialog).toBeVisible({ timeout: 20_000 });
    await expect(dialog).toContainText("Nothing links here.");
    await sbPage.keyboard.press("Escape");
  });
});
