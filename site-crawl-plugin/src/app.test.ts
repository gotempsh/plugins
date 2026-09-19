// SPDX-FileCopyrightText: 2024-2026 Temps Contributors
// SPDX-License-Identifier: MIT OR Apache-2.0
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./store";
import { createApp } from "./app";
import type { Report } from "./types";
const request = (path: string, method = "GET", body?: unknown) =>
  new Request(`http://plugin${path}`, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
test("API validates input, persists crawl evidence and exports/deletes report", async () => {
  const dir = mkdtempSync(join(tmpdir(), "site-crawl-test-"));
  const store = new Store(dir);
  const app = createApp(store, {
    delayMs: 0,
    fetch: async (url) => ({
      status: url.pathname === "/" ? 200 : 404,
      headers: { "content-type": "text/html" },
      body: '<html lang="en"><title>Fixture</title><h1>Fixture</h1></html>',
    }),
  });
  try {
    expect(
      (
        await app.fetch(
          request("/api/reports", "POST", { url: "file:///etc/passwd" }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await app.fetch(
          request("/api/reports", "POST", {
            url: "https://example.com",
            maxPages: 501,
          }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await app.fetch(
          request("/api/reports", "POST", {
            url: "https://example.com",
            maxPages: 1.5,
          }),
        )
      ).status,
    ).toBe(400);
    const created = await app.fetch(
      request("/api/reports", "POST", {
        url: "https://example.com",
        maxPages: 5,
      }),
    );
    expect(created.status).toBe(202);
    const { id } = (await created.json()) as { id: string };
    expect(
      (
        await app.fetch(
          request("/api/reports", "POST", { url: "https://example.com" }),
        )
      ).status,
    ).toBe(409);
    for (let i = 0; i < 100 && store.get(id)?.state === "running"; i++)
      await Bun.sleep(5);
    expect(store.get(id)?.state).toBe("completed");
    expect(store.get(id)?.pages[0]?.title).toBe("Fixture");
    const exported = await app.fetch(request(`/api/reports/${id}/export`));
    expect(exported.status).toBe(200);
    expect(exported.headers.get("content-disposition")).toContain(id);
    expect(
      (await app.fetch(request(`/api/reports/${id}`, "DELETE"))).status,
    ).toBe(200);
    expect(store.get(id)).toBeNull();
    expect((await app.fetch(request(`/api/reports/${id}`))).status).toBe(404);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true });
  }
});
test("restart marks active crawl interrupted; retained history is bounded", () => {
  const dir = mkdtempSync(join(tmpdir(), "site-crawl-store-"));
  let store = new Store(dir);
  try {
    for (let i = 0; i < 35; i++)
      store.save({
        id: String(i),
        url: "https://example.com/",
        maxPages: 1,
        state: i === 34 ? "running" : "completed",
        startedAt: new Date(i * 1000).toISOString(),
        finishedAt: null,
        pages: [],
        notices: [],
        discovered: 0,
        limited: false,
        error: null,
      } satisfies Report);
    expect(store.list()).toHaveLength(30);
    store.close();
    store = new Store(dir);
    expect(store.get("34")?.state).toBe("interrupted");
    expect(store.get("34")?.error).toContain("restarted");
  } finally {
    store.close();
    rmSync(dir, { recursive: true });
  }
});
