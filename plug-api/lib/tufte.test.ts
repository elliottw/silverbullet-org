import { expect, test } from "vitest";
import { replaceShortcodes, type Shortcode, tufteHtml } from "./tufte.ts";

const render = () => {
  let n = 0;
  return (code: Shortcode) => tufteHtml(code, () => ++n);
};

test("a margin note becomes Tufte's label, checkbox and span", () => {
  // The markup is a label and an input rather than an <aside> for a reason:
  // it is what lets a phone fold the note back inline instead of losing it
  // off the edge of the page.
  const html = replaceShortcodes(
    "Before {{< marginnote >}}An aside.{{< /marginnote >}} after.",
    render(),
  );
  expect(html).toContain('<label for="mn-1" class="margin-toggle">');
  expect(html).toContain('<input type="checkbox" id="mn-1"');
  expect(html).toContain('<span class="marginnote">An aside.</span>');
  expect(html).toContain("Before ");
  expect(html).toContain(" after.");
});

test("each margin note gets its own id", () => {
  const html = replaceShortcodes(
    "{{< marginnote >}}one{{< /marginnote >}}{{< marginnote >}}two{{< /marginnote >}}",
    render(),
  );
  expect(html).toContain('id="mn-1"');
  expect(html).toContain('id="mn-2"');
});

test("a figure knows whether it is full width", () => {
  const plain = replaceShortcodes('{{< figure src="a.jpg" >}}', render());
  expect(plain).toContain('<figure><img src="a.jpg"');
  expect(plain).not.toContain("fullwidth");

  const full = replaceShortcodes(
    '{{< figure src="hero-whiteboard.jpg" type="full" >}}',
    render(),
  );
  expect(full).toContain('<figure class="fullwidth">');
  expect(full).toContain('src="hero-whiteboard.jpg"');
});

test("a caption becomes a figcaption, escaped", () => {
  const html = replaceShortcodes(
    '{{< figure src="a.jpg" caption="Tom & Jerry <2008>" >}}',
    render(),
  );
  expect(html).toContain(
    "<figcaption>Tom &amp; Jerry &lt;2008&gt;</figcaption>",
  );
});

test("a margin note containing a figure renders both", () => {
  // The paired shortcode is replaced first so the pair is not cut in half;
  // the figure pass then runs over the result, so a figure *inside* a margin
  // note still becomes a figure.
  const html = replaceShortcodes(
    '{{< marginnote >}}See {{< figure src="a.jpg" >}}{{< /marginnote >}}',
    render(),
  );
  expect(html.match(/<span class="marginnote">/g)?.length).toBe(1);
  expect(html).toContain('<img src="a.jpg"');
  expect(html).not.toContain("{{<");
});

test("a vimeo id becomes a responsive embed", () => {
  const html = replaceShortcodes("{{< vimeo 1015318451 >}}", render());
  expect(html).toContain("player.vimeo.com/video/1015318451");
  expect(html).toContain('class="iframe-wrapper"');
});

test("text with no shortcodes is returned unchanged", () => {
  const text = "Just prose, with [[denote:20240101T000000][a link]].";
  expect(replaceShortcodes(text, render())).toBe(text);
});

test("a figure with no src is left alone rather than rendered broken", () => {
  const text = '{{< figure type="full" >}}';
  expect(replaceShortcodes(text, render())).toBe(text);
});
