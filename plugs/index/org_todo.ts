import {
  cloneTree,
  collectNodesMatching,
  type ParseTree,
  renderToText,
} from "@silverbulletmd/silverbullet/lib/tree";
import { system } from "@silverbulletmd/silverbullet/syscalls";
import type {
  ObjectValue,
  PageMeta,
} from "@silverbulletmd/silverbullet/type/index";
import {
  defaultTodoKeywords,
  mergeTodoKeywords,
  parseHeadlineTodo,
  parseTodoSequence,
  type TodoKeywords,
} from "@silverbulletmd/silverbullet/lib/org_todo";
import type { FrontMatter } from "./frontmatter.ts";
import { cleanTags, collectTags } from "./tags.ts";

/**
 * Org's headline tasks -- `* TODO Buy milk` -- indexed as `task` objects, the
 * same tag a `- [ ]` checkbox gets.
 *
 * Deliberately the same tag rather than one of its own: `index.tasks()` is
 * what a home page or an agenda query already asks, and a library whose tasks
 * live in headlines should answer it. The checkbox indexer in `item.ts` is
 * untouched -- it walks list items, and these are headings.
 */
type OrgTaskObject = ObjectValue<
  {
    name: string;
    text: string;
    page: string;
    /** The keyword as written: `TODO`, `NEXT`, `DONE`… */
    state: string;
    done: boolean;
    /** How deep the headline sits, as the header indexer reports it. */
    level: number;
    pos: number;
    toPos: number;
    pageLastModified: string;
  } & Record<string, any>
>;

/** `#+TODO:` and the two synonyms Org accepts for it. */
const sequenceKeywords = new Set(["TODO", "SEQ_TODO", "TYP_TODO"]);

const childOfType = (n: ParseTree, type: string) =>
  n.children?.find((c) => c.type === type);

/**
 * A headline's own text, stars removed, or undefined when this heading is not
 * an Org one.
 *
 * The discriminator is the `HeaderMark`: stars are Org, `#` is Markdown. A
 * Markdown page's `# TODO later` is a heading that happens to start with the
 * word, and turning it into a task would be a surprise.
 */
function orgHeadlineText(n: ParseTree): string | undefined {
  const children = n.children ?? [];
  const markIndex = children.findIndex((c) => c.type === "HeaderMark");
  if (markIndex === -1 || !/^\*+$/.test(renderToText(children[markIndex]))) {
    return undefined;
  }
  return children
    .slice(markIndex + 1)
    .map((c) => renderToText(c))
    .join("");
}

/** The sequences a file declares for itself, which override the space's. */
function fileTodoKeywords(tree: ParseTree): TodoKeywords | undefined {
  const sequences: TodoKeywords[] = [];
  for (const n of collectNodesMatching(tree, (t) => t.type === "OrgKeyword")) {
    const name = childOfType(n, "OrgKeywordName");
    if (!name || !sequenceKeywords.has(renderToText(name).toUpperCase())) {
      continue;
    }
    const value = childOfType(n, "OrgKeywordValue");
    if (value) {
      sequences.push(parseTodoSequence(renderToText(value)));
    }
  }
  return sequences.length > 0 ? mergeTodoKeywords(sequences) : undefined;
}

/**
 * The keywords in force for a page: what it declares, else what the space
 * configures (`org.todoKeywords`, in `#+TODO:` form), else Org's default.
 *
 * The space-wide setting is what stands in for an Emacs config's
 * `org-todo-keywords`, for a library whose files declare nothing.
 */
async function todoKeywordsFor(tree: ParseTree): Promise<TodoKeywords> {
  const declared = fileTodoKeywords(tree);
  if (declared) {
    return declared;
  }
  const configured = await system.getConfig<string | string[] | undefined>(
    "org.todoKeywords",
    undefined,
  );
  if (!configured) {
    return defaultTodoKeywords;
  }
  const sequences = (Array.isArray(configured) ? configured : [configured])
    .filter((s) => typeof s === "string")
    .map(parseTodoSequence);
  const merged = mergeTodoKeywords(sequences);
  return merged.notDone.length + merged.done.length > 0
    ? merged
    : defaultTodoKeywords;
}

export async function indexOrgTodos(
  pageMeta: PageMeta,
  _frontmatter: FrontMatter,
  tree: ParseTree,
): Promise<OrgTaskObject[]> {
  const headings = collectNodesMatching(
    tree,
    (t) => !!t.type?.startsWith("ATXHeading"),
  ).filter((n) => orgHeadlineText(n) !== undefined);
  // Nothing to configure for a page with no Org headlines at all, which is
  // every Markdown page in the space.
  if (headings.length === 0) {
    return [];
  }
  const keywords = await todoKeywordsFor(tree);
  const tasks: OrgTaskObject[] = [];

  for (const n of headings) {
    // Hashtags are collected before they are cleaned away, so a todo carrying
    // one is filed under it the way every other object is.
    const hashtags = collectTags(n);
    const clone = cloneTree(n);
    cleanTags(clone);
    const headline = orgHeadlineText(clone) ?? orgHeadlineText(n)!;
    const todo = parseHeadlineTodo(headline, keywords);
    if (!todo) {
      continue;
    }
    const task: OrgTaskObject = {
      ref: `${pageMeta.name}@${n.from}`,
      tag: "task",
      // Org's own `:tag:` strings alongside any SilverBullet hashtag.
      tags: [...new Set([...todo.tags, ...hashtags])],
      name: todo.text,
      text: todo.text,
      state: todo.keyword,
      done: todo.done,
      level: +n.type!.substring("ATXHeading".length),
      page: pageMeta.name,
      pos: n.from!,
      toPos: n.to!,
      range: [n.from!, n.to!],
      pageLastModified: pageMeta.lastModified,
    };
    if (todo.priority) {
      task.priority = todo.priority;
    }
    tasks.push(task);
  }
  return tasks;
}
