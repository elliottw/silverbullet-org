`debear.el`'s three panes — `[Tags] | [Notes] | [Editor]` — with **signatures**
in place of tags: the first level is the Johnny-Decimal category (`21 iteam`,
`23 Become a Therapist`), the second is the notes in it (`21=04 …`), and the
editor is the third.

`Shift-Alt-t` opens it, docked left.

```space-lua
-- priority: 10

signatures = signatures or {}

-- The separator that nests a row. A unit separator rather than `/` or `=`,
-- both of which occur in real titles and signatures -- the path here is
-- synthesized, so it must not collide with anything a note can contain.
signatures.sep = "\31"

-- A category is named by its `NN=00` hub note. Where two notes claim the same
-- hub -- this library has several, `21=00` being both "iteam" and "meta" --
-- the first by signature wins and the other is just a note in the category,
-- which is the only answer that does not silently drop one of them.
function signatures.categoryNames()
  local names = {}
  for _, d in ipairs(query [[
    from d = index.objects("denote")
    where d.signature != nil
    order by d.signature
  ]]) do
    local head, rest = string.match(d.signature, "^(%d+)=(0+)$")
    if head and rest and not names[head] then
      names[head] = d.title
    end
  end
  return names
end

-- `21=4` and `21=04` are the same address written two ways, and `9` sorts
-- after `10` as text. Padding each component makes the string order the
-- numeric one.
function signatures.sortKey(signature)
  local parts = {}
  for part in string.gmatch(signature or "", "[^=]+") do
    table.insert(parts, string.format("%04d", tonumber(part) or 0))
  end
  return table.concat(parts, "=")
end

function signatures.rows()
  local names = signatures.categoryNames()
  local rows = {}
  for _, d in ipairs(query [[
    from d = index.objects("denote")
    where d.signature != nil
  ]]) do
    local head = string.match(d.signature, "^(%d+)")
    if head then
      local named = names[head]
      -- The category reads as its number and its name, so the column is
      -- scannable by either.
      local category = named and (head .. "  " .. named) or head
      table.insert(rows, {
        name = category .. signatures.sep .. signatures.sortKey(d.signature),
        label = d.signature .. "  " .. (d.title or ""),
        -- The *page*, not the identifier: a denote object's `ref` is its
        -- identifier, and navigating to that opens a phantom page named after
        -- the timestamp rather than the note it belongs to.
        page = d.page,
        signature = d.signature,
        title = d.title,
      })
    end
  end
  -- The tree keeps the order it is given, so sorting here is what puts both
  -- columns in signature order.
  table.sort(rows, function(a, b)
    if a.name == b.name then return false end
    return a.name < b.name
  end)
  return rows
end

view.define {
  name = "std.signatures",
  title = "Signatures",
  command = "Navigate: Signature Browser",
  key = "Shift-Alt-t",
  mac = "Shift-Alt-t",
  menu = { location = "view", group = "1_views", order = 3, label = "Signatures" },
  dock = "lhs",
  supportedDocks = { "lhs", "rhs", "modal" },
  refreshOn = { "file:changed", "file:deleted", "mq:emptyQueue:indexQueue" },
  refreshOnOpen = true,
  source = signatures.rows,
  presentation = {
    mode = "tree",
    hierarchy = { field = "name", separator = "\31" },
    -- Both levels on screen at once, which is the point: debear shows the
    -- tags and the notes side by side, and a browser that opens as forty
    -- collapsed numbers shows neither. What you collapse is remembered.
    expandAll = true,
    row = {
      -- The path nests the row; this is what it reads as. A synthesized
      -- hierarchy needs both, because the path is not a name anyone wants to
      -- look at.
      primary = function(obj) return obj.label end,
      label = function(obj) return obj.label end,
      icon = function(obj)
        if obj.isFolder then return "folder" end
        return "file-text"
      end,
    },
  },
  onSelect = function(obj)
    if obj.page then editor.navigate(obj.page) end
  end,
}
```
