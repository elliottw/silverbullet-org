import { expect, gotoSilverBulletPage, test } from "./fixtures.ts";

// `variable-pitch-mode`, and the promise that it is fonts only: the measure,
// the leading and the code face have to come out of the toggle unchanged.
const NOTE = `#+title:      Pitch
#+identifier: 20261026T130000

Some prose to measure.

#+BEGIN_SRC js
const code = "stays monospace";
#+END_SRC
`;

test.describe("Toggle Variable Pitch", () => {
  test.use({
    spaceFiles: {
      "index.md": "# Home\n",
      "20261026T130000--pitch.org": NOTE,
    },
  });

  const metrics = (page: any) =>
    page.evaluate(() => {
      const content = document.querySelector("#sb-editor .cm-content")!;
      const code = document.querySelector("#sb-editor .sb-line-fenced-code");
      const f = (el: Element | null) =>
        el ? getComputedStyle(el).fontFamily : "";
      return {
        pitch: document.documentElement.dataset.pitch,
        prose: f(content),
        code: f(code),
        width: Math.round(content.getBoundingClientRect().width),
        leading: getComputedStyle(content).lineHeight,
      };
    });

  const toggle = (page: any) =>
    page.evaluate(() => {
      void (globalThis as any).sbRuntime.evalLuaScript(
        `editor.invokeCommand("Editor: Toggle Variable Pitch")`,
      );
    });

  test("switches the prose face, leaves code and layout alone", async ({
    sbPage,
    sbServer,
  }) => {
    await gotoSilverBulletPage(sbPage, sbServer, "20261026T130000--pitch.org");
    await expect(sbPage.locator("#sb-editor .cm-content")).toContainText(
      "Some prose to measure.",
      { timeout: 20_000 },
    );

    const variable = await metrics(sbPage);
    expect(variable.pitch).toBe("variable");
    expect(variable.prose).not.toMatch(/iA-Mono|Menlo|monospace/);
    // Code is monospace even while prose is not -- the whole point of the
    // split, and the thing that broke when only one token existed.
    expect(variable.code).toMatch(/iA-Mono|Menlo|monospace/);

    await toggle(sbPage);
    await expect
      .poll(
        () => sbPage.evaluate(() => document.documentElement.dataset.pitch),
        {
          timeout: 15_000,
        },
      )
      .toBe("mono");

    const mono = await metrics(sbPage);
    expect(mono.prose).toMatch(/iA-Mono|Menlo|monospace/);
    expect(mono.code).toMatch(/iA-Mono|Menlo|monospace/);
    // Fonts only: same measure, same leading.
    expect(mono.width).toBe(variable.width);
    expect(mono.leading).toBe(variable.leading);

    // And back.
    await toggle(sbPage);
    await expect
      .poll(
        () => sbPage.evaluate(() => document.documentElement.dataset.pitch),
        {
          timeout: 15_000,
        },
      )
      .toBe("variable");
  });

  test("the choice survives a reload", async ({ sbPage, sbServer }) => {
    await gotoSilverBulletPage(sbPage, sbServer, "20261026T130000--pitch.org");
    await expect(sbPage.locator("#sb-editor .cm-content")).toContainText(
      "Some prose",
      { timeout: 20_000 },
    );
    await toggle(sbPage);
    await expect
      .poll(
        () => sbPage.evaluate(() => document.documentElement.dataset.pitch),
        {
          timeout: 15_000,
        },
      )
      .toBe("mono");

    await sbPage.reload();
    await expect(sbPage.locator("#sb-editor .cm-content")).toContainText(
      "Some prose",
      { timeout: 20_000 },
    );
    // Stored per client, like dark mode: a display preference belongs to the
    // device, not the space.
    await expect
      .poll(
        () => sbPage.evaluate(() => document.documentElement.dataset.pitch),
        {
          timeout: 20_000,
        },
      )
      .toBe("mono");
  });
});
