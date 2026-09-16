/**
 * Signatures as sequences, and renaming in place.
 *
 * Denote's signature is the file-name component that orders and groups notes
 * -- `denote-sequence` reads `21=14=3` as a place in a tree, and a Johnny
 * Decimal address (`21=14`) is the same thing with two-digit components. The
 * commands here are `denote-sequence-find` and friends (parent, children,
 * siblings, previous, next), `denote-sequence-new-child`/`-sibling`,
 * `denote-sort-dired` by signature as a picker, and `denote-rename-file` /
 * `denote-keywords-add` / `denote-keywords-remove`, all of which rewrite the
 * front matter and let the file name follow.
 */
import {
  compareSignatures,
  denoteFileType,
  isSignatureChildOf,
  nextChildSignature,
  nextSiblingSignature,
  parseDenoteFrontMatter,
  parseDenoteName,
  rewriteDenoteFrontMatter,
  signatureParent,
  sluggify,
} from "@silverbulletmd/silverbullet/lib/denote";
import { editor, space } from "@silverbulletmd/silverbullet/syscalls";
import type { FilterOption } from "@silverbulletmd/silverbullet/type/client";
import { pathFromPageName } from "@silverbulletmd/silverbullet/lib/ref";
import {
  createDenoteNote,
  type DenoteNoteSummary,
  denoteNotes,
  promptForKeywords,
  renameFromFrontMatter,
} from "./denote.ts";

// ---------------------------------------------------------------------------
// Reading the library by signature
// ---------------------------------------------------------------------------

/** Every note that carries a signature, in sequence order. */
export async function signedNotes(): Promise<DenoteNoteSummary[]> {
  return (await denoteNotes())
    .filter((n) => n.signature)
    .sort(
      (a, b) =>
        compareSignatures(a.signature!, b.signature!) ||
        a.title.localeCompare(b.title),
    );
}

/** `21=14  Landslide mediation` -- what a signed note reads as in a picker. */
function option(note: DenoteNoteSummary): FilterOption {
  return {
    name: `${note.signature}  ${note.title}`,
    description: note.keywords.length ? note.keywords.join(", ") : undefined,
    // Keep sequence order rather than the picker's own.
    orderId: 0,
    value: note.name,
  } as FilterOption & { value: string };
}

async function pickAndOpen(
  label: string,
  notes: DenoteNoteSummary[],
  hint: string,
): Promise<void> {
  if (notes.length === 0) {
    await editor.flashNotification(hint, "error");
    return;
  }
  if (notes.length === 1) {
    await editor.navigate(pathFromPageName(notes[0].name) as any);
    return;
  }
  const choice = (await editor.filterBox(label, notes.map(option), hint)) as
    | (FilterOption & { value: string })
    | undefined;
  if (choice) {
    await editor.navigate(pathFromPageName(choice.value) as any);
  }
}

/** The open note's signature, or a complaint. */
async function currentSignature(): Promise<
  { page: string; signature: string } | undefined
> {
  const page = await editor.getCurrentPage();
  const signature = parseDenoteName(page)?.signature;
  if (!signature) {
    await editor.flashNotification("This note has no signature", "error");
    return;
  }
  return { page, signature };
}

/**
 * `denote-sort-dired` by signature, as a picker: every signed note in
 * sequence order. Typing `21=` narrows to a category, as it does in Dired.
 */
export async function browseBySignatureCommand(): Promise<void> {
  await pickAndOpen(
    "Signature",
    await signedNotes(),
    "No note carries a signature yet",
  );
}

/**
 * The note above this one in the sequence. `21=14` → the note signed `21`,
 * or `21=00` where a hub note holds the category's address, as in Johnny
 * Decimal. A top-level signature has no parent.
 */
export async function signatureParentCommand(): Promise<void> {
  const current = await currentSignature();
  if (!current) return;
  const parent = signatureParent(current.signature);
  if (!parent) {
    await editor.flashNotification(
      `${current.signature} is a top-level signature`,
      "error",
    );
    return;
  }
  const notes = await signedNotes();
  const candidates = notes.filter(
    (n) => n.signature === parent || n.signature === `${parent}=00`,
  );
  await pickAndOpen("Parent", candidates, `No note is signed ${parent}`);
}

/** The notes one level down: `21=14` → `21=14=*`. From a `NN=00` hub, the category's. */
export async function signatureChildrenCommand(): Promise<void> {
  const current = await currentSignature();
  if (!current) return;
  const parent = current.signature.endsWith("=00")
    ? current.signature.slice(0, -3)
    : current.signature;
  const notes = (await signedNotes()).filter(
    (n) => n.name !== current.page && isSignatureChildOf(n.signature!, parent),
  );
  await pickAndOpen("Child", notes, `Nothing is signed under ${parent}`);
}

/** The notes beside this one: same parent, same depth. */
export async function signatureSiblingsCommand(): Promise<void> {
  const current = await currentSignature();
  if (!current) return;
  const parent = signatureParent(current.signature);
  const notes = (await signedNotes()).filter(
    (n) =>
      n.name !== current.page &&
      signatureParent(n.signature!) === parent &&
      n.signature !== current.signature,
  );
  await pickAndOpen(
    "Sibling",
    notes,
    parent
      ? `Nothing else is signed under ${parent}`
      : "No other top-level signatures",
  );
}

/** `denote-sequence-find-next-sibling` / `-previous-sibling`. */
export async function signatureNeighborCommand(
  direction: "previous" | "next",
): Promise<void> {
  const current = await currentSignature();
  if (!current) return;
  const parent = signatureParent(current.signature);
  const siblings = (await signedNotes()).filter(
    (n) => signatureParent(n.signature!) === parent,
  );
  const at = siblings.findIndex((n) => n.name === current.page);
  const target =
    at === -1 ? undefined : siblings[at + (direction === "next" ? 1 : -1)];
  if (!target) {
    await editor.flashNotification(
      direction === "next" ? "Last in its sequence" : "First in its sequence",
      "error",
    );
    return;
  }
  await editor.navigate(pathFromPageName(target.name) as any);
}

export function signatureNextCommand(): Promise<void> {
  return signatureNeighborCommand("next");
}

export function signaturePreviousCommand(): Promise<void> {
  return signatureNeighborCommand("previous");
}

// ---------------------------------------------------------------------------
// New notes in the sequence
// ---------------------------------------------------------------------------

/**
 * `denote-sequence-new-child-of-current` / `-new-sibling-of-current`: a note
 * whose signature is the next free one under (or beside) this note's. The
 * computed signature is offered, not imposed -- the prompt can change it.
 */
async function newInSequence(relation: "child" | "sibling"): Promise<void> {
  const current = await currentSignature();
  if (!current) return;
  const existing = (await signedNotes()).map((n) => n.signature!);
  // A `NN=00` hub is the category itself: its children are the category's.
  const base = current.signature.endsWith("=00")
    ? current.signature.slice(0, -3)
    : current.signature;
  const proposed =
    relation === "child"
      ? nextChildSignature(base, existing)
      : nextSiblingSignature(current.signature, existing);
  const signature = await editor.prompt("Signature:", proposed);
  if (signature === undefined) return;
  const title = await editor.prompt("Title:", "");
  if (title === undefined) return;
  if (!title.trim()) {
    await editor.flashNotification("A note needs a title", "error");
    return;
  }
  const keywords = await promptForKeywords();
  if (keywords === undefined) return;
  const name = await createDenoteNote({
    title: title.trim(),
    keywords,
    signature: signature.trim() || undefined,
  });
  const text = await space.readPage(name);
  await editor.navigate({
    path: name as `${string}.${string}`,
    details: { type: "position", pos: text.length },
  });
}

export function newChildNoteCommand(): Promise<void> {
  return newInSequence("child");
}

export function newSiblingNoteCommand(): Promise<void> {
  return newInSequence("sibling");
}

// ---------------------------------------------------------------------------
// Renaming in place
// ---------------------------------------------------------------------------

/**
 * Rewrites the open note's front matter and renames the file to match, the
 * way `denote-rename-file` does both at once. Denote links address the
 * identifier, which never changes, so nothing that points here breaks.
 */
async function rewriteAndRename(changes: {
  title?: string;
  keywords?: string[];
  signature?: string;
}): Promise<void> {
  const page = await editor.getCurrentPage();
  const parsed = parseDenoteName(page);
  if (!parsed?.identifier) {
    await editor.flashNotification("Not a Denote note", "error");
    return;
  }
  const text = await editor.getText();
  const fileType = denoteFileType(parsed.extension, text);
  const rewritten = rewriteDenoteFrontMatter(text, fileType, {
    ...changes,
    signature:
      changes.signature === undefined
        ? undefined
        : sluggify("signature", changes.signature),
  });
  if (rewritten !== text) {
    await editor.setText(rewritten);
    await editor.save();
  }
  const renamed = await renameFromFrontMatter(page);
  await editor.flashNotification(renamed ? `Renamed to ${renamed}` : "Updated");
}

/** `denote-rename-file`: title, keywords and signature, each defaulting to what the note has. */
export async function renameNoteCommand(): Promise<void> {
  const page = await editor.getCurrentPage();
  const parsed = parseDenoteName(page);
  if (!parsed?.identifier) {
    await editor.flashNotification("Not a Denote note", "error");
    return;
  }
  const text = await editor.getText();
  const fm = parseDenoteFrontMatter(
    text,
    denoteFileType(parsed.extension, text),
  );
  const title = await editor.prompt("Title:", fm.title ?? "");
  if (title === undefined) return;
  const keywordsTyped = await editor.prompt(
    "Keywords (comma separated):",
    (fm.hasKeywords ? fm.keywords : parsed.keywords).join(", "),
  );
  if (keywordsTyped === undefined) return;
  const signature = await editor.prompt(
    "Signature (empty for none):",
    fm.signature ?? parsed.signature ?? "",
  );
  if (signature === undefined) return;
  await rewriteAndRename({
    title: title.trim() || fm.title,
    keywords: keywordsTyped
      .split(",")
      .map((k) => sluggify("keyword", k.trim()))
      .filter(Boolean)
      .sort(),
    signature: signature.trim(),
  });
}

/** Just the signature -- the one component that moves a note in the sequence. */
export async function setSignatureCommand(): Promise<void> {
  const page = await editor.getCurrentPage();
  const parsed = parseDenoteName(page);
  if (!parsed?.identifier) {
    await editor.flashNotification("Not a Denote note", "error");
    return;
  }
  const signature = await editor.prompt(
    "Signature (empty for none):",
    parsed.signature ?? "",
  );
  if (signature === undefined) return;
  await rewriteAndRename({ signature: signature.trim() });
}

/** `denote-keywords-add`: pick keywords to add to the open note. */
export async function addKeywordsCommand(): Promise<void> {
  const page = await editor.getCurrentPage();
  const parsed = parseDenoteName(page);
  if (!parsed?.identifier) {
    await editor.flashNotification("Not a Denote note", "error");
    return;
  }
  const chosen = await promptForKeywords();
  if (!chosen?.length) return;
  const text = await editor.getText();
  const fm = parseDenoteFrontMatter(
    text,
    denoteFileType(parsed.extension, text),
  );
  const current = fm.hasKeywords ? fm.keywords : parsed.keywords;
  await rewriteAndRename({
    keywords: [...new Set([...current, ...chosen])].sort(),
  });
}

/** `denote-keywords-remove`: pick one of the open note's keywords to drop. */
export async function removeKeywordsCommand(): Promise<void> {
  const page = await editor.getCurrentPage();
  const parsed = parseDenoteName(page);
  if (!parsed?.identifier) {
    await editor.flashNotification("Not a Denote note", "error");
    return;
  }
  const text = await editor.getText();
  const fm = parseDenoteFrontMatter(
    text,
    denoteFileType(parsed.extension, text),
  );
  const current = fm.hasKeywords ? fm.keywords : parsed.keywords;
  if (!current.length) {
    await editor.flashNotification("This note has no keywords", "error");
    return;
  }
  const choice = await editor.filterBox(
    "Remove",
    current.map((k) => ({ name: k })),
    "Which keyword to remove",
  );
  if (!choice) return;
  await rewriteAndRename({
    keywords: current.filter((k) => k !== choice.name),
  });
}
