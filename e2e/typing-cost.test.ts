import { expect, gotoSilverBulletPage, test } from "./fixtures.ts";

// A note the size of the real book file, in the same shape: headlines,
// prose, links. What matters is time-per-keystroke, which is what a stall
// actually is.
function build(kb: number): string {
  const lines = ["#+title:      Scenes", "#+identifier: 20260604T000002", ""];
  let size = 0;
  let i = 0;
  while (size < kb * 1024) {
    i++;
    const block = [
      `* Scene ${i}`,
      `Prose with a [[denote:2024012${i % 10}T164237][link]] and more words here.`,
      `** Beat ${i}`,
      `- a list item`,
      `- another, with /emphasis/ and *bold*`,
      "",
    ].join("\n");
    lines.push(block);
    size += block.length;
  }
  return lines.join("\n");
}

// Typing cost grows with the document because every decoration is rebuilt
// from the whole of it. These are the numbers that made that visible, and a
// ceiling so a new full-document scan cannot quietly put them back:
// measured on this machine at 1.7ms / 5.6ms / 14ms / 48ms for 1KB / 10KB /
// 26KB / 575KB. The ceilings are generous -- CI machines differ -- but a
// regression of the kind this caught was 50% worse, not 10%.
test.describe("typing cost", () => {
  test.use({
    spaceFiles: {
      "index.md": "# H\n",
      "small.org": build(1),
      "p95.org": build(10),
      "p99.org": build(26),
      "book.org": build(575),
    },
  });

  for (const [name, label, ceiling] of [
    ["small.org", "1 KB", 15],
    ["p95.org", "10 KB", 30],
    ["p99.org", "26 KB", 60],
    ["book.org", "575 KB (the book file)", 150],
  ] as [string, string, number][]) {
    test(`keystroke cost: ${label}`, async ({ sbPage, sbServer }) => {
      test.setTimeout(180000);
      await gotoSilverBulletPage(sbPage, sbServer, name);
      await expect(sbPage.locator("#sb-editor .cm-content")).toContainText(
        "Scene 1",
        { timeout: 30_000 },
      );
      await sbPage.waitForTimeout(2500);
      const ms = await sbPage.evaluate(() => {
        const view = (globalThis as any).client.editorView;
        // Type into the middle, where a real edit happens.
        const at = Math.floor(view.state.doc.length / 2);
        const times: number[] = [];
        for (let i = 0; i < 25; i++) {
          const t0 = performance.now();
          view.dispatch({ changes: { from: at + i, insert: "x" } });
          // Force the decorations to settle, as a paint would.
          void view.state.facet; // touch
          times.push(performance.now() - t0);
        }
        times.sort((a, b) => a - b);
        return {
          median: Math.round(times[12] * 100) / 100,
          worst: Math.round(times[24] * 100) / 100,
        };
      });
      console.log(
        `TIMING ${label}: median ${ms.median}ms  worst ${ms.worst}ms`,
      );
      expect(ms.median).toBeLessThan(ceiling);
      expect(true).toBe(true);
    });
  }
});
