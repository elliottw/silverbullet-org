import { readFileSync } from "node:fs";
import { expect, gotoSilverBulletPage, test } from "./fixtures.ts";
import { currentPage } from "./navigator-ui.ts";

// The same real Denote library denote.test.ts uses; these notes carry the
// signatures 0, 1a and 1b, which is enough of a sequence to walk.
const LIB = new URL("./fixtures/denote", import.meta.url).pathname;
const HUB = "20231221T085005==0--issues-of-law__law_meta.org";
const COSTS =
  "20240125T164237==1a--court-costs-relating-to-evictions__costs.org";
const WAIVERS =
  "20240126T082320==1b--waivers-of-filing-fees__costs_waivers.org";
const note = (name: string) => readFileSync(`${LIB}/${name}`, "utf-8");

// A Johnny Decimal branch: a category hub, a numbered sub-folder's note and
// a note straight in the category, written the way the migration writes them.
const org = (id: string, sig: string, title: string, kw: string) =>
  `#+title:      ${title}\n#+date:       [2025-01-01 Wed 10:00]\n#+filetags:   :${kw}:\n#+identifier: ${id}\n#+signature:  ${sig}\n\nBody of ${title}.\n`;
const JD_HUB = "20250101T100000==21=00--iteam.org";
const JD_TERM = "20250101T100001==21=01--hydroponics__term.org";
const JD_DIRECT = "20250101T100002==21--civic-design__iteam.org";
const JD_OTHER = "20250101T100003==22--backyard-shed.org";

async function runCommand(page: any, name: string) {
  await page.evaluate((command: string) => {
    void (globalThis as any).sbRuntime.evalLuaScript(
      `editor.invokeCommand("${command}")`,
    );
  }, name);
}

async function answer(page: any, value: string) {
  const prompt = page.locator(".sb-modal-box input, .sb-modal input").first();
  await expect(prompt).toBeVisible({ timeout: 20_000 });
  await prompt.fill(value);
  await prompt.press("Enter");
  await page.waitForTimeout(600);
}

/** Accepts a prompt's default answer. */
async function acceptDefault(page: any) {
  const prompt = page.locator(".sb-modal-box input, .sb-modal input").first();
  await expect(prompt).toBeVisible({ timeout: 20_000 });
  await prompt.press("Enter");
  await page.waitForTimeout(600);
}

async function pickerRows(page: any): Promise<string[]> {
  const rows = page.locator(".sb-result-list .sb-name");
  await expect(rows.first()).toBeVisible({ timeout: 20_000 });
  return await rows.allTextContents();
}

async function fileNames(sbServer: any): Promise<string> {
  return await (
    await fetch(`${sbServer.url}/.fs/`, { headers: { "X-Sync-Mode": "true" } })
  ).text();
}

test.describe("Signatures as a sequence", () => {
  test.use({
    spaceFiles: {
      "index.md": "# Denote\n",
      [JD_HUB]: org("20250101T100000", "21=00", "iteam", "iteam"),
      [JD_TERM]: org("20250101T100001", "21=01", "Hydroponics", "term"),
      [JD_DIRECT]: org("20250101T100002", "21", "Civic Design", "iteam"),
      [JD_OTHER]: org("20250101T100003", "22", "Backyard shed", "shed"),
      [HUB]: note(HUB),
      [COSTS]: note(COSTS),
      [WAIVERS]: note(WAIVERS),
    },
  });

  test("Browse by Signature lists every signed note in sequence order", async ({
    sbPage,
    sbServer,
  }) => {
    await gotoSilverBulletPage(sbPage, sbServer, JD_DIRECT);
    await runCommand(sbPage, "Denote: Browse by Signature");
    const rows = await pickerRows(sbPage);
    // Numeric order within a level, a parent before its children.
    const order = rows.map((r) => r.trim().split(/\s+/)[0]);
    expect(order).toEqual(["0", "1a", "1b", "21", "21=00", "21=01", "22"]);
    await sbPage.keyboard.press("Escape");
  });

  test("Parent, Children and Siblings walk the sequence", async ({
    sbPage,
    sbServer,
  }) => {
    await gotoSilverBulletPage(sbPage, sbServer, JD_TERM);
    // 21=01's parent is 21 -- or the 21=00 hub; both are offered.
    await runCommand(sbPage, "Denote: Signature Parent");
    let rows = await pickerRows(sbPage);
    expect(rows.join("\n")).toContain("21  Civic Design");
    expect(rows.join("\n")).toContain("21=00  iteam");
    await sbPage.keyboard.press("Escape");

    // From the hub, the children are the category's.
    await gotoSilverBulletPage(sbPage, sbServer, JD_HUB);
    await runCommand(sbPage, "Denote: Signature Children");
    // Only one child: 21=01 -- so it opens directly.
    await expect(currentPage(sbPage)).toHaveValue(JD_TERM, { timeout: 20_000 });

    // 22's only sibling at the top level with a different signature: 21 and 0
    // family. From 22, siblings are the other top-level signatures.
    await gotoSilverBulletPage(sbPage, sbServer, JD_OTHER);
    await runCommand(sbPage, "Denote: Signature Siblings");
    rows = await pickerRows(sbPage);
    expect(rows.join("\n")).toContain("21  Civic Design");
    expect(rows.join("\n")).not.toContain("21=01");
    await sbPage.keyboard.press("Escape");
  });

  test("Next and Previous move between siblings", async ({
    sbPage,
    sbServer,
  }) => {
    await gotoSilverBulletPage(sbPage, sbServer, COSTS);
    await runCommand(sbPage, "Denote: Signature Next");
    await expect(currentPage(sbPage)).toHaveValue(WAIVERS, { timeout: 20_000 });
    await runCommand(sbPage, "Denote: Signature Previous");
    await expect(currentPage(sbPage)).toHaveValue(COSTS, { timeout: 20_000 });
  });

  test("New Child Note proposes the next free address at the siblings' width", async ({
    sbPage,
    sbServer,
  }) => {
    await gotoSilverBulletPage(sbPage, sbServer, JD_HUB);
    await runCommand(sbPage, "Denote: New Child Note");
    // The proposal: 21=01 exists, so 21=02, two digits wide.
    const prompt = sbPage
      .locator(".sb-modal-box input, .sb-modal input")
      .first();
    await expect(prompt).toBeVisible({ timeout: 20_000 });
    await expect(prompt).toHaveValue("21=02");
    await prompt.press("Enter");
    await answer(sbPage, "Land banks");
    // Keywords: none.
    await sbPage
      .locator(".sb-modal-box input, .sb-modal input")
      .first()
      .press("Escape");
    await expect(currentPage(sbPage)).toHaveValue(
      /^\d{8}T\d{6}==21=02--land-banks\.org$/,
      { timeout: 20_000 },
    );
    const text = await sbPage.evaluate(() =>
      (globalThis as any).sbRuntime.evalLua("editor.getText()"),
    );
    expect(text).toContain("#+signature:  21=02");
  });

  test("Set Signature rewrites the front matter and renames the file", async ({
    sbPage,
    sbServer,
  }) => {
    await gotoSilverBulletPage(sbPage, sbServer, JD_OTHER);
    await runCommand(sbPage, "Denote: Set Signature");
    await answer(sbPage, "23");
    const renamed = "20250101T100003==23--backyard-shed__shed.org";
    await expect(currentPage(sbPage)).toHaveValue(renamed, { timeout: 20_000 });
    const text = await sbPage.evaluate(() =>
      (globalThis as any).sbRuntime.evalLua("editor.getText()"),
    );
    expect(text).toContain("#+signature:  23");
    expect(text).toContain("Body of Backyard shed.");
    expect(await fileNames(sbServer)).not.toContain(JD_OTHER);
  });

  test("Rename changes title, keywords and signature together", async ({
    sbPage,
    sbServer,
  }) => {
    await gotoSilverBulletPage(sbPage, sbServer, JD_DIRECT);
    await runCommand(sbPage, "Denote: Rename");
    await answer(sbPage, "Civic design practice");
    await answer(sbPage, "iteam, design");
    await answer(sbPage, "21=05");
    await expect(currentPage(sbPage)).toHaveValue(
      "20250101T100002==21=05--civic-design-practice__design_iteam.org",
      { timeout: 20_000 },
    );
    const text = await sbPage.evaluate(() =>
      (globalThis as any).sbRuntime.evalLua("editor.getText()"),
    );
    expect(text).toContain("#+title:      Civic design practice");
    expect(text).toContain("#+filetags:   :design:iteam:");
    expect(text).toContain("#+signature:  21=05");
  });

  test("Remove Keywords drops one and renames", async ({
    sbPage,
    sbServer,
  }) => {
    await gotoSilverBulletPage(sbPage, sbServer, WAIVERS);
    await runCommand(sbPage, "Denote: Remove Keywords");
    const filter = sbPage
      .locator(".sb-modal-box input, .sb-modal input")
      .first();
    await expect(filter).toBeVisible({ timeout: 20_000 });
    await filter.fill("waivers");
    await filter.press("Enter");
    await expect(currentPage(sbPage)).toHaveValue(
      "20240126T082320==1b--waivers-of-filing-fees__costs.org",
      { timeout: 20_000 },
    );
  });
});

test.describe("Generated pages under denote/", () => {
  test.use({
    spaceFiles: {
      "index.md": "# Denote\n",
      [JD_HUB]:
        org("20250101T100000", "21=00", "iteam", "iteam") +
        "\nSee [[denote:20250101T100001][Hydroponics]].\n",
      [JD_TERM]: org("20250101T100001", "21=01", "Hydroponics", "term"),
      [JD_DIRECT]: org("20250101T100002", "21", "Civic Design", "iteam"),
      "journal/20250120T123820--monday-20-january-2025__journal.org": org(
        "20250120T123820",
        "",
        "Monday 20 January 2025",
        "journal",
      ).replace("#+signature:  \n", ""),
      // A dangling link, for the health page.
      "20250101T100009--loose-end.org":
        org("20250101T100009", "", "Loose end", "misc").replace(
          "#+signature:  \n",
          "",
        ) + "\nSee [[denote:20990101T000000][nothing]].\n",
    },
  });

  test("denote/signatures is the sequence as a tree", async ({
    sbPage,
    sbServer,
  }) => {
    await gotoSilverBulletPage(sbPage, sbServer, "denote/signatures.org");
    const editor = sbPage.locator("#sb-editor .cm-content");
    await expect(editor).toContainText("3 notes carry a signature", {
      timeout: 20_000,
    });
    await expect(editor).toContainText("21 Civic Design");
    await expect(editor).toContainText("21=01 Hydroponics");
    // Narrowed to one branch.
    await gotoSilverBulletPage(sbPage, sbServer, "denote/signatures/21.org");
    await expect(editor).toContainText("Signatures under 21", {
      timeout: 20_000,
    });
    await expect(editor).toContainText("Hydroponics");
  });

  test("denote/keywords counts keywords and lists a keyword's notes", async ({
    sbPage,
    sbServer,
  }) => {
    await gotoSilverBulletPage(sbPage, sbServer, "denote/keywords.org");
    const editor = sbPage.locator("#sb-editor .cm-content");
    await expect(editor).toContainText("iteam 2", { timeout: 20_000 });
    await gotoSilverBulletPage(sbPage, sbServer, "denote/keywords/term.org");
    await expect(editor).toContainText("Hydroponics", { timeout: 20_000 });
  });

  test("the calendar marks written days and creates an entry for an unwritten one", async ({
    sbPage,
    sbServer,
  }) => {
    await gotoSilverBulletPage(sbPage, sbServer, "denote/calendar/2025.org");
    const editor = sbPage.locator("#sb-editor .cm-content");
    await expect(editor).toContainText("January", { timeout: 20_000 });
    // The whole year is generated, even if the editor only draws the top.
    const text = await sbPage.evaluate(() =>
      (globalThis as any).sbRuntime.evalLua("editor.getText()"),
    );
    expect(text).toContain("* August");
    expect(text).toContain("[[journal:2025-08-21][21]]");
    // 20 January links to its entry; 21 January is a journal: link.
    const written = editor.locator("a.sb-denote-link:not(.sb-journal-link)", {
      hasText: /^20$/,
    });
    await expect(written.first()).toBeVisible();
    const unwritten = editor.locator("a.sb-journal-link", { hasText: /^21$/ });
    await expect(unwritten.first()).toBeVisible();
    await unwritten.first().click();
    // The entry is stamped with the day it is for, not the day it was made.
    await expect(currentPage(sbPage)).toHaveValue(
      /^journal\/20250121T000000--tuesday-21-january-2025.*__journal\.org$/,
      { timeout: 20_000 },
    );
  });

  test("Journal Open Date makes an entry for a typed date", async ({
    sbPage,
    sbServer,
  }) => {
    await gotoSilverBulletPage(sbPage, sbServer, "index");
    await runCommand(sbPage, "Denote: Journal Open Date");
    await answer(sbPage, "2025-03-04");
    await expect(currentPage(sbPage)).toHaveValue(
      /^journal\/20250304T000000--tuesday-4-march-2025.*__journal\.org$/,
      { timeout: 20_000 },
    );
  });

  test("denote/health reports a dangling link", async ({
    sbPage,
    sbServer,
  }) => {
    await gotoSilverBulletPage(sbPage, sbServer, "denote/health.org");
    const editor = sbPage.locator("#sb-editor .cm-content");
    await expect(editor).toContainText(
      "1 identifiers linked to but carried by no note",
      { timeout: 30_000 },
    );
    await expect(editor).toContainText("20990101T000000");
  });

  test("Find Link and Find Backlink offer the notes around this one", async ({
    sbPage,
    sbServer,
  }) => {
    // The hub links to Hydroponics (see the fixture), so from the hub Find
    // Link has one place to go, and from Hydroponics Find Backlink has one.
    await gotoSilverBulletPage(sbPage, sbServer, JD_HUB);
    await sbPage.waitForTimeout(2000);
    await runCommand(sbPage, "Denote: Find Link");
    let rows = await pickerRows(sbPage);
    expect(rows.join("\n")).toContain("Hydroponics");
    await sbPage.keyboard.press("Enter");
    await expect(currentPage(sbPage)).toHaveValue(JD_TERM, { timeout: 20_000 });
    await runCommand(sbPage, "Denote: Find Backlink");
    rows = await pickerRows(sbPage);
    expect(rows.join("\n")).toContain("iteam");
    await sbPage.keyboard.press("Enter");
    await expect(currentPage(sbPage)).toHaveValue(JD_HUB, { timeout: 20_000 });
  });
});
