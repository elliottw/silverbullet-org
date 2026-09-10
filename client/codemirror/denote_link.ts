import { syntaxTree } from "@codemirror/language";
import {
  EditorSelection,
  EditorState,
  type Extension,
  StateEffect,
  StateField,
  type Transaction,
} from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  WidgetType,
} from "@codemirror/view";
import { parseDenoteName } from "@silverbulletmd/silverbullet/lib/denote";
import { hasLinkScheme } from "@silverbulletmd/silverbullet/lib/link_syntax";
import { orgInlineMedia } from "./org_image.ts";
import { encodePageURI } from "@silverbulletmd/silverbullet/lib/ref";
import type { PageMeta } from "@silverbulletmd/silverbullet/type/index";
import type { Client } from "../client.ts";
import { decoratorStateField, isCursorInRange, LinkWidget } from "./util.ts";

/**
 * Resolves a Denote identifier to a page, using the client's page list.
 *
 * A Denote link addresses a note by identifier rather than by path, so that
 * renaming a note — which Denote encourages, since the title and keywords live
 * *in* the file name — never breaks an inbound link. Every note's name begins
 * with its own identifier, so the page list is all that is needed.
 */
export function resolveDenoteIdentifier(
  allPages: PageMeta[],
  identifier: string,
): PageMeta | undefined {
  return allPages.find(
    (page) => parseDenoteName(page.name)?.identifier === identifier,
  );
}

const denoteTargetRegex = /^denote:([^:\s]+)(?:::(.*))?$/;

/**
 * An empty element standing in for hidden link machinery.
 *
 * `Decoration.replace({})` renders *nothing* — no DOM node at all. That is
 * fine while something else follows on the line, but when the hidden `]]`
 * ends the line there is no node after the link for the caret to attach to,
 * so a typed character goes into the nearest text node — the description —
 * and lands inside the link. Everything else in SilverBullet sidesteps this
 * by revealing its markup under the cursor; a described link deliberately
 * does not, so it needs the anchor.
 */
class HiddenMarkWidget extends WidgetType {
  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "sb-hidden-mark";
    span.setAttribute("aria-hidden", "true");
    // A zero-width space, not an empty element. Firefox reads the caret back
    // out of the DOM, and it will not sit in an empty inline element: at the
    // end of a line ending in a link it normalised into the description
    // instead, which is one position *before* the hidden `]]`. Vim's `A` then
    // appended inside the link. The character gives the caret somewhere to be.
    // It is widget DOM rather than document text, so it is never copied.
    span.textContent = "\u200b";
    return span;
  }

  override eq(): boolean {
    return true;
  }
}

/**
 * Moves `pos` out of any hidden machinery it has landed inside, travelling in
 * the direction it was already going.
 */
function outOfHiddenMark(
  hidden: DecorationSet,
  pos: number,
  bias: number,
): number {
  for (;;) {
    let moved = false;
    hidden.between(pos - 1, pos + 1, (from, to, value) => {
      // Strictly inside: the edges are legitimate places to be.
      if (value === hiddenMark && pos > from && pos < to) {
        pos = bias < 0 ? from : to;
        moved = true;
      }
    });
    if (!moved) {
      return pos;
    }
  }
}

/** Hides a range, leaving a DOM anchor behind — see `HiddenMarkWidget`. */
const hiddenMark = Decoration.replace({ widget: new HiddenMarkWidget() });

const toggleLinkDisplayEffect = StateEffect.define<void>();

/**
 * Whether a link is drawn as its description — `org-link-descriptive`.
 *
 * Off, every link shows its source, which is what `org-toggle-link-display`
 * is for: reading or repairing link syntax by hand.
 */
export const denoteLinkDisplay = StateField.define<boolean>({
  create: () => true,
  update(value: boolean, tr: Transaction) {
    for (const effect of tr.effects) {
      if (effect.is(toggleLinkDisplayEffect)) {
        return !value;
      }
    }
    return value;
  },
});

/** `org-toggle-link-display`. Returns the display state it left behind. */
export function toggleDenoteLinkDisplay(view: EditorView): boolean {
  view.dispatch({ effects: toggleLinkDisplayEffect.of(undefined) });
  return view.state.field(denoteLinkDisplay, false) ?? true;
}

/**
 * Renders `[[denote:ID][Description]]` — and a bare `[[Page][Description]]` —
 * as a single clickable link.
 */
export function denoteLinkPlugin(client: Client): Extension {
  const decorations = decoratorStateField((state): DecorationSet => {
    const descriptive = state.field(denoteLinkDisplay, false) ?? true;
    const widgets: any[] = [];
    syntaxTree(state).iterate({
      enter: ({ type, from, to, node }) => {
        const isDenote = type.name === "DenoteLink";
        if (!isDenote && type.name !== "OrgLink") {
          return;
        }
        // With `org-toggle-link-display` off, a link is just its source.
        if (!descriptive) {
          return;
        }
        // A *described* link keeps reading as its description with the cursor
        // on it — `org-link-descriptive`. Only the machinery is hidden, so the
        // description underneath stays real, editable document text and the
        // cursor has somewhere to be; `Alt-i` edits the target.
        //
        // A link with no description yet is the one being typed: auto-close
        // turns `[[` into a complete but empty link node straight away, and
        // there is no description to show in its place, so it shows its source
        // as every other live-preview decoration does. That is also what keeps
        // the inline `[[` completion usable.
        const describedFrom = node.getChild("OrgLinkDescription");
        const described =
          !!describedFrom && describedFrom.to > describedFrom.from;
        if (!described && isCursorInRange(state, [from, to])) {
          return;
        }
        const targetNode = node.getChild(
          isDenote ? "DenoteLinkTarget" : "OrgLinkTarget",
        );
        if (!targetNode) {
          return;
        }
        const target = state.sliceDoc(targetNode.from, targetNode.to);
        if (!isDenote && hasLinkScheme(target)) {
          // `file:` addresses something in this space, and a description-less
          // one is an image; both belong to other plugins.
          if (target.startsWith("file:")) {
            return;
          }
          // An external link reads as its description, the way a Denote link
          // reads as its title -- the URL is machinery, not prose. Marked
          // rather than replaced so the text stays real document text and
          // selection and copy behave normally, which is how Markdown links
          // are drawn too. The `sb-org-external-link` class carries the
          // indicator, in CSS so it never lands in copied text.
          const textFrom = described ? describedFrom!.from : targetNode.from;
          const textTo = described ? describedFrom!.to : targetNode.to;
          if (textTo === textFrom) {
            // Nothing to show; leave the source visible rather than vanish.
            return;
          }
          widgets.push(hiddenMark.range(from, textFrom));
          widgets.push(
            Decoration.mark({
              tagName: "a",
              class: "sb-link sb-org-external-link",
              attributes: { href: target, title: `Click to visit ${target}` },
            }).range(textFrom, textTo),
          );
          widgets.push(hiddenMark.range(textTo, to));
          return;
        }
        // An image belongs to the inline-image plugin; two replacements over
        // one range would collide. Only an actual image, though: a bare
        // `[[Some Note]]` is description-less too, and if this stepped aside
        // for that, neither plugin would draw it.
        if (!isDenote && orgInlineMedia(state, node, client) !== null) {
          return;
        }
        const match = isDenote ? denoteTargetRegex.exec(target) : null;
        if (isDenote && !match) {
          return;
        }
        const identifier = match ? match[1] : "";
        const heading = match ? match[2] : undefined;
        const description = described
          ? state.sliceDoc(describedFrom!.from, describedFrom!.to)
          : "";

        // A Denote link resolves by identifier; a bare Org link names a page.
        // An Org page's name carries its extension, so `[[Bob]]` has to find
        // `Bob.org` -- the same rule following the link uses. An existing
        // Markdown page of that name still wins, as it does there.
        const allPages = client.ui.viewState.allPages;
        const page = isDenote
          ? resolveDenoteIdentifier(allPages, identifier)
          : (allPages.find((p) => p.name === target) ??
            allPages.find((p) => p.name === `${target}.org`));
        // A note's own title is the best label when the link carries no
        // description; the bare identifier is the last resort.
        const text =
          description ||
          (page?.title as string | undefined) ||
          page?.name ||
          target;

        const title = page
          ? `Navigate to ${page.name}`
          : isDenote
            ? `No note with identifier ${identifier}`
            : `Page not found: ${target}`;
        const cssClass = page
          ? "sb-wiki-link sb-denote-link"
          : "sb-wiki-link sb-denote-link sb-wiki-link-page-missing";

        // A described link hides only its machinery and marks the description,
        // exactly as the external branch above does. That is what lets it stay
        // collapsed with the cursor on it: the words remain real text, so the
        // cursor has somewhere to land and nothing has to be revealed. The
        // hidden `[[…][` and `]]` are made atomic below so arrow keys step
        // over them rather than through them, invisibly.
        if (described) {
          widgets.push(hiddenMark.range(from, describedFrom!.from));
          widgets.push(
            Decoration.mark({
              tagName: "a",
              class: cssClass,
              attributes: {
                title,
                // What the link addresses, not what it resolved to: the click
                // handler resolves for itself, so a link written to a note
                // that only just appeared still follows.
                "data-link-target": target,
                ...(heading ? { "data-link-header": heading } : {}),
                ...(isDenote ? { "data-link-denote": "1" } : {}),
              },
            }).range(describedFrom!.from, describedFrom!.to),
          );
          widgets.push(hiddenMark.range(describedFrom!.to, to));
          return;
        }

        widgets.push(
          Decoration.replace({
            widget: new LinkWidget({
              from,
              text,
              title,
              href: page ? encodePageURI(page.name) : undefined,
              cssClass,
              callback: (e) => {
                if (!page && isDenote) {
                  // A Denote link names an identifier. There is nothing to
                  // create for one no note carries -- the identifier *is* the
                  // note's identity, minted when the file is.
                  client.ui.flashNotification(
                    `No note with identifier ${identifier}`,
                    "error",
                  );
                  return;
                }
                if (e.altKey) {
                  client.editorView.dispatch({ selection: { anchor: from } });
                  client.focus();
                  return;
                }
                if (!page) {
                  // A bare Org link to a page that does not exist yet: follow
                  // it and let it be created, as a Markdown wiki link is and as
                  // following this one with the keyboard already does. `.org`,
                  // matching the note doing the linking.
                  void client.navigate(
                    { path: `${target}.org` as `${string}.${string}` },
                    false,
                    e.ctrlKey || e.metaKey,
                  );
                  return;
                }
                void client.navigate(
                  {
                    path: page.name as `${string}.${string}`,
                    ...(heading
                      ? { details: { type: "header", header: heading } }
                      : {}),
                  },
                  false,
                  e.ctrlKey || e.metaKey,
                );
              },
            }),
          }).range(from, to),
        );
      },
    });
    return Decoration.set(widgets, true);
  });
  return [
    denoteLinkDisplay,
    decorations,
    // The hidden `[[…][` and `]]` of a described link. Without this an arrow
    // key would step through them one invisible character at a time, with
    // nothing moving on screen; with it the cursor steps from the text before
    // a link straight to its description, the way point moves over invisible
    // text in Org. Only the machinery is atomic — the description itself stays
    // ordinary text you can select, edit and put the cursor inside.
    // `atomicRanges` only governs CodeMirror's own motion commands. Vim works
    // out its positions itself, so `l` walked into the hidden `[[denote:…][`
    // one character at a time — invisible, except that the block cursor then
    // painted the character it was standing on (`[`, `d`, `e`) over the
    // description. This filter catches the selection whatever produced it.
    EditorState.transactionFilter.of((tr) => {
      if (!tr.selection || tr.docChanged) {
        return tr;
      }
      const hidden = tr.startState.field(decorations);
      const was = tr.startState.selection.main.head;
      let changed = false;
      const ranges = tr.selection.ranges.map((range) => {
        // A selection that spans a link is deliberate; only a bare cursor is
        // nudged out.
        if (!range.empty) {
          return range;
        }
        const head = outOfHiddenMark(
          hidden,
          range.head,
          range.head < was ? -1 : 1,
        );
        if (head === range.head) {
          return range;
        }
        changed = true;
        return EditorSelection.cursor(head);
      });
      return changed ? [tr, { selection: EditorSelection.create(ranges) }] : tr;
    }),
    EditorView.atomicRanges.of((view) =>
      view.state.field(decorations).update({
        filter: (_from, _to, value) => value === hiddenMark,
      }),
    ),
    linkClickHandler(client),
  ];
}

/**
 * Follows a described link, which is marked text rather than a widget and so
 * carries no click listener of its own.
 *
 * The listener sits on the editor and reads what the mark left in its data
 * attributes. A description-less link is a `LinkWidget`, which handles its own
 * click and stops propagation, so it never reaches here.
 */
function linkClickHandler(client: Client): Extension {
  return EditorView.domEventHandlers({
    click: (event) => {
      // Alt-click is for putting the cursor in the link, as it is on a widget.
      if (event.button !== 0 || event.altKey) {
        return false;
      }
      const anchor = (event.target as HTMLElement | null)?.closest?.(
        "a.sb-denote-link",
      ) as HTMLElement | null;
      if (!anchor) {
        return false;
      }
      const { linkHeader, linkDenote, linkTarget } = anchor.dataset;
      if (!linkTarget) {
        return false;
      }
      event.preventDefault();
      const newTab = event.ctrlKey || event.metaKey;
      const identifier = linkDenote
        ? denoteTargetRegex.exec(linkTarget)?.[1]
        : undefined;
      const resolve = (pages: PageMeta[]) =>
        linkDenote
          ? identifier
            ? resolveDenoteIdentifier(pages, identifier)
            : undefined
          : (pages.find((p) => p.name === linkTarget) ??
            pages.find((p) => p.name === `${linkTarget}.org`));

      void (async () => {
        // Resolved at click time rather than at render time, and from the
        // server when the cached list comes up short: a note written by
        // `denote-link-or-create` moments ago is on disk before the page list
        // hears about it, and a link to it must still follow.
        let page = resolve(client.ui.viewState.allPages);
        if (!page) {
          try {
            page = resolve(await client.space.fetchPageList());
          } catch (error) {
            console.error("Could not refresh the page list", error);
          }
        }
        if (page) {
          await client.navigate(
            {
              path: page.name as `${string}.${string}`,
              ...(linkHeader
                ? { details: { type: "header" as const, header: linkHeader } }
                : {}),
            },
            false,
            newTab,
          );
          return;
        }
        // A Denote link names an identifier, and there is nothing to create
        // for one no note carries -- the identifier *is* the note's identity,
        // minted when the file is. A bare Org link names a page, so it is
        // followed and the page created, as it is from the widget.
        if (linkDenote) {
          client.ui.flashNotification(
            `No note with identifier ${identifier ?? linkTarget}`,
            "error",
          );
          return;
        }
        await client.navigate(
          { path: `${linkTarget}.org` as `${string}.${string}` },
          false,
          newTab,
        );
      })();
      return true;
    },
  });
}
