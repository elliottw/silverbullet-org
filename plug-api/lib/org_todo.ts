/**
 * Org keeps a task's state in the headline — `* TODO Buy milk` — rather than
 * in a checkbox, and that is where most of a real Org library's tasks live.
 *
 * Which words count is declared per file with `#+TODO:` and otherwise follows
 * Org's own default of `TODO | DONE`. It is a declared set rather than
 * "anything in capitals" for a reason: `* API design` is a heading, not a
 * task, and guessing would quietly turn prose into todos.
 */

export type TodoKeywords = {
  /** States a task passes through. */
  notDone: string[];
  /** States it comes to rest in. */
  done: string[];
};

/** Org's default when a file and the space both declare nothing. */
export const defaultTodoKeywords: TodoKeywords = {
  notDone: ["TODO"],
  done: ["DONE"],
};

/** A fast-access key rides along in parentheses — `TODO(t)` — and is not part of the word. */
const stripFastKey = (word: string) => word.replace(/\(.*\)$/, "");

const words = (text: string) =>
  text
    .trim()
    .split(/[ \t]+/)
    .map(stripFastKey)
    .filter(Boolean);

/**
 * `#+TODO: TODO NEXT WAITING | DONE CANCELLED`.
 *
 * The bar separates the states a task is still open in from the ones that
 * close it. With no bar Org takes the **last** word as the closing state, so
 * `#+TODO: TODO DONE` says what the default already says.
 */
export function parseTodoSequence(value: string): TodoKeywords {
  const bar = value.indexOf("|");
  if (bar === -1) {
    const all = words(value);
    if (all.length === 0) {
      return { notDone: [], done: [] };
    }
    return { notDone: all.slice(0, -1), done: all.slice(-1) };
  }
  return {
    notDone: words(value.slice(0, bar)),
    done: words(value.slice(bar + 1)),
  };
}

/** Org allows more than one `#+TODO:` line; the sets accumulate. */
export function mergeTodoKeywords(sequences: TodoKeywords[]): TodoKeywords {
  const notDone = new Set<string>();
  const done = new Set<string>();
  for (const sequence of sequences) {
    for (const word of sequence.notDone) notDone.add(word);
    for (const word of sequence.done) done.add(word);
  }
  // A word declared done anywhere is done: the closing state is the stronger
  // claim, and a sequence that lists it on both sides is a mistake either way.
  for (const word of done) notDone.delete(word);
  return { notDone: [...notDone], done: [...done] };
}

export type HeadlineTodo = {
  keyword: string;
  done: boolean;
  /** The headline with keyword, priority cookie and tags taken off. */
  text: string;
  /** `[#A]`, without the brackets. */
  priority?: string;
  /** Org's trailing `:tag1:tag2:`, in the order and casing written. */
  tags: string[];
};

const priorityCookie = /^\[#([A-Za-z0-9])\][ \t]*/;
/**
 * Org's trailing tag string. Anchored to the end and allowed to touch the
 * start, so `* TODO :Inbox:` is a task tagged Inbox rather than one titled
 * `:Inbox:`.
 */
const trailingTags = /(?:^|[ \t]+)(:(?:[A-Za-z0-9_@#%]+:)+)[ \t]*$/;

/**
 * Reads a headline's own text (no stars) as a task, or returns undefined when
 * its first word is not one of the keywords in force.
 */
export function parseHeadlineTodo(
  headline: string,
  keywords: TodoKeywords = defaultTodoKeywords,
): HeadlineTodo | undefined {
  const match = /^(\S+)(?:[ \t]+([\s\S]*))?$/.exec(headline.trim());
  if (!match) {
    return undefined;
  }
  const keyword = match[1];
  const done = keywords.done.includes(keyword);
  if (!done && !keywords.notDone.includes(keyword)) {
    return undefined;
  }
  let text = (match[2] ?? "").trim();

  const tags: string[] = [];
  const tagged = trailingTags.exec(text);
  if (tagged) {
    tags.push(...tagged[1].split(":").filter(Boolean));
    text = text.slice(0, tagged.index).trim();
  }

  let priority: string | undefined;
  const prioritised = priorityCookie.exec(text);
  if (prioritised) {
    priority = prioritised[1];
    text = text.slice(prioritised[0].length).trim();
  }

  return { keyword, done, text, priority, tags };
}
