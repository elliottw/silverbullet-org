import { expect, gotoSilverBulletPage, test } from "./fixtures.ts";
import { currentPage } from "./navigator-ui.ts";

// `consult-denote-grep`: type, see matching lines from the whole library,
// land on the line. The point is the *line* -- a page picker already finds
// pages.
const org = (id: string, title: string, body: string) =>
  `#+title:      ${title}\n#+identifier: ${id}\n\n${body}\n`;

test.describe("Search Notes", () => {
  test.use({
    spaceFiles: {
      "index.md": "# Home\n",
      "20261102T100000--outreach.org": org(
        "20261102T100000",
        "Outreach",
        "* Calls\nleft a voicemail for brandi gurcak\nnothing else here\n",
      ),
      "20261102T100001--shed.org": org(
        "20261102T100001",
        "Shed",
        "* Materials\nordered the cedar shingles\n- [ ] call brandi about the permit\n",
      ),
      "20261102T100002--quiet.org": org(
        "20261102T100002",
        "Quiet",
        "nothing to find in this one\n",
      ),
    },
  });

  const open = (page: any) =>
    page.evaluate(() => {
      void (globalThis as any).sbRuntime.evalLuaScript(
        `editor.invokeCommand("Navigate: Search Notes")`,
      );
    });

  // A navigator view, not a filter box: its own input and row markup.
  const filter = (page: any) => page.locator(".sb-nav-input").first();

  const rows = (page: any) =>
    page.locator(".sb-nav-primary").allTextContents();

  test("finds matching lines across notes and opens the line", async ({
    sbPage,
    sbServer,
  }) => {
    await gotoSilverBulletPage(sbPage, sbServer, "index");
    // Let the space index settle -- the search reads indexed objects.
    await sbPage.waitForTimeout(3000);
    await open(sbPage);
    await expect(filter(sbPage)).toBeVisible({ timeout: 20_000 });

    // Under the minimum, nothing is offered rather than everything.
    await filter(sbPage).fill("br");
    await sbPage.waitForTimeout(600);
    expect((await rows(sbPage)).join("|")).not.toContain("brandi");

    await filter(sbPage).fill("brandi");
    await expect
      .poll(() => rows(sbPage), { timeout: 20_000 })
      .toEqual(
        expect.arrayContaining([
          expect.stringContaining("voicemail for brandi gurcak"),
        ]),
      );
    // Both notes that mention her, including the one in a task.
    const found = (await rows(sbPage)).join("|");
    expect(found).toContain("brandi about the permit");
    // And not the note that says nothing.
    expect(found).not.toContain("nothing to find");

    await filter(sbPage).press("Enter");
    // Lands on the page holding the line.
    await expect(currentPage(sbPage)).toHaveValue(
      /20261102T10000[01]--(outreach|shed)\.org/,
      { timeout: 20_000 },
    );
  });

  test("matching is case-insensitive and takes punctuation literally", async ({
    sbPage,
    sbServer,
  }) => {
    await gotoSilverBulletPage(sbPage, sbServer, "index");
    await sbPage.waitForTimeout(3000);
    await open(sbPage);
    await expect(filter(sbPage)).toBeVisible({ timeout: 20_000 });

    await filter(sbPage).fill("BRANDI");
    await expect
      .poll(() => rows(sbPage), { timeout: 20_000 })
      .toEqual(
        expect.arrayContaining([expect.stringContaining("brandi gurcak")]),
      );

    // A regex metacharacter is a character, not a pattern: `%s` finds nothing
    // here rather than matching every space.
    await filter(sbPage).fill("%s+");
    await sbPage.waitForTimeout(800);
    expect((await rows(sbPage)).join("|")).not.toContain("voicemail");
  });
});
