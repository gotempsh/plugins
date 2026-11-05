// SPDX-FileCopyrightText: 2024-2026 Temps Contributors
// SPDX-License-Identifier: MIT OR Apache-2.0
import type { PluginEvent } from "@temps-sdk/plugin";
import { Scheduler, type SchedulerOptions } from "./automation";
import { normalize } from "./http";
import { Store } from "./store";
import { message } from "./types";
async function readJson(request: Request): Promise<unknown> {
  const reader = request.body?.getReader();
  let bytes = 0;
  const chunks: Uint8Array[] = [];
  if (reader)
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > 4096) {
        await reader.cancel();
        throw new Error("Request exceeds 4 KiB.");
      }
      chunks.push(value);
    }
  try {
    return JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    throw new Error("Send a valid JSON object.");
  }
}
export function createApp(store: Store, options: SchedulerOptions = {}) {
  const scheduler = new Scheduler(store, options);
  scheduler.kick();
  const json = (body: unknown, status = 200) =>
    Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
  return {
    deployment(event: PluginEvent) {
      scheduler.deployment(event);
    },
    async fetch(request: Request): Promise<Response> {
      const path = new URL(request.url).pathname;
      try {
        if (request.method === "GET" && path === "/api/automation")
          return json(await scheduler.status());
        if (request.method === "PUT" && path === "/api/automation") {
          try {
            return json(scheduler.update(await readJson(request)));
          } catch (error) {
            return json({ error: message(error) }, 400);
          }
        }
        if (request.method === "DELETE" && path === "/api/automation/queue") {
          scheduler.clearQueue();
          return json({ cleared: true });
        }
        if (request.method === "GET" && path === "/api/reports")
          return json(store.list());
        if (request.method === "POST" && path === "/api/reports") {
          if (scheduler.busy())
            return json(
              {
                error:
                  "A crawl is running or queued. Wait or cancel it before starting another.",
              },
              409,
            );
          let body: unknown;
          try {
            body = await readJson(request);
          } catch (error) {
            return json({ error: message(error) }, 400);
          }
          if (
            !body ||
            typeof body !== "object" ||
            !("url" in body) ||
            typeof body.url !== "string"
          )
            return json({ error: "A site URL is required." }, 400);
          const input = body as { url: string; maxPages?: unknown };
          const maxPages = input.maxPages ?? 100;
          if (
            typeof maxPages !== "number" ||
            !Number.isInteger(maxPages) ||
            maxPages < 1 ||
            maxPages > 500
          )
            return json(
              { error: "Page limit must be an integer from 1 to 500." },
              400,
            );
          let target: URL;
          try {
            target = normalize(input.url);
          } catch (error) {
            return json({ error: message(error) }, 400);
          }
          if (scheduler.busy())
            return json(
              { error: "A crawl is already running or queued." },
              409,
            );
          return json({ id: scheduler.manual(target.href, maxPages) }, 202);
        }
        const match =
          /^\/api\/reports\/([a-f0-9-]{36})(\/cancel|\/export)?$/.exec(path);
        if (match) {
          const id = match[1]!;
          const report = store.get(id);
          if (!report) return json({ error: "Report not found." }, 404);
          if (request.method === "GET" && match[2] === "/export")
            return new Response(JSON.stringify(report, null, 2), {
              headers: {
                "Content-Type": "application/json",
                "Content-Disposition": `attachment; filename="site-crawl-${id}.json"`,
                "Cache-Control": "no-store",
              },
            });
          if (request.method === "GET" && !match[2]) return json(report);
          if (request.method === "POST" && match[2] === "/cancel") {
            if (!scheduler.cancel(id))
              return json({ error: "This crawl is no longer running." }, 409);
            return json({ cancelling: true });
          }
          if (request.method === "DELETE" && !match[2]) {
            if (scheduler.isActive(id))
              return json(
                { error: "Cancel the crawl before deleting its report." },
                409,
              );
            store.delete(id);
            return json({ deleted: true });
          }
        }
        return json({ error: "Route not found." }, 404);
      } catch (error) {
        console.error(
          JSON.stringify({
            level: "error",
            operation: `${request.method} ${path}`,
            error: message(error),
          }),
        );
        return json(
          {
            error:
              "The report or settings could not be saved or loaded. Check plugin storage and retry.",
          },
          500,
        );
      }
    },
    async close() {
      await scheduler.close();
      store.close();
    },
  };
}
