import { expect, gotoSilverBulletPage, test } from "./fixtures.ts";
import { currentPage } from "./navigator-ui.ts";

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

function mockZotero(
  options: {
    port?: number;
    /** Refuse a chunked upload, as the real file store does. */
    strictUpload?: boolean;
    /** Tags the library already holds, by item key. */
    seedTags?: Record<string, string[]>;
    /** The items a library listing answers with. */
    library?: Record<string, unknown>[];
    /** Milliseconds to sit on a library listing, as a big read does. */
    slowList?: number;
    libraryVersion?: number;
    deleted?: string[];
    /** Tags an importer added, which Zotero marks `type: 1`. */
    automaticTags?: string[];
  } = {},
): Promise<{
  server: Server;
  url: string;
  calls: string[];
  uploads: Buffer[];
  items: any[];
  /** Item key → the tags the library holds, as PATCHes leave them. */
  tags: Map<string, string[]>;
  patches: string[];
}> {
  const calls: string[] = [];
  const uploads: Buffer[] = [];
  const items: any[] = [];
  const tags = new Map<string, string[]>(
    Object.entries(options.seedTags ?? {}),
  );
  const versions = new Map<string, number>();
  const patches: string[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      calls.push(
        `${req.method} ${req.url} key=${req.headers["zotero-api-key"]}`,
      );
      if (
        req.method === "GET" &&
        req.url?.startsWith("/users/42/collections")
      ) {
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Total-Results": "1",
        });
        res.end(
          JSON.stringify([
            {
              key: "COLL0001",
              data: { name: "2026", parentCollection: false },
            },
          ]),
        );
      } else if (req.method === "POST" && req.url === "/users/42/items") {
        // A parent item, then the attachment under it.
        const isAttachment = body
          .toString()
          .includes('"itemType":"attachment"');
        items.push(JSON.parse(body.toString())[0]);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            successful: {
              "0": { key: isAttachment ? "MOCKKEY1" : "MOCKPAR1" },
            },
          }),
        );
      } else if (
        req.method === "GET" &&
        req.url?.startsWith("/users/42/items?")
      ) {
        // The library, as a versioned listing. `since` makes it incremental;
        // this mock answers the same items either way, which is enough to
        // prove the pass runs and writes.
        const library = options.library ?? [];
        if (options.slowList) {
          setTimeout(() => {
            res.writeHead(200, {
              "Content-Type": "application/json",
              "Last-Modified-Version": String(options.libraryVersion ?? 7),
              "Total-Results": "0",
            });
            res.end("[]");
          }, options.slowList);
          return;
        }
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Last-Modified-Version": String(options.libraryVersion ?? 7),
          "Total-Results": String(
            library.filter((i: any) => !i.parentItem).length,
          ),
        });
        res.end(
          JSON.stringify(
            library.map((data: any) => ({
              key: data.key,
              data: {
                ...data,
                tags:
                  tags.get(data.key)?.map((tag) => ({ tag })) ??
                  data.tags ??
                  [],
              },
            })),
          ),
        );
      } else if (
        req.method === "GET" &&
        req.url?.startsWith("/users/42/deleted")
      ) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ items: options.deleted ?? [] }));
      } else if (
        req.method === "GET" &&
        /^\/users\/42\/items\/[A-Z0-9]+$/.test(req.url ?? "")
      ) {
        // One item: its version, its tags, and -- for an attachment -- the
        // item it hangs from.
        const key = req.url!.split("/").pop()!;
        const version = versions.get(key) ?? 1;
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Last-Modified-Version": String(version),
        });
        res.end(
          JSON.stringify({
            data: {
              key,
              version,
              itemType: key === "MOCKKEY1" ? "attachment" : "document",
              ...(key === "MOCKKEY1"
                ? { parentItem: "MOCKPAR1" }
                : { citationKey: "paper2026" }),
              tags: [
                ...(tags.get(key) ?? []).map((tag) => ({ tag })),
                // An importer's tag, which Zotero marks `type: 1`.
                ...(key === "MOCKPAR1"
                  ? (options.automaticTags ?? []).map((tag) => ({
                      tag,
                      type: 1,
                    }))
                  : []),
              ],
            },
          }),
        );
      } else if (
        req.method === "PATCH" &&
        /^\/users\/42\/items\/[A-Z0-9]+$/.test(req.url ?? "")
      ) {
        const key = req.url!.split("/").pop()!;
        patches.push(`${key} ${body.toString()}`);
        const parsed = JSON.parse(body.toString()) as {
          tags?: { tag: string }[];
        };
        tags.set(
          key,
          (parsed.tags ?? []).map((x) => x.tag),
        );
        versions.set(key, (versions.get(key) ?? 1) + 1);
        res.writeHead(204);
        res.end();
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
          (options.strictUpload ?? true) &&
          (!req.headers["content-length"] || req.headers["transfer-encoding"])
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
  const port = options.port ?? MOCK_PORT;
  return new Promise((resolve) =>
    server.listen(port, "127.0.0.1", () =>
      resolve({
        server,
        url: `http://127.0.0.1:${port}`,
        calls,
        uploads,
        items,
        tags,
        patches,
      }),
    ),
  );
}

test.describe("Zotero: adding a file", () => {
  let mock: Awaited<ReturnType<typeof mockZotero>>;
  test.beforeAll(async () => {
    mock = await mockZotero();
  });
  test.afterAll(async () => {
    await new Promise((r) => mock.server.close(r));
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

    // The title, offered from the file name; Enter accepts.
    const prompt = sbPage
      .locator(".sb-modal-box input, .sb-modal input")
      .first();
    await expect(prompt).toBeVisible({ timeout: 20_000 });
    await expect(prompt).toHaveValue("Paper");
    await prompt.press("Enter");
    // The collection, from the tree; the only one on offer here.
    const filter = sbPage
      .locator(".sb-modal-box input, .sb-modal input")
      .first();
    await expect(filter).toBeVisible({ timeout: 20_000 });
    await filter.fill("2026");
    await filter.press("Enter");

    // What lands in the note is a link to the *reference note*, not to the
    // file: a citation belongs in a note of its own.
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
      .toMatch(/\[\[denote:\d{8}T\d{6}\]\[Paper\]\]/);
    // And that note is a Denote note carrying the reference keyword, the
    // item's key, and a link to the file in Zotero.
    const listing = await (
      await fetch(`${sbServer.url}/.fs/`, {
        headers: { "X-Sync-Mode": "true" },
      })
    ).text();
    const noteName = (listing.match(/[^"]*--paper__bib\.org/) ?? [])[0];
    expect(noteName).toBeTruthy();
    const note = await (
      await fetch(`${sbServer.url}/.fs/${encodeURI(noteName!)}`, {
        headers: { "X-Sync-Mode": "true" },
      })
    ).text();
    expect(note).toContain("#+title:      Paper");
    expect(note).toContain("#+filetags:   :bib:");
    expect(note).toContain("#+zotero:");
    expect(note).toContain("MOCKPAR1");
    // An agreed tag set, empty but recorded: without the line a keyword added
    // here would be read as predating the arrangement and never pushed.
    expect(note).toMatch(/^#\+zotero_tags:/m);
    expect(note).toContain("[[zotero:MOCKKEY1][paper.pdf]]");
    // A parent to cite, in the chosen collection, with the file as its child.
    const parent = mock.items.find((i) => i.itemType !== "attachment");
    const child = mock.items.find((i) => i.itemType === "attachment");
    expect(parent).toMatchObject({
      itemType: "document",
      title: "Paper",
      collections: ["COLL0001"],
    });
    expect(child).toMatchObject({
      parentItem: "MOCKPAR1",
      filename: "paper.pdf",
    });
    // All four steps, with the key, and the bytes wrapped as instructed.
    expect(
      mock.calls.filter((c) => c.includes("key=k")).length,
    ).toBeGreaterThanOrEqual(3);
    expect(mock.uploads.length).toEqual(1);
    expect(mock.uploads[0].toString()).toContain("%PDF-1.4 hello");
    expect(mock.uploads[0].toString().startsWith("--xx\r\n")).toBe(true);
  });
});

// A bibliography that knows the item the mock creates, by its attachment
// key, and gives it two Zotero tags.
const SYNC_BIB = String.raw`
@misc{paper2026,
  title = {Paper},
  keywords = {Landbank,RTK},
  file = {/Users/elliott/Zotero/storage/MOCKKEY1/paper.pdf}
}
`;

const SYNC_NOTE = `#+title:      Paper
#+date:       [2026-10-04 Sun 10:00]
#+filetags:   :bib:
#+identifier: 20261004T100000
#+zotero:     MOCKPAR1

[[zotero:MOCKKEY1][paper.pdf]]
`;

const SYNC_PORT = MOCK_PORT + 1;

test.describe("Zotero: keywords and tags in step", () => {
  let mock: Awaited<ReturnType<typeof mockZotero>>;
  test.beforeAll(async () => {
    // The API and the export agree, as they do in a real library.
    mock = await mockZotero({
      port: SYNC_PORT,
      seedTags: { MOCKPAR1: ["Landbank", "RTK"] },
    });
  });
  test.afterAll(async () => {
    await new Promise((r) => mock.server.close(r));
  });

  test.use({
    spaceFiles: {
      "index.md": "# Home\n",
      "zotero.bib": SYNC_BIB,
      "20261004T100000--paper__bib.org": SYNC_NOTE,
      "CONFIG.md":
        "```space-lua\n" +
        `config.set("zotero", { username = "u", userId = "42", apiKey = "k", api = "http://127.0.0.1:${SYNC_PORT}" })\n` +
        "```\n",
    },
  });

  test("Zotero's tags arrive as keywords, and the citekey fills itself in", async ({
    sbPage,
    sbServer,
  }) => {
    const patchesBefore = mock.patches.length;
    // Opening the note is what syncs it.
    await gotoSilverBulletPage(
      sbPage,
      sbServer,
      "20261004T100000--paper__bib.org",
    );
    await expect(sbPage.locator("#sb-editor .cm-content")).toContainText(
      "paper.pdf",
      { timeout: 20_000 },
    );
    // Keywords are part of the file name, so the page is renamed.
    await expect(currentPage(sbPage)).toHaveValue(
      "20261004T100000--paper__bib_landbank_rtk.org",
      { timeout: 30_000 },
    );
    const text = await sbPage.evaluate(() =>
      (globalThis as any).sbRuntime.evalLuaScript("return editor.getText()"),
    );
    expect(text).toContain("#+filetags:   :bib:landbank:rtk:");
    // The citekey Better BibTeX minted, found through the attachment key.
    expect(text).toContain("#+reference:  paper2026");
    // And the shadow of what both sides agreed on.
    expect(text).toMatch(/#\+zotero_tags:\s+landbank rtk/);
    // Nothing was pushed: Zotero had both tags already.
    expect(mock.patches.length).toBe(patchesBefore);
  });

  test("a keyword added here becomes a tag there", async ({
    sbPage,
    sbServer,
  }) => {
    const patchesBefore = mock.patches.length;
    await gotoSilverBulletPage(
      sbPage,
      sbServer,
      "20261004T100000--paper__bib.org",
    );
    await expect(currentPage(sbPage)).toHaveValue(
      "20261004T100000--paper__bib_landbank_rtk.org",
      { timeout: 30_000 },
    );
    // Add one, the way `Denote: Add Keywords` does.
    await sbPage.evaluate(() =>
      (globalThis as any).sbRuntime.evalLuaScript(`
        local text = editor.getText()
        editor.setText((string.gsub(text, "#%+filetags:   :bib:landbank:rtk:", "#+filetags:   :bib:landbank:rtk:solar", 1)))
        editor.save()
      `),
    );
    await expect(currentPage(sbPage)).toHaveValue(
      "20261004T100000--paper__bib_landbank_rtk_solar.org",
      { timeout: 30_000 },
    );
    // Sync pushes it to the item, keeping Zotero's own spelling of the rest.
    await sbPage.evaluate(() =>
      (globalThis as any).sbRuntime.evalLuaScript(
        'editor.invokeCommand("Zotero: Sync Reference Notes")',
      ),
    );
    await expect
      .poll(() => mock.tags.get("MOCKPAR1") ?? [], { timeout: 30_000 })
      .toEqual(["Landbank", "RTK", "solar"]);
    expect(mock.patches.length).toBe(patchesBefore + 1);
  });
});

const DROP_PORT = MOCK_PORT + 2;

test.describe("Zotero: dropping a document", () => {
  let mock: Awaited<ReturnType<typeof mockZotero>>;
  test.beforeAll(async () => {
    // Lenient about the upload framing: that is the Rust proxy's business and
    // the suite above guards it; this is about what the drop leaves behind.
    mock = await mockZotero({ port: DROP_PORT, strictUpload: false });
  });
  test.afterAll(async () => {
    await new Promise((r) => mock.server.close(r));
  });

  test.use({
    spaceFiles: {
      "index.md": "# Home\n",
      "Drop.org": "#+title: Drop\n\nFirst line here.\n\nSecond line here.\n",
      "CONFIG.md":
        "```space-lua\n" +
        `config.set("zotero", { username = "u", userId = "42", apiKey = "k", api = "http://127.0.0.1:${DROP_PORT}" })\n` +
        "```\n",
    },
  });

  test("a dropped PDF becomes a reference note, linked where it was dropped", async ({
    sbPage,
    sbServer,
  }) => {
    await gotoSilverBulletPage(sbPage, sbServer, "Drop.org");
    const editor = sbPage.locator("#sb-editor .cm-content");
    await expect(editor).toContainText("Second line here.");
    await sbPage.waitForTimeout(2500); // config to settle

    // The cursor is parked at the very end; the drop happens on the *first*
    // line, which is where the link has to land.
    await editor.click();
    await sbPage.keyboard.press("Control+End");
    const target = await sbPage.evaluate(() => {
      const el = [...document.querySelectorAll("#sb-editor .cm-line")].find(
        (l) => l.textContent?.includes("First line here."),
      )!;
      const rect = el.getBoundingClientRect();
      // The very start of that line.
      return { x: rect.left + 1, y: rect.top + rect.height / 2 };
    });
    await sbPage.evaluate(({ x, y }) => {
      const dt = new DataTransfer();
      dt.items.add(
        new File([new TextEncoder().encode("%PDF-1.4 dropped")], "paper.pdf", {
          type: "application/pdf",
        }),
      );
      document.querySelector("#sb-editor .cm-content")!.dispatchEvent(
        new DragEvent("drop", {
          dataTransfer: dt,
          clientX: x,
          clientY: y,
          bubbles: true,
          cancelable: true,
        }),
      );
    }, target);

    const prompt = sbPage
      .locator(".sb-modal-box input, .sb-modal input")
      .first();
    await expect(prompt).toBeVisible({ timeout: 20_000 });
    await prompt.press("Enter");
    const filter = sbPage
      .locator(".sb-modal-box input, .sb-modal input")
      .first();
    await expect(filter).toBeVisible({ timeout: 20_000 });
    await filter.fill("2026");
    await filter.press("Enter");

    const text = await expect
      .poll(
        () =>
          sbPage.evaluate(() =>
            (globalThis as any).sbRuntime.evalLuaScript(
              "return editor.getText()",
            ),
          ),
        { timeout: 30_000 },
      )
      .toMatch(/\[\[denote:\d{8}T\d{6}\]\[Paper\]\]/)
      .then(() =>
        sbPage.evaluate(() =>
          (globalThis as any).sbRuntime.evalLuaScript(
            "return editor.getText()",
          ),
        ),
      );
    // On the first line, where it was dropped -- not at the end, where the
    // cursor was.
    const line = (text as string)
      .split("\n")
      .find((l: string) => l.includes("denote:"))!;
    expect(line).toMatch(
      /^\[\[denote:\d{8}T\d{6}\]\[Paper\]\]First line here\.$/,
    );
    expect((text as string).trimEnd().endsWith("Second line here.")).toBe(true);
  });
});

const OWN_PORT = MOCK_PORT + 3;

/** A library as the API hands it over: an item, its attachment, a second item. */
const LIBRARY = [
  {
    key: "ITEMAAAA",
    version: 5,
    itemType: "journalArticle",
    citationKey: "graham2004hackers",
    title: "Hackers & Painters",
    creators: [
      { creatorType: "author", firstName: "Paul", lastName: "Graham" },
    ],
    date: "2004-05-01",
    publicationTitle: "Some Journal",
    tags: [{ tag: "essays" }],
  },
  {
    key: "ATTACHAA",
    version: 5,
    itemType: "attachment",
    parentItem: "ITEMAAAA",
    filename: "hackers.pdf",
    linkMode: "imported_file",
  },
  {
    key: "ITEMBBBB",
    version: 6,
    itemType: "document",
    citationKey: "nokeyitem2026",
    title: "A Report",
    tags: [],
  },
  // No citekey: kept in the index, left out of the file, since it cannot be
  // cited.
  {
    key: "ITEMCCCC",
    version: 6,
    itemType: "document",
    title: "Uncitable",
  },
];

test.describe("Zotero: SilverBullet owns the bibliography", () => {
  let mock: Awaited<ReturnType<typeof mockZotero>>;
  test.beforeAll(async () => {
    mock = await mockZotero({
      port: OWN_PORT,
      library: LIBRARY,
      libraryVersion: 11,
    });
  });
  test.afterAll(async () => {
    await new Promise((r) => mock.server.close(r));
  });

  test.use({
    spaceFiles: {
      "index.md": "# Home\n",
      // An existing bibliography, which is where the storage path is learned
      // from: the one citar on that machine already opens files with.
      "zotero.bib":
        "@misc{old,\n  title = {Old},\n  file = {/Users/elliott/Zotero/storage/OLDKEY00/old.pdf}\n}\n",
      "CONFIG.md":
        "```space-lua\n" +
        `config.set("zotero", { username = "u", userId = "42", apiKey = "k", api = "http://127.0.0.1:${OWN_PORT}" })\n` +
        "```\n",
    },
  });

  test("a sync writes the bibliography, with Zotero's citekeys and local file paths", async ({
    sbPage,
    sbServer,
  }) => {
    await gotoSilverBulletPage(sbPage, sbServer, "index");
    await sbPage.waitForTimeout(2500); // config to settle
    await sbPage.evaluate(() =>
      (globalThis as any).sbRuntime.evalLuaScript(
        'editor.invokeCommand("Zotero: Sync Library")',
      ),
    );

    const bib = async () =>
      await (
        await fetch(`${sbServer.url}/.fs/zotero.bib`, {
          headers: { "X-Sync-Mode": "true" },
        })
      ).text();
    await expect.poll(bib, { timeout: 30_000 }).toContain("graham2004hackers");
    const text = await bib();
    // Written by us, from the API.
    expect(text).toContain("% Written by SilverBullet");
    expect(text).toContain("@article{graham2004hackers,");
    expect(text).toContain("title = {Hackers \\& Painters}");
    expect(text).toContain("author = {Graham, Paul}");
    expect(text).toContain("journal = {Some Journal}");
    expect(text).toContain("keywords = {essays}");
    // The storage path was learned from the bibliography that was there.
    expect(text).toContain(
      "file = {/Users/elliott/Zotero/storage/ATTACHAA/hackers.pdf}",
    );
    // An item with no citekey cannot be cited, so it is not in the file.
    expect(text).not.toContain("Uncitable");
    // And the entry that was there before, which Zotero does not have, is
    // gone: the library is the source now.
    expect(text).not.toContain("@misc{old");

    // The index holds the library, with the item keys the export lacks.
    const indexed = await sbPage.evaluate(() =>
      (globalThis as any).sbRuntime.evalLuaScript(`
        local o = {}
        for _, z in ipairs(query[[from z = index.tag "zotero" order by z.citekey]]) do
          table.insert(o, tostring(z.citekey) .. ":" .. tostring(z.item))
        end
        local s = query[[from index.tag "zotero-sync"]]
        return table.concat(o, ",") .. " | version=" .. tostring(s[1] and s[1].version)
      `),
    );
    expect(indexed).toContain("graham2004hackers:ITEMAAAA");
    expect(indexed).toContain("version=11");
  });

  test("a citation renders from the written bibliography", async ({
    sbPage,
    sbServer,
  }) => {
    await gotoSilverBulletPage(sbPage, sbServer, "index");
    await sbPage.waitForTimeout(2500);
    await sbPage.evaluate(() =>
      (globalThis as any).sbRuntime.evalLuaScript(
        'editor.invokeCommand("Zotero: Sync Library")',
      ),
    );
    await sbPage.waitForTimeout(3000);
    // A note written after the sync cites the item by the key Zotero gave it.
    await sbPage.evaluate(() =>
      (globalThis as any).sbRuntime.evalLuaScript(
        'space.writePage("Cite.org", "#+title: Cite\\n\\nSee [cite:@graham2004hackers].\\n")',
      ),
    );
    await gotoSilverBulletPage(sbPage, sbServer, "Cite.org");
    await expect(
      sbPage.locator("#sb-editor .cm-content a.sb-zotero-citation"),
    ).toContainText("Graham 2004", { timeout: 30_000 });
  });
});

const EMPTY_PORT = MOCK_PORT + 4;

test.describe("Zotero: a sync that reads nothing", () => {
  let mock: Awaited<ReturnType<typeof mockZotero>>;
  test.beforeAll(async () => {
    // A key without access, a wrong user id: the API answers with a library
    // of no items. The bibliography must survive that.
    mock = await mockZotero({ port: EMPTY_PORT, library: [] });
  });
  test.afterAll(async () => {
    await new Promise((r) => mock.server.close(r));
  });

  test.use({
    spaceFiles: {
      "index.md": "# Home\n",
      "zotero.bib":
        "@misc{keepme,\n  title = {Keep me},\n  file = {/Users/elliott/Zotero/storage/OLDKEY00/old.pdf}\n}\n",
      "CONFIG.md":
        "```space-lua\n" +
        `config.set("zotero", { username = "u", userId = "42", apiKey = "k", api = "http://127.0.0.1:${EMPTY_PORT}" })\n` +
        "```\n",
    },
  });

  test("leaves the bibliography alone", async ({ sbPage, sbServer }) => {
    await gotoSilverBulletPage(sbPage, sbServer, "index");
    await sbPage.waitForTimeout(2500);
    await sbPage.evaluate(() =>
      (globalThis as any).sbRuntime.evalLuaScript(
        'editor.invokeCommand("Zotero: Sync Library")',
      ),
    );
    await sbPage.waitForTimeout(4000);
    const bib = await (
      await fetch(`${sbServer.url}/.fs/zotero.bib`, {
        headers: { "X-Sync-Mode": "true" },
      })
    ).text();
    expect(bib).toContain("@misc{keepme");
    // And citations still resolve from it, since an empty library does not
    // take the file out of service.
    const resolved = await sbPage.evaluate(() =>
      (globalThis as any).sbRuntime.evalLuaScript(
        'local z = query[[from z = index.tag "zotero" where z.citekey == "keepme"]] return #z',
      ),
    );
    expect(Number(resolved)).toBe(1);
  });
});

const SLOW_PORT = MOCK_PORT + 5;

test.describe("Zotero: a slow library does not swallow a drop", () => {
  let mock: Awaited<ReturnType<typeof mockZotero>>;
  test.beforeAll(async () => {
    // Reading a real library is thousands of items over tens of requests. A
    // drop must not wait for it: the note and the link come first.
    mock = await mockZotero({
      port: SLOW_PORT,
      strictUpload: false,
      slowList: 20_000,
    });
  });
  test.afterAll(async () => {
    await new Promise((r) => mock.server.close(r));
  });

  test.use({
    spaceFiles: {
      "index.md": "# Home\n",
      "Slow.org": "#+title: Slow\n\nDrop here.\n",
      "CONFIG.md":
        "```space-lua\n" +
        `config.set("zotero", { username = "u", userId = "42", apiKey = "k", api = "http://127.0.0.1:${SLOW_PORT}" })\n` +
        "```\n",
    },
  });

  test("the reference note and its link arrive without waiting for the library", async ({
    sbPage,
    sbServer,
  }) => {
    await gotoSilverBulletPage(sbPage, sbServer, "Slow.org");
    const editor = sbPage.locator("#sb-editor .cm-content");
    await expect(editor).toContainText("Drop here.");
    await sbPage.waitForTimeout(2500);
    await editor.click();
    await sbPage.keyboard.press("Control+End");
    await sbPage.evaluate(() => {
      const dt = new DataTransfer();
      dt.items.add(
        new File([new TextEncoder().encode("%PDF-1.4 slow")], "paper.pdf", {
          type: "application/pdf",
        }),
      );
      document.querySelector("#sb-editor .cm-content")!.dispatchEvent(
        new DragEvent("drop", {
          dataTransfer: dt,
          clientX: 0,
          clientY: 0,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    const prompt = sbPage
      .locator(".sb-modal-box input, .sb-modal input")
      .first();
    await expect(prompt).toBeVisible({ timeout: 20_000 });
    await prompt.press("Enter");
    const filter = sbPage
      .locator(".sb-modal-box input, .sb-modal input")
      .first();
    await expect(filter).toBeVisible({ timeout: 20_000 });
    await filter.fill("2026");
    const started = Date.now();
    await filter.press("Enter");

    // Well inside the 20 seconds the listing sits on its answer.
    await expect
      .poll(
        () =>
          sbPage.evaluate(() =>
            (globalThis as any).sbRuntime.evalLuaScript(
              "return editor.getText()",
            ),
          ),
        { timeout: 12_000 },
      )
      .toMatch(/\[\[denote:\d{8}T\d{6}\]\[Paper\]\]/);
    expect(Date.now() - started).toBeLessThan(15_000);
  });
});

const OURS_PORT = MOCK_PORT + 6;

/** The note a drop leaves behind: the item key, no tags agreed yet. */
const OURS_NOTE = `#+title:      Paper
#+date:       [2026-10-05 Mon 09:39]
#+filetags:   :bib:
#+identifier: 20261005T093900
#+zotero:     MOCKPAR1
#+zotero_tags:

[[zotero:MOCKKEY1][paper.pdf]]
`;

test.describe("Zotero: keywords on a note SilverBullet made", () => {
  let mock: Awaited<ReturnType<typeof mockZotero>>;
  test.beforeAll(async () => {
    mock = await mockZotero({ port: OURS_PORT, library: [] });
  });
  test.afterAll(async () => {
    await new Promise((r) => mock.server.close(r));
  });

  test.use({
    spaceFiles: {
      "index.md": "# Home\n",
      // A bibliography that knows nothing of this item: the note was made on a
      // device whose library has never been read, which is every device the
      // first time a drop makes a note.
      "zotero.bib": "@misc{somethingelse,\n  title = {Something else}\n}\n",
      "20261005T093900--paper__bib.org": OURS_NOTE,
      "CONFIG.md":
        "```space-lua\n" +
        `config.set("zotero", { username = "u", userId = "42", apiKey = "k", api = "http://127.0.0.1:${OURS_PORT}" })\n` +
        "```\n",
    },
  });

  test("reach Zotero as tags, without waiting for a library-wide sync", async ({
    sbPage,
    sbServer,
  }) => {
    await gotoSilverBulletPage(
      sbPage,
      sbServer,
      "20261005T093900--paper__bib.org",
    );
    await expect(sbPage.locator("#sb-editor .cm-content")).toContainText(
      "paper.pdf",
      { timeout: 20_000 },
    );
    // The sync on open asks the item itself for the citekey -- no library
    // sync, no bibliography entry. Let it finish, so the edit below is not
    // racing it.
    await expect(sbPage.locator("#sb-editor .cm-content")).toContainText(
      "paper2026",
      { timeout: 20_000 },
    );
    // Add two keywords, the way `Denote: Add Keywords` does.
    await sbPage.evaluate(() =>
      (globalThis as any).sbRuntime.evalLuaScript(`
        local text = editor.getText()
        editor.setText((string.gsub(text, "#%+filetags:   :bib:", "#+filetags:   :bib:psychology:race:", 1)))
        editor.save()
      `),
    );
    // Opening it again is what syncs it; the rename follows the keywords.
    await expect(currentPage(sbPage)).toHaveValue(
      "20261005T093900--paper__bib_psychology_race.org",
      { timeout: 30_000 },
    );
    await gotoSilverBulletPage(
      sbPage,
      sbServer,
      "20261005T093900--paper__bib_psychology_race.org",
    );
    await expect
      .poll(() => mock.tags.get("MOCKPAR1") ?? [], { timeout: 30_000 })
      .toEqual(["psychology", "race"]);
  });
});

const MARKER_PORT = MOCK_PORT + 7;

test.describe("Zotero: tags an importer added", () => {
  let mock: Awaited<ReturnType<typeof mockZotero>>;
  test.beforeAll(async () => {
    mock = await mockZotero({
      port: MARKER_PORT,
      library: [],
      // One tag somebody chose, one an importer added.
      seedTags: { MOCKPAR1: ["chosen"] },
      automaticTags: ["imported"],
    });
  });
  test.afterAll(async () => {
    await new Promise((r) => mock.server.close(r));
  });

  test.use({
    spaceFiles: {
      "index.md": "# Home\n",
      "zotero.bib": "@misc{other,\n  title = {Other}\n}\n",
      // A note about an item that holds one chosen tag and one an importer
      // added.
      "20261005T120200--auto-tags__bib.org":
        "#+title:      Auto tags\n#+filetags:   :bib:\n#+identifier: 20261005T120200\n#+zotero:     MOCKPAR1\n#+zotero_tags:\n\n[[zotero:MOCKKEY1][paper.pdf]]\n",
      "CONFIG.md":
        "```space-lua\n" +
        `config.set("zotero", { username = "u", userId = "42", apiKey = "k", api = "http://127.0.0.1:${MARKER_PORT}" })\n` +
        "```\n",
    },
  });

  test("an automatic tag is not a keyword, and survives a push", async ({
    sbPage,
    sbServer,
  }) => {
    // The item holds one chosen tag and one an importer added; the note is to
    // take the first and leave the second alone.
    await gotoSilverBulletPage(
      sbPage,
      sbServer,
      "20261005T120200--auto-tags__bib.org",
    );
    // `chosen` arrives; `imported` does not.
    await expect(currentPage(sbPage)).toHaveValue(
      "20261005T120200--auto-tags__bib_chosen.org",
      { timeout: 45_000 },
    );
    const text = await sbPage.evaluate(() =>
      (globalThis as any).sbRuntime.evalLuaScript("return editor.getText()"),
    );
    expect(text).not.toContain("imported");
    // Add a keyword, which pushes -- and the importer's tag must still be there.
    await sbPage.evaluate(() =>
      (globalThis as any).sbRuntime.evalLuaScript(`
        local t = editor.getText()
        editor.setText((string.gsub(t, "#%+filetags:   :bib:chosen:", "#+filetags:   :bib:chosen:mine:", 1)))
        editor.save()
      `),
    );
    // The chosen tags are what changed; the importer's is still there.
    await expect
      .poll(() => [...(mock.tags.get("MOCKPAR1") ?? [])].sort(), {
        timeout: 45_000,
      })
      .toEqual(["chosen", "imported", "mine"]);
  });
});
