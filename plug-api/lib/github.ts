/**
 * Committing a set of files to GitHub over the API.
 *
 * One commit for the whole publish, not one per file: the Git Data API lets a
 * tree be built from a base tree and committed in a single move, so the site
 * never builds from a half-written set. The alternative -- the contents API,
 * one PUT per file -- makes a commit per file and would trigger a Pages build
 * for each.
 */

export type GitHubRepo = {
  owner: string;
  repo: string;
  branch: string;
  token: string;
  /** Overridable for tests. */
  api?: string;
};

export type GitHubFile = {
  /** Repo-relative path, forward slashes. */
  path: string;
  content: Uint8Array;
};

const githubApi = "https://api.github.com";

function headers(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json",
  };
}

/** Base64 without a data: prefix, which is what the blobs endpoint wants. */
export function base64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

async function call(
  repo: GitHubRepo,
  path: string,
  init?: RequestInit,
  fetchFn: typeof fetch = fetch,
): Promise<any> {
  const base = repo.api ?? githubApi;
  const res = await fetchFn(`${base}/repos/${repo.owner}/${repo.repo}${path}`, {
    ...init,
    headers: headers(repo.token),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    // GitHub says why in the body, and the status alone is rarely enough to
    // tell a bad token from a protected branch.
    throw new Error(
      `GitHub ${res.status} on ${path}${body ? `: ${body.slice(0, 300)}` : ""}`,
    );
  }
  return await res.json();
}

/**
 * Commits `files` to `branch`, leaving everything else in the tree alone.
 *
 * @returns the new commit's sha, or undefined when nothing differed from what
 *   the branch already holds -- worth distinguishing, because an empty commit
 *   would rebuild and redeploy the site for no reason.
 */
export async function commitFiles(
  repo: GitHubRepo,
  files: GitHubFile[],
  message: string,
  fetchFn: typeof fetch = fetch,
): Promise<string | undefined> {
  if (files.length === 0) return undefined;

  const ref = await call(repo, `/git/ref/heads/${repo.branch}`, {}, fetchFn);
  const headSha = ref.object.sha;
  const head = await call(repo, `/git/commits/${headSha}`, {}, fetchFn);
  const baseTree = head.tree.sha;

  const tree = [];
  for (const file of files) {
    const blob = await call(
      repo,
      "/git/blobs",
      {
        method: "POST",
        body: JSON.stringify({
          content: base64(file.content),
          encoding: "base64",
        }),
      },
      fetchFn,
    );
    tree.push({
      path: file.path,
      mode: "100644",
      type: "blob",
      sha: blob.sha,
    });
  }

  const newTree = await call(
    repo,
    "/git/trees",
    { method: "POST", body: JSON.stringify({ base_tree: baseTree, tree }) },
    fetchFn,
  );
  // An identical tree means the files already say what they would say. The
  // ref is left alone rather than advanced over an empty commit.
  if (newTree.sha === baseTree) return undefined;

  const commit = await call(
    repo,
    "/git/commits",
    {
      method: "POST",
      body: JSON.stringify({
        message,
        tree: newTree.sha,
        parents: [headSha],
      }),
    },
    fetchFn,
  );
  await call(
    repo,
    `/git/refs/heads/${repo.branch}`,
    { method: "PATCH", body: JSON.stringify({ sha: commit.sha }) },
    fetchFn,
  );
  return commit.sha;
}
