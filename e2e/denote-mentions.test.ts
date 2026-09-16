import { expect, gotoSilverBulletPage, test } from "./fixtures.ts";

// Backlinks the way org-roam shows them: the page, the outline path the link
// sits under, and the paragraph around it -- plus the pages that say the
// title without linking it, and a button that makes the link.
const org = (id: string, title: string, body: string) =>
  `#+title:      ${title}\n#+date:       [2025-01-20 Mon 10:00]\n#+filetags:   :character:\n#+identifier: ${id}\n\n${body}`;
const CHERISE = "20250101T100000--cherise-green__character.org";
const DAY = "journal/20250120T090000--monday-20-january-2025__character.org";
const PLAIN = "20250102T100000--site-notes__character.org";

test.describe("Linked mentions with context", () => {
  test.use({
    spaceFiles: {
      "index.md": "# Denote\n",
      [CHERISE]: org("20250101T100000", "Cherise Green", "Runs the clinic.\n"),
      [DAY]: org(
        "20250120T090000",
        "Monday 20 January 2025",
        "* Morning\nCoffee.\n\n* Site visit\n** With the clinic\nWalked the block with [[denote:20250101T100000][Cherise]] and\ntalked about the vending program.\nShe wants a map.\n\nLater, lunch.\n",
      ),
      [PLAIN]: org(
        "20250102T100000",
        "Site notes",
        "Notes from the walk.\n\n- Cherise Green said the corner lot is city-owned. Nothing links her here.\n",
      ),
    },
  });

  test("a backlink shows its outline path and paragraph; a plain mention can be linked", async ({
    sbPage,
    sbServer,
  }) => {
    await gotoSilverBulletPage(sbPage, sbServer, CHERISE);
    const panel = sbPage.locator(
      '.sb-page-widget[data-view="std.linkedMentions"]',
    );
    await expect(panel).toBeVisible({ timeout: 30_000 });
    // The outline path above the link, innermost last.
    await expect(panel).toContainText("Site visit › With the clinic", {
      timeout: 30_000,
    });
    // The whole paragraph, not the one line the link is on.
    await expect(panel).toContainText("talked about the vending program");
    await expect(panel).toContainText("She wants a map");
    await expect(panel).not.toContainText("Coffee");

    // The unlinked mention, with its page and an excerpt.
    await expect(panel).toContainText("Unlinked mentions");
    await expect(panel).toContainText("Site notes");
    await expect(panel).toContainText("corner lot is city-owned");

    // Linking it, from the picker, rewrites that page; it then moves to the
    // linked list.
    await sbPage.evaluate(() => {
      void (globalThis as any).sbRuntime.evalLuaScript(
        `editor.invokeCommand("Denote: Link Mentions")`,
      );
    });
    const filter = sbPage
      .locator(".sb-modal-box input, .sb-modal input")
      .first();
    await expect(filter).toBeVisible({ timeout: 20_000 });
    await expect(sbPage.locator(".sb-result-list")).toContainText("Site notes");
    await filter.press("Enter");
    await sbPage.waitForTimeout(1000);
    await sbPage.keyboard.press("Escape");
    await expect(panel).not.toContainText("Unlinked mentions", {
      timeout: 30_000,
    });
    await expect(panel).toContainText("Site notes");
    const text = await (
      await fetch(`${sbServer.url}/.fs/${encodeURI(PLAIN)}`, {
        headers: { "X-Sync-Mode": "true" },
      })
    ).text();
    expect(text).toContain("[[denote:20250101T100000][Cherise Green]] said");
  });
});
