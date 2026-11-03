import { expect, gotoSilverBulletPage, test } from "./fixtures.ts";
import { currentPage } from "./navigator-ui.ts";

// debear's two lists, over signatures: category first, its notes under it.
const org = (id: string, sig: string, title: string) =>
  `#+title:      ${title}\n#+identifier: ${id}\n#+signature:  ${sig}\n\nBody of ${title}.\n`;

const files: Record<string, string> = {
  "index.md": "# Home\n",
  // Two categories, each with a hub note naming it.
  "20260101T000100==21=00--iteam.org": org("20260101T000100", "21=00", "iteam"),
  "20260101T000101==21=04--rumspringa.org": org(
    "20260101T000101",
    "21=04",
    "Rumspringa",
  ),
  // Deliberately out of numeric order on disk, and single-digit, to prove the
  // sort: 21=9 must come before 21=10.
  "20260101T000103==21=10--tenth.org": org("20260101T000103", "21=10", "Tenth"),
  "20260101T000102==21=9--ninth.org": org("20260101T000102", "21=9", "Ninth"),
  "20260101T000200==23=00--become-a-therapist.org": org(
    "20260101T000200",
    "23=00",
    "Become a Therapist",
  ),
  "20260101T000201==23=02--existential.org": org(
    "20260101T000201",
    "23=02",
    "Existential",
  ),
  // Two notes claim `21=00`. The migration minted the `meta` one -- note the
  // identifier that is not a date -- and the real note must name the
  // category. This is the case that was wrong.
  "00000000T002100==21=00--meta.org": org("00000000T002100", "21=00", "meta"),
  // A category whose only hub is synthetic still has to be named by it.
  "00000000T000026==26=00--community-medic.org": org(
    "00000000T000026",
    "26=00",
    "Community Medic",
  ),
  // No signature: not in the browser at all.
  "20260101T000300--unsigned.org":
    "#+title:      Unsigned\n#+identifier: 20260101T000300\n\nNothing.\n",
};

test.describe("Signature browser", () => {
  test.use({ spaceFiles: files });

  const open = (page: any) =>
    page.evaluate(() => {
      void (globalThis as any).sbRuntime.evalLuaScript(
        `editor.invokeCommand("Navigate: Signature Browser")`,
      );
    });

  const rows = (page: any) => page.locator(".sb-nav-primary").allTextContents();

  test("categories are named by their hub note, notes nest under them", async ({
    sbPage,
    sbServer,
  }) => {
    await gotoSilverBulletPage(sbPage, sbServer, "index");
    await sbPage.waitForTimeout(3500); // index settles
    await open(sbPage);

    // The category reads as its number and the title of its `NN=00` note.
    await expect
      .poll(() => rows(sbPage), { timeout: 20_000 })
      .toEqual(
        expect.arrayContaining([
          expect.stringContaining("21  iteam"),
          expect.stringContaining("23  Become a Therapist"),
        ]),
      );
    // An unsigned note is not a signature, so it is not here.
    expect((await rows(sbPage)).join("|")).not.toContain("Unsigned");
    // The real note names the category, not the migration's placeholder --
    // and `meta` is still there, as a note inside it.
    const all = (await rows(sbPage)).join("|");
    expect(all).not.toContain("21  meta");
    expect(all).toContain("21=00  meta");
    // A synthetic hub is used when it is the only one.
    expect(all).toContain("26  Community Medic");
  });

  test("a category's notes are in signature order, not text order", async ({
    sbPage,
    sbServer,
  }) => {
    await gotoSilverBulletPage(sbPage, sbServer, "index");
    await sbPage.waitForTimeout(3500);
    await open(sbPage);
    await expect
      .poll(() => rows(sbPage), { timeout: 20_000 })
      .toEqual(expect.arrayContaining([expect.stringContaining("21=04")]));

    const all = await rows(sbPage);
    const at = (needle: string) =>
      all.findIndex((r: string) => r.includes(needle));
    // 21=9 before 21=10: padded numerically, where plain text would invert it.
    expect(at("21=9")).toBeGreaterThan(-1);
    expect(at("21=10")).toBeGreaterThan(-1);
    expect(at("21=9")).toBeLessThan(at("21=10"));
    // And the hub sorts first within its category.
    expect(at("21=00")).toBeLessThan(at("21=04"));
  });

  test("picking a note opens it", async ({ sbPage, sbServer }) => {
    await gotoSilverBulletPage(sbPage, sbServer, "index");
    await sbPage.waitForTimeout(3500);
    await open(sbPage);
    const row = sbPage.locator(".sb-nav-primary", { hasText: "Rumspringa" });
    await expect(row).toBeVisible({ timeout: 20_000 });
    await row.click();
    await expect(currentPage(sbPage)).toHaveValue(
      "20260101T000101==21=04--rumspringa.org",
      { timeout: 20_000 },
    );
  });
});
