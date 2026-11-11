import { expect, test } from "vitest";
import { base64, commitFiles } from "./github.ts";

const repo = {
  owner: "elliottw",
  repo: "elliottw.github.io",
  branch: "main",
  token: "tok",
  api: "https://api.test",
};

/** A GitHub stand-in that records the calls and returns plausible shapes. */
function mockGitHub(options: { treeSame?: boolean } = {}) {
  const calls: { method: string; url: string; body?: any }[] = [];
  const fetchFn = ((url: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({
      method,
      // Down to the endpoint, so assertions read as the API docs do.
      url: String(url).replace(
        `${repo.api}/repos/${repo.owner}/${repo.repo}`,
        "",
      ),
      body,
    });
    const json = (value: unknown) =>
      Promise.resolve({ ok: true, json: () => Promise.resolve(value) } as any);

    if (url.toString().endsWith("/git/ref/heads/main")) {
      return json({ object: { sha: "HEADSHA" } });
    }
    if (url.toString().includes("/git/commits/HEADSHA")) {
      return json({ tree: { sha: "BASETREE" } });
    }
    if (url.toString().endsWith("/git/blobs")) {
      return json({ sha: `BLOB${calls.length}` });
    }
    if (url.toString().endsWith("/git/trees")) {
      return json({ sha: options.treeSame ? "BASETREE" : "NEWTREE" });
    }
    if (url.toString().endsWith("/git/commits")) {
      return json({ sha: "NEWCOMMIT" });
    }
    return json({});
  }) as unknown as typeof fetch;
  return { calls, fetchFn };
}

const file = (path: string, text: string) => ({
  path,
  content: new TextEncoder().encode(text),
});

test("a publish is one commit, not one per file", () => {
  // One commit matters for more than tidiness: Pages rebuilds per push, and
  // a commit per file would deploy the site from a half-written set.
  const { calls, fetchFn } = mockGitHub();
  return commitFiles(
    repo,
    [
      file("content/posts/a/index.org", "#+title:  A\n"),
      file("content/posts/b/index.org", "#+title:  B\n"),
    ],
    "Publish from the note library",
    fetchFn,
  ).then((sha) => {
    expect(sha).toBe("NEWCOMMIT");
    expect(calls.filter((c) => c.url.endsWith("/git/blobs")).length).toBe(2);
    expect(
      calls.filter((c) => c.url.endsWith("/git/commits") && c.method === "POST")
        .length,
    ).toBe(1);
    // Built on the existing tree, so nothing outside content/posts is touched.
    const tree = calls.find((c) => c.url.endsWith("/git/trees"))!;
    expect(tree.body.base_tree).toBe("BASETREE");
    expect(tree.body.tree.map((e: any) => e.path)).toEqual([
      "content/posts/a/index.org",
      "content/posts/b/index.org",
    ]);
    // And the branch is advanced to it.
    const patch = calls.find((c) => c.method === "PATCH")!;
    expect(patch.url).toBe("/git/refs/heads/main");
    expect(patch.body.sha).toBe("NEWCOMMIT");
  });
});

test("an unchanged tree makes no commit", () => {
  // Otherwise every publish would rebuild and redeploy the site to say
  // exactly what it already said.
  const { calls, fetchFn } = mockGitHub({ treeSame: true });
  return commitFiles(repo, [file("x", "y")], "msg", fetchFn).then((sha) => {
    expect(sha).toBeUndefined();
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
    expect(
      calls.some((c) => c.url.endsWith("/git/commits") && c.method === "POST"),
    ).toBe(false);
  });
});

test("nothing to commit makes no API calls at all", () => {
  const { calls, fetchFn } = mockGitHub();
  return commitFiles(repo, [], "msg", fetchFn).then((sha) => {
    expect(sha).toBeUndefined();
    expect(calls).toEqual([]);
  });
});

test("an error carries GitHub's explanation, not just a status", () => {
  const fetchFn = (() =>
    Promise.resolve({
      ok: false,
      status: 403,
      text: () => Promise.resolve('{"message":"Resource not accessible"}'),
    } as any)) as unknown as typeof fetch;
  return commitFiles(repo, [file("x", "y")], "msg", fetchFn).then(
    () => expect.unreachable("should have thrown"),
    (e: Error) => {
      expect(e.message).toContain("403");
      // A bad token and a protected branch are both 403; the body is what
      // tells them apart.
      expect(e.message).toContain("Resource not accessible");
    },
  );
});

test("base64 handles bytes a text encoder would mangle", () => {
  expect(base64(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBe("iVBORw==");
  expect(base64(new Uint8Array())).toBe("");
});
