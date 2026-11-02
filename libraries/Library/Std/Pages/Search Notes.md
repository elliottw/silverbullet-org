Full-text search across every note, in the shape `consult-denote-grep` has in
Emacs: type, see matching **lines** from the whole library narrowing as you go,
press Return to land on the line itself.

Bound to `Alt-/`. `Cmd-/` is Open Command Palette in this fork; see the README
if you would rather swap them.

```space-lua
-- priority: 10

search = search or {}

-- Below this, a phrase matches so much that the list is noise and the query
-- is expensive for nothing. `consult-async-min-input` is 3 for the same
-- reason.
search.minPhrase = 3

-- Enough to scroll, few enough to stay responsive. A phrase that needs more
-- than this wants narrowing, not paging.
search.maxHits = 200

-- Every object that carries a line of a note: prose, list items, tasks and
-- headings. Four tags rather than one because the indexer splits a page by
-- what each piece *is* -- there is no single "text" object to ask.
search.textTags = { "paragraph", "item", "task", "header" }

-- Matching is plain and case-insensitive: `string.find` with `plain` set, so
-- a phrase with a `-` or a `.` in it searches for those characters instead of
-- being read as a pattern. Nobody types `%s+` into a search box by accident,
-- and everybody types hyphens.
function search.matches(text, needle)
  if not text then return false end
  return string.find(string.lower(text), needle, 1, true) ~= nil
end

-- One line of a note, as a row: what matched, and where it was.
function search.hits(phrase)
  local needle = string.lower(phrase)
  local hits = {}
  for _, tag in ipairs(search.textTags) do
    local remaining = search.maxHits - #hits
    if remaining <= 0 then
      return hits
    end
    -- The filter goes in the query so the limit is applied where the scan is,
    -- rather than after everything has been handed over.
    local found = query [[
      from o = index.objects(tag)
      where search.matches(o.text or o.name, needle)
      limit remaining
    ]]
    for _, obj in ipairs(found) do
      table.insert(hits, {
        ref = obj.ref,
        page = obj.page,
        text = string.trim(obj.text or obj.name or ""),
        tag = tag,
      })
    end
  end
  return hits
end

view.define {
  name = "std.searchNotes",
  title = "Search Notes",
  command = "Navigate: Search Notes",
  key = "Alt-/",
  mac = "Alt-/",
  menu = { location = "file", group = "3_palette", label = "Search Notes..." },
  dock = "modal",
  -- The source is re-run with what has been typed, rather than the rows being
  -- filtered client-side: the library is far too big to hand over in full,
  -- and this is the whole reason the mode exists.
  search = "source",
  placeholder = "Search every note...",
  source = function(ctx)
    local phrase = string.trim(ctx.phrase or "")
    if #phrase < search.minPhrase then
      return {}
    end
    return search.hits(phrase)
  end,
  presentation = {
    row = {
      -- The matching line is what you are reading; the page is context for
      -- it. That way round because a page name is often a date.
      primary = function(obj) return obj.text end,
      description = function(obj) return obj.page end,
      icon = function(obj)
        if obj.tag == "header" then return "hash" end
        if obj.tag == "task" then return "check-square" end
        return "align-left"
      end,
    },
  },
  -- `page@pos` lands on the line, not the top of the page -- the thing that
  -- makes a grep worth having over a page picker.
  onSelect = function(obj) editor.navigate(obj.ref) end,
}
```
