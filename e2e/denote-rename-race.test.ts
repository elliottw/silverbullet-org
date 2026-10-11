import { readdirSync } from "node:fs";
import { expect, gotoSilverBulletPage, test } from "./fixtures.ts";
import { currentPage } from "./navigator-ui.ts";

// Renaming on every save means renaming mid-word, and the rename of a title
// typed a moment ago races the typing that follows it: the editor saves
// pending changes under the name it still thinks it is on, which is the name
// the rename has just deleted. That left one note in two files under one
// identifier -- the one thing an identifier cannot allow.

const TYPED = "20260101T000000--acorn.org";
const DUPE_STALE = "20260202T000000--acorn-med.org";
const DUPE_KEPT = "20260202T000000--acorn-medic.org";

const org = (id: string, title: string, body: string) =>
  `#+title:      ${title}\n#+identifier: ${id}\n\n${body}\n`;

/** Every file in the space carrying this identifier. */
function filesFor(spaceDir: string, identifier: string): string[] {
  return readdirSync(spaceDir)
    .filter((name) => name.startsWith(identifier) && !name.endsWith("~"))
    .sort();
}

/** Replaces the whole note, as typing it does, and saves. */
async function type(page: any, text: string) {
  await page.evaluate(
    (t: string) =>
      (globalThis as any).sbRuntime.evalLuaScript(
        `editor.setText([==[\n${t}]==]) editor.save()`,
      ),
    text,
  );
}

test.describe("Rename from front matter while typing", () => {
  test.use({
    spaceFiles: {
      "index.md": "# x\n",
      [TYPED]: org("20260101T000000", "acorn", "Body."),
      [DUPE_STALE]: org("20260202T000000", "Acorn Medic", "The later text."),
      [DUPE_KEPT]: org("20260202T000000", "Acorn Medic", "The earlier text."),
    },
  });

  test("the file name waits for the typing to stop", async ({
    sbPage,
    sbServer,
  }) => {
    await gotoSilverBulletPage(sbPage, sbServer, TYPED);
    await expect(sbPage.locator("#sb-editor .cm-content")).toContainText(
      "Body.",
      { timeout: 20_000 },
    );

    // A title half typed, and saved -- SilverBullet saves a second after the
    // last keystroke, so this is what every pause mid-title looks like.
    await type(sbPage, org("20260101T000000", "Acorn Med", "Body."));
    await sbPage.waitForTimeout(1200);
    expect(filesFor(sbServer.spaceDir, "20260101T000000")).toEqual([TYPED]);

    // The rest of the title, within the quiet period.
    await type(sbPage, org("20260101T000000", "Acorn Medic", "Body."));
    await expect
      .poll(() => filesFor(sbServer.spaceDir, "20260101T000000"), {
        timeout: 20_000,
      })
      .toEqual(["20260101T000000--acorn-medic.org"]);
    // One rename, to the finished title: the half-typed name never existed.
    await expect(currentPage(sbPage)).toHaveValue(
      "20260101T000000--acorn-medic.org",
      { timeout: 20_000 },
    );
  });

  test("a note already in two files is folded back into one", async ({
    sbPage,
    sbServer,
  }) => {
    // What the race used to leave behind: the same note under two names, the
    // stale one holding the newer text. Renaming it finds its proper name
    // taken by itself, which is a fold rather than a failure.
    await gotoSilverBulletPage(sbPage, sbServer, DUPE_STALE);
    await expect(sbPage.locator("#sb-editor .cm-content")).toContainText(
      "The later text.",
      { timeout: 20_000 },
    );
    await sbPage.evaluate(() => {
      void (globalThis as any).sbRuntime.evalLuaScript(
        `editor.invokeCommand("Denote: Rename File from Front Matter")`,
      );
    });
    await expect
      .poll(() => filesFor(sbServer.spaceDir, "20260202T000000"), {
        timeout: 20_000,
      })
      .toEqual([DUPE_KEPT]);
    // The newer text is the one kept, and the editor is on the surviving file.
    await expect(sbPage.locator("#sb-editor .cm-content")).toContainText(
      "The later text.",
    );
    await expect(currentPage(sbPage)).toHaveValue(DUPE_KEPT, {
      timeout: 20_000,
    });
    await expect(sbPage.locator(".sb-notification-error")).toHaveCount(0);
  });
});
