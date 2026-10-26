import { expect, gotoSilverBulletPage, test } from "./fixtures.ts";

// Indexing made headline TODOs queryable; this makes them visible. An open
// state and a finished one have to read differently, and a heading that
// merely opens with a capitalised word must not be drawn as either.
const NOTE = `#+title:      Reminders
#+identifier: 20261026T140000

* TODO gas data from peoples
* DONE Book the room
* API design
* HOLD Wrap-up event
`;

const DECLARED = `#+title:      Project
#+identifier: 20261026T140001
#+TODO: TODO NEXT HOLD | DONE CANCELLED

* HOLD Wrap-up event
* CANCELLED Old plan
* NEXT Email the board
`;

test.describe("Org TODO states", () => {
  test.use({
    spaceFiles: {
      "index.md": "# Home\n",
      "20261026T140000--reminders.org": NOTE,
      "20261026T140001--project.org": DECLARED,
    },
  });

  const states = (page: any) =>
    page.evaluate(() => ({
      todo: [...document.querySelectorAll("#sb-editor .sb-org-todo")].map(
        (el) => el.textContent,
      ),
      done: [...document.querySelectorAll("#sb-editor .sb-org-done")].map(
        (el) => el.textContent,
      ),
    }));

  test("an open state and a finished one are drawn differently", async ({
    sbPage,
    sbServer,
  }) => {
    await gotoSilverBulletPage(
      sbPage,
      sbServer,
      "20261026T140000--reminders.org",
    );
    await expect(sbPage.locator("#sb-editor .cm-content")).toContainText(
      "gas data",
      { timeout: 20_000 },
    );
    // Under Org's default set: TODO is open, DONE is closed, and neither
    // `API design` nor an undeclared `HOLD` is a state at all.
    await expect
      .poll(() => states(sbPage), { timeout: 15_000 })
      .toEqual({
        todo: ["TODO"],
        done: ["DONE"],
      });

    const colors = await sbPage.evaluate(() => {
      const c = (s: string) => {
        const el = document.querySelector(`#sb-editor ${s}`)!;
        const style = getComputedStyle(el);
        return `${style.color}|${style.backgroundColor}`;
      };
      return { todo: c(".sb-org-todo"), done: c(".sb-org-done") };
    });
    expect(colors.todo).not.toEqual(colors.done);
  });

  test("a file's own #+TODO: sequence is what gets drawn", async ({
    sbPage,
    sbServer,
  }) => {
    await gotoSilverBulletPage(
      sbPage,
      sbServer,
      "20261026T140001--project.org",
    );
    await expect(sbPage.locator("#sb-editor .cm-content")).toContainText(
      "Wrap-up event",
      { timeout: 20_000 },
    );
    await expect
      .poll(() => states(sbPage), { timeout: 15_000 })
      .toEqual({
        todo: ["HOLD", "NEXT"],
        done: ["CANCELLED"],
      });
  });
});
