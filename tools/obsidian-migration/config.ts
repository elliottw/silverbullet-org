import { homedir } from "node:os";
import { join } from "node:path";

export const config = {
  vault: join(
    homedir(),
    "Library/Mobile Documents/iCloud~md~obsidian/Documents/obsidian",
  ),
  library: join(homedir(), "org"),
  /** Where the manifest, report and staged output go. Never the library itself. */
  out: join(homedir(), "org-migration"),

  /** The perpetual calendar: split into journal entries, its navigation dropped. */
  calendarDir: "✱",
  /** The vault's own journal folder (after the area layer is stripped). */
  vaultJournalFolder: "01 journal",

  // Mirror the fork's `denote.journal*` settings.
  journalFolder: "journal",
  journalKeyword: "journal",
  journalTitleFormat: "day-date-month-year",

  /** Resolution for scanned PDFs rendered to page images. */
  rasterDpi: 150,

  /** Files with no JD category land here for sorting by hand. */
  unassignedFolder: "00 inbox",

  /** Vault link targets that map onto pages the library already has. */
  linkAliases: {
    "✱ Home": "00000000T000000--home.org",
  } as Record<string, string>,
};
