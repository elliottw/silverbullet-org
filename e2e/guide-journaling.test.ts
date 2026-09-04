import type { Page } from "@playwright/test";
import { expect, test, waitForSaveAndReadFromServer } from "./fixtures.ts";
import { currentPage, runCommandViaPalette } from "./navigator-ui.ts";

// This file exercises the journalling workflow end-to-end. In this fork the
// journal is `denote-journal`: `Journal: Today` makes a Denote note in the
// journal directory, keyworded and titled with the date, rather than a
// Markdown `Journal/<date>` page.

/** Today's Denote identifier stamp, which every entry for the day carries. */
function todayStamp(): string {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}${mm}${dd}`;
}

/** The page name of the entry currently open. */
async function openedEntry(sbPage: Page): Promise<string> {
  return await currentPage(sbPage).inputValue();
}

/**
 * Wait for the welcome page to be loaded (proxy for "the editor is ready and
 * the built-in libraries have registered their commands"), then run the
 * "Journal: Today" command via the command palette.
 */
async function runJournalToday(sbPage: Page): Promise<void> {
  const editor = sbPage.locator("#sb-editor .cm-content");
  await expect(editor).toContainText("Welcome");

  // The command defined by the Journal template has to be there to lead the
  // list, which is what the helper asserts before pressing Enter.
  await runCommandViaPalette(sbPage, "Journal: Today");
  await expect(sbPage.locator(".sb-modal")).toBeHidden();

  await expect(currentPage(sbPage)).toHaveValue(
    new RegExp(`^journal/${todayStamp()}T\\d{6}--.*__journal\\.org$`),
    { timeout: 20_000 },
  );
}

test.describe("Guide: Journaling", () => {
  test.use({
    spaceFiles: {
      "index.md": "# Welcome\nA fresh space, ready to journal.",
    },
  });

  test("running 'Journal: Today' from the command palette creates today's journal page", async ({
    sbPage,
  }) => {
    await runJournalToday(sbPage);

    // Denote front matter, not a template body: the keyword is what marks it
    // as a journal entry, and the title is the date.
    const editor = sbPage.locator("#sb-editor .cm-content");
    await expect(editor).toContainText("#+filetags:  :journal:");
    await expect(editor).toContainText("#+identifier:");
  });

  test("created journal page is tagged journal on disk", async ({
    sbPage,
    sbServer,
  }) => {
    await runJournalToday(sbPage);

    // On disk it is a Denote note: the keyword is in the file name as well as
    // the front matter, which is what makes Emacs see it as a journal entry.
    // Read it straight from the server -- unlike a template, a Denote entry is
    // written before it is opened, so there is no unsaved edit to wait for.
    const entry = await openedEntry(sbPage);
    expect(entry).toContain("__journal.org");
    const resp = await fetch(`${sbServer.url}/.fs/${entry}`);
    expect(resp.ok).toBe(true);
    const content = await resp.text();
    expect(content).toContain(":journal:");
    expect(content).toContain("#+identifier:");
  });

  test("a journal entry can link out to a new page, which is created as Org", async ({
    sbPage,
    sbServer,
  }) => {
    await runJournalToday(sbPage);

    // Type a journal entry that links to [[Alice]] — this is the
    // "watch topic pages come alive" flow from the guide.
    const editor = sbPage.locator("#sb-editor .cm-content");
    await editor.click();
    // Into the body: a click lands wherever it lands, and typing into Denote
    // front matter would rename the file rather than write an entry.
    await sbPage.keyboard.press("Control+End");
    await sbPage.keyboard.type("Reviewed the Q2 roadmap with [[Alice]]", {
      delay: 20,
    });
    // Live preview shows the source while the cursor is on a link, so step off
    // it before looking for the rendered one.
    await sbPage.keyboard.press("Enter");

    // Wait for the journal entry to save
    const entry = await openedEntry(sbPage);
    const journalContent = await waitForSaveAndReadFromServer(
      sbPage,
      sbServer,
      entry,
    );
    expect(journalContent).toContain("[[Alice]]");

    // Navigate to Alice's page via the wiki link
    const wikiLinkText = editor.locator(".sb-wiki-link", { hasText: "Alice" });
    await expect(wikiLinkText).toBeVisible({ timeout: 10_000 });
    await wikiLinkText.click();

    // `.org`: a note linked from an Org page is created as one, matching the
    // note that linked to it.
    await expect(sbPage.locator("#sb-current-page input.sb-input")).toHaveValue(
      "Alice.org",
    );

    // NOTE: no Linked Mentions assertion here, deliberately. A *bare* Org link
    // is not indexed as a relation -- only `denote:` links are -- so it
    // produces no backlink. Linking by identifier does, which is what the `[[`
    // completion writes and what `e2e/denote.test.ts` covers under
    // "Backlinks". Writing a bare link to a page that does not exist yet is
    // the one route that leaves no trail.
  });
});
