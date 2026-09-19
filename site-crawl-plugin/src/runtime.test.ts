// SPDX-FileCopyrightText: 2024-2026 Temps Contributors
// SPDX-License-Identifier: MIT OR Apache-2.0
import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type WebSocket from "ws";
import { createConnection } from "node:net";
// Import the implementation: Bun's built-in ws shim does not support Unix sockets.
const UnixWebSocket = (
  await import(new URL("../node_modules/ws/wrapper.mjs", import.meta.url).href)
).default as typeof WebSocket;

test("compiled plugin handshake, authentication, report API and embedded UI", async () => {
  const dir = mkdtempSync(join(tmpdir(), "site-crawl-runtime-"));
  const socket = join(dir, "plugin.sock");
  const binary = join(dir, "site-crawl");
  const uiBuild = Bun.spawn(["bun", "run", "build:ui"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(await uiBuild.exited).toBe(0);
  const build = Bun.spawn(
    ["bun", "build", "src/index.ts", "--compile", "--outfile", binary],
    { stdout: "pipe", stderr: "pipe" },
  );
  expect(await build.exited).toBe(0);
  const secret = crypto.randomUUID();
  const child = spawn(
    binary,
    ["--socket-path", socket, "--data-dir", join(dir, "data")],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk.toString()).slice(-8192);
  });
  const lines = createInterface({ input: child.stdout });
  const iterator = lines[Symbol.asyncIterator]();
  const line = async () => {
    const result = await Promise.race([
      iterator.next(),
      Bun.sleep(10000).then(() => {
        throw new Error("Plugin handshake timed out");
      }),
    ]);
    if (result.done)
      throw new Error(
        `Plugin exited during handshake (code=${child.exitCode}, signal=${child.signalCode}): ${stderr}`,
      );
    return JSON.parse(result.value);
  };
  let channel: WebSocket | undefined;
  const headers = (role: string) => ({
    "x-temps-auth-signature": secret,
    "x-temps-user-id": "1",
    "x-temps-user-email": "admin@example.test",
    "x-temps-user-role": role,
  });
  const get = (path: string, extra: RequestInit = {}) =>
    fetch(`http://localhost${path}`, { unix: socket, ...extra });
  try {
    const hello = await line();
    expect(hello.type).toBe("hello");
    expect(hello.protocol_version).toBe(2);
    expect(hello.manifest.name).toBe("site-crawl");
    expect(hello.manifest.host_permissions).toContain("events_read");
    child.stdin.write(
      JSON.stringify({
        protocol_version: 2,
        auth_secret: secret,
        database_url: null,
        host_data_dir: null,
      }) + "\n",
    );
    const ready = await line();
    expect(ready.type).toBe("ready");
    expect(ready.has_ui).toBe(true);
    expect((await get("/_temps/channel")).status).toBe(401);
    channel = new UnixWebSocket("ws://localhost/_temps/channel", {
      createConnection: () => createConnection(socket),
      headers: { "x-temps-auth-signature": secret },
    });
    await new Promise<void>((resolve, reject) => {
      channel!.once("open", resolve);
      channel!.once("error", reject);
    });
    channel.on("message", (raw) => {
      const request = JSON.parse(raw.toString());
      channel!.send(
        JSON.stringify({
          type: "response",
          id: request.id,
          outcome: {
            ok: {
              method: request.call.method,
              result: { permissions: ["events_read"] },
            },
          },
        }),
      );
    });
    let response: Response | undefined;
    for (let i = 0; i < 100; i++) {
      response = await get("/api/reports", { headers: headers("admin") });
      if (response.status !== 503) break;
      await Bun.sleep(10);
    }
    expect(response?.status).toBe(200);
    expect(await response!.json()).toEqual([]);
    expect(
      (await get("/api/reports", { headers: { "x-temps-user-role": "admin" } }))
        .status,
    ).toBe(401);
    expect(
      (
        await get("/api/reports", {
          headers: { ...headers("admin"), "x-temps-auth-signature": "wrong" },
        })
      ).status,
    ).toBe(401);
    expect(
      (await get("/api/reports", { headers: headers("reader") })).status,
    ).toBe(403);
    expect(
      (await get("/api/reports", { headers: headers("platform_admin") }))
        .status,
    ).toBe(200);
    const ui = await get("/ui/", { headers: headers("admin") });
    expect(ui.status).toBe(200);
    expect(await ui.text()).toContain("Site Crawl");
    const created = await get("/api/reports", {
      method: "POST",
      headers: headers("admin"),
      body: JSON.stringify({ url: "http://127.0.0.1/", maxPages: 1 }),
    });
    expect(created.status).toBe(202);
    const { id } = (await created.json()) as { id: string };
    let report;
    for (let i = 0; i < 100; i++) {
      report = (await (
        await get(`/api/reports/${id}`, { headers: headers("admin") })
      ).json()) as { state: string; error: string };
      if (report.state !== "running") break;
      await Bun.sleep(10);
    }
    expect(report?.state).toBe("failed");
    expect(report?.error).toContain("private, local, or reserved");
    const automation = await get("/api/automation", {
      headers: headers("admin"),
    });
    expect(automation.status).toBe(200);
    expect(
      ((await automation.json()) as { access: { configured: boolean } }).access
        .configured,
    ).toBe(true);
    const deployment = {
      id: "deployment-test",
      event_type: "deployment.succeeded",
      timestamp: new Date().toISOString(),
      project_id: 1,
      data: {
        deployment_id: 42,
        environment_id: 1,
        environment_name: "production",
        url: "http://127.0.0.1/",
      },
    };
    expect(
      (
        await get("/_events", {
          method: "POST",
          headers: headers("admin"),
          body: JSON.stringify(deployment),
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await get("/_events", {
          method: "POST",
          headers: headers("admin"),
          body: JSON.stringify(deployment),
        })
      ).status,
    ).toBe(200);
    let automatic:
      { state: string; trigger?: { deploymentId: number } } | undefined;
    for (let i = 0; i < 140; i++) {
      const reports = (await (
        await get("/api/reports", { headers: headers("admin") })
      ).json()) as { state: string; trigger?: { deploymentId: number } }[];
      automatic = reports.find((r) => r.trigger?.deploymentId === 42);
      if (automatic?.state === "failed") {
        expect(reports).toHaveLength(2);
        break;
      }
      await Bun.sleep(50);
    }
    expect(automatic?.state).toBe("failed");
    expect(automatic?.trigger?.deploymentId).toBe(42);
  } finally {
    channel?.close();
    child.kill("SIGTERM");
    await Promise.race([
      new Promise((resolve) => child.once("exit", resolve)),
      Bun.sleep(2000),
    ]);
    if (child.exitCode === null) child.kill("SIGKILL");
    lines.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 30000);
