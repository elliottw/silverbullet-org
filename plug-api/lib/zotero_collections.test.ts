import { expect, test } from "vitest";
import { listCollections } from "./zotero_api.ts";

const creds = { userId: "42", apiKey: "k", api: "https://api.test" };

/** A library of `total` collections, served 100 at a time. */
function mockLibrary(total: number) {
  const order: number[] = [];
  const fetchFn = ((url: string) => {
    const start = Number(new URL(String(url)).searchParams.get("start") ?? 0);
    order.push(start);
    const page = Array.from(
      { length: Math.max(0, Math.min(100, total - start)) },
      (_, i) => ({
        key: `K${start + i}`,
        data: { name: `c${start + i}`, parentCollection: false },
      }),
    );
    return Promise.resolve({
      json: () => Promise.resolve(page),
      headers: { get: () => String(total) },
    } as any);
  }) as unknown as typeof fetch;
  return { order, fetchFn };
}

test("every collection is returned, in order", async () => {
  const { fetchFn } = mockLibrary(250);
  const all = await listCollections(creds, fetchFn);
  expect(all.length).toBe(250);
  expect(all[0].key).toBe("K0");
  expect(all[249].key).toBe("K249");
});

test("the pages after the first are fetched together, not one after another", async () => {
  // A thousand collections used to be ten serial round trips -- half a
  // minute before a picker could open on a drop. The first page says how
  // many there are, which turns the rest into one batch.
  let inFlight = 0;
  let peak = 0;
  const { fetchFn } = mockLibrary(1000);
  const counting = ((url: string) => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    return (fetchFn as any)(url).then((r: any) => {
      inFlight--;
      return r;
    });
  }) as unknown as typeof fetch;

  const all = await listCollections(creds, counting);
  expect(all.length).toBe(1000);
  // Nine pages after the first, all open at once.
  expect(peak).toBeGreaterThan(1);
});

test("a library smaller than a page costs one request", async () => {
  const { order, fetchFn } = mockLibrary(12);
  const all = await listCollections(creds, fetchFn);
  expect(all.length).toBe(12);
  expect(order).toEqual([0]);
});

test("an empty library costs one request and returns nothing", async () => {
  const { order, fetchFn } = mockLibrary(0);
  expect(await listCollections(creds, fetchFn)).toEqual([]);
  expect(order).toEqual([0]);
});
