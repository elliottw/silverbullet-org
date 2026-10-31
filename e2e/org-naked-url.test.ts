import { expect, gotoSilverBulletPage, test } from "./fixtures.ts";

// Pasted bare URLs, which is how they arrive in a journal entry.
const NOTE = `#+title:      Outreach
#+identifier: 20261031T090000

- called https://www.emdria.org/directory/people/brandi/ left vmail
- https://www.psychologytoday.com/us/therapists/joshua/126743 not taking new clients
- described [[https://example.com][a bracketed link]] for contrast
`;

test.describe("Bare URLs in an Org note", () => {
  test.use({
    spaceFiles: {
      "index.md": "# Home\n",
      "20261031T090000--outreach.org": NOTE,
    },
  });

  test("are coloured as links and open in a new tab when clicked", async ({
    sbPage,
    sbServer,
    context,
  }) => {
    await gotoSilverBulletPage(
      sbPage,
      sbServer,
      "20261031T090000--outreach.org",
    );
    const editor = sbPage.locator("#sb-editor .cm-content");
    await expect(editor).toContainText("not taking new clients", {
      timeout: 20_000,
    });

    const urls = sbPage.locator("#sb-editor .sb-naked-url");
    await expect(urls).toHaveCount(2, { timeout: 15_000 });

    // Coloured like a link rather than inheriting body text, and showing a
    // pointer so it reads as clickable.
    const look = await sbPage.evaluate(() => {
      const el = document.querySelector("#sb-editor .sb-naked-url")!;
      const body = document.querySelector("#sb-editor .cm-line")!;
      const s = getComputedStyle(el);
      return {
        color: s.color,
        cursor: s.cursor,
        bodyColor: getComputedStyle(body).color,
      };
    });
    expect(look.color).not.toEqual(look.bodyColor);
    expect(look.cursor).toBe("pointer");

    // And it actually follows.
    const opened = context.waitForEvent("page", { timeout: 20_000 });
    await urls.first().click({ modifiers: ["Meta"] });
    const tab = await opened;
    expect(tab.url()).toContain("emdria.org");
    await tab.close();
  });
});
