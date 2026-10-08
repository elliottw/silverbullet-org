import { createServer, type Server } from "node:http";
import { expect, gotoSilverBulletPage, test } from "./fixtures.ts";

// A stand-in for a page on the web. The server's fetch proxy sends http:// to
// a loopback host, so the plug can reach this the same way it reaches a real
// site -- the whole path, proxy included, is under test.
const MOCK_PORT = 41000 + Math.floor(Math.random() * 18000);

function mockSite(): Promise<{ server: Server; hits: string[] }> {
  const hits: string[] = [];
  const server = createServer((req, res) => {
    hits.push(req.url ?? "");
    if (req.url?.startsWith("/paper")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(
        `<html><head><title>\n  Attention Is All You&nbsp;Need &mdash; arXiv\n</title></head><body>x</body></html>`,
      );
    } else if (req.url?.startsWith("/secret")) {
      res.writeHead(403, { "content-type": "text/html" });
      res.end("<html><head><title>Forbidden</title></head></html>");
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  return new Promise((resolve) =>
    server.listen(MOCK_PORT, "127.0.0.1", () => resolve({ server, hits })),
  );
}

const NOTE = `#+title:      Reading
#+identifier: 20261007T120000

Found this: 
`;

test.describe("Insert Web Link", () => {
  let mock: Awaited<ReturnType<typeof mockSite>>;
  test.beforeAll(async () => {
    mock = await mockSite();
  });
  test.afterAll(async () => {
    await new Promise((r) => mock.server.close(r));
  });

  test.use({
    spaceFiles: {
      "index.md": "# Home\n",
      "20261007T120000--reading.org": NOTE,
      "Notes.md": "# Notes\n\nSee \n",
    },
  });

  async function insertWebLink(page: any) {
    await page.evaluate(() => {
      void (globalThis as any).sbRuntime.evalLuaScript(
        `editor.invokeCommand("Denote: Insert Web Link")`,
      );
    });
  }

  function prompt(page: any) {
    return page.locator(".sb-modal-box input, .sb-modal input").first();
  }

  /** The note's text, once the insert that follows the prompt has landed. */
  function expectText(page: any) {
    return expect.poll(
      () =>
        page.evaluate(() =>
          (globalThis as any).sbRuntime.evalLuaScript(
            "return editor.getText()",
          ),
        ),
      { timeout: 20_000 },
    );
  }

  test("an Org note gets an Org link described by the page's own title", async ({
    sbPage,
    sbServer,
  }) => {
    await gotoSilverBulletPage(
      sbPage,
      sbServer,
      "20261007T120000--reading.org",
    );
    const editor = sbPage.locator("#sb-editor .cm-content");
    await expect(editor).toContainText("Found this:", { timeout: 20_000 });
    await editor.click();
    await sbPage.evaluate(() => {
      void (globalThis as any).sbRuntime.evalLuaScript(
        "editor.moveCursor(string.len(editor.getText()))",
      );
    });

    await insertWebLink(sbPage);
    await expect(prompt(sbPage)).toBeVisible({ timeout: 20_000 });
    await prompt(sbPage).fill(`http://127.0.0.1:${MOCK_PORT}/paper`);
    await prompt(sbPage).press("Enter");

    // The second prompt arrives prefilled with the fetched title: entities
    // decoded, whitespace collapsed.
    await expect(prompt(sbPage)).toHaveValue(
      "Attention Is All You Need — arXiv",
      { timeout: 20_000 },
    );
    await prompt(sbPage).press("Enter");

    await expect(editor).toContainText("Attention Is All You Need — arXiv", {
      timeout: 20_000,
    });
    await expectText(sbPage).toContain(
      `[[http://127.0.0.1:${MOCK_PORT}/paper][Attention Is All You Need — arXiv]]`,
    );
    expect(mock.hits.some((u) => u.startsWith("/paper"))).toBe(true);
  });

  test("a selection is the description, and a Markdown page gets Markdown", async ({
    sbPage,
    sbServer,
  }) => {
    await gotoSilverBulletPage(sbPage, sbServer, "Notes.md");
    const editor = sbPage.locator("#sb-editor .cm-content");
    await expect(editor).toContainText("See", { timeout: 20_000 });
    // Select the word "Notes" in the heading and link it.
    await sbPage.evaluate(() => {
      void (globalThis as any).sbRuntime.evalLuaScript(
        "editor.setSelection(2, 7)",
      );
    });
    await insertWebLink(sbPage);
    await expect(prompt(sbPage)).toBeVisible({ timeout: 20_000 });
    await prompt(sbPage).fill(`http://127.0.0.1:${MOCK_PORT}/paper`);
    await prompt(sbPage).press("Enter");
    // A selection is the author's own description, so no title is fetched.
    await expect(prompt(sbPage)).toHaveValue("Notes", { timeout: 20_000 });
    await prompt(sbPage).press("Enter");

    await expectText(sbPage).toContain(
      `[Notes](http://127.0.0.1:${MOCK_PORT}/paper)`,
    );
  });

  test("a page that will not answer still gets its link", async ({
    sbPage,
    sbServer,
  }) => {
    await gotoSilverBulletPage(
      sbPage,
      sbServer,
      "20261007T120000--reading.org",
    );
    const editor = sbPage.locator("#sb-editor .cm-content");
    await expect(editor).toContainText("Found this:", { timeout: 20_000 });
    await editor.click();
    await sbPage.evaluate(() => {
      void (globalThis as any).sbRuntime.evalLuaScript(
        "editor.moveCursor(string.len(editor.getText()))",
      );
    });

    await insertWebLink(sbPage);
    await expect(prompt(sbPage)).toBeVisible({ timeout: 20_000 });
    await prompt(sbPage).fill(`http://127.0.0.1:${MOCK_PORT}/secret`);
    await prompt(sbPage).press("Enter");
    // 403: nothing to suggest, and that is not a reason to refuse the link.
    await expect(prompt(sbPage)).toHaveValue("", { timeout: 20_000 });
    await prompt(sbPage).press("Enter");

    // No description: Org shows the target, as `org-insert-link` does.
    console.log("DOM:", JSON.stringify(await editor.innerText()));
    console.log("MODALS:", await sbPage.locator(".sb-modal-box").count());
    await expectText(sbPage).toContain(
      `[[http://127.0.0.1:${MOCK_PORT}/secret]]`,
    );
  });
});
