import { expect, gotoSilverBulletPage, test } from "./fixtures.ts";

// A described link stays collapsed with the cursor on it, hiding its `[[…][`
// and `]]`. Everything else in SilverBullet reveals its markup under the
// cursor, so these paths — motion, deletion, selection, copying — are the ones
// that have no precedent to lean on.

const LINK = "[[denote:20240125T164237][clinical affairs]]";
const PAGE = `#+title: Collapsed

- ${LINK} tail words
`;

test.use({
  spaceFiles: {
    "index.md": "# Home\n",
    "Collapsed.org": PAGE,
    "20240125T164237--court-costs__costs.org":
      "#+title:      Court Costs\n#+identifier: 20240125T164237\n\nBody.\n",
  },
});

const doc = (p: any) =>
  p.evaluate(() =>
    (globalThis as any).sbRuntime.evalLuaScript("return editor.getText()"),
  );
const cursor = (p: any) =>
  p.evaluate(() =>
    (globalThis as any).sbRuntime.evalLuaScript("return editor.getCursor()"),
  );

async function open(sbPage: any, sbServer: any) {
  await gotoSilverBulletPage(sbPage, sbServer, "Collapsed.org");
  await expect(sbPage.locator("#sb-editor .cm-content")).toContainText(
    "clinical",
  );
  await sbPage.waitForTimeout(900);
}

async function at(sbPage: any, pos: number) {
  await sbPage.evaluate(
    (p: number) =>
      (globalThis as any).sbRuntime.evalLuaScript(`editor.moveCursor(${p})`),
    pos,
  );
  await sbPage.waitForTimeout(400);
}

function marks(text: string) {
  const linkFrom = text.indexOf("[[denote:");
  const descFrom = text.indexOf("][", linkFrom) + 2;
  const descTo = text.indexOf("]]", descFrom);
  return { linkFrom, descFrom, descTo, linkTo: descTo + 2 };
}

test("copying carries the link's source and no zero-width space", async ({
  sbPage,
  sbServer,
  context,
  browserName,
}) => {
  // Reading the clipboard needs a permission only Chromium exposes.
  test.skip(browserName !== "chromium", "clipboard-read is Chromium-only");
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await open(sbPage, sbServer);
  await sbPage.locator("#sb-editor .cm-content").click();
  await sbPage.keyboard.press("ControlOrMeta+a");
  await sbPage.waitForTimeout(200);
  await sbPage.keyboard.press("ControlOrMeta+c");
  await sbPage.waitForTimeout(500);
  const clip: string = await sbPage.evaluate(() =>
    navigator.clipboard.readText(),
  );
  // The anchor that lets Firefox put a caret after a hidden `]]` is widget
  // DOM, not document text, so it must never reach the clipboard.
  expect(clip).toContain(LINK);
  expect(clip).not.toContain("​");
});

test("arrow keys step over the machinery, never into it", async ({
  sbPage,
  sbServer,
}) => {
  await open(sbPage, sbServer);
  const text: string = await doc(sbPage);
  const m = marks(text);
  await at(sbPage, text.indexOf("- [["));

  const seen: number[] = [];
  for (let i = 0; i < 10; i++) {
    await sbPage.keyboard.press("ArrowRight");
    await sbPage.waitForTimeout(80);
    seen.push(await cursor(sbPage));
  }
  expect(seen.filter((p) => p > m.linkFrom && p < m.descFrom)).toEqual([]);
  expect(seen.filter((p) => p > m.descTo && p < m.linkTo)).toEqual([]);
});

test("double-clicking selects a word of the description, not the markup", async ({
  sbPage,
  sbServer,
}) => {
  await open(sbPage, sbServer);
  // Near the left edge, so the double-click lands inside "clinical" rather
  // than on the space at the element's centre.
  await sbPage
    .getByText("clinical affairs")
    .first()
    .dblclick({ modifiers: ["Alt"], position: { x: 8, y: 6 } });
  await sbPage.waitForTimeout(500);
  const selected = await sbPage.evaluate(() =>
    (globalThis as any).sbRuntime.evalLuaScript(
      "return editor.getSelection().text",
    ),
  );
  expect(selected).toEqual("clinical");
});

for (const [label, key, offset] of [
  ["Backspace just after it", "Backspace", "after"],
  ["Delete just before it", "Delete", "before"],
] as const) {
  test(`${label} removes the whole link, not half of it`, async ({
    sbPage,
    sbServer,
  }) => {
    await open(sbPage, sbServer);
    const text: string = await doc(sbPage);
    const m = marks(text);
    await at(sbPage, offset === "after" ? m.linkTo : m.linkFrom);

    await sbPage.keyboard.press(key);
    await sbPage.waitForTimeout(500);
    const line = (await doc(sbPage))
      .split("\n")
      .find((l: string) => l.startsWith("-"));
    // The machinery is atomic, so one keypress used to take `[[…][` or `]]`
    // and leave the rest behind as broken syntax.
    expect(line).toEqual("-  tail words");
  });
}

test.describe("with vim mode", () => {
  async function vimPage(sbPage: any, sbServer: any) {
    await open(sbPage, sbServer);
    await sbPage.evaluate(() =>
      (globalThis as any).sbRuntime.evalLuaScript(
        'editor.invokeCommand("Editor: Toggle Vim Mode")',
      ),
    );
    await expect(sbPage.locator(".cm-vim-panel")).toHaveCount(1, {
      timeout: 10_000,
    });
    await sbPage.waitForTimeout(500);
    // Vim has to be on when the editor is built, as a real session has it.
    await gotoSilverBulletPage(sbPage, sbServer, "Collapsed.org");
    await expect(sbPage.locator(".cm-vim-panel")).toHaveCount(1, {
      timeout: 10_000,
    });
    await sbPage.waitForTimeout(1000);
  }

  test("normal-mode Backspace stays a motion", async ({ sbPage, sbServer }) => {
    await vimPage(sbPage, sbServer);
    const text: string = await doc(sbPage);
    await at(sbPage, marks(text).linkTo);
    await sbPage.keyboard.press("Escape");
    await sbPage.waitForTimeout(300);

    await sbPage.keyboard.press("Backspace");
    await sbPage.waitForTimeout(500);
    // `<BS>` is `h` in normal mode: it moves, it does not delete.
    expect(await doc(sbPage)).toEqual(text);
  });

  test("insert-mode Backspace inside the description deletes one character", async ({
    sbPage,
    sbServer,
  }) => {
    await vimPage(sbPage, sbServer);
    const text: string = await doc(sbPage);
    await at(sbPage, marks(text).descFrom + 4);
    await sbPage.keyboard.press("Escape");
    await sbPage.waitForTimeout(250);
    await sbPage.keyboard.press("i");
    await sbPage.waitForTimeout(250);

    await sbPage.keyboard.press("Backspace");
    await sbPage.waitForTimeout(500);
    const line = (await doc(sbPage))
      .split("\n")
      .find((l: string) => l.startsWith("-"));
    expect(line).toEqual(
      "- [[denote:20240125T164237][cliical affairs]] tail words",
    );
  });

  for (const [keys, expected] of [
    ["x", "- [[denote:20240125T164237][linical affairs]] tail words"],
    ["dw", "- [[denote:20240125T164237][affairs]] tail words"],
    ["rz", "- [[denote:20240125T164237][zlinical affairs]] tail words"],
  ] as const) {
    test(`${keys} on the description edits only the description`, async ({
      sbPage,
      sbServer,
    }) => {
      await vimPage(sbPage, sbServer);
      const text: string = await doc(sbPage);
      await at(sbPage, marks(text).descFrom);
      await sbPage.keyboard.press("Escape");
      await sbPage.waitForTimeout(300);

      for (const k of keys) {
        await sbPage.keyboard.press(k);
        await sbPage.waitForTimeout(150);
      }
      await sbPage.waitForTimeout(400);
      const line = (await doc(sbPage))
        .split("\n")
        .find((l: string) => l.startsWith("-"));
      expect(line).toEqual(expected);
    });
  }
});
