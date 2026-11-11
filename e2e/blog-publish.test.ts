import { createServer, type Server } from "node:http";
import { expect, gotoSilverBulletPage, test } from "./fixtures.ts";

// Stands in for api.github.com. The plug's fetch goes through the server's
// proxy, so a page-level override never sees it -- the same reason the Zotero
// suite points its API base at a local port.
const GH_PORT = 43000 + Math.floor(Math.random() * 15000);
const paths: string[] = [];
const blobs: string[] = [];
const bodies: { path: string; content: string }[] = [];

function mockGitHub(): Promise<Server> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const url = req.url ?? "";
      const body = chunks.length
        ? JSON.parse(Buffer.concat(chunks).toString())
        : undefined;
      const send = (value: unknown) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(value));
      };
      if (url.endsWith("/git/ref/heads/main")) {
        return send({ object: { sha: "HEAD" } });
      }
      if (url.includes("/git/commits/HEAD")) {
        return send({ tree: { sha: "BASE" } });
      }
      if (url.endsWith("/git/blobs")) {
        blobs.push(
          Buffer.from(String(body?.content ?? ""), "base64").toString("utf8"),
        );
        return send({ sha: `B${blobs.length}` });
      }
      if (url.endsWith("/git/trees")) {
        for (const entry of body?.tree ?? []) {
          paths.push(entry.path);
          const n = Number(String(entry.sha).slice(1));
          bodies.push({ path: entry.path, content: blobs[n - 1] ?? "" });
        }
        return send({ sha: "NEW" });
      }
      if (url.endsWith("/git/commits")) return send({ sha: "COMMITSHA" });
      if (req.method === "PATCH") return send({ ok: true });
      res.writeHead(404);
      res.end();
    });
  });
  return new Promise((resolve) =>
    server.listen(GH_PORT, "127.0.0.1", () => resolve(server)),
  );
}

// A note keyworded for the site becomes a Hugo page bundle. The scan comes
// first, because a link to a note that is not a post is the one thing the
// exporter cannot decide on its own.
const org = (id: string, title: string, keywords: string, body: string) =>
  `#+title:      ${title}\n#+date:       [2026-11-09 Mon 09:41]\n` +
  `#+filetags:   :${keywords}:\n#+identifier: ${id}\n\n${body}\n`;

const K = "elliottwgithubio";

test.describe("Blog: Publish", () => {
  let gh: Server;
  test.beforeAll(async () => {
    gh = await mockGitHub();
  });
  test.afterAll(async () => {
    await new Promise((r) => gh.close(r));
  });

  test.use({
    spaceFiles: {
      "index.md": "# Home\n",
      "CONFIG.md":
        "```space-lua\n" +
        `config.set("blog", { keyword = "${K}", api = "http://127.0.0.1:${GH_PORT}" })\n` +
        "```\n",
      // Two posts; the second links to the first (fine) and to a note that is
      // not a post (the thing to report).
      [`20261109T094102==21=04--on-civic-design__${K}_design.org`]: org(
        "20261109T094102",
        "On Civic Design",
        `${K}:design`,
        "* A section\nProse {{< marginnote >}}An aside.{{< /marginnote >}}.\n",
      ),
      [`20261109T094200--second-post__${K}.org`]: org(
        "20261109T094200",
        "Second Post",
        K,
        "See [[denote:20261109T094102][the first]] and " +
          "[[denote:20261109T094300][a private note]].\n",
      ),
      [`20261109T094400--a-page__${K}_page.org`]: org(
        "20261109T094400",
        "A Page",
        `${K}:page`,
        "About me.\n",
      ),
      [`20261109T094500--held-back__${K}_post_draft.org`]: org(
        "20261109T094500",
        "Held Back",
        `${K}:post:draft`,
        "Not ready.\n",
      ),
      "20261109T094300--a-private-note.org": org(
        "20261109T094300",
        "A private note",
        "journal",
        "Not for the site.\n",
      ),
    },
  });

  /** The paths the publish committed, as the mock GitHub saw them. */
  const committed = () => paths;

  test("exports bundles, and reports links to notes that are not posts", async ({
    sbPage,
    sbServer,
  }) => {
    await gotoSilverBulletPage(sbPage, sbServer, "index");
    await sbPage.waitForTimeout(3500); // config and index settle
    // The token lives in the client store, not in the space.
    await sbPage.evaluate(() =>
      (globalThis as any).sbRuntime.evalLuaScript(
        'clientStore.set("blogGitHubToken", "test-token")',
      ),
    );

    await sbPage.evaluate(() => {
      void (globalThis as any).sbRuntime.evalLuaScript(
        `editor.invokeCommand("Blog: Publish")`,
      );
    });

    // The scan stops to ask, naming what points where.
    const dialog = sbPage.locator(".sb-modal-box, .sb-modal").first();
    await expect(dialog).toContainText("A private note", { timeout: 20_000 });
    await expect(dialog).toContainText("Second Post");
    // The link to the other post is fine and must not be reported.
    await expect(dialog).not.toContainText("the first");

    // Publish anyway.
    await sbPage
      .locator(".sb-modal-box button, .sb-modal button")
      .filter({ hasText: /ok|yes|publish|confirm/i })
      .first()
      .click();

    // One commit, carrying both posts as page bundles under content/posts.
    await expect
      .poll(() => committed(), { timeout: 25_000 })
      .toEqual([
        // A post goes under posts/, a page at the root -- the distinction is
        // the keyword, not a guess at a missing date.
        "posts/on-civic-design/index.html",
        "posts/second-post/index.html",
        "a-page/index.html",
        "index.html",
        "tufte.css",
      ]);
  });

  test("a draft is held back, and the index lists what was published", async ({
    sbPage,
    sbServer,
  }) => {
    paths.length = 0;
    bodies.length = 0;
    await gotoSilverBulletPage(sbPage, sbServer, "index");
    await sbPage.waitForTimeout(3500);
    await sbPage.evaluate(() =>
      (globalThis as any).sbRuntime.evalLuaScript(
        'clientStore.set("blogGitHubToken", "test-token")',
      ),
    );
    await sbPage.evaluate(() => {
      void (globalThis as any).sbRuntime.evalLuaScript(
        `editor.invokeCommand("Blog: Publish")`,
      );
    });
    const dialog = sbPage.locator(".sb-modal-box, .sb-modal").first();
    await expect(dialog).toContainText("A private note", { timeout: 20_000 });
    await sbPage
      .locator(".sb-modal-box button, .sb-modal button")
      .filter({ hasText: /ok|yes|publish|confirm/i })
      .first()
      .click();

    await expect
      .poll(() => paths, { timeout: 25_000 })
      .toEqual(expect.arrayContaining(["index.html"]));
    // The draft never reaches the site.
    expect(paths.some((p) => p.includes("held-back"))).toBe(false);
    const index = bodies.find((b) => b.path === "index.html")!.content;
    expect(index).toContain("On Civic Design");
    expect(index).toContain("A Page");
    expect(index).not.toContain("Held Back");
    // And the margin note in the body became Tufte's markup.
    const post = bodies.find((b) =>
      b.path.includes("on-civic-design"),
    )!.content;
    expect(post).toContain('class="marginnote"');
    expect(post).toContain('href="../../tufte.css"');
  });
});
