/**
 * The site's own markup: the four Hugo shortcodes this content already uses,
 * and the Tufte stylesheet they are written for.
 *
 * These are not invented. `{{< marginnote >}}` appears 44 times in the
 * imported posts, `{{< figure >}}` 29 times -- the writing already assumes
 * Tufte's margins, so a generator that ignored them would quietly flatten
 * half the work.
 */

export type Shortcode =
  | { kind: "marginnote"; body: string }
  | { kind: "figure"; src: string; full: boolean; caption?: string }
  | { kind: "vimeo"; id: string };

const attr = (text: string, name: string): string | undefined =>
  new RegExp(`${name}\\s*=\\s*"([^"]*)"`).exec(text)?.[1];

/**
 * Replaces each shortcode via `render`, leaving everything else alone.
 *
 * Paired `marginnote` first: its body may contain a `figure`, and matching
 * the opener on its own would cut the pair in half.
 */
export function replaceShortcodes(
  text: string,
  render: (code: Shortcode) => string,
): string {
  let out = text.replace(
    /\{\{<\s*marginnote\s*>\}\}([\s\S]*?)\{\{<\s*\/\s*marginnote\s*>\}\}/g,
    (_, body) => render({ kind: "marginnote", body: String(body).trim() }),
  );
  // Non-greedy to the closing `>}}` rather than to the first `>`: a caption
  // is prose and may contain one.
  out = out.replace(/\{\{<\s*figure\b([\s\S]*?)>\}\}/g, (whole, rest) => {
    const src = attr(String(rest), "src");
    if (!src) return whole;
    return render({
      kind: "figure",
      src,
      full: (attr(String(rest), "type") ?? "") === "full",
      caption: attr(String(rest), "caption"),
    });
  });
  out = out.replace(/\{\{<\s*vimeo\s+(\d+)\s*>\}\}/g, (_, id) =>
    render({ kind: "vimeo", id: String(id) }),
  );
  return out;
}

const escapeHtml = (text: string) =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

/**
 * Tufte's own markup for each.
 *
 * A margin note is a labelled checkbox and a span, which is how Tufte CSS
 * lets a narrow screen fold the note back inline instead of losing it off
 * the edge -- the reason to use its markup rather than a `<aside>`.
 */
export function tufteHtml(code: Shortcode, counter: () => number): string {
  switch (code.kind) {
    case "marginnote": {
      const id = `mn-${counter()}`;
      return (
        `<label for="${id}" class="margin-toggle">&#8853;</label>` +
        `<input type="checkbox" id="${id}" class="margin-toggle"/>` +
        `<span class="marginnote">${code.body}</span>`
      );
    }
    case "figure": {
      const img = `<img src="${escapeHtml(code.src)}" alt="${escapeHtml(
        code.caption ?? "",
      )}"/>`;
      const caption = code.caption
        ? `<figcaption>${escapeHtml(code.caption)}</figcaption>`
        : "";
      return code.full
        ? `<figure class="fullwidth">${img}${caption}</figure>`
        : `<figure>${img}${caption}</figure>`;
    }
    case "vimeo":
      return (
        `<figure class="iframe-wrapper"><iframe src="https://player.vimeo.com/video/${code.id}" ` +
        `frameborder="0" allow="fullscreen; picture-in-picture" allowfullscreen></iframe></figure>`
      );
  }
}

/**
 * The stylesheet. Tufte's measure and margin, pared to what this site uses:
 * the margin note, the two figure widths, and type that holds at a phone's
 * width without the margin column collapsing the layout.
 */
export const tufteCss = `
:root {
  --paper: #fffff8;
  --ink: #111;
  --muted: #666;
  --rule: #e6e2d3;
  --accent: #a00000;
}
@media (prefers-color-scheme: dark) {
  :root { --paper: #151513; --ink: #f0eee4; --muted: #9b968a; --rule: #32302a; --accent: #ef8a7d; }
}
html { font-size: 15px; background: var(--paper); }
body {
  width: 87.5%; margin-left: auto; margin-right: auto; padding-left: 12.5%;
  font-family: et-book, Palatino, "Palatino Linotype", "Times New Roman", serif;
  background: var(--paper); color: var(--ink);
  max-width: 1400px; counter-reset: sidenote-counter;
}
h1 { font-weight: 400; margin-top: 4rem; margin-bottom: 1.5rem; font-size: 3.2rem; line-height: 1; }
h2 { font-style: italic; font-weight: 400; margin-top: 2.1rem; margin-bottom: 1.4rem; font-size: 2.2rem; line-height: 1; }
h3 { font-style: italic; font-weight: 400; font-size: 1.7rem; margin-top: 2rem; margin-bottom: 1.4rem; line-height: 1; }
p, ol, ul { font-size: 1.4rem; line-height: 2rem; }
p { margin-top: 1.4rem; margin-bottom: 1.4rem; padding-right: 0; vertical-align: baseline; }
article { padding: 5rem 0; }
section > p, section > footer, section > table, article > p, article > ol, article > ul { width: 55%; }
a { color: inherit; text-underline-offset: 2px; }
a:hover { color: var(--accent); }
.subtitle { font-style: italic; margin-top: 1rem; margin-bottom: 1rem; font-size: 1.8rem; display: block; color: var(--muted); }
blockquote { font-size: 1.4rem; }
blockquote p { width: 55%; margin-right: 40px; }
figure { padding: 0; border: 0; font-size: 100%; font: inherit; vertical-align: baseline; max-width: 55%; margin: 0 0 3em 0; }
figcaption { float: right; clear: right; margin-right: -48%; width: 40%; margin-top: 0; margin-bottom: 0; font-size: 1.1rem; line-height: 1.6; vertical-align: baseline; color: var(--muted); }
figure.fullwidth figcaption { margin-right: 24%; }
figure.fullwidth { max-width: 90%; }
img { max-width: 100%; }
.marginnote { float: right; clear: right; margin-right: -60%; width: 50%; margin-top: 0.3rem; margin-bottom: 0; font-size: 1.1rem; line-height: 1.6; vertical-align: baseline; position: relative; color: var(--muted); }
label.margin-toggle:not(.sidenote-number) { display: none; }
input.margin-toggle { display: none; }
code, pre { font-family: "SF Mono", Consolas, monospace; font-size: 1.1rem; }
pre { width: 52.5%; padding-left: 2.5%; overflow-x: auto; background: rgba(0,0,0,0.03); }
hr { border: 0; border-top: 1px solid var(--rule); margin: 3rem 0; }
.iframe-wrapper { position: relative; padding-bottom: 56.25%; height: 0; max-width: 90%; }
.iframe-wrapper iframe { position: absolute; top: 0; left: 0; width: 100%; height: 100%; border: 0; }
nav.index ul { list-style: none; padding: 0; width: 55%; }
nav.index li { margin-bottom: 0.9rem; }
nav.index .when { color: var(--muted); font-size: 1.1rem; display: block; }
footer.site { margin-top: 5rem; padding: 2rem 0 4rem; border-top: 1px solid var(--rule); color: var(--muted); font-size: 1.1rem; width: 55%; }
@media (max-width: 760px) {
  body { width: 84%; padding-left: 8%; padding-right: 8%; }
  article { padding: 2rem 0; }
  section > p, section > footer, section > table, article > p, article > ol, article > ul,
  pre, blockquote p, nav.index ul, footer.site { width: 100%; }
  figure { max-width: 100%; }
  figcaption, figure.fullwidth figcaption { margin-right: 0%; max-width: none; width: 100%; float: none; }
  /* The margin folds back inline rather than off the edge: the checkbox is
     what reveals it, which is why the markup is a label and an input. */
  label.margin-toggle:not(.sidenote-number) { display: inline; color: var(--accent); cursor: pointer; }
  .marginnote { display: none; }
  .margin-toggle:checked + .marginnote { display: block; float: left; left: 1rem; clear: both; width: 95%; margin: 1rem 2.5%; position: relative; }
}
`;
