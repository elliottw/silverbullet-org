/**
 * Keeping a reference note's keywords and its Zotero item's tags in step.
 *
 * Two places hold the same list and either may be edited, so a plain
 * comparison cannot tell "added here" from "removed there". The note keeps a
 * shadow of the last agreed set (`#+zotero_tags:`), which turns the
 * comparison into an ordinary three-way merge -- the same trick a file
 * synchroniser uses.
 *
 * Keywords and tags are not spelled alike: Denote sluggifies a keyword
 * (`Land bank` → `landbank`), so slugs are what the sides are compared on and
 * Zotero's own spelling is kept for tags it already has.
 */

export type TagMerge = {
  /** What the note's keywords should be: slugs, sorted, no marker keyword. */
  keywords: string[];
  /** What the item's tags should be, Zotero's spelling kept where it has one. */
  tags: string[];
  /** The new shadow: the slugs both sides now agree on. */
  shadow: string[];
  noteChanged: boolean;
  zoteroChanged: boolean;
};

export type TagMergeInput = {
  /** The note's keywords, already sluggified, with the `bib` marker removed. */
  noteKeywords: string[];
  /** The item's tags, as Zotero spells them. */
  zoteroTags: string[];
  /** The slugs the last sync left both sides holding. */
  shadow: string[];
  /**
   * Whether a keyword added on the note may be pushed to Zotero. With this
   * off the note is downstream only: Zotero's tags arrive, local keywords
   * stay local, and nothing is written to the library.
   */
  push: boolean;
};

export const slugifyTag = (tag: string) =>
  tag.toLowerCase().replace(/[^a-z0-9]+/g, "");

export function mergeTags(input: TagMergeInput): TagMerge {
  const { push } = input;
  const bySlug = new Map<string, string>();
  for (const tag of input.zoteroTags) {
    const slug = slugifyTag(tag);
    if (slug && !bySlug.has(slug)) bySlug.set(slug, tag);
  }
  const zotero = new Set(bySlug.keys());
  const note = new Set(input.noteKeywords.map(slugifyTag).filter(Boolean));
  const shadow = new Set(input.shadow.map(slugifyTag).filter(Boolean));

  const keywords = new Set<string>();
  const tags = new Set<string>();
  const agreed = new Set<string>();

  for (const slug of new Set([...zotero, ...note, ...shadow])) {
    const inZ = zotero.has(slug);
    const inN = note.has(slug);
    const inS = shadow.has(slug);
    if (inZ && inN) {
      // Both have it.
      keywords.add(slug);
      tags.add(bySlug.get(slug)!);
      agreed.add(slug);
    } else if (inZ && !inN && inS) {
      // Dropped from the note since the last sync.
      if (push) continue;
      tags.add(bySlug.get(slug)!);
      agreed.add(slug);
    } else if (inZ && !inN) {
      // Added in Zotero.
      keywords.add(slug);
      tags.add(bySlug.get(slug)!);
      agreed.add(slug);
    } else if (inN && inS) {
      // Dropped in Zotero since the last sync.
      continue;
    } else if (inN) {
      // Added on the note. Without `push` it is a local keyword, and stays
      // out of the shadow so it is never mistaken for a Zotero tag later.
      keywords.add(slug);
      if (push) {
        tags.add(slug);
        agreed.add(slug);
      }
    }
    // In the shadow only: gone from both sides, so gone.
  }

  const sorted = (s: Set<string>) => [...s].sort();
  const sameSet = (a: string[], b: string[]) =>
    a.length === b.length && a.every((x, i) => x === b[i]);
  return {
    keywords: sorted(keywords),
    tags: sorted(tags),
    shadow: sorted(agreed),
    noteChanged: !sameSet(
      sorted(keywords),
      sorted(new Set(input.noteKeywords.map(slugifyTag).filter(Boolean))),
    ),
    zoteroChanged: !sameSet(
      sorted(tags),
      sorted(new Set(input.zoteroTags.filter((t) => slugifyTag(t)))),
    ),
  };
}
