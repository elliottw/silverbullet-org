import { readFileSync } from "node:fs";
import { expect, gotoSilverBulletPage, test } from "./fixtures.ts";

const IMAGE = readFileSync("client/images/favicon-96x96.png").toString(
  "base64",
);

const NOTE = `#+title:      Picture note
#+identifier: 20260303T000000

* With a description

[[file:shot.png][a screenshot]]

* Without a description

[[file:shot.png]]

* Sized

#+ATTR_ORG: :width 40
[[file:shot.png]]
`;

test.describe("Org inline images", () => {
  test.use({
    spaceFiles: {
      "index.md": "# Index\n",
      "20260303T000000--picture-note__meta.org": NOTE,
      // Written as base64 by the fixture; the bytes are a real PNG.
      "shot.png.b64": IMAGE,
    },
  });

  test("a link with no description shows the image; with one it stays text", async ({
    sbPage,
    sbServer,
  }) => {
    // Put the real binary in place through the file API.
    await fetch(`${sbServer.url}/.fs/shot.png`, {
      method: "PUT",
      headers: { "X-Sync-Mode": "true", "Content-Type": "image/png" },
      body: Uint8Array.from(atob(IMAGE), (c) => c.charCodeAt(0)),
    });
    await gotoSilverBulletPage(
      sbPage,
      sbServer,
      "20260303T000000--picture-note__meta.org",
    );
    const editor = sbPage.locator("#sb-editor .cm-content");
    await expect(editor).toContainText("With a description", {
      timeout: 20_000,
    });

    // Org shows an image only for a link with no description.
    const images = sbPage.locator("#sb-editor .sb-org-inline-image img");
    await expect(images).toHaveCount(2, { timeout: 20_000 });
    // The described link is still rendered as its words.
    await expect(editor).toContainText("a screenshot");

    // Both images actually loaded, rather than showing a broken icon.
    for (let i = 0; i < 2; i++) {
      const loaded = await images
        .nth(i)
        .evaluate(
          (img: HTMLImageElement) => img.complete && img.naturalWidth > 0,
        );
      expect(loaded, `image ${i} loaded`).toBe(true);
    }
  });

  test("#+ATTR_ORG :width sizes the image", async ({ sbPage, sbServer }) => {
    await fetch(`${sbServer.url}/.fs/shot.png`, {
      method: "PUT",
      headers: { "X-Sync-Mode": "true", "Content-Type": "image/png" },
      body: Uint8Array.from(atob(IMAGE), (c) => c.charCodeAt(0)),
    });
    await gotoSilverBulletPage(
      sbPage,
      sbServer,
      "20260303T000000--picture-note__meta.org",
    );
    const images = sbPage.locator("#sb-editor .sb-org-inline-image img");
    await expect(images).toHaveCount(2, { timeout: 20_000 });
    // The second one carries the ATTR_ORG width; the first does not.
    expect(
      await images.nth(1).evaluate((i: HTMLImageElement) => i.style.width),
    ).toEqual("40px");
    expect(
      await images.nth(0).evaluate((i: HTMLImageElement) => i.style.width),
    ).toEqual("");
  });
});

test.describe("Dropping a file into an Org page", () => {
  test.use({
    spaceFiles: {
      "index.md": "# Index\n",
      "20260304T000000--drop-target__meta.org":
        "#+title:      Drop target\n#+identifier: 20260304T000000\n\n* Here\n\n",
    },
  });

  test("a dropped image is uploaded and shown inline", async ({
    sbPage,
    sbServer,
  }) => {
    await gotoSilverBulletPage(
      sbPage,
      sbServer,
      "20260304T000000--drop-target__meta.org",
    );
    const editor = sbPage.locator("#sb-editor .cm-content");
    await expect(editor).toContainText("Here", { timeout: 20_000 });
    await editor.click();
    await sbPage.keyboard.press("Control+End");

    // The real drop path: CodeMirror's own `drop` handler, with a real File.
    await sbPage.evaluate((b64: string) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const transfer = new DataTransfer();
      transfer.items.add(
        new File([bytes], "dropped.png", { type: "image/png" }),
      );
      document.querySelector("#sb-editor .cm-content")!.dispatchEvent(
        new DragEvent("drop", {
          dataTransfer: transfer,
          bubbles: true,
          cancelable: true,
        }),
      );
    }, IMAGE);

    // It asks where to put the file, as it does for a paste.
    const prompt = sbPage
      .locator(".sb-modal-box input, .sb-modal input")
      .first();
    await expect(prompt).toBeVisible({ timeout: 20_000 });
    await prompt.press("Enter");
    await sbPage.waitForTimeout(2500);

    const text = await sbPage.evaluate(() =>
      (globalThis as any).sbRuntime.evalLuaScript("return editor.getText()"),
    );
    // Org syntax, not Markdown's `![[...]]`.
    expect(text).toContain("[[file:dropped.png]]");
    expect(text).not.toContain("![[");

    // Move off the link: like every live-preview decoration, the source shows
    // while the cursor is inside it.
    await sbPage.evaluate(() =>
      (globalThis as any).sbRuntime.evalLuaScript("editor.moveCursor(0)"),
    );
    await sbPage.waitForTimeout(800);

    // And it renders as the picture.
    const image = sbPage.locator("#sb-editor .sb-org-inline-image img").first();
    await expect(image).toBeVisible({ timeout: 20_000 });
    expect(
      await image.evaluate(
        (img: HTMLImageElement) => img.complete && img.naturalWidth > 0,
      ),
    ).toBe(true);
  });
});
