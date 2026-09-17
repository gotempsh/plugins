// SPDX-FileCopyrightText: 2024-2026 Temps Contributors
// SPDX-License-Identifier: MIT OR Apache-2.0
import {
  runPlugin,
  createManifest,
  extractAuthContext,
} from "@temps-sdk/plugin";
import { assets } from "./assets";
import { createApp } from "./app";
import { Store } from "./store";
import { eventAccess } from "./host";
let app: ReturnType<typeof createApp> | undefined;
await runPlugin({
  manifest: () => ({
    ...createManifest("site-crawl", "0.1.0")
      .displayName("Site Crawl")
      .description(
        "Find broken internal routes and technical SEO issues in deployed sites",
      )
      .addNav("Site Crawl", "scan-search", "/")
      .event("deployment.succeeded")
      .build(),
    host_permissions: ["events_read"],
  }),
  embeddedUiAssets: () => assets,
  handler(ctx) {
    app = createApp(new Store(ctx.dataDir), {
      hostAccess: () => eventAccess(ctx.temps),
    });
    return async (req, res) => {
      // Reports are instance-wide, so all data/API access is administrator-only.
      const caller = extractAuthContext(req);
      if (!caller || (!caller.isAdmin() && caller.role !== "platform_admin")) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error:
              "An administrator account is required to crawl sites and view reports.",
          }),
        );
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      await new Promise<void>((resolve) => {
        req.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size <= 4096) chunks.push(Buffer.from(chunk));
        });
        req.on("end", resolve);
      });
      if (size > 4096) {
        res.writeHead(413);
        res.end(JSON.stringify({ error: "Request too large" }));
        return;
      }
      const method = req.method ?? "GET";
      const request = new Request(`http://plugin${req.url ?? "/"}`, {
        method,
        headers: { "Content-Type": "application/json" },
        ...(method === "GET" || method === "HEAD"
          ? {}
          : { body: Buffer.concat(chunks) }),
      });
      const response = await app!.fetch(request);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    };
  },
  onEvent(_ctx, event) {
    app?.deployment(event);
  },
  async onShutdown() {
    await app?.close();
  },
});
