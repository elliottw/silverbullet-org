import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
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

  // The only test here that runs with the service worker on, because the bug
  // only exists when it is: `/.fs` is then answered from a background-synced
  // replica, and the whole question is what happens when that replica is
  // behind the server.
  test.describe("with the service worker serving the file list", () => {
    test.use({ disableServiceWorker: false });

    test("finds an entry only the server knows about", async ({
      sbPage,
      sbServer,
    }) => {
      // The failure this actually had in the wild. `space.listPages()` reads
      // through the service worker, which answers from a background-synced
      // replica -- so an entry written on another device is missing from it,
      // and the command creates a second one for the day. Simulated by writing
      // the file on the server's disk, which no client cache has seen.
      await gotoSilverBulletPage(sbPage, sbServer, "index");
      await sbPage.waitForTimeout(1500);

      const name = `journal/${stamp()}T060000--from-the-phone__journal.org`;
      mkdirSync(join(sbServer.spaceDir, "journal"), { recursive: true });
      writeFileSync(
        join(sbServer.spaceDir, name),
        `#+title:      From the phone\n#+identifier: ${stamp()}T060000\n` +
          `#+filetags:   :journal:\n\nWritten elsewhere.\n`,
      );

      await sbPage.evaluate(() => {
        void (globalThis as any).sbRuntime.evalLuaScript(
          `editor.invokeCommand("Denote: Journal Today")`,
        );
      });
      // It opens what the server has rather than writing a second entry.
      await expect(currentPage(sbPage)).toHaveValue(name, { timeout: 25_000 });
      expect(entriesToday(sbServer.spaceDir)).toEqual([
        `${stamp()}T060000--from-the-phone__journal.org`,
      ]);
    });
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
