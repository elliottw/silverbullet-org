import { expect, gotoSilverBulletPage, test } from "./fixtures.ts";

// The point of indexing Org headline TODOs as `task` objects rather than a
// type of their own: a home page already asking `index.tasks()` should start
// answering with them. This drives the real query path, which a unit test on
// the indexer cannot.
const REMINDERS = `#+title:      Reminders
#+identifier: 20261026T120000

* TODO gas data from peoples                                          :Inbox:
* DONE Book the room
* TODO Read the draft :struggle:2024hjr:
* Planning
- [ ] a checkbox too
`;

const QUERY = `#+title:      Agenda
#+identifier: 20261026T120001

\${query[[
  from t = index.tasks()
  where not t.done
  order by t.name
  select t.state .. " | " .. t.name .. " | " .. table.concat(t.tags, ",")
]]}
`;

test.describe("Org headline TODOs", () => {
  test.use({
    spaceFiles: {
      "index.md": "# Home\n",
      "20261026T120000--reminders.org": REMINDERS,
      "20261026T120001--agenda.org": QUERY,
    },
  });

  test("a headline TODO answers index.tasks(), a DONE one does not", async ({
    sbPage,
    sbServer,
  }) => {
    await gotoSilverBulletPage(sbPage, sbServer, "20261026T120001--agenda.org");
    const editor = sbPage.locator("#sb-editor .cm-content");
    // Both open headline todos, with their Org tags, and the checkbox beside
    // them -- one task list, whatever syntax each task was written in.
    await expect(editor).toContainText(
      "TODO | Read the draft | struggle,2024hjr",
      {
        timeout: 30_000,
      },
    );
    await expect(editor).toContainText("TODO | gas data from peoples | Inbox");
    await expect(editor).toContainText("| a checkbox too |");
    // Done is done: the closed one stays out.
    await expect(editor).not.toContainText("Book the room");
  });
});
