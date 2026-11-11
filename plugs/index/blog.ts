import {
  clientStore,
  editor,
  index,
  markdown,
  space,
  system,
} from "@silverbulletmd/silverbullet/syscalls";
import {
  replaceShortcodes,
  type Shortcode,
  tufteCss,
  tufteHtml,
} from "@silverbulletmd/silverbullet/lib/tufte";
import {
  commitFiles,
  type GitHubFile,
} from "@silverbulletmd/silverbullet/lib/github";
import { getZoteroAttachment } from "@silverbulletmd/silverbullet/lib/zotero_api";
import { sluggify } from "@silverbulletmd/silverbullet/lib/denote";
import type { DenoteObject } from "./denote.ts";

/**
 * Publishing notes to a Hugo site.
 *
 * The site already speaks Org -- its posts are `index.org` page bundles with
 * `#+` front matter -- so this is a translation of four keys and an image
 * copy, not a format conversion. `#+title:` and `#+date:` are carried across
 * untouched, which is the whole reason this is cheap.
 *
 * It exports into the space rather than committing: SilverBullet runs on a
 * seedbox that deliberately holds no GitHub push credential, so the files go
 * somewhere Syncthing carries to the Mac and `tools/publish-blog.sh` finishes
 * the job there. Keeping the credential on one machine is the point.
 */
export type BlogConfig = {
  /** The Denote keyword marking a note as belonging to the site. */
  keyword: string;
  /** Where bundles are written, relative to the space root. */
  exportDir: string;
  owner: string;
  repo: string;
  branch: string;
  /** Shown in the tab and the footer. */
  siteTitle: string;
  /** Overridable so a test can stand in for api.github.com. */
  api?: string;
};

/**
 * The GitHub token, kept in the client store rather than in config.
 *
 * Config lives in the space, and the space syncs to a seedbox and to every
 * device -- a write token for the site does not need to be in that many
 * places. The client store is this browser's alone, so the token is pasted
 * once per device and never travels.
 */
const tokenKey = "blogGitHubToken";

export async function githubToken(): Promise<string | undefined> {
  const stored = await clientStore.get(tokenKey);
  return typeof stored === "string" && stored ? stored : undefined;
}

/** `Blog: Set GitHub Token` -- paste it once, on this device. */
export async function setTokenCommand(): Promise<void> {
  const existing = await githubToken();
  const value = await editor.prompt(
    existing
      ? "GitHub token (set; replace it, or empty to forget):"
      : "GitHub token (fine-grained, Contents: write on the site repo):",
    "",
  );
  if (value === undefined) return;
  if (!value.trim()) {
    await clientStore.del(tokenKey);
    await editor.flashNotification("Token forgotten on this device");
    return;
  }
  await clientStore.set(tokenKey, value.trim());
  await editor.flashNotification("Token stored for this browser only");
}

export async function blogConfig(): Promise<BlogConfig> {
  const configured = await system.getConfig<Partial<BlogConfig>>("blog", {});
  return {
    // Named after the repository so that a second site is a second keyword
    // rather than a second convention.
    keyword: configured.keyword ?? "elliottwgithubio",
    exportDir: configured.exportDir ?? "_publish",
    owner: configured.owner ?? "elliottw",
    repo: configured.repo ?? "elliottw.github.io",
    branch: configured.branch ?? "main",
    siteTitle: configured.siteTitle ?? "elliott.io",
    api: configured.api,
  };
}

/** Org's `[2026-05-30 Sat 09:46]` as the `2026-05-30` Hugo wants. */
export function hugoDate(orgDate: string | undefined): string {
  const m = /(\d{4})-(\d{2})-(\d{2})/.exec(orgDate ?? "");
  return m ? `${m[1]}-${m[2]}-${m[3]}` : "";
}

/** A post's directory name. Its title, not its identifier: this is a URL. */
export function slugFor(title: string, identifier: string): string {
  const slug = sluggify("title", title);
  return slug || identifier;
}

const denoteLink = /denote:(\d{8}T\d{6})/g;
const fileLink = /\[\[file:([^\]]+)\]\]/g;
const zoteroLink = /\[\[zotero:([A-Z0-9]{8})\](?:\[[^\]]*\])?\]/g;

/**
 * Translates a note into its post. The body is carried across as it stands --
 * it is already Org, and rewriting prose is not this function's business.
 */
export function toPost(
  text: string,
  spec: { categories: string[]; draft: boolean },
): string {
  const lines = text.split("\n");
  let i = 0;
  const front: Record<string, string> = {};
  while (i < lines.length && (lines[i].startsWith("#+") || !lines[i].trim())) {
    const m = /^#\+(\w+):[ \t]*(.*)$/.exec(lines[i]);
    if (m) front[m[1].toLowerCase()] = m[2].trim();
    i++;
  }
  const body = lines.slice(i).join("\n").trim();

  const out = [`#+title:  ${front.title ?? ""}`];
  const date = hugoDate(front.date);
  if (date) out.push(`#+date:   ${date}`);
  if (spec.categories.length) {
    out.push(`#+categories: ${spec.categories.join(", ")}`);
  }
  if (front.description) out.push(`#+description: ${front.description}`);
  // Hugo's own notion of a draft: built by `hugo server -D`, omitted from a
  // production build. The note says it, the generator reads the same word.
  out.push(`#+draft:  ${spec.draft ? "true" : "false"}`);
  // `#+identifier:` and `#+signature:` are how the *library* addresses a
  // note. They mean nothing to a reader and are left behind.
  return `${out.join("\n")}\n\n${body}\n`;
}

/** Every note marked for the site. */
async function publishable(keyword: string): Promise<DenoteObject[]> {
  const notes = await index.queryLuaObjects<DenoteObject>("denote", {});
  return notes.filter((note) => (note.keywords ?? []).includes(keyword));
}

export type DanglingLink = {
  from: string;
  to: string;
  title: string;
};

/**
 * Links from a post to a note that is not itself a post.
 *
 * Reported rather than rewritten. A link out of the library into nothing is a
 * decision about what the piece says, and it belongs to whoever wrote the
 * sentence -- not to an exporter that would quietly flatten it.
 */
export async function danglingLinks(keyword: string): Promise<DanglingLink[]> {
  const posts = await publishable(keyword);
  const published = new Set(posts.map((p) => p.identifier));
  const byIdentifier = new Map(
    (await index.queryLuaObjects<DenoteObject>("denote", {})).map((n) => [
      n.identifier,
      n,
    ]),
  );
  const out: DanglingLink[] = [];
  for (const post of posts) {
    let text: string;
    try {
      text = await space.readPage(post.page);
    } catch {
      continue;
    }
    for (const match of text.matchAll(denoteLink)) {
      const target = match[1];
      if (target === post.identifier || published.has(target)) continue;
      const to = byIdentifier.get(target);
      out.push({
        from: post.title || post.page,
        to: target,
        title: to?.title ?? "(no such note)",
      });
    }
  }
  return out;
}

/**
 * `Blog: Publish` -- scan, then export.
 *
 * The scan comes first and can stop the run, because a link to an
 * unpublished note is the one thing the exporter cannot decide on its own.
 */
export async function publishCommand(): Promise<void> {
  const cfg = await blogConfig();
  const token = await githubToken();
  if (!token) {
    await editor.flashNotification("Run Blog: Set GitHub Token first", "error");
    return;
  }
  const all = await publishable(cfg.keyword);
  const live = all.filter((n) => !(n.keywords ?? []).includes("draft"));
  if (live.length === 0) {
    await editor.flashNotification(
      `No notes keyworded ${cfg.keyword} to publish`,
      "error",
    );
    return;
  }

  const dangling = await danglingLinks(cfg.keyword);
  if (dangling.length > 0) {
    const shown = dangling
      .slice(0, 12)
      .map((d) => `  ${d.from} → ${d.title}`)
      .join("\n");
    const more =
      dangling.length > 12 ? `\n  …and ${dangling.length - 12} more` : "";
    const go = await editor.confirm(
      `${dangling.length} link${dangling.length === 1 ? "" : "s"} point at ` +
        `notes that are not published:\n\n${shown}${more}\n\n` +
        `Publish anyway? They will appear as dead links.`,
    );
    if (!go) return;
  }

  const creds = await zoteroCredentials();
  const files: GitHubFile[] = [];
  const encode = (text: string) => new TextEncoder().encode(text);
  // Identifier -> where that post ended up, so a `denote:` link between two
  // published notes becomes an ordinary href.
  const hrefs = new Map<string, string>();
  for (const note of live) {
    hrefs.set(note.identifier, `${pathFor(note, cfg)}/`);
  }

  let pulled = 0;
  const entries: PageEntry[] = [];
  for (const note of live) {
    let text: string;
    try {
      text = await space.readPage(note.page);
    } catch {
      continue;
    }
    const dir = pathFor(note, cfg);
    let body = text;

    // Attachments travel with the page, so a relative src keeps working.
    for (const match of text.matchAll(fileLink)) {
      const name = match[1].trim();
      const leaf = name.slice(name.lastIndexOf("/") + 1);
      try {
        files.push({
          path: `${dir}/${leaf}`,
          content: await space.readDocument(name),
        });
        body = body.replaceAll(match[0], `[[file:${leaf}]]`);
      } catch {
        /* a missing image is the author's to fix */
      }
    }
    for (const match of text.matchAll(zoteroLink)) {
      if (!creds) break;
      try {
        const file = await getZoteroAttachment(creds, match[1]);
        if (!file) continue;
        files.push({ path: `${dir}/${file.name}`, content: file.content });
        body = body.replaceAll(match[0], `[[file:${file.name}]]`);
        pulled++;
      } catch {
        /* likewise */
      }
    }

    const page = await renderPage(note, body, hrefs, cfg);
    files.push({ path: `${dir}/index.html`, content: encode(page.html) });
    entries.push(page.entry);
  }

  files.push({
    path: "index.html",
    content: encode(renderIndex(entries, cfg)),
  });
  files.push({ path: "tufte.css", content: encode(tufteCss) });

  await editor.flashNotification(`Committing ${files.length} files…`);
  let sha: string | undefined;
  try {
    sha = await commitFiles(
      {
        owner: cfg.owner,
        repo: cfg.repo,
        branch: cfg.branch,
        token,
        api: cfg.api,
      },
      files,
      `Publish ${live.length} page${live.length === 1 ? "" : "s"}`,
    );
  } catch (e: any) {
    await editor.flashNotification(e.message, "error");
    return;
  }
  if (!sha) {
    await editor.flashNotification("Already up to date — nothing to publish");
    return;
  }
  const drafts = all.length - live.length;
  await editor.flashNotification(
    `Published ${live.length} page${live.length === 1 ? "" : "s"}` +
      (drafts
        ? `, ${drafts} held back as draft${drafts === 1 ? "" : "s"}`
        : "") +
      (pulled ? `, ${pulled} file${pulled === 1 ? "" : "s"} from Zotero` : "") +
      ` — ${sha.slice(0, 7)}`,
  );
}

type PageEntry = { title: string; href: string; date: string; post: boolean };

/**
 * Where a note lands. A post goes under `posts/`, a page at the root: the
 * distinction is a keyword, not a guess at a missing date.
 */
function pathFor(note: DenoteObject, cfg: BlogConfig): string {
  const slug = slugFor(note.title, note.identifier);
  return (note.keywords ?? []).includes("page") ? slug : `posts/${slug}`;
}

/** One page, rendered. */
async function renderPage(
  note: DenoteObject,
  body: string,
  hrefs: Map<string, string>,
  cfg: BlogConfig,
): Promise<{ html: string; entry: PageEntry }> {
  const front = Object.fromEntries(
    [...body.matchAll(/^#\+(\w+):[ \t]*(.*)$/gim)].map((m) => [
      m[1].toLowerCase(),
      m[2].trim(),
    ]),
  );
  const post = !(note.keywords ?? []).includes("page");
  const dir = pathFor(note, cfg);
  const depth = dir.split("/").length;
  const up = "../".repeat(depth);

  // A link between two published notes becomes a real href; one to anything
  // else keeps its words and loses its link, which is what the scan warned
  // about.
  let source = body.replace(
    /\[\[denote:(\d{8}T\d{6})\](?:\[([^\]]*)\])?\]/g,
    (whole, id, label) => {
      const href = hrefs.get(id);
      const text = label || id;
      return href ? `[[${up}${href}][${text}]]` : text;
    },
  );
  const counter = (() => {
    let n = 0;
    return () => ++n;
  })();
  // Each shortcode becomes a token the renderer carries through as plain
  // text, and its HTML goes back in afterwards. Substituting before the
  // render hands raw HTML to a parser that escapes it; a token keeps the two
  // passes from fighting.
  const pieces: string[] = [];
  source = replaceShortcodes(source, (code: Shortcode) => {
    pieces.push(tufteHtml(code, counter));
    return `SBSHORTCODE${pieces.length - 1}END`;
  });

  let rendered = await markdown.pageToHtml(note.page, source);
  pieces.forEach((piece, i) => {
    const token = `SBSHORTCODE${i}END`;
    // A block-level figure lands alone in a paragraph; unwrap it rather than
    // leaving a <figure> inside a <p>.
    rendered = rendered
      .replaceAll(`<p>${token}</p>`, piece)
      .replaceAll(token, piece);
  });
  const title = front.title ?? note.title;
  const date = hugoDate(front.date);
  const html = [
    "<!doctype html>",
    '<html lang="en"><head>',
    '<meta charset="utf-8"/>',
    '<meta name="viewport" content="width=device-width, initial-scale=1"/>',
    `<title>${escapeHtml(title)} — ${escapeHtml(cfg.siteTitle)}</title>`,
    front.description
      ? `<meta name="description" content="${escapeHtml(front.description)}"/>`
      : "",
    `<link rel="stylesheet" href="${up}tufte.css"/>`,
    "</head><body><article>",
    `<h1>${escapeHtml(title)}</h1>`,
    front.description
      ? `<p class="subtitle">${escapeHtml(front.description)}</p>`
      : "",
    rendered,
    "</article>",
    `<footer class="site"><a href="${up}">${escapeHtml(cfg.siteTitle)}</a>` +
      (date ? ` · ${escapeHtml(date)}` : "") +
      "</footer>",
    "</body></html>",
  ]
    .filter(Boolean)
    .join("\n");

  return { html, entry: { title, href: `${dir}/`, date, post } };
}

/** The front page: pages first, then posts newest first. */
function renderIndex(entries: PageEntry[], cfg: BlogConfig): string {
  const posts = entries
    .filter((e) => e.post)
    .sort((a, b) => b.date.localeCompare(a.date));
  const pages = entries.filter((e) => !e.post);
  const list = (items: PageEntry[]) =>
    items
      .map(
        (e) =>
          `<li><a href="${e.href}">${escapeHtml(e.title)}</a>` +
          (e.date ? `<span class="when">${escapeHtml(e.date)}</span>` : "") +
          "</li>",
      )
      .join("\n");
  return [
    "<!doctype html>",
    '<html lang="en"><head>',
    '<meta charset="utf-8"/>',
    '<meta name="viewport" content="width=device-width, initial-scale=1"/>',
    `<title>${escapeHtml(cfg.siteTitle)}</title>`,
    '<link rel="stylesheet" href="tufte.css"/>',
    "</head><body><article>",
    `<h1>${escapeHtml(cfg.siteTitle)}</h1>`,
    pages.length ? `<nav class="index"><ul>${list(pages)}</ul></nav>` : "",
    `<nav class="index"><ul>${list(posts)}</ul></nav>`,
    "</article></body></html>",
  ]
    .filter(Boolean)
    .join("\n");
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** Zotero credentials, or undefined when the library is not set up here. */
async function zoteroCredentials() {
  const zotero = await system.getConfig<{
    userId?: string;
    apiKey?: string;
    api?: string;
  }>("zotero", {});
  if (!zotero.userId || !zotero.apiKey) return undefined;
  return { userId: zotero.userId, apiKey: zotero.apiKey, api: zotero.api };
}

/** `Blog: Check Links` -- the scan on its own, without exporting. */
export async function checkLinksCommand(): Promise<void> {
  const { keyword } = await blogConfig();
  const dangling = await danglingLinks(keyword);
  if (dangling.length === 0) {
    await editor.flashNotification("Every link points at a post");
    return;
  }
  await editor.flashNotification(
    `${dangling.length} link${dangling.length === 1 ? "" : "s"} point at ` +
      `notes that are not posts`,
    "error",
  );
  console.log("[blog] links to non-posts:", dangling);
}
