import { syntaxTree } from "@codemirror/language";
import { Decoration, type DecorationSet } from "@codemirror/view";
import { parseDenoteName } from "@silverbulletmd/silverbullet/lib/denote";
import { hasLinkScheme } from "@silverbulletmd/silverbullet/lib/link_syntax";
import { orgInlineImageTarget } from "./org_image.ts";
import { encodePageURI } from "@silverbulletmd/silverbullet/lib/ref";
import type { PageMeta } from "@silverbulletmd/silverbullet/type/index";
import type { Client } from "../client.ts";
import {
  decoratorStateField,
  invisibleDecoration,
  isCursorInRange,
  LinkWidget,
} from "./util.ts";

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
 * Renders `[[denote:ID][Description]]` — and a bare `[[Page][Description]]` —
 * as a single clickable link.
 */
export function denoteLinkPlugin(client: Client) {
  return decoratorStateField((state): DecorationSet => {
    const widgets: any[] = [];
    syntaxTree(state).iterate({
      enter: ({ type, from, to, node }) => {
        const isDenote = type.name === "DenoteLink";
        if (!isDenote && type.name !== "OrgLink") {
          return;
        }
        // Editing a link shows its source, as every other live-preview
        // decoration does.
        if (isCursorInRange(state, [from, to])) {
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
          const descriptionNode = node.getChild("OrgLinkDescription");
          const textFrom = descriptionNode
            ? descriptionNode.from
            : targetNode.from;
          const textTo = descriptionNode ? descriptionNode.to : targetNode.to;
          if (textTo === textFrom) {
            // Nothing to show; leave the source visible rather than vanish.
            return;
          }
          widgets.push(invisibleDecoration.range(from, textFrom));
          widgets.push(
            Decoration.mark({
              tagName: "a",
              class: "sb-link sb-org-external-link",
              attributes: { href: target, title: `Click to visit ${target}` },
            }).range(textFrom, textTo),
          );
          widgets.push(invisibleDecoration.range(textTo, to));
          return;
        }
        // An image link with no description belongs to the inline-image
        // plugin; two replacements over one range would collide.
        if (!isDenote && orgInlineImageTarget(state, node) !== null) {
          return;
        }
        const match = isDenote ? denoteTargetRegex.exec(target) : null;
        if (isDenote && !match) {
          return;
        }
        const identifier = match ? match[1] : "";
        const heading = match ? match[2] : undefined;
        const descriptionNode = node.getChild("OrgLinkDescription");
        const description = descriptionNode
          ? state.sliceDoc(descriptionNode.from, descriptionNode.to)
          : "";

        // A Denote link resolves by identifier; a bare Org link names a page.
        const page = isDenote
          ? resolveDenoteIdentifier(client.ui.viewState.allPages, identifier)
          : client.ui.viewState.allPages.find((p) => p.name === target);
        // A note's own title is the best label when the link carries no
        // description; the bare identifier is the last resort.
        const text =
          description ||
          (page?.title as string | undefined) ||
          page?.name ||
          target;

        widgets.push(
          Decoration.replace({
            widget: new LinkWidget({
              from,
              text,
              title: page
                ? `Navigate to ${page.name}`
                : isDenote
                  ? `No note with identifier ${identifier}`
                  : `Page not found: ${target}`,
              href: page ? encodePageURI(page.name) : undefined,
              cssClass: page
                ? "sb-wiki-link sb-denote-link"
                : "sb-wiki-link sb-denote-link sb-wiki-link-page-missing",
              callback: (e) => {
                if (!page) {
                  client.ui.flashNotification(
                    isDenote
                      ? `No note with identifier ${identifier}`
                      : `Page not found: ${target}`,
                    "error",
                  );
                  return;
                }
                if (e.altKey) {
                  client.editorView.dispatch({ selection: { anchor: from } });
                  client.focus();
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
}
