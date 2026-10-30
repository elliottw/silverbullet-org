import { expect, gotoSilverBulletPage, test } from "./fixtures.ts";

// Putting the caret on a heading reveals its `*` markers. They hang back into
// the indent so the heading's own text stays put -- and the compensation has
// to be exact, because a jump as the caret lands is the kind of thing you
// feel on every keystroke.
const NOTE = `#+title:      Shift
#+identifier: 20261030T120000

* Alpha heading
body of alpha
** Beta heading
body of beta
*** Gamma heading
body of gamma
`;

test.describe("Revealing a heading's markers", () => {
  test.use({
    spaceFiles: {
      "index.md": "# Home\n",
      "20261030T120000--shift.org": NOTE,
    },
  });

  /** The x of a heading's first text glyph, measured from its text node. */
  const textX = (page: any, needle: string) =>
    page.evaluate((text: string) => {
      const line = [...document.querySelectorAll("#sb-editor .cm-line")].find(
        (l) => (l.textContent ?? "").includes(text),
      )!;
      // Walk to the text node holding the heading's words, skipping the
      // marker run, and measure where it actually starts.
      const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
      let node: Node | null;
      while ((node = walker.nextNode())) {
        const idx = (node.textContent ?? "").indexOf(text);
        if (idx === -1) continue;
        const range = document.createRange();
        range.setStart(node, idx);
        range.setEnd(node, idx + 1);
        return range.getBoundingClientRect().left;
      }
      return null;
    }, needle);

  const putCaretOn = (page: any, needle: string) =>
    page.evaluate((text: string) => {
      const view = (globalThis as any).client.editorView;
      const pos = view.state.doc.toString().indexOf(text);
      view.dispatch({ selection: { anchor: pos + 2 } });
      view.focus();
    }, needle);

  for (const heading of ["Alpha heading", "Beta heading", "Gamma heading"]) {
    test(`"${heading}" does not move when the caret arrives`, async ({
      sbPage,
      sbServer,
    }) => {
      await gotoSilverBulletPage(
        sbPage,
        sbServer,
        "20261030T120000--shift.org",
      );
      await expect(sbPage.locator("#sb-editor .cm-content")).toContainText(
        "body of gamma",
        { timeout: 20_000 },
      );
      // Caret parked elsewhere: markers hidden.
      await putCaretOn(sbPage, "body of gamma");
      await sbPage.waitForTimeout(300);
      const before = await textX(sbPage, heading);
      expect(before).not.toBeNull();

      // Caret on the heading: markers revealed, hanging into the indent.
      await putCaretOn(sbPage, heading);
      await sbPage.waitForTimeout(300);
      const after = await textX(sbPage, heading);
      expect(after).not.toBeNull();

      // Sub-pixel is fine; a glyph of movement is not.
      expect(Math.abs((after as number) - (before as number))).toBeLessThan(1);
    });
  }
});
