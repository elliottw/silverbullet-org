/**
 * Give every migrated attachment a parent item, so it can be cited.
 *
 * A bare attachment in Zotero is a file; a regular item with the file as
 * its child is *reference material* -- Better BibTeX gives it a citekey,
 * and `[cite:@key]` follows. The migration uploaded files bare. This makes
 * the parents.
 *
 * The title, in order of trust: an identifier in the first pages (a DOI
 * through Crossref, an ISBN through OpenLibrary); the PDF's own embedded
 * title when it is plausible; the words a note used to link the file; the
 * file name, cleaned. The item type follows what was found, or the folder:
 * a saved page is a `webpage` with its source URL, a file under `book/` a
 * `book`, the rest `document`. The linking note's keywords become tags.
 *
 *     npx tsx tools/obsidian-migration/zotero-parents.ts            # dry run
 *     npx tsx tools/obsidian-migration/zotero-parents.ts --apply    # resumable
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createParentItem,
  type ParentItemSpec,
  type ZoteroCredentials,
} from "../../plug-api/lib/zotero_api.ts";
import { config } from "./config.ts";
import type { Manifest } from "./manifest.ts";

const apply = process.argv.includes("--apply");
const only = process.argv.includes("--only")
  ? process.argv[process.argv.indexOf("--only") + 1]
  : undefined;

const home = process.env.HOME!;
const creds: ZoteroCredentials = {
  apiKey: readFileSync(join(home, ".config/silverbullet/zotero.env"), "utf8")
    .trim()
    .split("=")[1],
  userId: readFileSync(join(home, ".config/silverbullet/zotero.userid"), "utf8")
    .trim()
    .split("=")[1],
};
const headers = { "Zotero-API-Key": creds.apiKey, "Zotero-API-Version": "3" };
const base = `https://api.zotero.org/users/${creds.userId}`;

async function zfetch(path: string, init: RequestInit = {}): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(path.startsWith("http") ? path : `${base}${path}`, {
      ...init,
      headers: { ...headers, ...(init.headers as Record<string, string>) },
    });
    const backoff =
      res.headers.get("Backoff") ?? res.headers.get("Retry-After");
    if (res.status === 429 || (res.status >= 500 && attempt < 5)) {
      const wait = Math.max(2, Number(backoff) || 2 ** attempt) * 1000;
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    if (backoff)
      await new Promise((r) => setTimeout(r, Number(backoff) * 1000));
    return res;
  }
}

// ---------------------------------------------------------------------------
// What a file is called
// ---------------------------------------------------------------------------

const doiRe = /\b(10\.\d{4,9}\/[^\s"<>)\]]+)/;
const isbnRe =
  /ISBN[-: ]*((?:97[89][- ]?)?\d[- ]?\d{2,5}[- ]?\d{2,7}[- ]?[\dX])\b/i;

function firstPagesText(abs: string): string {
  try {
    return execFileSync("pdftotext", ["-l", "3", "-q", abs, "-"], {
      encoding: "utf8",
      timeout: 30_000,
    });
  } catch {
    return "";
  }
}

function embeddedTitle(abs: string): string | undefined {
  try {
    const info = execFileSync("pdfinfo", [abs], {
      encoding: "utf8",
      timeout: 15_000,
    });
    // Spaces only: an empty `Title:` must not run on to the next line.
    const m = /^Title:[ \t]+(\S.*)$/m.exec(info);
    // PDF strings escape parentheses; some tools wrap the whole title in them.
    const title = m?.[1]
      .trim()
      .replace(/\\([()])/g, "$1")
      .replace(/^\((.*)\)$/, "$1")
      .trim();
    if (!title) return undefined;
    // What word processors and scanners write is not a title.
    if (
      /^(microsoft word|untitled|document\d*|scan|scanned|img_|dsc_|print|slide ?\d*)/i.test(
        title,
      )
    )
      return undefined;
    if (/\.(docx?|pdf|pptx?|xlsx?|indd|ai)$/i.test(title)) return undefined;
    if (title.length < 4 || title.length > 200) return undefined;
    return title;
  } catch {
    return undefined;
  }
}

/** `decisionmatrix-219-azalea-rd-e.pdf` → `Decisionmatrix 219 Azalea Rd E`. */
function titleFromFilename(name: string): string {
  const stem = name
    .replace(/\.[^.]+$/, "")
    .replace(/^\d{8}T\d{6}(==[^-]*)?--/, "")
    // Download-site suffixes and the like.
    .replace(/\s*[-–(]\s*(libgen\.\w+|z-?lib\w*|annas?-?archive)[^)]*\)?$/i, "")
    .replace(/\s+/g, " ")
    .trim();
  // A name that is already words -- mixed case, spaces -- is left as it is.
  // One that is a slug gets its separators back and a capital per word.
  if (/\s/.test(stem) && /[a-z]/.test(stem) && /[A-Z]/.test(stem)) return stem;
  return stem
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** The source URL a saved page carries: SingleFile's comment, or a clipper's. */
function savedPageUrl(abs: string): string | undefined {
  try {
    const head = readFileSync(abs, "utf8").slice(0, 4000);
    return (
      /url:\s*(https?:\/\/\S+)/i.exec(head)?.[1] ??
      /saved from url=\(\d+\)(https?:\/\/\S+)/i.exec(head)?.[1] ??
      /<link[^>]+rel="canonical"[^>]+href="([^"]+)"/i.exec(head)?.[1]
    );
  } catch {
    return undefined;
  }
}

function htmlTitle(abs: string): string | undefined {
  try {
    const m = /<title[^>]*>([^<]{2,200})<\/title>/i.exec(
      readFileSync(abs, "utf8").slice(0, 20000),
    );
    return m?.[1].replace(/\s+/g, " ").trim();
  } catch {
    return undefined;
  }
}

async function fromCrossref(
  doi: string,
): Promise<Partial<ParentItemSpec> | undefined> {
  try {
    const res = await fetch(
      `https://api.crossref.org/works/${encodeURIComponent(doi)}`,
      {
        headers: {
          "User-Agent": "silverbullet-org (mailto:elliott@elliott.io)",
        },
      },
    );
    if (!res.ok) return undefined;
    const w = (await res.json()).message;
    const types: Record<string, string> = {
      "journal-article": "journalArticle",
      book: "book",
      "book-chapter": "bookSection",
      "proceedings-article": "conferencePaper",
      report: "report",
    };
    const itemType = types[w.type] ?? "document";
    const container = w["container-title"]?.[0];
    // The containing work's field is named per type: a chapter's book is
    // `bookTitle`, a paper's proceedings `proceedingsTitle`, an article's
    // journal `publicationTitle`; a book or report has none.
    const containerField: Record<string, string> = {
      journalArticle: "publicationTitle",
      bookSection: "bookTitle",
      conferencePaper: "proceedingsTitle",
    };
    return {
      itemType,
      title: (w.title?.[0] ?? "").trim() || undefined,
      creators: (w.author ?? []).map((a: any) => ({
        creatorType: "author",
        firstName: a.given,
        lastName: a.family,
      })),
      date: w.issued?.["date-parts"]?.[0]?.join("-"),
      fields: {
        DOI: doi,
        ...(container && containerField[itemType]
          ? { [containerField[itemType]]: container }
          : {}),
      },
    };
  } catch {
    return undefined;
  }
}

async function fromOpenLibrary(
  isbn: string,
): Promise<Partial<ParentItemSpec> | undefined> {
  const clean = isbn.replace(/[- ]/g, "");
  try {
    const res = await fetch(
      `https://openlibrary.org/api/books?bibkeys=ISBN:${clean}&jscmd=data&format=json`,
    );
    if (!res.ok) return undefined;
    const b = (await res.json())[`ISBN:${clean}`];
    if (!b?.title) return undefined;
    return {
      itemType: "book",
      title: b.title,
      creators: (b.authors ?? []).map((a: any) => ({
        creatorType: "author",
        name: a.name,
      })),
      date: b.publish_date,
      fields: {
        ISBN: clean,
        ...(b.publishers?.[0]?.name ? { publisher: b.publishers[0].name } : {}),
      },
    };
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// What the notes say about a file
// ---------------------------------------------------------------------------

type Context = { alias?: string; keywords: string[] };

/** For each vault file: the words notes used to link it, and their keywords. */
function contextFromNotes(manifest: Manifest): Map<string, Context> {
  const ctx = new Map<string, Context>();
  const aliasCounts = new Map<string, Map<string, number>>();
  const keywords = new Map<string, Set<string>>();
  const byName = new Map<string, string>();
  for (const e of manifest.entries) {
    if (e.kind === "attachment" && e.target) {
      byName.set(e.source.split("/").pop()!.toLowerCase(), e.source);
      byName.set(e.source.toLowerCase(), e.source);
    }
  }
  const wiki = /!?\[\[([^\]|#^]+)(?:[#^][^\]|]*)?(?:\|([^\]]*))?\]\]/g;
  const md = /!?\[([^\]]*)\]\(((?!https?:|mailto:|[a-z]+:\/\/)[^)\s]+)\)/g;
  for (const e of manifest.entries) {
    if (e.kind !== "note" || !e.target) continue;
    let text: string;
    try {
      text = readFileSync(join(manifest.vault, e.source), "utf8");
    } catch {
      continue;
    }
    const dir = e.source.split("/").slice(0, -1).join("/");
    const note = (target: string, alias?: string) => {
      let t = target.trim();
      try {
        t = decodeURIComponent(t);
      } catch {
        // A stray `%` in a wiki link is not an escape.
      }
      const source =
        byName.get(t.toLowerCase()) ??
        byName.get(`${dir}/${t}`.toLowerCase()) ??
        byName.get(t.split("/").pop()!.toLowerCase());
      if (!source) return;
      const a = alias?.trim();
      if (a && !/\.(pdf|docx?|pptx?|xlsx?|html?|epub)$/i.test(a)) {
        const m = aliasCounts.get(source) ?? new Map();
        m.set(a, (m.get(a) ?? 0) + 1);
        aliasCounts.set(source, m);
      }
      const k = keywords.get(source) ?? new Set();
      for (const kw of e.keywords) k.add(kw);
      keywords.set(source, k);
    };
    for (const m of text.matchAll(wiki)) note(m[1], m[2]);
    for (const m of text.matchAll(md)) note(m[2], m[1]);
  }
  for (const source of new Set([...aliasCounts.keys(), ...keywords.keys()])) {
    const best = [...(aliasCounts.get(source) ?? [])].sort(
      (a, b) => b[1] - a[1],
    )[0]?.[0];
    ctx.set(source, {
      alias: best,
      keywords: [...(keywords.get(source) ?? [])].sort(),
    });
  }
  return ctx;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

type MapEntry = { key: string; collection: string; parent?: string };

async function main() {
  const manifest: Manifest = JSON.parse(
    readFileSync(join(config.out, "manifest.json"), "utf8"),
  );
  const mapPath = join(config.out, "zotero-map.json");
  const map: Record<string, MapEntry> = JSON.parse(
    readFileSync(mapPath, "utf8"),
  );
  const ctx = contextFromNotes(manifest);

  const todo = Object.entries(map).filter(
    ([s, v]) => !v.parent && (!only || s.includes(only)),
  );
  console.log(
    `${Object.keys(map).length} mapped files, ${todo.length} without a parent`,
  );
  const tally: Record<string, number> = {};
  let n = 0;
  for (const [source, entry] of todo) {
    const abs = join(manifest.vault, source);
    const name = source.split("/").pop()!;
    const isPdf = /\.pdf$/i.test(name);
    const isHtml = /\.html?$/i.test(name);
    const c = ctx.get(source);

    // Is the mapped key already a regular item? Then the file has a parent.
    const itemRes = await zfetch(`/items/${entry.key}`);
    if (itemRes.status === 404) {
      console.log(`  gone     ${source}`);
      continue;
    }
    const item = await itemRes.json();
    if (item.data.itemType !== "attachment") {
      entry.parent = entry.key;
      tally["already a regular item"] =
        (tally["already a regular item"] ?? 0) + 1;
      continue;
    }
    if (item.data.parentItem) {
      entry.parent = item.data.parentItem;
      tally["already had a parent"] = (tally["already had a parent"] ?? 0) + 1;
      continue;
    }

    // The title and type.
    let spec: ParentItemSpec | undefined;
    let how = "";
    if (isPdf && existsSync(abs)) {
      const text = firstPagesText(abs);
      const doi = doiRe.exec(text)?.[1].replace(/[.,;]+$/, "");
      const isbn = isbnRe.exec(text)?.[1];
      if (doi) {
        const found = await fromCrossref(doi);
        if (found?.title) {
          spec = { ...found, title: found.title } as ParentItemSpec;
          how = "doi";
        }
      }
      if (!spec && isbn) {
        const found = await fromOpenLibrary(isbn);
        if (found?.title) {
          spec = { ...found, title: found.title } as ParentItemSpec;
          how = "isbn";
        }
      }
      if (!spec) {
        const t = embeddedTitle(abs);
        if (t) {
          spec = { title: t };
          how = "embedded title";
        }
      }
    }
    if (!spec && isHtml && existsSync(abs)) {
      const t = htmlTitle(abs);
      const url = savedPageUrl(abs);
      if (t || url) {
        spec = {
          itemType: "webpage",
          title: t ?? c?.alias ?? titleFromFilename(name),
          url,
        };
        how = "saved page";
      }
    }
    if (!spec && c?.alias) {
      spec = { title: c.alias };
      how = "link text";
    }
    if (!spec) {
      spec = { title: titleFromFilename(name) };
      how = "file name";
    }
    if (!spec.itemType) {
      spec.itemType =
        /\/book\//i.test(source) || /\/books\//i.test(source)
          ? "book"
          : "document";
    }
    spec.collections = item.data.collections ?? [];
    spec.tags = c?.keywords ?? [];
    tally[how] = (tally[how] ?? 0) + 1;

    if (!apply) {
      if (n++ < 25)
        console.log(
          `  ${how.padEnd(15)} ${spec.itemType?.padEnd(8)} ${spec.title.slice(0, 70)}  ← ${name}`,
        );
      continue;
    }
    try {
      const parent = await createParentItem(creds, spec);
      const version = itemRes.headers.get("Last-Modified-Version") ?? "";
      const patch = await zfetch(`/items/${entry.key}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "If-Unmodified-Since-Version": version,
        },
        body: JSON.stringify({ parentItem: parent, collections: [] }),
      });
      if (patch.status !== 204)
        throw new Error(
          `could not attach: ${patch.status} ${await patch.text()}`,
        );
      entry.parent = parent;
      if (++n % 10 === 0) writeFileSync(mapPath, JSON.stringify(map, null, 1));
      console.log(`  ${how.padEnd(15)} ${parent}  ${spec.title.slice(0, 60)}`);
    } catch (e: any) {
      console.log(`  FAILED ${source}: ${e.message}`);
    }
  }
  writeFileSync(mapPath, JSON.stringify(map, null, 1));
  console.log("\nby source of title:", tally);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
