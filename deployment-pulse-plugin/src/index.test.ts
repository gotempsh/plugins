// SPDX-FileCopyrightText: 2024-2026 Temps Contributors
// SPDX-License-Identifier: MIT OR Apache-2.0

import { expect, test, mock, spyOn } from "bun:test";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { AuthenticatedCaller, PluginContext, type TempsClient } from "@temps-sdk/plugin";
// Test-only fixture hook: production uses extractAuthContext, never this helper.
import { attachVerifiedCaller } from "../node_modules/@temps-sdk/plugin/dist/auth.js";
import { plugin } from "./index";

async function overview(caller?: AuthenticatedCaller) {
  const listProjects = mock(async () => []);
  const ctx = new PluginContext({
    pluginName: "deployment-pulse", dataDir: "/tmp/test-pulse",
    authSecret: "test-only", client: { listProjects } as unknown as TempsClient,
  });
  const req = new IncomingMessage(new Socket());
  req.method = "GET";
  req.url = "/overview";
  // Forging raw identity headers must never authorize a request.
  req.headers = { "x-temps-user-role": "admin", "x-temps-user-permissions": "system:admin" };
  if (caller) attachVerifiedCaller(req, caller);
  const res = new ServerResponse(req);
  const end = spyOn(res, "end").mockImplementation(() => res);
  const handler = await plugin.handler(ctx);
  await handler(req, res);
  end.mockRestore();
  req.destroy();
  return { status: res.statusCode, calls: listProjects.mock.calls.length };
}

function caller(role: "admin" | "reader" | "custom", permissions: string[]) {
  return new AuthenticatedCaller({
    userId: 1, userEmail: "operator@example.test", role, permissions, requestId: "test",
  });
}

test("unverified identity headers cannot read any projects", async () => {
  expect(await overview()).toEqual({ status: 401, calls: 0 });
});

test("readers cannot read installation-wide deployment data", async () => {
  expect(await overview(caller("reader", ["projects:read"]))).toEqual({ status: 403, calls: 0 });
});

test("admin role cannot bypass narrowed effective permissions", async () => {
  expect(await overview(caller("admin", ["projects:read"]))).toEqual({ status: 403, calls: 0 });
});

test("verified system administrators can read the overview", async () => {
  expect(await overview(caller("admin", ["system:admin"]))).toEqual({ status: 200, calls: 1 });
});

test("authorization follows effective permission, not the role label", async () => {
  expect(await overview(caller("custom", ["system:admin"]))).toEqual({ status: 200, calls: 1 });
});
