// SPDX-FileCopyrightText: 2024-2026 Temps Contributors
// SPDX-License-Identifier: MIT OR Apache-2.0
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginEvent, TempsClient } from "@temps-sdk/plugin";
import { Scheduler, DEFAULT_AUTOMATION } from "./automation";
import { Store } from "./store";
import { eventAccess } from "./host";
const event = (
  id: number,
  environment = "production",
  project = 1,
): PluginEvent => ({
  id: String(id),
  event_type: "deployment.succeeded",
  project_id: project,
  timestamp: new Date().toISOString(),
  data: {
    deployment_id: id,
    environment_id: 1,
    environment_name: environment,
    url: "https://example.com/",
  },
});
const access = async () => ({
  configured: true,
  reason: null,
  setupPath: "/settings/plugins",
});
const fetchPage = async (url: URL) => ({
  status: url.pathname === "/" ? 200 : 404,
  headers: { "content-type": "text/html" },
  body: "<title>Fixture</title><h1>Fixture</h1>",
});
async function until(check: () => boolean) {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await Bun.sleep(5);
  }
  throw new Error("Crawl did not finish");
}
test("deployment queue filters, deduplicates and attributes completed reports", async () => {
  const dir = mkdtempSync(join(tmpdir(), "crawl-auto-"));
  const store = new Store(dir);
  const scheduler = new Scheduler(store, {
    hostAccess: access,
    settleMs: 0,
    delayMs: 0,
    fetch: fetchPage,
  });
  try {
    scheduler.deployment(event(1, "preview"));
    scheduler.deployment({ ...event(2), event_type: "deployment.failed" });
    scheduler.deployment(event(3));
    scheduler.deployment(event(3));
    expect(() => scheduler.manual("https://example.com/", 1)).toThrow("queued");
    await until(
      () => store.list().length === 1 && store.list()[0]?.state === "completed",
    );
    expect(store.list()[0]?.trigger?.deploymentId).toBe(3);
    expect(store.list()[0]?.trigger?.projectId).toBe(1);
    scheduler.update({
      ...DEFAULT_AUTOMATION,
      productionOnly: false,
      excludedProjects: [2],
    });
    scheduler.deployment(event(4, "preview"));
    scheduler.deployment(event(5, "production", 2));
    await until(
      () =>
        store.list().length === 2 &&
        store.list().every((r) => r.state === "completed"),
    );
    expect((await scheduler.status()).queued).toBe(0);
  } finally {
    await scheduler.close();
    store.close();
    rmSync(dir, { recursive: true });
  }
});
test("queue persists across restart, stays bounded and obeys permission revocation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "crawl-auto-"));
  let store = new Store(dir);
  let scheduler = new Scheduler(store, {
    settleMs: 0,
    hostAccess: async () => ({ ...(await access()), configured: false }),
  });
  try {
    for (let i = 1; i <= 25; i++) scheduler.deployment(event(i));
    await Bun.sleep(20);
    expect((await scheduler.status()).queued).toBe(20);
    expect(store.list()).toHaveLength(0);
    await scheduler.close();
    store.close();
    store = new Store(dir);
    scheduler = new Scheduler(store, {
      hostAccess: access,
      settleMs: 0,
      delayMs: 0,
      fetch: fetchPage,
    });
    scheduler.kick();
    await until(
      () =>
        store.list().length === 20 &&
        store.list().every((r) => r.state === "completed"),
    );
    scheduler.deployment(event(25));
    expect((await scheduler.status()).queued).toBe(0);
  } finally {
    await scheduler.close();
    store.close();
    rmSync(dir, { recursive: true });
  }
});
test("settings prune queued work and crawls never overlap", async () => {
  const dir = mkdtempSync(join(tmpdir(), "crawl-auto-"));
  const store = new Store(dir);
  let active = 0;
  let peak = 0;
  const scheduler = new Scheduler(store, {
    hostAccess: access,
    settleMs: 0,
    delayMs: 0,
    fetch: async (url) => {
      active++;
      peak = Math.max(peak, active);
      await Bun.sleep(5);
      active--;
      return fetchPage(url);
    },
  });
  try {
    scheduler.deployment(event(1));
    scheduler.deployment(event(2));
    await until(
      () =>
        store.list().length === 2 &&
        store.list().every((r) => r.state === "completed"),
    );
    expect(peak).toBe(1);
    scheduler.deployment(event(3));
    scheduler.update({ ...DEFAULT_AUTOMATION, enabled: false });
    expect((await scheduler.status()).queued).toBe(0);
    expect(() =>
      scheduler.update({ ...DEFAULT_AUTOMATION, maxPages: 501 }),
    ).toThrow();
    expect(() =>
      scheduler.update({ ...DEFAULT_AUTOMATION, excludedProjects: [-1] }),
    ).toThrow();
    scheduler.deployment({ ...event(4), data: {} });
    expect(store.list()).toHaveLength(2);
  } finally {
    await scheduler.close();
    store.close();
    rmSync(dir, { recursive: true });
  }
});
test("host permission discovery validates grants and malformed responses", async () => {
  const client = (result: unknown) =>
    ({
      call: async (method: string) => {
        expect(method).toBe("get_host_capabilities");
        return result;
      },
    }) as unknown as TempsClient;
  expect(
    (await eventAccess(client({ permissions: ["events_read"] }))).configured,
  ).toBe(true);
  expect((await eventAccess(client({ permissions: [] }))).configured).toBe(
    false,
  );
  await expect(eventAccess(client({}))).rejects.toThrow("permission discovery");
});
