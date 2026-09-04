import { syntaxTree } from "@codemirror/language";
import type { EditorState, Range } from "@codemirror/state";
import { Decoration, WidgetType } from "@codemirror/view";
import { hasLinkScheme } from "@silverbulletmd/silverbullet/lib/link_syntax";
import type { Path } from "@silverbulletmd/silverbullet/lib/ref";
import {
  type Transclusion,
  resolveTransclusionUrl,
} from "@silverbulletmd/silverbullet/lib/transclusion";
import type { SyntaxNode } from "@lezer/common";
import type { Client } from "../client.ts";
import { createMediaElement } from "../markdown_renderer/inline.ts";
import { decoratorStateField, isCursorInRange } from "./util.ts";

/**
 * The file an Org link points at, if it is one this can show inline.
 *
 * Org displays an image for a link with **no description** — `[[file:a.png]]`
 * shows the picture, `[[file:a.png][a picture]]` shows the words. A link
 * naming a scheme other than `file:` addresses something outside the space and
 * is left alone.
 */
export function orgInlineImageTarget(
  state: EditorState,
  node: SyntaxNode,
): string | null {
  if (node.name !== "OrgLink" || node.getChild("OrgLinkDescription")) {
    return null;
  }
  const targetNode = node.getChild("OrgLinkTarget");
  if (!targetNode) {
    return null;
  }
  const target = state.sliceDoc(targetNode.from, targetNode.to);
  if (target.startsWith("file:")) {
    return target.slice(5);
  }
  return hasLinkScheme(target) ? null : target;
}

/**
 * The transclusion an Org link resolves to, or null when it is not one this
 * can draw as media.
 *
 * `orgInlineImageTarget` only says the link *could* be media — no description,
 * no foreign scheme. Whether it actually is depends on the file, and both
 * plugins have to agree: the link plugin steps aside for media, so if it
 * stepped aside for every description-less link, a bare `[[Some Note]]` would
 * be drawn by neither and vanish.
 */
export function orgInlineMedia(
  state: EditorState,
  node: SyntaxNode,
  client: Client,
): Transclusion | null {
  const target = orgInlineImageTarget(state, node);
  if (!target) {
    return null;
  }
  const transclusion: Transclusion = {
    url: target,
    alias: "",
    linktype: "wikilink",
    dimension: attributeDimensions(state, node.from),
  };
  resolveTransclusionUrl(
    transclusion,
    client.currentPath() as Path,
    client.clientSystem.allKnownFiles,
  );
  return createMediaElement(transclusion) ? transclusion : null;
}

/**
 * `#+ATTR_ORG: :width 300` on a line just above the link, which is how Org
 * sizes an inline image. `#+ATTR_HTML:` is read the same way.
 */
function attributeDimensions(
  state: EditorState,
  linkFrom: number,
): { width?: number; height?: number } {
  const line = state.doc.lineAt(linkFrom);
  for (
    let number = line.number - 1;
    number >= 1 && number >= line.number - 2;
    number--
  ) {
    const text = state.doc.line(number).text;
    if (!/^\s*#\+attr_(org|html)\s*:/i.test(text)) {
      // Only an attribute line directly above (or above a lone bracket line)
      // applies; anything else ends the search.
      if (text.trim() !== "") {
        return {};
      }
      continue;
    }
    const width = /:width\s+(\d+)/i.exec(text);
    const height = /:height\s+(\d+)/i.exec(text);
    return {
      width: width ? Number(width[1]) : undefined,
      height: height ? Number(height[1]) : undefined,
    };
  }
  return {};
}

class MediaWidget extends WidgetType {
  constructor(readonly transclusion: Transclusion) {
    super();
  }

  eq(other: MediaWidget): boolean {
    return (
      other.transclusion.url === this.transclusion.url &&
      other.transclusion.dimension?.width ===
        this.transclusion.dimension?.width &&
      other.transclusion.dimension?.height ===
        this.transclusion.dimension?.height
    );
  }

  toDOM(): HTMLElement {
    const element = createMediaElement(this.transclusion);
    const wrapper = document.createElement("span");
    wrapper.className = "sb-org-inline-image";
    if (element) {
      wrapper.appendChild(element);
    }
    return wrapper;
  }
}

/** Shows `[[file:picture.png]]` as the picture, the way Org does. */
export function orgInlineImagePlugin(client: Client) {
  return decoratorStateField((state: EditorState) => {
    const widgets: Range<Decoration>[] = [];
    syntaxTree(state).iterate({
      enter: ({ name, from, to, node }) => {
        if (name !== "OrgLink") {
          return;
        }
        // Editing the link shows its source, as every other live-preview
        // decoration does.
        if (isCursorInRange(state, [from, to])) {
          return;
        }
        // Null means it is not media — an Org link to a note, say, which the
        // link plugin renders instead.
        const transclusion = orgInlineMedia(state, node, client);
        if (!transclusion) {
          return;
        }
        widgets.push(
          Decoration.replace({ widget: new MediaWidget(transclusion) }).range(
            from,
            to,
          ),
        );
      },
    });
    return Decoration.set(widgets, true);
  });
}
