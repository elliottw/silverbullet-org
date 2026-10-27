import { readdirSync } from "node:fs";
import { join } from "node:path";
import { expect, gotoSilverBulletPage, test } from "./fixtures.ts";
import { currentPage } from "./navigator-ui.ts";

// A journal has one entry per day, and a lookup that misses does not degrade
// gracefully -- it writes a second entry and splits the day in two. The
// lookup therefore cannot depend on the object index, which is still being
// built on a cold start and lags a sync that brought an entry from another
// device.

const stamp = () => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
};

/** Today's journal files on disk, which is the only authority that matters. */
const entriesToday = (spaceDir: string) => {
  const dir = join(spaceDir, "journal");
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((n) => n.startsWith(stamp()) && n.endsWith(".org"))
    .sort();
};

test.describe("Journal Today", () => {
  test.use({ spaceFiles: { "index.md": "# Home\n" } });

  test("asked twice, makes one entry and returns to it", async ({
    sbPage,
    sbServer,
  }) => {
    await gotoSilverBulletPage(sbPage, sbServer, "index");
    expect(entriesToday(sbServer.spaceDir)).toHaveLength(0);

    const today = (page: any) =>
      page.evaluate(() => {
        void (globalThis as any).sbRuntime.evalLuaScript(
          `editor.invokeCommand("Denote: Journal Today")`,
        );
      });

    await today(sbPage);
    await expect(currentPage(sbPage)).toHaveValue(
      new RegExp(`^journal/${stamp()}T\\d{6}--.*__journal\\.org$`),
      { timeout: 25_000 },
    );
    const first = entriesToday(sbServer.spaceDir);
    expect(first).toHaveLength(1);

    // Away and back, then asked again -- the shape of tapping the button
    // twice in a day.
    await gotoSilverBulletPage(sbPage, sbServer, "index");
    await expect(currentPage(sbPage)).toHaveValue("index", { timeout: 20_000 });
    await today(sbPage);
    await expect(currentPage(sbPage)).toHaveValue(
      new RegExp(`^journal/${stamp()}T\\d{6}--.*__journal\\.org$`),
      { timeout: 25_000 },
    );
    expect(entriesToday(sbServer.spaceDir)).toEqual(first);
  });

  test("finds an entry the index has never seen", async ({
    sbPage,
    sbServer,
  }) => {
    // The real failure: an entry arrives by sync, or the app is cold, so the
    // object index does not hold it. The file name says everything needed --
    // the date and the `journal` keyword -- so the lookup reads that instead.
    await gotoSilverBulletPage(sbPage, sbServer, "index");
    await sbPage.evaluate(
      async ({ name, body }: { name: string; body: string }) => {
        const client = (globalThis as any).client;
        // Written straight through the space, with no indexing pass.
        await client.space.writePage(name, body);
      },
      {
        name: `journal/${stamp()}T070000--already-here__journal.org`,
        body:
          `#+title:      Already here\n#+identifier: ${stamp()}T070000\n` +
          `#+filetags:   :journal:\n\nWritten earlier.\n`,
      },
    );

    await sbPage.evaluate(() => {
      void (globalThis as any).sbRuntime.evalLuaScript(
        `editor.invokeCommand("Denote: Journal Today")`,
      );
    });
    // It opens the entry that is there rather than writing a second one.
    await expect(currentPage(sbPage)).toHaveValue(
      `journal/${stamp()}T070000--already-here__journal.org`,
      { timeout: 25_000 },
    );
    expect(entriesToday(sbServer.spaceDir)).toEqual([
      `${stamp()}T070000--already-here__journal.org`,
    ]);
  });
});
