import { expect, gotoSilverBulletPage, test } from "./fixtures.ts";

// Depth read off the left edge instead of off the type: one size throughout,
// weight descending to body copy, and a hairline per level crossed.
const NOTE = `#+title:      Outline
#+identifier: 20261030T090000

Preamble, before any section.

* Alpha
Body of alpha.
** Beta
Body of beta.
*** Gamma
Body of gamma.
**** Delta
Body of delta.
* Second top level
Body again.
`;

test.describe("Outline indentation", () => {
  test.use({
    spaceFiles: {
      "index.md": "# Home\n",
      "20261030T090000--outline.org": NOTE,
    },
  });

  /** Left edge and type of each line, as rendered. */
  const lines = (page: any) =>
    page.evaluate(() =>
      [...document.querySelectorAll("#sb-editor .cm-line")].map((el) => {
        const s = getComputedStyle(el);
        return {
          text: (el.textContent ?? "").trim().slice(0, 24),
          // Unrounded: the step is a rem value, so rounding each line
          // independently puts a pixel of slack between n*step and the nth
          // line's own padding.
          padLeft: parseFloat(s.paddingLeft),
          size: Math.round(parseFloat(s.fontSize)),
          weight: s.fontWeight,
          guides: parseFloat(getComputedStyle(el, "::before").width) || 0,
        };
      }),
    );

  test("each level steps in, and the preamble does not", async ({
    sbPage,
    sbServer,
  }) => {
    await gotoSilverBulletPage(
      sbPage,
      sbServer,
      "20261030T090000--outline.org",
    );
    await expect(sbPage.locator("#sb-editor .cm-content")).toContainText(
      "Body of delta.",
      { timeout: 20_000 },
    );
    const rendered = await lines(sbPage);
    const at = (needle: string) =>
      rendered.find((l: any) => l.text.startsWith(needle))!;

    // Nothing before the first section is indented.
    expect(at("Preamble").padLeft).toBe(0);
    // A heading sits one step out from its own body.
    const alpha = at("Alpha");
    const alphaBody = at("Body of alpha");
    expect(alpha.padLeft).toBe(0);
    expect(alphaBody.padLeft).toBeGreaterThan(alpha.padLeft);
    // Each level steps in by the same amount.
    const step = alphaBody.padLeft - alpha.padLeft;
    expect(step).toBeGreaterThan(8); // a real step, not a hairline
    expect(at("Beta").padLeft).toBeCloseTo(step, 1);
    expect(at("Gamma").padLeft).toBeCloseTo(step * 2, 1);
    expect(at("Delta").padLeft).toBeCloseTo(step * 3, 1);
    expect(at("Body of delta").padLeft).toBeCloseTo(step * 4, 1);
    // And coming back out returns to the top.
    expect(at("Second top level").padLeft).toBe(0);
  });

  test("one size throughout, weight descending to body copy", async ({
    sbPage,
    sbServer,
  }) => {
    await gotoSilverBulletPage(
      sbPage,
      sbServer,
      "20261030T090000--outline.org",
    );
    await expect(sbPage.locator("#sb-editor .cm-content")).toContainText(
      "Body of delta.",
      { timeout: 20_000 },
    );
    const rendered = await lines(sbPage);
    const at = (needle: string) =>
      rendered.find((l: any) => l.text.startsWith(needle))!;

    const body = at("Body of alpha");
    for (const name of ["Alpha", "Beta", "Gamma", "Delta"]) {
      expect(at(name).size).toBe(body.size);
    }
    // Bold, semibold, medium, then body weight -- and body copy itself.
    expect(+at("Alpha").weight).toBeGreaterThan(+at("Beta").weight);
    expect(+at("Beta").weight).toBeGreaterThan(+at("Gamma").weight);
    expect(+at("Gamma").weight).toBeGreaterThan(+at("Delta").weight);
    expect(at("Delta").weight).toBe(body.weight);
  });

  test("the guides span exactly the levels crossed", async ({
    sbPage,
    sbServer,
  }) => {
    await gotoSilverBulletPage(
      sbPage,
      sbServer,
      "20261030T090000--outline.org",
    );
    await expect(sbPage.locator("#sb-editor .cm-content")).toContainText(
      "Body of delta.",
      { timeout: 20_000 },
    );
    const rendered = await lines(sbPage);
    const at = (needle: string) =>
      rendered.find((l: any) => l.text.startsWith(needle))!;
    // Nothing to draw where nothing is indented.
    expect(at("Preamble").guides).toBe(0);
    expect(at("Alpha").guides).toBe(0);
    // Otherwise the bar zone is the indent, so adjacent lines paint the same
    // x positions and the hairlines join down a subtree.
    expect(at("Body of alpha").guides).toBeCloseTo(
      at("Body of alpha").padLeft,
      1,
    );
    expect(at("Body of delta").guides).toBeCloseTo(
      at("Body of delta").padLeft,
      1,
    );
  });
});
