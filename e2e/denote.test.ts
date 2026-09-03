import { readFileSync } from "node:fs";
import { expect, gotoSilverBulletPage, mod, test } from "./fixtures.ts";
import {
  currentPage,
  navInput,
  navRows,
  openPagePicker,
} from "./navigator-ui.ts";

// Every note below is verbatim from github.com/l-o-l-h/law, a real public
// Denote library. Keeping real files (rather than hand-written ones) is the
// point: they carry the signature component, historical identifiers, and the
// file-name/front-matter drift that real libraries accumulate.
const LIB = new URL("./fixtures/denote", import.meta.url).pathname;

const HUB = "20231221T085005==0--issues-of-law__law_meta.org";
const COSTS =
  "20240125T164237==1a--court-costs-relating-to-evictions__costs.org";
const WAIVERS =
  "20240126T082320==1b--waivers-of-filing-fees__costs_waivers.org";

function note(name: string): string {
  return readFileSync(`${LIB}/${name}`, "utf-8");
}

const DASHBOARD = `# Dashboard

# Notes
\${query[[
  from d = tags.denote
  order by d.identifier
  select d.identifier .. " | " .. d.title .. " | " .. table.concat(d.keywords, ",")
]]}

# Tagged costs
\${query[[from p = tags.costs order by p.name select p.title]]}
`;

test.describe("Denote library", () => {
  test.use({
    spaceFiles: {
      "index.md": "# Denote\nA Denote library.",
      "Dashboard.md": DASHBOARD,
      [HUB]: note(HUB),
      [COSTS]: note(COSTS),
      [WAIVERS]: note(WAIVERS),
    },
  });

  test("a denote: link renders as its description and navigates by identifier", async ({
    sbPage,
    sbServer,
  }) => {
    await gotoSilverBulletPage(sbPage, sbServer, HUB);
    const editor = sbPage.locator("#sb-editor .cm-content");
    await expect(editor).toContainText("Issues of Law");

    // The raw link markup is replaced by a single clickable link. Resolution
    // needs the page list, so the link starts out marked missing and
    // re-decorates once that arrives — wait for the resolved state.
    const link = sbPage
      .locator("#sb-editor .sb-denote-link:not(.sb-wiki-link-page-missing)", {
        hasText: "1a  Court Costs Relating to Evictions",
      })
      .first();
    await expect(link).toBeVisible({ timeout: 20_000 });
    await expect(editor).not.toContainText("[[denote:20240125T164237]");

    // Following it resolves the identifier to the file that carries it, even
    // though nothing in the link mentions that file's name.
    await link.click();
    await expect(currentPage(sbPage)).toHaveValue(COSTS, { timeout: 10_000 });
    await expect(sbPage.locator("#sb-editor .cm-content")).toContainText(
      "Court Costs Relating to Evictions",
    );
  });

  test("a link to an identifier no note carries is marked missing", async ({
    sbPage,
    sbServer,
  }) => {
    await gotoSilverBulletPage(sbPage, sbServer, HUB);
    // The hub links to many notes; only three are in this space, so the rest
    // resolve to nothing and must be visibly dangling rather than silently
    // rendered as working links.
    await expect(
      sbPage
        .locator("#sb-editor .sb-denote-link.sb-wiki-link-page-missing")
        .first(),
    ).toBeVisible({ timeout: 10_000 });
  });

  test("notes are indexed by identifier, title and keywords", async ({
    sbPage,
    sbServer,
  }) => {
    await gotoSilverBulletPage(sbPage, sbServer, "Dashboard");
    const editor = sbPage.locator("#sb-editor .cm-content");

    // Title comes from the front matter; keywords come from the file name.
    await expect(editor).toContainText(
      "20231221T085005 | Issues of Law | law,meta",
      { timeout: 20_000 },
    );
    await expect(editor).toContainText(
      "20240126T082320 | Waivers of Filing Fees | costs,waivers",
    );

    // Denote keywords become SilverBullet tags, so an ordinary tag query finds
    // the notes carrying that keyword.
    await expect(editor).toContainText("Court Costs Relating to Evictions");
    await expect(editor).toContainText("Waivers of Filing Fees");
  });

  test("the page picker shows titles and keywords, not raw file names", async ({
    sbPage,
  }) => {
    const frame = await openPagePicker(sbPage);
    // Still findable by the file-name slug...
    await navInput(sbPage).fill("waivers-of-filing-fees");
    // ...but shown by its title.
    await expect(navRows(frame).first()).toHaveText("Waivers of Filing Fees", {
      timeout: 20_000,
    });
    // The raw file name is not shown: it is a slug of the title already on the
    // row. It stays searchable, as the fill above demonstrates.
    await expect(frame.locator(".sb-nav-row").first()).not.toContainText(
      WAIVERS,
    );

    // Keywords are drawn bare: Org writes `:costs:waivers:`, never `#costs`.
    const chips = frame.locator(".sb-nav-row").first().locator(".sb-hashtag");
    await expect(chips.first()).toBeVisible();
    const texts = await chips.allInnerTexts();
    expect(texts.map((t) => t.trim()).sort()).toEqual(["costs", "waivers"]);
    for (const text of texts) {
      expect(text).not.toContain("#");
    }
  });
});

test.describe("Denote link authoring", () => {
  test.use({
    spaceFiles: {
      "index.md": "# Denote\n",
      "Markdown Note.md": "# A markdown note\n",
      [HUB]: note(HUB),
      [COSTS]: note(COSTS),
    },
  });

  test("typing [[ on an Org page completes to a denote: link", async ({
    sbPage,
    sbServer,
  }) => {
    await gotoSilverBulletPage(sbPage, sbServer, HUB);
    const editor = sbPage.locator("#sb-editor .cm-content");
    await editor.click();
    // Land on a blank line at the very end of the note.
    await sbPage.keyboard.press("Control+End");
    await sbPage.keyboard.press("Enter");
    await sbPage.keyboard.type("[[court-costs");
    // Wait for the completion list, then take the first entry.
    await expect(sbPage.locator(".cm-tooltip-autocomplete")).toBeVisible({
      timeout: 20_000,
    });
    await sbPage.keyboard.press("Enter");
    await sbPage.waitForTimeout(700);

    const text = await editor.innerText();
    // The identifier, not the file name — and the title as the description,
    // which is what Denote's own `denote-link` inserts.
    expect(text).toContain(
      "[[denote:20240125T164237][Court Costs Relating to Evictions]]",
    );
    expect(text).not.toContain("[[20240125T164237==1a--court-costs");
  });

  test("typing [[ on a Markdown page still completes to a wiki link", async ({
    sbPage,
    sbServer,
  }) => {
    await gotoSilverBulletPage(sbPage, sbServer, "Markdown Note");
    const editor = sbPage.locator("#sb-editor .cm-content");
    await editor.click();
    await sbPage.keyboard.press("Control+End");
    await sbPage.keyboard.press("Enter");
    await sbPage.keyboard.type("[[ind");
    await expect(sbPage.locator(".cm-tooltip-autocomplete")).toBeVisible({
      timeout: 20_000,
    });
    await sbPage.keyboard.press("Enter");
    await sbPage.waitForTimeout(700);
    // Markdown pages are untouched by the Org link rules.
    const text = await editor.innerText();
    expect(text).toContain("[[index]]");
    expect(text).not.toContain("denote:");
  });
});

test.describe("Renaming a Denote note", () => {
  test.use({
    spaceFiles: {
      "index.md": "# Denote\n",
      [HUB]: note(HUB),
      [COSTS]: note(COSTS),
    },
  });

  // Renaming is routine in Denote — the title and keywords live in the file
  // name — so the rename path must not assume a `.md` extension.
  test("renaming an Org note keeps its extension and its content", async ({
    sbPage,
    sbServer,
  }) => {
    await gotoSilverBulletPage(sbPage, sbServer, COSTS);
    const renamed =
      "20240125T164237==1a--court-costs-renamed__costs_updated.org";
    // Fire the command without awaiting: it blocks on its own prompt, which
    // is then filled in like a user would.
    await sbPage.evaluate(() => {
      void (globalThis as any).sbRuntime.evalLuaScript(
        'editor.invokeCommand("Page: Rename")',
      );
    });
    const prompt = sbPage
      .locator(".sb-modal-box input, .sb-modal input")
      .first();
    await expect(prompt).toBeVisible({ timeout: 15_000 });
    await prompt.fill(renamed);
    await prompt.press("Enter");
    await expect(currentPage(sbPage)).toHaveValue(renamed, { timeout: 20_000 });
    await expect(sbPage.locator("#sb-editor .cm-content")).toContainText(
      "Court Costs Relating to Evictions",
    );
    // The old name is gone and the new file is on disk under it.
    const listing = await (
      await fetch(`${sbServer.url}/.fs/`, {
        headers: { "X-Sync-Mode": "true" },
      })
    ).text();
    expect(listing).toContain(renamed);
    expect(listing).not.toContain(COSTS);
  });
});

test.describe("Following a Denote link by keyboard", () => {
  test.use({
    spaceFiles: {
      "index.md": "# Denote\n",
      [HUB]: note(HUB),
      [COSTS]: note(COSTS),
    },
  });

  // Clicking is handled by the link widget itself; Cmd/Ctrl-Enter goes through
  // the navigate plug, which used to parse every page as Markdown and so saw
  // no link at all on an Org page.
  test("Cmd-Enter follows the denote: link under the cursor", async ({
    sbPage,
    sbServer,
  }) => {
    await gotoSilverBulletPage(sbPage, sbServer, HUB);
    await expect(sbPage.locator("#sb-editor .cm-content")).toContainText(
      "Issues of Law",
    );

    // Put the cursor inside the link's target rather than clicking it, which
    // would navigate on its own and prove nothing about the keybinding.
    const moved = await sbPage.evaluate(() =>
      (globalThis as any).sbRuntime.evalLuaScript(`
        local text = editor.getText()
        local pos = string.find(text, "[[denote:20240125T164237", 1, true)
        if pos == nil then return -1 end
        editor.moveCursor(pos + 10)
        return pos
      `),
    );
    expect(moved).toBeGreaterThan(0);

    await sbPage.keyboard.press(`${mod}+Enter`);
    await expect(currentPage(sbPage)).toHaveValue(COSTS, { timeout: 15_000 });
    await expect(sbPage.locator("#sb-editor .cm-content")).toContainText(
      "Court Costs Relating to Evictions",
    );
  });
});

test.describe("Creating a Denote note", () => {
  test.use({
    spaceFiles: { "index.md": "# Denote\n", [COSTS]: note(COSTS) },
  });

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

  async function finishKeywords(page: any) {
    const filter = page.locator(".sb-modal-box input, .sb-modal input").first();
    await expect(filter).toBeVisible({ timeout: 20_000 });
    // Escape on the filter input means "that is all", as an empty answer does
    // in Denote's own keyword prompt.
    await filter.press("Escape");
    await page.waitForTimeout(600);
  }

  async function pickKeyword(page: any, keyword: string) {
    const filter = page.locator(".sb-modal-box input, .sb-modal input").first();
    await expect(filter).toBeVisible({ timeout: 20_000 });
    await filter.fill(keyword);
    await expect(
      page.locator(".sb-result-list .sb-name").first(),
    ).toContainText(keyword, { timeout: 10_000 });
    await filter.press("Enter");
    await page.waitForTimeout(600);
  }

  async function newKeyword(page: any, value: string) {
    const filter = page.locator(".sb-modal-box input, .sb-modal input").first();
    await expect(filter).toBeVisible({ timeout: 20_000 });
    await filter.fill("New keyword");
    await expect(
      page.locator(".sb-result-list .sb-name").first(),
    ).toContainText("New keyword", { timeout: 10_000 });
    await filter.press("Enter");
    await page.waitForTimeout(600);
    await answer(page, value);
  }

  test("Denote: New Note builds the file name and front matter", async ({
    sbPage,
    sbServer,
  }) => {
    await gotoSilverBulletPage(sbPage, sbServer, "index");
    await runCommand(sbPage, "Denote: New Note");
    await answer(sbPage, "Kiemle & Hagood Company v. Daniels");
    // The keyword picker completes over keywords already in the space; a new
    // one is typed through its own row.
    await pickKeyword(sbPage, "costs");
    await newKeyword(sbPage, "Case Law, trust");
    await finishKeywords(sbPage);

    // The name is built from the title and keywords, each sluggified by its own
    // rule: the title hyphenates, a keyword joins its words.
    const name = await currentPage(sbPage).inputValue();
    expect(name).toMatch(
      /^\d{8}T\d{6}--kiemle-hagood-company-v-daniels__caselaw_costs_trust\.org$/,
    );

    const identifier = name.slice(0, 15);
    const body = await sbPage.locator("#sb-editor .cm-content").innerText();
    expect(body).toContain("#+title:      Kiemle & Hagood Company v. Daniels");
    expect(body).toContain("#+filetags:   :caselaw:costs:trust:");
    expect(body).toContain(`#+identifier: ${identifier}`);
    expect(body).toMatch(/#\+date:\s+\[\d{4}-\d{2}-\d{2} \w{3} \d{2}:\d{2}\]/);

    // It is a real file, under exactly that name.
    const listing = await (
      await fetch(`${sbServer.url}/.fs/`, {
        headers: { "X-Sync-Mode": "true" },
      })
    ).text();
    expect(listing).toContain(name);
  });

  test("a new note is immediately linkable by its identifier", async ({
    sbPage,
    sbServer,
  }) => {
    await gotoSilverBulletPage(sbPage, sbServer, "index");
    await runCommand(sbPage, "Denote: New Note");
    await answer(sbPage, "Freshly Made Note");
    await newKeyword(sbPage, "fresh");
    await finishKeywords(sbPage);
    const created = await currentPage(sbPage).inputValue();
    const identifier = created.slice(0, 15);

    // Link to it from another Org note and follow that link.
    await gotoSilverBulletPage(sbPage, sbServer, COSTS);
    const editor = sbPage.locator("#sb-editor .cm-content");
    await editor.click();
    await sbPage.keyboard.press("Control+End");
    await sbPage.keyboard.press("Enter");
    await sbPage.keyboard.type("[[Freshly Made");
    await expect(sbPage.locator(".cm-tooltip-autocomplete")).toBeVisible({
      timeout: 20_000,
    });
    await sbPage.keyboard.press("Enter");
    await expect(editor).toContainText(
      `[[denote:${identifier}][Freshly Made Note]]`,
    );
  });

  test("Denote: New Note with Signature includes the signature", async ({
    sbPage,
    sbServer,
  }) => {
    await gotoSilverBulletPage(sbPage, sbServer, "index");
    await runCommand(sbPage, "Denote: New Note with Signature");
    await answer(sbPage, "Nature of Unlawful Detainer");
    await newKeyword(sbPage, "ud");
    await finishKeywords(sbPage);
    await answer(sbPage, "coa div1");

    const name = await currentPage(sbPage).inputValue();
    // A signature joins its words with `=`, which is its own slug rule.
    expect(name).toMatch(
      /^\d{8}T\d{6}==coa=div1--nature-of-unlawful-detainer__ud\.org$/,
    );
    await expect(sbPage.locator("#sb-editor .cm-content")).toContainText(
      "#+signature:  coa=div1",
    );
  });
});

test.describe("Finding notes by title", () => {
  test.use({
    spaceFiles: {
      "index.md": "# Denote\n",
      [HUB]: note(HUB),
      [COSTS]: note(COSTS),
    },
  });

  // A Denote file name is a slug; the human title only exists in the front
  // matter. Indexing it as `displayName` is what lets the picker find it.
  test("the page picker finds a note by its title, not just its file name", async ({
    sbPage,
  }) => {
    const frame = await openPagePicker(sbPage);
    await navInput(sbPage).fill("Court Costs Relating");
    await expect(navRows(frame).first()).toHaveText(
      "Court Costs Relating to Evictions",
      { timeout: 20_000 },
    );
    await sbPage.keyboard.press("Enter");
    await expect(currentPage(sbPage)).toHaveValue(COSTS);
  });
});

test.describe("Front matter drives the file name", () => {
  test.use({
    spaceFiles: {
      "index.md": "# Denote\n",
      [COSTS]: note(COSTS),
      [HUB]: note(HUB),
    },
  });

  async function fileNames(sbServer: any): Promise<string> {
    return await (
      await fetch(`${sbServer.url}/.fs/`, {
        headers: { "X-Sync-Mode": "true" },
      })
    ).text();
  }

  test("editing the title renames the file, keeping the identifier", async ({
    sbPage,
    sbServer,
  }) => {
    await gotoSilverBulletPage(sbPage, sbServer, COSTS);
    await expect(sbPage.locator("#sb-editor .cm-content")).toContainText(
      "Court Costs Relating to Evictions",
    );

    await sbPage.evaluate(() =>
      (globalThis as any).sbRuntime.evalLuaScript(`
        local text = editor.getText()
        local updated = string.gsub(text, "Court Costs Relating to Evictions", "Filing Fees and Costs", 1)
        editor.setText(updated)
      `),
    );
    // The identifier is identity, so it must survive the rename.
    const renamed = "20240125T164237==1a--filing-fees-and-costs__costs.org";
    await expect(currentPage(sbPage)).toHaveValue(renamed, { timeout: 20_000 });

    const listing = await fileNames(sbServer);
    expect(listing).toContain(renamed);
    expect(listing).not.toContain(COSTS);
  });

  test("editing the keywords renames the file", async ({
    sbPage,
    sbServer,
  }) => {
    await gotoSilverBulletPage(sbPage, sbServer, COSTS);
    await sbPage.evaluate(() =>
      (globalThis as any).sbRuntime.evalLuaScript(`
        local text = editor.getText()
        local updated = string.gsub(text, "#%+filetags:   :costs:", "#+filetags:   :costs:waivers:", 1)
        editor.setText(updated)
      `),
    );
    await expect(currentPage(sbPage)).toHaveValue(
      "20240125T164237==1a--court-costs-relating-to-evictions__costs_waivers.org",
      { timeout: 20_000 },
    );
  });

  test("inbound denote links survive the rename untouched", async ({
    sbPage,
    sbServer,
  }) => {
    await gotoSilverBulletPage(sbPage, sbServer, COSTS);
    await sbPage.evaluate(() =>
      (globalThis as any).sbRuntime.evalLuaScript(`
        local text = editor.getText()
        editor.setText(string.gsub(text, "Court Costs Relating to Evictions", "Renamed Entirely", 1))
      `),
    );
    await expect(currentPage(sbPage)).toHaveValue(
      "20240125T164237==1a--renamed-entirely__costs.org",
      { timeout: 20_000 },
    );

    // The hub links by identifier, so its link text never needed rewriting and
    // still resolves after the target moved.
    await gotoSilverBulletPage(sbPage, sbServer, HUB);
    const link = sbPage
      .locator("#sb-editor .sb-denote-link:not(.sb-wiki-link-page-missing)", {
        hasText: "1a  Court Costs Relating to Evictions",
      })
      .first();
    await expect(link).toBeVisible({ timeout: 20_000 });
    await link.click();
    await expect(currentPage(sbPage)).toHaveValue(
      "20240125T164237==1a--renamed-entirely__costs.org",
      { timeout: 15_000 },
    );
  });
});

test.describe("Dynamic blocks", () => {
  const DBLOCK = `#+title:      Costs index
#+filetags:   :meta:
#+identifier: 20260101T000000

* Court costs

#+BEGIN: denote-links :regexp "_costs" :sort-by-component nil :reverse-sort nil :id-only nil
- [[denote:20240125T164237][1a  Court Costs Relating to Evictions]]
#+END:
`;

  test.use({
    spaceFiles: {
      "index.md": "# Denote\n",
      [COSTS]: note(COSTS),
      [WAIVERS]: note(WAIVERS),
      "20260101T000000--costs-index__meta.org": DBLOCK,
    },
  });

  test("a stored dblock's links render and resolve", async ({
    sbPage,
    sbServer,
  }) => {
    await gotoSilverBulletPage(
      sbPage,
      sbServer,
      "20260101T000000--costs-index__meta.org",
    );
    // The body of a dynamic block is ordinary Org, so its links are real links.
    const link = sbPage
      .locator("#sb-editor .sb-denote-link:not(.sb-wiki-link-page-missing)", {
        hasText: "Court Costs Relating to Evictions",
      })
      .first();
    await expect(link).toBeVisible({ timeout: 20_000 });
  });

  test("updating regenerates the block from the space", async ({
    sbPage,
    sbServer,
  }) => {
    await gotoSilverBulletPage(
      sbPage,
      sbServer,
      "20260101T000000--costs-index__meta.org",
    );
    await expect(sbPage.locator("#sb-editor .cm-content")).toContainText(
      "Court costs",
      { timeout: 20_000 },
    );

    await sbPage.evaluate(() =>
      (globalThis as any).sbRuntime.evalLuaScript(
        'editor.invokeCommand("Denote: Update Dynamic Blocks")',
      ),
    );
    await sbPage.waitForTimeout(2500);
    const text = await sbPage.evaluate(() =>
      (globalThis as any).sbRuntime.evalLuaScript("return editor.getText()"),
    );
    // The waivers note also carries `_costs`, so refreshing picks it up.
    expect(text).toContain(
      "- [[denote:20240125T164237][1a  Court Costs Relating to Evictions]]",
    );
    expect(text).toContain(
      "- [[denote:20240126T082320][1b  Waivers of Filing Fees]]",
    );
    // The delimiters survive: the file stays a valid Org dynamic block.
    expect(text).toContain('#+BEGIN: denote-links :regexp "_costs"');
    expect(text).toContain("#+END:");
  });
});

test.describe("Dynamic blocks update themselves", () => {
  const HUB_DB = `#+title:      Costs index
#+filetags:   :meta:
#+identifier: 20260101T000000

* Court costs

#+BEGIN: denote-links :regexp "_costs" :sort-by-component nil :reverse-sort nil :id-only nil
- [[denote:20240125T164237][1a  Court Costs Relating to Evictions]]
#+END:

Trailing paragraph.
`;
  const PAGE = "20260101T000000--costs-index__meta.org";

  test.use({
    spaceFiles: {
      "index.md": "# Denote\n",
      [COSTS]: note(COSTS),
      [WAIVERS]: note(WAIVERS),
      [PAGE]: HUB_DB,
    },
  });

  test("a stale block refreshes on save, and settles", async ({
    sbPage,
    sbServer,
  }) => {
    await gotoSilverBulletPage(sbPage, sbServer, PAGE);
    const editor = sbPage.locator("#sb-editor .cm-content");
    await expect(editor).toContainText("Court costs", { timeout: 20_000 });

    // Type, which triggers a save.
    await editor.click();
    await sbPage.keyboard.press("Control+End");
    await sbPage.keyboard.type(" edited");
    await sbPage.waitForTimeout(4000);

    const text = await sbPage.evaluate(() =>
      (globalThis as any).sbRuntime.evalLuaScript("return editor.getText()"),
    );
    // The waivers note also carries `_costs`; the stale block picks it up.
    expect(text).toContain(
      "- [[denote:20240126T082320][1b  Waivers of Filing Fees]]",
    );
    // The edit survives the rewrite, and the block stays well-formed.
    expect(text).toContain("Trailing paragraph.");
    expect(text).toContain("edited");
    expect(text).toContain('#+BEGIN: denote-links :regexp "_costs"');
    expect(text.match(/#\+END:/g)?.length).toEqual(1);
    // Exactly one copy of each link: a re-entrant rewrite would duplicate them.
    expect(text.match(/denote:20240126T082320/g)?.length).toEqual(1);

    // It has settled: a further save leaves the block exactly as it is,
    // rather than appending to it each time.
    await sbPage.keyboard.type("!");
    await sbPage.waitForTimeout(4000);
    const after = await sbPage.evaluate(() =>
      (globalThis as any).sbRuntime.evalLuaScript("return editor.getText()"),
    );
    const blockOf = (t: string) =>
      t.slice(t.indexOf("#+BEGIN:"), t.indexOf("#+END:"));
    expect(blockOf(after)).toEqual(blockOf(text));
    expect(after).toContain("edited!");
  });
});

test.describe("Inserting dynamic blocks", () => {
  const PAGE = "20260202T000000--dblock-host__meta.org";
  test.use({
    spaceFiles: {
      "index.md": "# Denote\n",
      [COSTS]: note(COSTS),
      [WAIVERS]: note(WAIVERS),
      [HUB]: note(HUB),
      [PAGE]: `#+title:      Dblock host\n#+identifier: 20260202T000000\n\n* Blocks\n\n`,
    },
  });

  const body = (page: any) =>
    page.evaluate(() =>
      (globalThis as any).sbRuntime.evalLuaScript("return editor.getText()"),
    );

  async function atEnd(page: any) {
    await page.locator("#sb-editor .cm-content").click();
    await page.keyboard.press("Control+End");
  }

  test("Insert Links Block writes a block Emacs would recognise, filled in", async ({
    sbPage,
    sbServer,
  }) => {
    await gotoSilverBulletPage(sbPage, sbServer, PAGE);
    await expect(sbPage.locator("#sb-editor .cm-content")).toContainText(
      "Blocks",
      { timeout: 20_000 },
    );
    await atEnd(sbPage);
    await sbPage.evaluate(() => {
      void (globalThis as any).sbRuntime.evalLuaScript(
        'editor.invokeCommand("Denote: Insert Links Block")',
      );
    });
    const prompt = sbPage
      .locator(".sb-modal-box input, .sb-modal input")
      .first();
    await expect(prompt).toBeVisible({ timeout: 20_000 });
    await prompt.fill("_costs");
    await prompt.press("Enter");
    await sbPage.waitForTimeout(2500);

    const text = await body(sbPage);
    expect(text).toContain('#+BEGIN: denote-links :regexp "_costs"');
    expect(text).toContain("#+END:");
    // Filled in on insert, as `org-update-dblock` does.
    expect(text).toContain(
      "- [[denote:20240125T164237][1a  Court Costs Relating to Evictions]]",
    );
    expect(text).toContain(
      "- [[denote:20240126T082320][1b  Waivers of Filing Fees]]",
    );
  });

  test("Insert Backlinks Block lists the notes linking here", async ({
    sbPage,
    sbServer,
  }) => {
    // The hub links to COSTS, so a backlinks block on COSTS finds it.
    await gotoSilverBulletPage(sbPage, sbServer, COSTS);
    await expect(sbPage.locator("#sb-editor .cm-content")).toContainText(
      "Court Costs",
      { timeout: 20_000 },
    );
    await atEnd(sbPage);
    await sbPage.evaluate(() =>
      (globalThis as any).sbRuntime.evalLuaScript(
        'editor.invokeCommand("Denote: Insert Backlinks Block")',
      ),
    );
    await sbPage.waitForTimeout(3000);
    const text = await body(sbPage);
    expect(text).toContain("#+BEGIN: denote-backlinks");
    expect(text).toContain("[[denote:20231221T085005]");
  });
});

test.describe("A meta keyword is not a meta page", () => {
  // SilverBullet reserves the tag `meta` for infrastructure pages and hides
  // them from the picker's default segment. `meta` is also an ordinary Denote
  // keyword — this library uses it on ten notes — so without care a note
  // keyworded `:law:meta:` becomes unfindable.
  test.use({
    spaceFiles: {
      "index.md": "# Denote\n",
      [HUB]: note(HUB),
      [COSTS]: note(COSTS),
    },
  });

  test("a note keyworded :meta: is findable by title in the picker", async ({
    sbPage,
  }) => {
    const frame = await openPagePicker(sbPage);
    await navInput(sbPage).fill("issues of law");
    await expect(navRows(frame).first()).toHaveText("Issues of Law", {
      timeout: 20_000,
    });
    await sbPage.keyboard.press("Enter");
    await expect(currentPage(sbPage)).toHaveValue(HUB);
  });

  test("and completable with [[ without a caret prefix", async ({
    sbPage,
    sbServer,
  }) => {
    await gotoSilverBulletPage(sbPage, sbServer, COSTS);
    const editor = sbPage.locator("#sb-editor .cm-content");
    await editor.click();
    await sbPage.keyboard.press("Control+End");
    await sbPage.keyboard.press("Enter");
    await sbPage.keyboard.type("[[issues-of-law");
    await expect(sbPage.locator(".cm-tooltip-autocomplete")).toBeVisible({
      timeout: 20_000,
    });
    await sbPage.keyboard.press("Enter");
    await sbPage.waitForTimeout(800);
    await expect(editor).toContainText("[[denote:20231221T085005]");
  });
});

test.describe("Open or create", () => {
  test.use({
    spaceFiles: { "index.md": "# Denote\n", [COSTS]: note(COSTS) },
  });

  async function answer(page: any, expected?: string) {
    const prompt = page.locator(".sb-modal-box input, .sb-modal input").first();
    await expect(prompt).toBeVisible({ timeout: 20_000 });
    if (expected !== undefined) {
      await expect(prompt).toHaveValue(expected);
    }
    await prompt.press("Enter");
    await page.waitForTimeout(600);
  }

  test("the picker's create row mints a Denote note, not a Markdown page", async ({
    sbPage,
    sbServer,
  }) => {
    // `denote-open-or-create`. Before this, the create row navigated to the
    // phrase, which made `Motion To Dismiss.md`: no identifier, outside the
    // naming scheme, and unreachable by every `denote:` link.
    await gotoSilverBulletPage(sbPage, sbServer, COSTS);
    const frame = await openPagePicker(sbPage);
    await navInput(sbPage).fill("Motion To Dismiss");
    await expect(frame.locator(".sb-nav-create .sb-nav-primary")).toHaveText(
      "Motion To Dismiss",
      { timeout: 20_000 },
    );
    await sbPage.keyboard.press("Shift+Enter");

    // Denote uses what was typed at the file prompt as the default title, so
    // the title is not asked for a second time.
    await answer(sbPage, "Motion To Dismiss");
    const filter = sbPage
      .locator(".sb-modal-box input, .sb-modal input")
      .first();
    await expect(filter).toBeVisible({ timeout: 20_000 });
    await filter.press("Escape");

    await expect(currentPage(sbPage)).toHaveValue(
      /^\d{8}T\d{6}--motion-to-dismiss\.org$/,
      { timeout: 20_000 },
    );
    await expect(sbPage.locator("#sb-editor .cm-content")).toContainText(
      "#+title:      Motion To Dismiss",
    );
  });

  test("creating from an ordinary page still makes a Markdown page", async ({
    sbPage,
    sbServer,
  }) => {
    // A space can hold both, and a stock Markdown space must not change.
    await gotoSilverBulletPage(sbPage, sbServer, "index");
    const frame = await openPagePicker(sbPage);
    await navInput(sbPage).fill("Plain New Page");
    await expect(frame.locator(".sb-nav-create .sb-nav-primary")).toHaveText(
      "Plain New Page",
      { timeout: 20_000 },
    );
    await sbPage.keyboard.press("Shift+Enter");
    await expect(sbPage.locator(".sb-modal")).toBeHidden();
    await expect(currentPage(sbPage)).toHaveValue("Plain New Page");
  });
});

test.describe("Link or create", () => {
  test.use({
    spaceFiles: {
      "index.md": "# Denote\n",
      [COSTS]: note(COSTS),
      [WAIVERS]: note(WAIVERS),
    },
  });

  test("links to an existing note by identifier", async ({
    sbPage,
    sbServer,
  }) => {
    await gotoSilverBulletPage(sbPage, sbServer, COSTS);
    const editor = sbPage.locator("#sb-editor .cm-content");
    await expect(editor).toContainText("Court Costs");
    await editor.click();
    await sbPage.keyboard.press("Control+End");
    await sbPage.keyboard.press("Enter");

    await sbPage.evaluate(() => {
      void (globalThis as any).sbRuntime.evalLuaScript(
        `editor.invokeCommand("Denote: Link or Create")`,
      );
    });
    const filter = sbPage
      .locator(".sb-modal-box input, .sb-modal input")
      .first();
    await expect(filter).toBeVisible({ timeout: 20_000 });
    await filter.fill("Waivers");
    await expect(
      sbPage.locator(".sb-result-list .sb-name").first(),
    ).toContainText("Waivers", { timeout: 10_000 });
    await filter.press("Enter");

    // The description is Denote's own: signature, two spaces, title.
    await expect(editor).toContainText(
      "[[denote:20240126T082320][1b  Waivers of Filing Fees]]",
      { timeout: 20_000 },
    );
  });
});

test.describe("Backlinks", () => {
  test.use({
    spaceFiles: {
      "index.md": "# Denote\n",
      [HUB]: note(HUB),
      [COSTS]: note(COSTS),
    },
  });

  /** The Linked Mentions panel sits below the note, so it has to be scrolled to. */
  async function backlinksPanel(page: any) {
    const editor = page.locator("#sb-editor .cm-content");
    await editor.click();
    await page.keyboard.press("Control+End");
    const panel = page.locator(".sb-page-slot-page-bottom");
    await expect(panel).toContainText("Linked Mentions", { timeout: 20_000 });
    return panel;
  }

  test("a backlink is listed by title, with its context", async ({
    sbPage,
    sbServer,
  }) => {
    // `denote-backlinks`, with `denote-backlinks-show-context`. The data was
    // always indexed; what this note needed was to be named by its title.
    await gotoSilverBulletPage(sbPage, sbServer, COSTS);
    const panel = await backlinksPanel(sbPage);

    await expect(panel).toContainText("Issues of Law");
    // Not the slug, which is what a Denote file name is.
    await expect(panel).not.toContainText("issues-of-law__law_meta.org");
    // The context, with the Org link markup reduced to what Org displays --
    // rendered as Markdown it would otherwise come out mangled.
    await expect(panel).toContainText("Court Costs Relating to Evictions");
    await expect(panel).not.toContainText("denote:20240125T164237]");
  });

  test("following a backlink opens the note that links here", async ({
    sbPage,
    sbServer,
  }) => {
    await gotoSilverBulletPage(sbPage, sbServer, COSTS);
    const panel = await backlinksPanel(sbPage);
    await panel.getByText("Issues of Law").first().click();
    await expect(currentPage(sbPage)).toHaveValue(HUB, { timeout: 20_000 });
  });
});

test.describe("Link or create from [[", () => {
  test.use({
    spaceFiles: {
      "index.md": "# Denote\n",
      [HUB]: note(HUB),
      [COSTS]: note(COSTS),
    },
  });

  test("[[ offers a create row that mints a Denote note and links to it", async ({
    sbPage,
    sbServer,
  }) => {
    // A Denote link addresses a note by identifier, so linking to a note that
    // does not exist yet is impossible -- Markdown's aspiring-page route would
    // leave `[[Brand New Note]]`, resolving to nothing, and following it made a
    // Markdown page outside the naming scheme.
    await gotoSilverBulletPage(sbPage, sbServer, COSTS);
    const editor = sbPage.locator("#sb-editor .cm-content");
    await editor.click();
    await sbPage.keyboard.press("Control+End");
    await sbPage.keyboard.press("Enter");
    await sbPage.keyboard.type("[[Brand New Note");

    const tooltip = sbPage.locator(".cm-tooltip-autocomplete");
    await expect(tooltip).toBeVisible({ timeout: 20_000 });
    await expect(tooltip).toContainText('Create "Brand New Note"');
    await sbPage.keyboard.press("Enter");

    // The title is already typed, so it is offered as the default rather than
    // asked for twice; then the keyword prompt, as for any new note.
    const prompt = sbPage
      .locator(".sb-modal-box input, .sb-modal input")
      .first();
    await expect(prompt).toBeVisible({ timeout: 20_000 });
    await expect(prompt).toHaveValue("Brand New Note");
    await prompt.press("Enter");
    const filter = sbPage
      .locator(".sb-modal-box input, .sb-modal input")
      .first();
    await expect(filter).toBeVisible({ timeout: 20_000 });
    await filter.press("Escape");

    // A link by identifier, to a note that now exists -- and we are still in
    // the note being written, as Denote's `:in-background` leaves you.
    await expect(editor).toContainText(
      /\[\[denote:\d{8}T\d{6}\]\[Brand New Note\]\]/,
      {
        timeout: 20_000,
      },
    );
    await expect(currentPage(sbPage)).toHaveValue(COSTS);

    const names = await sbPage.evaluate(async () => {
      const rt = (globalThis as any).sbRuntime;
      return String(
        await rt.evalLuaScript(
          "return table.concat(query[[from d = index.tag('denote') select d.page]], ' | ')",
        ),
      );
    });
    expect(names).toMatch(/\d{8}T\d{6}--brand-new-note\.org/);
  });

  test("the new note is reachable through the link just written", async ({
    sbPage,
    sbServer,
  }) => {
    await gotoSilverBulletPage(sbPage, sbServer, COSTS);
    const editor = sbPage.locator("#sb-editor .cm-content");
    await editor.click();
    await sbPage.keyboard.press("Control+End");
    await sbPage.keyboard.press("Enter");
    await sbPage.keyboard.type("[[Followed Note");
    await expect(sbPage.locator(".cm-tooltip-autocomplete")).toBeVisible({
      timeout: 20_000,
    });
    await sbPage.keyboard.press("Enter");
    const prompt = sbPage
      .locator(".sb-modal-box input, .sb-modal input")
      .first();
    await expect(prompt).toBeVisible({ timeout: 20_000 });
    await prompt.press("Enter");
    await expect(
      sbPage.locator(".sb-modal-box input, .sb-modal input").first(),
    ).toBeVisible({ timeout: 20_000 });
    await sbPage
      .locator(".sb-modal-box input, .sb-modal input")
      .first()
      .press("Escape");
    await expect(editor).toContainText("denote:", { timeout: 20_000 });

    await sbPage.getByText("Followed Note").last().click();
    await expect(currentPage(sbPage)).toHaveValue(
      /^\d{8}T\d{6}--followed-note\.org$/,
      { timeout: 20_000 },
    );
  });
});

test.describe("A bare Org link", () => {
  test.use({
    spaceFiles: {
      "index.md": "# Denote\n",
      "Plain.md": "# A markdown page\n",
      [COSTS]: note(COSTS),
      "Notebook.org": "#+title: Notebook\n\nSome notes.\n",
    },
  });

  test("reaches an existing .org page rather than making a Markdown one", async ({
    sbPage,
    sbServer,
  }) => {
    // `parseToRef` reads an extensionless name as Markdown, so this used to
    // navigate to `Notebook.md` -- creating an empty Markdown page while
    // `Notebook.org` sat right there.
    await gotoSilverBulletPage(sbPage, sbServer, COSTS);
    const editor = sbPage.locator("#sb-editor .cm-content");
    await editor.click();
    await sbPage.keyboard.press("Control+End");
    await sbPage.keyboard.press("Enter");
    await sbPage.keyboard.type("[[Notebook");
    await sbPage.keyboard.press("Escape");
    await sbPage.waitForTimeout(400);
    await sbPage.keyboard.press("ArrowLeft");
    await sbPage.keyboard.press("ArrowLeft");
    await sbPage.keyboard.press(`${mod}+Enter`);
    await expect(currentPage(sbPage)).toHaveValue("Notebook.org", {
      timeout: 20_000,
    });
  });

  test("still reaches an existing Markdown page", async ({
    sbPage,
    sbServer,
  }) => {
    await gotoSilverBulletPage(sbPage, sbServer, COSTS);
    const editor = sbPage.locator("#sb-editor .cm-content");
    await editor.click();
    await sbPage.keyboard.press("Control+End");
    await sbPage.keyboard.press("Enter");
    await sbPage.keyboard.type("[[Plain");
    await sbPage.keyboard.press("Escape");
    await sbPage.waitForTimeout(400);
    await sbPage.keyboard.press("ArrowLeft");
    await sbPage.keyboard.press("ArrowLeft");
    await sbPage.keyboard.press(`${mod}+Enter`);
    await expect(currentPage(sbPage)).toHaveValue("Plain", {
      timeout: 20_000,
    });
  });

  test("creates an Org page, not a Markdown one, where nothing exists", async ({
    sbPage,
    sbServer,
  }) => {
    await gotoSilverBulletPage(sbPage, sbServer, COSTS);
    const editor = sbPage.locator("#sb-editor .cm-content");
    await editor.click();
    await sbPage.keyboard.press("Control+End");
    await sbPage.keyboard.press("Enter");
    await sbPage.keyboard.type("[[Hand Typed");
    await sbPage.keyboard.press("Escape");
    await sbPage.waitForTimeout(400);
    await sbPage.keyboard.press("ArrowLeft");
    await sbPage.keyboard.press("ArrowLeft");
    await sbPage.keyboard.press(`${mod}+Enter`);
    await expect(currentPage(sbPage)).toHaveValue("Hand Typed.org", {
      timeout: 20_000,
    });
  });
});
