import { expect, gotoSilverBulletPage, test } from "./fixtures.ts";

// A Better BibTeX export, as written: braces, escapes, storage paths.
const BIB = String.raw`
@book{graham2004hackers,
  title = {Hackers \& Painters},
  author = {Graham, Paul},
  year = {2004},
  keywords = {essays},
  file = {/Users/elliott/Zotero/storage/PSKBJDH2/hackers-and-painters.pdf}
}

@article{brown2007moral,
  title = {Moral Capital},
  author = {Brown, Christopher Leslie},
  year = {2007},
  journal = {Some Journal}
}
`;

const NOTE = `#+title:      Reading
#+identifier: 20260914T120000

Start with [cite:@graham2004hackers], then [cite:see @brown2007moral p. 3].
And the file itself: [[zotero:PSKBJDH2]] or [[zotero:PSKBJDH2][the PDF]].
`;

const REFERENCE = `#+title:      Hackers and Painters
#+identifier: 20260914T130000
#+reference:  graham2004hackers
#+filetags:   :bib:

Notes on the book.
`;

test.describe("Zotero", () => {
  test.use({
    spaceFiles: {
      "index.md": "# Home\n",
      "zotero.bib": BIB,
      "CONFIG.md":
        '```space-lua\nconfig.set("zotero", { username = "elliottwilliams" })\n```\n',
      "Reading.org": NOTE,
      "20260914T130000--hackers-and-painters__bib.org": REFERENCE,
    },
  });

  const lua = (page: any, s: string) =>
    page.evaluate(
      (s: string) => (globalThis as any).sbRuntime.evalLuaScript(s),
      s,
    );

  test("a citation reads as author and year, and links to zotero.org", async ({
    sbPage,
    sbServer,
  }) => {
    await gotoSilverBulletPage(sbPage, sbServer, "Reading.org");
    const editor = sbPage.locator("#sb-editor .cm-content");
    await expect(editor).toContainText("Graham 2004", { timeout: 20_000 });
    await expect(editor).toContainText("Brown 2007");
    await expect(editor).not.toContainText("[cite:");

    const cite = editor.locator("a.sb-zotero-citation").first();
    await expect(cite).toHaveAttribute(
      "href",
      "https://www.zotero.org/elliottwilliams/items/PSKBJDH2",
    );
    // No file for Brown: the desktop app is the only place it can open.
    await expect(editor.locator("a.sb-zotero-citation").nth(1)).toHaveAttribute(
      "href",
      "zotero://select/items/@brown2007moral",
    );
  });

  test("a bare zotero: link reads as the item's title; a described one keeps its text", async ({
    sbPage,
    sbServer,
  }) => {
    await gotoSilverBulletPage(sbPage, sbServer, "Reading.org");
    const editor = sbPage.locator("#sb-editor .cm-content");
    await expect(editor).toContainText("Hackers & Painters", {
      timeout: 20_000,
    });
    await expect(editor).toContainText("the PDF");
    await expect(editor).not.toContainText("zotero:PSKBJDH2");
  });

  test("the bibliography is indexed, and citations and references are relations", async ({
    sbPage,
    sbServer,
  }) => {
    await gotoSilverBulletPage(sbPage, sbServer, "Reading.org");
    await sbPage.waitForTimeout(3000);
    await expect
      .poll(
        () =>
          lua(
            sbPage,
            "return #query[[from z = index.tag('zotero') select z.citekey]]",
          ),
        { timeout: 30_000 },
      )
      .toEqual(2);
    const graham = await lua(
      sbPage,
      "return (query[[from z = index.tag('zotero') where z.citekey == 'graham2004hackers' select z]])[1]",
    );
    expect(graham.title).toEqual("Hackers & Painters");
    expect(graham.short).toEqual("Graham 2004");
    expect(graham.attachments).toEqual(["PSKBJDH2"]);

    // Two `[cite:]` keys plus two `[[zotero:…]]` links cite Graham: 3 for
    // Graham (one cite + two links), 1 for Brown.
    await expect
      .poll(
        () =>
          lua(
            sbPage,
            "return #query[[from r = index.tag('relation') where r.kind == 'citation' and r.to == 'graham2004hackers' select r.ref]]",
          ),
        { timeout: 30_000 },
      )
      .toEqual(3);
    // The reference note points at its item.
    expect(
      await lua(
        sbPage,
        "return (query[[from r = index.tag('relation') where r.kind == 'reference' select r.from]])[1]",
      ),
    ).toEqual("20260914T130000--hackers-and-painters__bib.org");
  });

  test("Zotero: New Reference Note writes a citar-denote note", async ({
    sbPage,
    sbServer,
  }) => {
    await gotoSilverBulletPage(sbPage, sbServer, "Reading.org");
    await sbPage.waitForTimeout(2000);
    await sbPage.evaluate(() => {
      void (globalThis as any).sbRuntime.evalLuaScript(
        'editor.invokeCommand("Zotero: New Reference Note")',
      );
    });
    const filter = sbPage
      .locator(".sb-modal-box input, .sb-modal input")
      .first();
    await expect(filter).toBeVisible({ timeout: 20_000 });
    await filter.fill("Moral");
    await expect(
      sbPage.locator(".sb-result-list .sb-name").first(),
    ).toContainText("Moral Capital", { timeout: 10_000 });
    await filter.press("Enter");

    await expect(sbPage.locator("#sb-current-page input.sb-input")).toHaveValue(
      /^\d{8}T\d{6}--moral-capital__bib\.org$/,
      { timeout: 20_000 },
    );
    const text: string = await lua(sbPage, "return editor.getText()");
    expect(text).toMatch(/^#\+reference:\s+brown2007moral$/m);
    expect(text).toContain("#+filetags:   :bib:");
    expect(text).toContain("[cite:@brown2007moral]");
  });
});

// A stand-in for api.zotero.org that speaks the four-step upload protocol
// and remembers what it was sent, so the paste path can be driven end to end
// -- through the plug sandbox and the server's fetch proxy -- without a key.
import { createServer, type Server } from "node:http";

const MOCK_PORT = 40000 + Math.floor(Math.random() * 20000);

function mockZotero(): Promise<{
  server: Server;
  url: string;
  calls: string[];
  uploads: Buffer[];
}> {
  const calls: string[] = [];
  const uploads: Buffer[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      calls.push(
        `${req.method} ${req.url} key=${req.headers["zotero-api-key"]}`,
      );
      if (req.method === "POST" && req.url === "/users/42/items") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ successful: { "0": { key: "MOCKKEY1" } } }));
      } else if (
        req.url === "/users/42/items/MOCKKEY1/file" &&
        body.toString().startsWith("md5=")
      ) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            url: `http://127.0.0.1:${(server.address() as any).port}/upload`,
            contentType: "multipart/form-data; boundary=xx",
            prefix: "--xx\r\n",
            suffix: "\r\n--xx--",
            uploadKey: "UPKEY",
          }),
        );
      } else if (req.url === "/upload") {
        // S3's form upload refuses a chunked body; what arrives here must be
        // framed with a Content-Length, as the real file store demands.
        if (
          !req.headers["content-length"] ||
          req.headers["transfer-encoding"]
        ) {
          res.writeHead(411);
          res.end();
          return;
        }
        uploads.push(body);
        res.writeHead(201);
        res.end();
      } else if (
        req.url === "/users/42/items/MOCKKEY1/file" &&
        body.toString().startsWith("upload=")
      ) {
        res.writeHead(204);
        res.end();
      } else {
        res.writeHead(404);
        res.end();
      }
    });
  });
  return new Promise((resolve) =>
    server.listen(MOCK_PORT, "127.0.0.1", () =>
      resolve({
        server,
        url: `http://127.0.0.1:${MOCK_PORT}`,
        calls,
        uploads,
      }),
    ),
  );
}

test.describe("Zotero: adding a file", () => {
  let mock: Awaited<ReturnType<typeof mockZotero>>;
  test.beforeAll(async () => {
    mock = await mockZotero();
  });
  test.afterAll(() => {
    mock.server.close();
  });

  test.use({
    spaceFiles: {
      "index.md": "# Home\n",
      "Paste.org": "#+title: Paste\n\nBefore.\n",
      "CONFIG.md":
        "```space-lua\n" +
        `config.set("zotero", { username = "u", userId = "42", apiKey = "k", api = "http://127.0.0.1:${MOCK_PORT}" })\n` +
        "```\n",
    },
  });

  test("a pasted PDF goes to Zotero and the note links to it; an image stays", async ({
    sbPage,
    sbServer,
  }) => {
    await gotoSilverBulletPage(sbPage, sbServer, "Paste.org");
    const editor = sbPage.locator("#sb-editor .cm-content");
    await expect(editor).toContainText("Before.");
    await sbPage.waitForTimeout(2500); // config to settle

    await editor.click();
    await sbPage.keyboard.press("Control+End");
    await sbPage.evaluate(() => {
      const dt = new DataTransfer();
      dt.items.add(
        new File([new TextEncoder().encode("%PDF-1.4 hello")], "paper.pdf", {
          type: "application/pdf",
        }),
      );
      document.querySelector("#sb-editor .cm-content")!.dispatchEvent(
        new ClipboardEvent("paste", {
          clipboardData: dt,
          bubbles: true,
          cancelable: true,
        }),
      );
    });

    await expect
      .poll(
        () =>
          sbPage.evaluate(() =>
            (globalThis as any).sbRuntime.evalLuaScript(
              "return editor.getText()",
            ),
          ),
        { timeout: 30_000 },
      )
      .toContain("[[zotero:MOCKKEY1][paper.pdf]]");
    // All four steps, with the key, and the bytes wrapped as instructed.
    expect(
      mock.calls.filter((c) => c.includes("key=k")).length,
    ).toBeGreaterThanOrEqual(3);
    expect(mock.uploads.length).toEqual(1);
    expect(mock.uploads[0].toString()).toContain("%PDF-1.4 hello");
    expect(mock.uploads[0].toString().startsWith("--xx\r\n")).toBe(true);
  });
});
