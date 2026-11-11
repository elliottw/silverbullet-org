import {
  clientStore,
  editor,
  index,
  space,
  system,
} from "@silverbulletmd/silverbullet/syscalls";
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
  /** Where posts live in the repo. */
  postsDir: string;
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
    postsDir: configured.postsDir ?? "content/posts",
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
  const posts = await publishable(cfg.keyword);
  if (posts.length === 0) {
    await editor.flashNotification(
      `No notes keyworded ${cfg.keyword}`,
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
        `notes that are not posts:\n\n${shown}${more}\n\n` +
        `Publish anyway? They will appear as dead links.`,
    );
    if (!go) return;
  }

  const creds = await zoteroCredentials();
  const files: GitHubFile[] = [];
  let drafts = 0;
  let pulled = 0;
  for (const post of posts) {
    let text: string;
    try {
      text = await space.readPage(post.page);
    } catch {
      continue;
    }
    const draft = /^#\+draft:[ \t]*true[ \t]*$/im.test(text);
    if (draft) drafts++;
    const categories = (post.keywords ?? []).filter((k) => k !== cfg.keyword);
    const slug = slugFor(post.title, post.identifier);
    const dir = `${cfg.postsDir}/${slug}`;
    let body = text;

    // An image kept beside the note travels with the post: a page bundle is
    // a directory, so the relative link keeps working.
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
        // A missing image is the author's to fix, and not worth failing the
        // whole publish over.
      }
    }

    // A file that lives in Zotero rather than beside the note is pulled down
    // and put in the bundle, so the site does not link into a library only
    // you can read.
    for (const match of text.matchAll(zoteroLink)) {
      if (!creds) break;
      const key = match[1];
      try {
        const file = await getZoteroAttachment(creds, key);
        if (!file) continue;
        files.push({ path: `${dir}/${file.name}`, content: file.content });
        body = body.replaceAll(match[0], `[[file:${file.name}]]`);
        pulled++;
      } catch {
        // Likewise: a reference that will not download is reported by its
        // absence, not by a failed publish.
      }
    }

    files.push({
      path: `${dir}/index.org`,
      content: new TextEncoder().encode(toPost(body, { categories, draft })),
    });
  }

  await editor.flashNotification(
    `Committing ${files.length} file${files.length === 1 ? "" : "s"}…`,
  );
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
      `Publish ${posts.length} post${posts.length === 1 ? "" : "s"} ` +
        `from the note library`,
    );
  } catch (e: any) {
    await editor.flashNotification(e.message, "error");
    return;
  }
  if (!sha) {
    await editor.flashNotification("Already up to date — nothing to publish");
    return;
  }
  await editor.flashNotification(
    `Published ${posts.length} post${posts.length === 1 ? "" : "s"}` +
      (drafts ? `, ${drafts} as draft${drafts === 1 ? "" : "s"}` : "") +
      (pulled ? `, ${pulled} file${pulled === 1 ? "" : "s"} from Zotero` : "") +
      ` — ${sha.slice(0, 7)}`,
  );
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
