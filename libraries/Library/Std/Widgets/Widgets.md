#meta

Implements some useful general purpose widgets. Specifically:

## Buttons
Types of button widgets:

* `widgets.button(text, callback)` renders a simple button running the callback when clicked
* `widgets.commandButton(commandName)` renders a button for a particular command (where the button text is the command name itself)
* `widgets.commandButton(text, commandName)` renders a button for a particular command with a custom button text
* `widgets.commandButton(text, commandName, args)` renders a button for a particular command and arguments (specified as a table list) with a custom button text

Examples:

${widgets.button("Hello", function()
  editor.flashNotification "Hi there!"
end)}

${widgets.commandButton("System: Reload")}

## Docked widgets
* **Table of Contents** (`std.toc`, command `Navigate: Table of Contents`): the current page's headers as a tree, live as you type. Opens as a modal. A page with fewer than `minHeaders` headers has no outline worth showing, and the view renders nothing at all in a page dock there.
* **Linked Mentions** (`std.linkedMentions`, command `Navigate: Linked Mentions`): every other page linking to this one, with a snippet of context. Docks at the bottom of the page, open until you close it.
* **Linked Tasks** (`std.linkedTasks`, command `Navigate: Linked Tasks`): incomplete tasks on other pages that link to this one. Docks at the top of the page, open until you close it.

None of the three has an `enabled` config key any more. Each remembers its own dock and open/closed state: close it with its ×, bring it back with its command, move it with its dock menu, and that choice is what applies from then on. The one knob left is how short an outline is too short to be worth showing:

```lua
-- Only show a table of contents on pages with >= 5 headers
config.set("std.widgets.toc.minHeaders", 5)
```

To set where a view docks space-wide, use `view.docks` (`navigator.docks` still works as a fallback)

# Implementation

## Buttons
```space-lua
-- priority: 10
function widgets.button(text, callback, attrs)
  local buttonEl = {
    onclick = callback,
    text
  }

  -- attrs can be used for additional customization
  if attrs then
    for k, v in pairs(attrs) do
      buttonEl[k] = v
    end
  end

  return widget.html(dom.button(buttonEl))
end

function widgets.commandButton(text, commandName, args)
  if not commandName then
    -- When only passed one argument, then let's assume it's a command name
    commandName = text
  end
  return widget.html(dom.button {
    onclick = function()
      editor.invokeCommand(commandName, args)
    end,
    text
  })
end

function widgets.subPages(pageName)
  pageName = pageName or editor.getCurrentPage()
  return widget.markdown(table.concat(query[[
    from p = index.subPages(pageName)
    select templates.pageItem(p)
  ]]))
end
```

## Table of contents
```space-lua
-- priority: 10
widgets = widgets or {}

config.defineCategory {
  name = "Widgets",
  description = "Enable and configure built-in widgets (table of contents, linked mentions, etc.)",
  priority = 45,
}

-- The Table of Contents view has no `enabled` key -- it remembers its own dock
-- and open state -- but it does have a floor: a page with fewer headers than
-- this has no outline worth showing, so the view renders nothing at all there.
config.define("std.widgets.toc", {
  type = "object",
  properties = {
    minHeaders = {
      type = "number",
      default = 3,
      description = "Minimum number of headers required before rendering a table of contents at all.",
      ui = { category = "Widgets", label = "Minimum headers for TOC", priority = 3 },
    },
  }
})

-- Every ATX heading in `text` (defaulting to the page being edited), as
-- `{name, pos, level}`: the text to show, the position to navigate to, and the
-- nesting depth. The single header extractor -- the `std.toc` view is its one
-- caller today, and anything else wanting the page's headers should use it
-- rather than parsing them again.
function widgets.tocHeaders(text)
  local parsedMarkdown = markdown.parseMarkdown(text or editor.getText())
  local headers = {}
  for topLevelChild in parsedMarkdown.children do
    if topLevelChild.type then
      local headerLevel = string.match(topLevelChild.type, "^ATXHeading(%d+)")
      if headerLevel then
        local label = ""
        table.remove(topLevelChild.children, 1)
        for child in topLevelChild.children do
          label = label .. string.trim(markdown.renderParseTree(child))
        end
        -- Strip link syntax to avoid nested brackets in TOC
        label = string.gsub(label, "%[%[(.-)%]%]", "%1")

        if label != "" then
          table.insert(headers, {
            name = label,
            pos = topLevelChild.from,
            level = tonumber(headerLevel)
          })
        end
      end
    end
  end
  return headers
end

```

### Table of Contents
```space-lua
-- priority: -1
view.define {
  name = "std.toc",
  title = "Table of Contents",
  placeholder = "Header",
  command = "Navigate: Table of Contents",
  menu = { location = "view", group = "1_views", order = 1, label = "Table of Contents" },
  dock = "modal",
  supportedDocks = { "page-top", "page-bottom", "lhs", "rhs", "modal" },
  defaultOpen = false,
  refreshOn = { "editor:pageModified", "editor:pageLoaded", "editor:documentLoaded" },
  refreshOnOpen = true,
  source = function(ctx)
    -- A document (not a page) has no markdown text for `tocHeaders` to read,
    -- and `editor.getText()` would answer with whatever page was open before.
    local path = editor.getCurrentPath()
    if not string.match(path, "%.md$") then
      return {}
    end
    local headers = widgets.tocHeaders()
    if ctx.dock == "page-top" or ctx.dock == "page-bottom" then
      local minHeaders = config.get("std.widgets.toc", {}).minHeaders or 3
      if #headers < minHeaders then
        return {}
      end
    end
    -- Nest by ancestor chain: nearest shallower header is the parent.
    local rows = {}
    local stack = {}
    local taken = {}
    for _, header in ipairs(headers) do
      while #stack > 0 and stack[#stack].level >= header.level do
        table.remove(stack)
      end
      -- "/" is the tree's path separator; look-alike keeps it literal.
      local nodePath = string.gsub(header.name, "/", "∕")
      if #stack > 0 then
        nodePath = stack[#stack].path .. "/" .. nodePath
      end
      while taken[nodePath] do
        nodePath = nodePath .. " @" .. header.pos
      end
      taken[nodePath] = true
      table.insert(stack, { level = header.level, path = nodePath })
      table.insert(rows, {
        name = nodePath,
        header = header.name,
        pos = header.pos,
      })
    end
    return rows
  end,
  presentation = {
    mode = "tree",
    expandAll = true,
    expansionScope = "page",
    foldersFirst = false,
    row = {
      primary = "header",
      label = "header",
      cssClass = function() return "sb-nav-noband" end,
    },
  },
  keymap = {
    [" "] = function(obj)
      editor.navigate { page = editor.getCurrentPage(), pos = obj.pos }
    end,
  },
  onSelect = function(obj)
    editor.navigate { page = editor.getCurrentPage(), pos = obj.pos }
  end,
}

```

## Linked mentions
```space-lua
-- priority: 10
widgets = widgets or {}

-- A mention as org-roam's backlink buffer shows one: the page, the outline
-- path the link sits under, and the paragraph around it.
local mentionTemplate = template.new [==[
**[[${_.page}@${_.start}|${_.label}]]**${_.heading}
${_.snippet}

]==]

local function crumb(heading)
  if heading and heading != "" then
    return " › " .. heading
  end
  return ""
end

-- What to call a page here: its display name where it has one, else its own
-- name. A Denote library's file names are slugs of the title with the
-- identifier and keywords attached -- `20231221T085005==0--issues-of-law__law_meta.org`
-- -- so the raw name tells a reader far less than the title does.
local function mentionLabel(name)
  local page = index.getObjectByRef(name, "page", name)
  if page and page.displayName and page.displayName != "" then
    return page.displayName
  end
  return name
end

-- Org link markup does not survive being rendered as Markdown: Markdown reads
-- the `[[target]` of `[[target][description]]` as a wiki link of its own and
-- shows the wreckage. A snippet is context rather than something to follow, so
-- a link is reduced to the text Org itself displays for it.
local function plainOrgSnippet(text)
  text = string.gsub(text, "%[%[[^%]]*%]%[([^%]]*)%]%]", "%1")
  -- A bare Denote link reads as the note's title, as it does on the page.
  text = string.gsub(text, "%[%[denote:(%w+)%]%]", function(id)
    local note = index.getObjectByRef(id, "denote", id)
    return note and note.title or id
  end)
  -- A bare file link is an inline image: nothing to read.
  text = string.gsub(text, "%[%[file:[^%]]*%]%]%s*", "")
  text = string.gsub(text, "%[%[([^%]]*)%]%]", "%1")
  return text
end

local function mentionSnippet(page, snippet)
  if string.endsWith(page, ".org") then
    return plainOrgSnippet(snippet)
  end
  return snippet
end

function widgets.linkedMentionsMarkdown(pageName)
  pageName = pageName or editor.getCurrentPage()
  local linkedMentions = query[[
    from r = index.relations()
    where r.page != pageName
      and r.to == pageName
      and r.kind != "co-mention"
    order by r.pageLastModified desc, r.range[1]
    select mentionTemplate({
      page = r.page,
      label = mentionLabel(r.page),
      heading = crumb(r.heading),
      snippet = mentionSnippet(r.page, r.snippet),
      start = r.range[1],
    })
  ]]
  if #linkedMentions == 0 then
    return ""
  end
  return table.concat(linkedMentions)
end

-- Unlinked mentions, as org-roam's "unlinked references": paragraphs on
-- other pages that say this note's title without linking to it. Only a
-- title worth searching for -- four characters or more, and not a journal
-- entry's date -- and only pages that do not already link here. The panel
-- lists them; `Denote: Link Mentions` picks one and rewrites that page's
-- first plain mention after the paragraph's start into a Denote link.
local function titleOf(pageName)
  local page = index.getObjectByRef(pageName, "page", pageName)
  if page and page.displayName and page.displayName != "" then
    return page.displayName
  end
  return nil
end

local function excerpt(text, needle, width)
  local at = string.find(string.lower(text), needle, 1, true) or 1
  local from = math.max(1, at - width)
  local to = math.min(#text, at + #needle + width)
  local out = string.sub(text, from, to)
  if from > 1 then out = "…" .. out end
  if to < #text then out = out .. "…" end
  return out
end

function widgets.linkMention(page, pos, title, identifier)
  local text = space.readPage(page)
  local lower = string.lower(text)
  local at = string.find(lower, string.lower(title), pos + 1, true)
  if not at then
    editor.flashNotification("Mention not found any more", "error")
    return
  end
  local found = string.sub(text, at, at + #title - 1)
  local link
  if string.endsWith(page, ".org") then
    link = "[[denote:" .. identifier .. "][" .. found .. "]]"
  else
    link = "[[denote:" .. identifier .. "|" .. found .. "]]"
  end
  space.writePage(page, string.sub(text, 1, at - 1) .. link .. string.sub(text, at + #title))
  editor.flashNotification("Linked on " .. (titleOf(page) or page))
end

-- The unlinked mentions of a note, each with the paragraph it sits in.
function widgets.unlinkedMentions(pageName)
  pageName = pageName or editor.getCurrentPage()
  local title = titleOf(pageName)
  local notes = query[[from d = index.tag "denote" where d.page == pageName limit 1]]
  local identifier = notes[1] and notes[1].identifier
  if not title or #title < 4 or not identifier
     or string.match(title, "^%a+ %d+ %a+ %d%d%d%d") then
    return {}, title, identifier
  end
  local needle = string.lower(title)
  local linking = {}
  for _, r in ipairs(query[[
    from r = index.relations() where r.to == pageName select r.page
  ]]) do linking[r] = true end
  -- Prose is in paragraph objects; a list's lines are item objects.
  local rows = query[[
    from p = index.tag "paragraph"
    where p.page != pageName and not linking[p.page]
      and string.find(string.lower(p.text), needle, 1, true)
    select { page = p.page, pos = p.pos, text = p.text }
  ]]
  for _, i in ipairs(query[[
    from i = index.tag "item"
    where i.page != pageName and not linking[i.page]
      and string.find(string.lower(i.text), needle, 1, true)
    select { page = i.page, pos = i.pos, text = i.text }
  ]]) do table.insert(rows, i) end
  table.sort(rows, function(a, b)
    if a.page == b.page then return a.pos < b.pos end
    return a.page < b.page
  end)
  while #rows > 40 do table.remove(rows) end
  return rows, title, identifier
end

function widgets.unlinkedMentionsMarkdown(pageName)
  local rows, title = widgets.unlinkedMentions(pageName)
  if #rows == 0 then
    return ""
  end
  local needle = string.lower(title)
  local out = {}
  for _, p in ipairs(rows) do
    table.insert(out,
      "**[[" .. p.page .. "@" .. p.pos .. "|" .. mentionLabel(p.page) .. "]]**\n" ..
      mentionSnippet(p.page, excerpt(p.text, needle, 120)) .. "\n\n")
  end
  return table.concat(out)
end

-- `Denote: Link Mentions`: pick an unlinked mention of the open note and
-- turn it into a link, the way org-roam's unlinked-references buffer offers
-- to. Stays open for the next one until Escape.
command.define {
  name = "Denote: Link Mentions",
  run = function()
    local pageName = editor.getCurrentPage()
    while true do
      local rows, title, identifier = widgets.unlinkedMentions(pageName)
      if #rows == 0 then
        editor.flashNotification("No unlinked mentions of " .. tostring(title))
        return
      end
      local options = {}
      for _, p in ipairs(rows) do
        table.insert(options, {
          name = mentionLabel(p.page),
          description = excerpt(p.text, string.lower(title), 60),
          page = p.page,
          pos = p.pos,
        })
      end
      local choice = editor.filterBox("Link mention", options,
        #rows .. " pages say “" .. title .. "” without linking it; Enter links one, Escape stops")
      if not choice then
        return
      end
      widgets.linkMention(choice.page, choice.pos, title, identifier)
    end
  end,
}

function widgets.linkedMentions(pageName)
  local md = widgets.linkedMentionsMarkdown(pageName)
  if md != "" then
    return widget.new {
      markdown = "# Linked Mentions\n" .. md
    }
  end
end

view.define {
  name = "std.linkedMentions",
  title = "Linked Mentions",
  command = "Navigate: Linked Mentions",
  menu = { location = "view", group = "1_views", order = 2, label = "Linked Mentions" },
  dock = "page-bottom",
  supportedDocks = { "page-top", "page-bottom", "lhs", "rhs", "modal" },
  defaultOpen = true,
  refreshOn = { "editor:pageLoaded", "mq:emptyQueue:indexQueue" },
  refreshOnOpen = true,
  content = function()
    local linked = widgets.linkedMentionsMarkdown()
    local unlinked = widgets.unlinkedMentionsMarkdown()
    if unlinked == "" then
      return linked
    end
    return linked .. "\n## Unlinked mentions\n" .. unlinked
  end,
}
```

## Linked tasks
```space-lua
-- priority: 10

-- The linked-task list as markdown, with no heading of its own -- the shared
-- builder behind `widgets.linkedTasks()` and the `std.linkedTasks` content
-- view. `templates.taskItem` renders each task with its `[[page@pos]]` ref,
-- which is what makes the rendered checkbox tick through to the page the task
-- actually lives on. Returns "" when nothing links here.
function widgets.linkedTasksMarkdown(pageName)
  pageName = pageName or editor.getCurrentPage()
  local tasks = query[[
    from t = index.tasks()
    where not t.done and table.includes(t.ilinks, pageName)
    order by t.page
    select templates.taskItem(t)
  ]]
  if #tasks == 0 then
    return ""
  end
  return table.concat(tasks)
end

function widgets.linkedTasks(pageName)
  local md = widgets.linkedTasksMarkdown(pageName)
  if md != "" then
    md = "# Linked Tasks\n" .. md
  end
  return widget.new {
    markdown = md
  }
end
```

### Top widget
```space-lua
-- priority: -1
-- A *content* view, like linked mentions: the tasks render as real markdown
-- tasks, so their checkboxes tick and write straight back to the page each
-- task lives on -- no need to navigate there first.
view.define {
  name = "std.linkedTasks",
  title = "Linked Tasks",
  command = "Navigate: Linked Tasks",
  menu = { location = "view", group = "1_views", order = 3, label = "Linked Tasks" },
  dock = "page-top",
  supportedDocks = { "page-top", "page-bottom", "lhs", "rhs", "modal" },
  defaultOpen = true,
  refreshOn = { "editor:pageLoaded", "mq:emptyQueue:indexQueue" },
  refreshOnOpen = true,
  content = function()
    return widgets.linkedTasksMarkdown()
  end,
}
```
