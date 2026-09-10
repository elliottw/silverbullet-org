import { expect, gotoSilverBulletPage, test } from "./fixtures.ts";

const PAGE = `# Alpha

alpha body one
alpha body two

# Beta

* parent item
  * child one

Final line.
`;

const FAT_CURSOR = ".cm-fat-cursor.cm-cursor-primary";

async function enableVim(page: any) {
  await page.evaluate(() =>
    (globalThis as any).sbRuntime.evalLuaScript(
      'editor.invokeCommand("Editor: Toggle Vim Mode")',
    ),
  );
  await expect(page.locator(".cm-vim-panel")).toHaveCount(1, {
    timeout: 10_000,
  });
}

/** How the block cursor is actually painted, not merely whether it exists. */
async function cursorPaint(page: any) {
  return await page.evaluate((sel: string) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const cs = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    const transparent = (c: string) =>
      c === "transparent" || /rgba\(\s*0,\s*0,\s*0,\s*0\s*\)/.test(c);
    return {
      sized: rect.width > 0 && rect.height > 0,
      filled: !transparent(cs.backgroundColor),
      outlined: cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) > 0,
    };
  }, FAT_CURSOR);
}

test.describe("Vim block cursor", () => {
  test.use({ spaceFiles: { "index.md": PAGE } });

  test("stays visible while moving through the document", async ({
    sbPage,
    sbServer,
  }) => {
    await gotoSilverBulletPage(sbPage, sbServer, "index");
    await enableVim(sbPage);
    await sbPage.locator("#sb-editor .cm-content").click();
    await sbPage.evaluate(() =>
      (globalThis as any).sbRuntime.evalLuaScript("editor.moveCursor(0)"),
    );
    await sbPage.waitForTimeout(400);

    for (let i = 0; i < PAGE.split("\n").length; i++) {
      const paint = await cursorPaint(sbPage);
      expect(paint, `line ${i + 1}`).not.toBeNull();
      expect(paint!.sized, `line ${i + 1} has size`).toBe(true);
      expect(paint!.filled, `line ${i + 1} is painted`).toBe(true);
      await sbPage.keyboard.press("j");
      await sbPage.waitForTimeout(180);
    }
  });

  test("stays visible when the editor loses focus", async ({
    sbPage,
    sbServer,
  }) => {
    await gotoSilverBulletPage(sbPage, sbServer, "index");
    await enableVim(sbPage);
    await sbPage.locator("#sb-editor .cm-content").click();
    await sbPage.waitForTimeout(400);
    expect((await cursorPaint(sbPage))!.filled).toBe(true);

    await sbPage.evaluate(() => {
      (document.activeElement as HTMLElement | null)?.blur();
    });
    await sbPage.waitForTimeout(500);
    expect(
      await sbPage.locator(".cm-editor.cm-focused").count(),
      "editor is blurred",
    ).toBe(0);

    // Unfocused, codemirror-vim draws the block hollow. It must still be
    // drawn *somehow*: a cursor that is present but painted entirely in
    // transparent is the bug this guards.
    const paint = (await cursorPaint(sbPage))!;
    expect(paint.sized).toBe(true);
    expect(paint.filled || paint.outlined, "visible when unfocused").toBe(true);
  });
});

// A described link stays collapsed with the cursor on it, so its `[[…][` and
// `]]` are hidden while being edited around — which is exactly when an
// insertion can land on the wrong side of them.
test.describe("Vim insertion around a collapsed link", () => {
  test.use({
    spaceFiles: {
      "index.md": "# Home\n",
      "Links.org": `#+title:      Links
#+date:       [0000-00-00 00:00]
#+identifier: 00000000T000000

** missions

- [[denote:20260819T162106][upmc community paramedic]]
- [[https://example.com][an external one]]
- 
** quick reference 
- [[denote:20240124T104100][mitfcu]]
- Mid line [[https://example.com][a link]] and more.

* Recently modified
\${query[[
  from p = index.contentPages()
  order by p.lastModified desc
  limit 10
  select templates.fullPageItem(p)
]]}

* Notes needing attention
\${some(query[[
  from t = index.tasks()
  where not t.done
  order by t.pageLastModified desc
  limit 10
  select templates.taskItem(t)
]]) or "_Nothing outstanding._"}
`,
    },
  });

  for (const lead of ["- [[denote:20260819", "- [[https://", "- Mid line"]) {
    test(`A appends past the hidden ]] — ${lead}`, async ({
      sbPage,
      sbServer,
    }) => {
      await gotoSilverBulletPage(sbPage, sbServer, "Links.org");
      await expect(sbPage.locator("#sb-editor .cm-content")).toContainText(
        "upmc community paramedic",
      );
      await enableVim(sbPage);
      // Let the page settle: the query block renders as a widget, and the
      // line geometry this bug depends on is not final until it has.
      await sbPage.waitForTimeout(1500);

      const read = () =>
        sbPage.evaluate(() =>
          (globalThis as any).sbRuntime.evalLuaScript(
            "return editor.getText()",
          ),
        );
      const text: string = await read();
      const lineStart = text.indexOf(lead);

      // From the very start of the line, which is how this was first hit: a
      // bullet whose link runs to the end of the line.
      await sbPage.evaluate(
        (p: number) =>
          (globalThis as any).sbRuntime.evalLuaScript(
            `editor.moveCursor(${p})`,
          ),
        lineStart,
      );
      await sbPage.waitForTimeout(500);
      await sbPage.keyboard.press("Escape");
      await sbPage.waitForTimeout(300);
      await sbPage.keyboard.press("Shift+A");
      await sbPage.waitForTimeout(300);
      await sbPage.keyboard.type("XX");
      await sbPage.waitForTimeout(400);

      const line = (await read()).split("\n").find((l) => l.startsWith(lead));
      // Appended at the end of the line, not tucked inside the link.
      expect(line).not.toContain("XX]]");
      expect(line?.endsWith("XX")).toBe(true);
    });
  }
});

// `org-return-follows-link`: Return follows the link under the cursor, and is
// otherwise vim's own `<CR>` — `j^`, down a line to its first non-blank.
test.describe("Return follows a link in normal mode", () => {
  const NOTE = "20240125T164237--court-costs__costs.org";
  test.use({
    spaceFiles: {
      "index.md": "# Home\n",
      "Ret.org": `#+title: Ret

** missions
- [[denote:20240125T164237][a note]]
- plain line with no link at all
`,
      [NOTE]:
        "#+title:      Court Costs\n#+identifier: 20240125T164237\n\nBody.\n",
    },
  });

  /** Vim mode has to be on when the editor is *built*, as a real session is. */
  async function vimPage(sbPage: any, sbServer: any) {
    await gotoSilverBulletPage(sbPage, sbServer, "Ret.org");
    await expect(sbPage.locator("#sb-editor .cm-content")).toContainText(
      "a note",
    );
    await enableVim(sbPage);
    await sbPage.waitForTimeout(800);
    await gotoSilverBulletPage(sbPage, sbServer, "Ret.org");
    await expect(sbPage.locator(".cm-vim-panel")).toHaveCount(1, {
      timeout: 10_000,
    });
    await sbPage.waitForTimeout(1200);
  }

  const docOf = (sbPage: any) =>
    sbPage.evaluate(() =>
      (globalThis as any).sbRuntime.evalLuaScript("return editor.getText()"),
    );
  const cursorOf = (sbPage: any) =>
    sbPage.evaluate(() =>
      (globalThis as any).sbRuntime.evalLuaScript("return editor.getCursor()"),
    );

  async function normalModeAt(sbPage: any, pos: number) {
    await sbPage.evaluate(
      (p: number) =>
        (globalThis as any).sbRuntime.evalLuaScript(`editor.moveCursor(${p})`),
      pos,
    );
    await sbPage.waitForTimeout(400);
    await sbPage.keyboard.press("Escape");
    await sbPage.waitForTimeout(300);
    await expect(sbPage.locator(".cm-vim-panel")).toContainText("NORMAL");
  }

  test("on a link, Return follows it", async ({ sbPage, sbServer }) => {
    await vimPage(sbPage, sbServer);
    const text: string = await docOf(sbPage);
    await normalModeAt(sbPage, text.indexOf("a note") + 2);

    await sbPage.keyboard.press("Enter");
    await expect(sbPage.locator("#sb-current-page input.sb-input")).toHaveValue(
      NOTE,
      { timeout: 20_000 },
    );
  });

  test("off a link, Return is still vim's j^", async ({ sbPage, sbServer }) => {
    await vimPage(sbPage, sbServer);
    const text: string = await docOf(sbPage);
    // On the `** missions` heading; the next line is the bullet below it.
    await normalModeAt(sbPage, text.indexOf("** missions") + 3);

    await sbPage.keyboard.press("Enter");
    await sbPage.waitForTimeout(800);
    // Down a line, to its first non-blank — and no line break inserted.
    expect(await cursorOf(sbPage)).toEqual(text.indexOf("- [[denote:"));
    expect(await docOf(sbPage)).toEqual(text);
  });

  test("in insert mode, Return still breaks the line", async ({
    sbPage,
    sbServer,
  }) => {
    await vimPage(sbPage, sbServer);
    const text: string = await docOf(sbPage);
    await normalModeAt(sbPage, text.indexOf("plain line") + 5);

    await sbPage.keyboard.press("i");
    await expect(sbPage.locator(".cm-vim-panel")).toContainText("INSERT");
    await sbPage.keyboard.press("Enter");
    await sbPage.waitForTimeout(600);
    expect((await docOf(sbPage)).split("\n").length).toEqual(
      text.split("\n").length + 1,
    );
  });
});
