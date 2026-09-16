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

  /**
   * Folders that are not notes and their files, decided by hand after
   * looking at each. Everything else in the vault dissolves into the flat
   * library. Paths are vault-relative.
   */
  folders: {
    /** Code and project working directories → where they live under ~/code. */
    code: {
      "20-29 Missions/25 app with mike/25.02 preline-halle-code.nosync":
        "halle",
      "20-29 Missions/25 app with mike/assets/acorn narrow colored cross.icon":
        "halle/icons/acorn narrow colored cross.icon",
      "20-29 Missions/25 app with mike/assets/acorn smaller cross.icon":
        "halle/icons/acorn smaller cross.icon",
      "20-29 Missions/25 app with mike/assets/acorn squat cross on top.icon":
        "halle/icons/acorn squat cross on top.icon",
      "20-29 Missions/25 app with mike/assets/acorn squat cut out cross.icon":
        "halle/icons/acorn squat cut out cross.icon",
      "20-29 Missions/24 pittsburgh book/24.06 scripts":
        "pittsburgh-book/scripts",
      "20-29 Missions/24 pittsburgh book/05 resources/04 data/arcgis-pittsburgh-ownership":
        "pittsburgh-book/data/arcgis-pittsburgh-ownership",
      "40-49 Acts/46 mxg/03 Projects/2023-04-04 slim-chair": "slim-chair",
    } as Record<string, string>,
    codeDir: join(homedir(), "code"),
    /**
     * Folders of project folders whose files (cut files, CAD, photos) go to
     * Zotero, one parent item per project. A project that is code is code.
     */
    zoteroProjects: ["40-49 Acts/46 mxg/03 Projects"],
    /** Not migrated at all. */
    drop: [
      // Byte-identical to halle/preline.
      "50-59 Design/UI Design/preline-pro-templates.nosync",
      // The history of the Markdown folder; bundled into ~/code/pittsburgh-book at cutover.
      "20-29 Missions/24 pittsburgh book/.git",
    ],
  },

  /** Vault link targets that map onto pages the library already has. */
  linkAliases: {
    "✱ Home": "00000000T000000--home.org",
  } as Record<string, string>,
};
