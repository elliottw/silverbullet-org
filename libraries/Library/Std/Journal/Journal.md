#meta

This page implements the built-in daily journal feature: four commands (`Journal: Today`, `Journal: Previous Day`, `Journal: Next Day`, `Journal: Picker`).

In this fork the journal is [`denote-journal`](https://github.com/protesilaos/denote-journal): an entry is a Denote note in `denote.journalDirectory` carrying the journal keyword, titled with the date. The commands and their keys are unchanged, so there is one journal system rather than two — but the entries are notes Emacs recognises as journal entries too, and the settings that shape them are the `denote.journal*` keys rather than the `journal.*` ones below.

# Configuration
The journal feature can be configured via the `journal` config key:

* `journal.enabled` — set to `false` to disable all journal commands.
* `journal.tag` — tag used to mark journal pages (defaults to `journal`). The default index page keys off this tag.

`journal.template` and `journal.prefix` no longer apply: a Denote entry's name is built from its identifier, title and keywords, and its body comes from Denote's front matter. What shapes an entry is:

* `denote.journalDirectory` — where entries live, relative to the space (defaults to `journal`, mirroring `denote-journal-directory`).
* `denote.journalKeyword` — the keyword marking an entry (defaults to `journal`).
* `denote.journalTitleFormat` — `day`, `day-date-month-year`, `day-date-month-year-24h` (the default), `day-date-month-year-12h`, or a literal `format-time-string` pattern.

# Configuration
The schema, helpers, and command definitions live in two fenced blocks. The first (`priority: 10`) registers the config schema and defines helpers attached to the `journal` namespace. The second (`priority: -1`) runs after user CONFIG has loaded, so `config.get("journal.enabled")` reflects the user's override.

```space-lua
-- priority: 10
journal = journal or {}

config.defineCategory {
  name = "Journal",
  description = "Configure the built-in daily journal feature.",
  priority = 15,
}

config.define("journal", {
  description = "Configure the built-in journal feature",
  type = "object",
  properties = {
    enabled = {
      type = "boolean",
      default = true,
      description = "Enable the built-in Journal commands",
      ui = { category = "Journal", label = "Enable journal", priority = 4 },
    },
    template = {
      type = "string",
      default = "Library/Std/Journal/Template",
      description = "Page name to use as the template for new journal entries",
      ui = { category = "Journal", label = "Journal template page", priority = 3 },
    },
    prefix = {
      type = "string",
      default = "Journal/",
      description = "Page-name prefix for new journal entries (e.g. 'Journal/' yields 'Journal/2026-05-12'). Must end with '/' to group under a folder.",
      ui = { category = "Journal", label = "Journal page prefix", priority = 2 },
    },
    tag = {
      type = "string",
      default = "journal",
      description = "Tag used to mark journal pages. Prev/Next and the index-page section both key off this tag.",
      ui = { category = "Journal", label = "Journal tag", priority = 1 },
    },
  },
  additionalProperties = false,
})
```

# API

```space-lua
-- priority: 10
-- This fork is Denote-first, so the journal is `denote-journal`: an entry is a
-- Denote note in `denote.journalDirectory` carrying the journal keyword, with
-- a title built from the date. The commands and their keys are unchanged --
-- there is one journal system, not two -- but the entries they open are notes
-- Emacs also recognises.
function journal.openOrCreate(dateStr)
  system.invokeFunction("index.denoteJournalOpenOrCreate", dateStr)
end

function journal.entries()
  -- Already newest-first, ordered by identifier: that is the day an entry *is*,
  -- and what denote-journal itself matches on.
  return system.invokeFunction("index.denoteJournalEntries")
end

-- Entries are newest-first, so "previous" is the next one along and "next" is
-- the one before. Reading something that is not an entry, "previous" means the
-- latest entry -- the same place `Journal: Today` would leave you on a day you
-- have not written yet.
function journal.neighbor(direction)
  local entries = journal.entries()
  if #entries == 0 then return nil end
  local currentPage = editor.getCurrentPage()
  local index = nil
  for i, e in ipairs(entries) do
    if e.name == currentPage then
      index = i
      break
    end
  end
  if index == nil then
    return direction == "previous" and entries[1] or nil
  end
  if direction == "previous" then
    return entries[index + 1]
  end
  return entries[index - 1]
end
```

# Commands
```space-lua
-- priority: -1
if config.get("journal.enabled", true) then
  -- using command.update here (instead of command.define) to support key binding overrides (executed before)
  command.update {
    name = "Journal: Today",
    key = "Ctrl-q j",
    run = function()
      journal.openOrCreate(date.today())
    end,
  }
  command.update {
    name = "Journal: Previous Day",
    key = "Ctrl-q p",
    run = function()
      local entry = journal.neighbor("previous")
      if entry then
        editor.navigate(entry.name)
      else
        editor.flashNotification("No earlier journal entries")
      end
    end,
  }
  command.update {
    name = "Journal: Next Day",
    key = "Ctrl-q n",
    run = function()
      local entry = journal.neighbor("next")
      if entry then
        editor.navigate(entry.name)
      else
        editor.flashNotification("No later journal entries")
      end
    end,
  }
  -- Journals are dated paths ("Journal/2026/08/07"), so a tree is the shape
  -- they already have: a year is a folder, a month is a folder, and reaching
  -- last March is three keystrokes rather than a phrase.
  navigator.define {
    name = "std.journal",
    title = "Journal",
    dock = "modal",
    presentation = {
      mode = "tree",
      -- A picker has to open with something to pick: collapsed, this one opens
      -- as a single "Journal" folder row and nothing else. Expanded, the dates
      -- are on screen and what you close is what it remembers.
      expandAll = true,
      row = {
        icon = function(obj)
          if obj.isFolder then return "folder" end
          return "calendar"
        end,
      },
    },
    source = function() return journal.entries() end,
    onSelect = function(obj) editor.navigate(obj.ref or obj.name) end,
  }

  command.update {
    name = "Journal: Picker",
    run = function()
      if editor.openNavigator("std.journal") then
        -- The panel focuses its own filter input.
        return false
      end
      local entries = journal.entries()
      if #entries == 0 then
        editor.flashNotification("No journal entries yet")
        return
      end
      -- An entry's title *is* its date ("Wednesday 20 August 2025 12:38"),
      -- so it is the label. The file name is a slug of that title with the
      -- identifier and keyword attached, and reads far worse.
      local items = {}
      for _, e in ipairs(entries) do
        table.insert(items, { name = e.title or e.name, fullName = e.name })
      end
      local selected = editor.filterBox("Journal entry", items, "Pick a journal entry to open")
      if not selected then return end
      editor.navigate(selected.fullName)
    end,
  }
end
```
