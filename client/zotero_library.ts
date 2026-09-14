/**
 * The bibliography as the editor sees it: a citekey → entry map kept in
 * memory so a citation can be drawn as `Graham 2004` without a round trip.
 *
 * Loaded from the Better BibTeX export in the space (`zotero.bibliography`)
 * once the file list is known, and again whenever that file changes -- BBT
 * rewrites it on every library change, and the sync brings it in.
 */
import {
  parseBibtex,
  type BibEntry,
} from "@silverbulletmd/silverbullet/lib/bibtex";
import type { Client } from "./client.ts";

export class ZoteroLibrary {
  private byCitekey = new Map<string, BibEntry>();
  private byItemKey = new Map<string, BibEntry>();
  private loadedName?: string;

  constructor(private client: Client) {}

  get bibliographyName(): string {
    return (
      this.client.config.get<{ bibliography?: string }>("zotero", {})
        .bibliography ?? "zotero.bib"
    );
  }

  /** Wire up: load now, reload on change. Safe to call before boot finishes. */
  attach() {
    const hook = this.client.eventHook;
    // The file list arrives after boot; nothing can be read before it does.
    hook.addLocalListener("file:listed", () => void this.reload());
    hook.addLocalListener("file:changed", (name: string) => {
      if (name === this.bibliographyName) void this.reload();
    });
  }

  async reload() {
    const name = this.bibliographyName;
    let entries: BibEntry[] = [];
    // Only a file the space is known to hold is read. A fetch for one that
    // does not exist is not a harmless miss here: the client reads a failed
    // fetch as having gone offline, and completion and the page list go
    // with it. A space with no bibliography must cost nothing.
    if (this.client.clientSystem.allKnownFiles.has(name)) {
      try {
        const { data } = await this.client.space.readDocument(name);
        entries = parseBibtex(new TextDecoder().decode(data));
      } catch {
        // Unreadable: citations render as their citekey.
      }
    }
    this.byCitekey = new Map(entries.map((e) => [e.citekey, e]));
    this.byItemKey = new Map(
      entries.flatMap((e) => e.attachments.map((a) => [a.key, e] as const)),
    );
    const changed = this.loadedName !== name || entries.length > 0;
    this.loadedName = name;
    if (changed && this.client.editorView) {
      // Redraw so citations pick up their titles.
      this.client.editorView.dispatch({});
    }
  }

  entry(citekey: string): BibEntry | undefined {
    return this.byCitekey.get(citekey);
  }

  entryForItem(key: string): BibEntry | undefined {
    return this.byItemKey.get(key);
  }
}
