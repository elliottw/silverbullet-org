import { renameSync } from "node:fs";
import { join } from "node:path";
import { expect, gotoSilverBulletPage, test } from "./fixtures.ts";
import { currentPage } from "./navigator-ui.ts";

// A Denote link addresses an identifier, so a note renamed outside the
// editor -- in Emacs, arriving by sync -- must still be found by it: the
// client's page list has to learn the new name without a reload.
const org = (id: string, title: string) =>
  `#+title:      ${title}\n#+identifier: ${id}\n\nBody.\n`;
const HUB = "20250101T100000--hub.org";
const NOTE = "20250102T100000--calisthenics-routine.org";
const RENAMED = "20250102T100000==41=04--calisthenics-routine.org";

test.describe("A note renamed on disk", () => {
  test.use({
    spaceFiles: {
      "index.md": "# x\n",
      [HUB]:
        org("20250101T100000", "hub") +
        "See [[denote:20250102T100000][calisthenics]].\n",
      [NOTE]: org("20250102T100000", "calisthenics routine"),
    },
  });

  test("keeps resolving by identifier from an open page", async ({
    sbPage,
    sbServer,
  }) => {
    await gotoSilverBulletPage(sbPage, sbServer, HUB);
    const link = sbPage.locator("#sb-editor .cm-content a.sb-denote-link", {
      hasText: "calisthenics",
    });
    await expect(link).not.toHaveClass(/page-missing/, { timeout: 20_000 });

    // Emacs gives the note a signature: same identifier, new file name.
    renameSync(join(sbServer.spaceDir, NOTE), join(sbServer.spaceDir, RENAMED));
    await expect
      .poll(
        () =>
          sbPage.evaluate(() =>
            (globalThis as any).client.ui.viewState.allPages
              .map((p: any) => p.name)
              .filter(
                (n: string) => n.includes("calisthenics") && n.endsWith(".org"),
              ),
          ),
        { timeout: 30_000 },
      )
      .toEqual([RENAMED]);
    await expect(link).not.toHaveClass(/page-missing/);
    await link.click();
    await expect(currentPage(sbPage)).toHaveValue(RENAMED, { timeout: 20_000 });
  });
});
