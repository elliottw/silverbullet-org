import { expect, gotoSilverBulletPage, test } from "./fixtures.ts";
import {
  currentPage,
  navInput,
  navRows,
  openPagePicker,
} from "./navigator-ui.ts";

// End-to-end cover for `.org` files as first-class pages: they open in the
// page editor (not a document editor), highlight through the Org parser, and
// land in the same object index Markdown pages do — so a Markdown query page
// can see an Org page's tasks.

const PROJECT_ORG = `#+TITLE: Warehouse move

* Planning
Some *bold* text and _underlined_ plans.

** Milestones
- [ ] Draft the floor plan
- [X] Book the truck

#+BEGIN_SRC lua
print("hello from org")
#+END_SRC

* Delivery
Another paragraph.
`;

const DASHBOARD = `# Dashboard

# Open tasks
\${template.each(query[[
  from t = tags.task
  where not t.done
  order by t.name
]], templates.taskItem)}

# Headers
\${query[[
  from h = tags.header
  where h.page == "Project.org"
  order by h.pos
]]}
`;

test.describe("Org Mode pages", () => {
  test.use({
    spaceFiles: {
      "index.md": "# Welcome\nThis is the index.",
      "Project.org": PROJECT_ORG,
      "Dashboard.md": DASHBOARD,
    },
  });

  test("an .org file opens in the page editor with Org highlighting", async ({
    sbPage,
    sbServer,
  }) => {
    await gotoSilverBulletPage(sbPage, sbServer, "Project.org");
    const editor = sbPage.locator("#sb-editor .cm-content");
    await expect(editor).toContainText("Planning");

    // A `*` headline is highlighted with the same class as a Markdown `#` one.
    await expect(
      sbPage.locator("#sb-editor .sb-h1", { hasText: "Planning" }).first(),
    ).toBeVisible({ timeout: 10_000 });
    await expect(
      sbPage.locator("#sb-editor .sb-h2", { hasText: "Milestones" }).first(),
    ).toBeVisible();

    // Org emphasis reuses the Markdown decoration.
    await expect(
      sbPage.locator("#sb-editor .sb-strong", { hasText: "bold" }).first(),
    ).toBeVisible();

    // Org's `_underline_` has no Markdown equivalent, so it gets its own class,
    // and its markers hide in live preview like every other emphasis marker.
    await expect(
      sbPage
        .locator("#sb-editor .sb-org-underline", { hasText: "underlined" })
        .first(),
    ).toBeVisible();

    // Checkbox items become real, clickable tasks.
    const checkboxes = sbPage.locator(
      "#sb-editor .cm-content .sb-checkbox input[type='checkbox']",
    );
    await expect(checkboxes).toHaveCount(2, { timeout: 10_000 });
    await expect(checkboxes.nth(0)).not.toBeChecked();
    await expect(checkboxes.nth(1)).toBeChecked();

    // A `#+BEGIN_SRC lua` block is a FencedCode whose language comes from its
    // CodeInfo node, and its body is highlighted by the nested Lua parser.
    // Reading the language off the Markdown fence instead used to throw out of
    // the whole decoration state field, leaving the page unopenable.
    await expect(
      sbPage.locator("#sb-editor .sb-code-info", { hasText: "lua" }),
    ).toBeVisible();
    await expect(
      sbPage
        .locator("#sb-editor .sb-string", { hasText: "hello from org" })
        .first(),
    ).toBeVisible({ timeout: 10_000 });
  });

  test("Org pages are indexed alongside Markdown pages", async ({
    sbPage,
    sbServer,
  }) => {
    await gotoSilverBulletPage(sbPage, sbServer, "Dashboard");
    const editor = sbPage.locator("#sb-editor .cm-content");

    // The open task from the Org page shows up in a Markdown query, and the
    // finished one does not.
    await expect(editor).toContainText("Draft the floor plan", {
      timeout: 20_000,
    });
    await expect(editor).not.toContainText("Book the truck");

    // Org headlines are indexed as headers, in document order.
    await expect(editor).toContainText("Planning");
    await expect(editor).toContainText("Milestones");
    await expect(editor).toContainText("Delivery");
  });

  test("the page picker lists an Org page under its full name", async ({
    sbPage,
  }) => {
    const frame = await openPagePicker(sbPage);
    await navInput(sbPage).fill("Project");
    // The `.org` extension is part of the page name, which is what keeps
    // `Project.md` and `Project.org` distinct.
    await expect(navRows(frame).first()).toHaveText("Project.org", {
      timeout: 20_000,
    });
    await sbPage.keyboard.press("Enter");
    await expect(currentPage(sbPage)).toHaveValue("Project.org");
  });
});

test.describe("Space Lua in Org pages", () => {
  test.use({
    spaceFiles: {
      "index.md": "# Welcome\n",
      "Project.org": PROJECT_ORG,
      // `${...}` is a SilverBullet construct, not an Org one — but without it
      // an Org page cannot hold a query, which makes an Org home page inert.
      "Dash.org": `#+title:      Dash\n\n* Pages\n\n\${query[[from p = tags.page order by p.name limit 3 select p.name]]}\n\n* Sum\n\n\${1 + 2}\n`,
    },
  });

  test("a query in an Org page renders instead of showing its source", async ({
    sbPage,
    sbServer,
  }) => {
    await gotoSilverBulletPage(sbPage, sbServer, "Dash.org");
    const editor = sbPage.locator("#sb-editor .cm-content");
    await expect(editor).toContainText("Dash", { timeout: 20_000 });
    // The query rendered its rows, and the expression its result.
    await expect(editor).toContainText("Dash.org", { timeout: 20_000 });
    await expect(editor).toContainText("Sum", { timeout: 20_000 });
    await expect(editor).toContainText("3", { timeout: 20_000 });
    // The directive source is replaced, not shown alongside.
    await expect(editor).not.toContainText("${query");
    await expect(editor).not.toContainText("${1 + 2}");
  });
});

test.describe("Org Mode and vim", () => {
  test.use({
    spaceFiles: {
      "index.md": "# Welcome\nThis is the index.",
      "Project.org": PROJECT_ORG,
    },
  });

  // Org pages go through their own language extension, so vim — which is
  // attached in a compartment independent of the language — is worth pinning.
  test("vim mode stays active on an Org page", async ({ sbPage, sbServer }) => {
    await gotoSilverBulletPage(sbPage, sbServer, "index");
    await sbPage.evaluate(() =>
      (globalThis as any).sbRuntime.evalLuaScript(
        'editor.invokeCommand("Editor: Toggle Vim Mode")',
      ),
    );
    await expect(sbPage.locator(".cm-vim-panel")).toHaveCount(1, {
      timeout: 10_000,
    });

    await sbPage.evaluate(() =>
      (globalThis as any).sbRuntime.evalLuaScript(
        'editor.navigate("Project.org")',
      ),
    );
    await expect(sbPage.locator("#sb-editor .cm-content")).toContainText(
      "Planning",
      { timeout: 10_000 },
    );
    await expect(sbPage.locator(".cm-vim-panel")).toHaveCount(1);
    await expect(sbPage.locator(".cm-vim-panel")).toHaveText("--NORMAL--");

    // Normal mode is genuinely in force, not just rendered: `i` inserts nothing.
    const editor = sbPage.locator("#sb-editor .cm-content");
    await editor.click();
    const before = await editor.innerText();
    await sbPage.keyboard.press("i");
    await sbPage.keyboard.press("Escape");
    expect(await editor.innerText()).toEqual(before);
  });
});
