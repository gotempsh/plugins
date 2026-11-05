// SPDX-FileCopyrightText: 2024-2026 Temps Contributors
// SPDX-License-Identifier: MIT OR Apache-2.0
// Local development only. The distributed entrypoint is index.ts, which requires Temps authentication.
import { assets } from "./assets";
import { createApp } from "./app";
import { Store } from "./store";
const app = createApp(new Store(".data"));
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 3198,
  fetch(request) {
    const path = new URL(request.url).pathname;
    const file = assets.get(path === "/" ? "index.html" : path.slice(1));
    if (request.method === "GET" && file)
      return new Response(file.content, {
        headers: { "Content-Type": file.contentType },
      });
    return app.fetch(request);
  },
});
console.log(`Site Crawl development UI: ${server.url}`);
process.on("SIGINT", async () => {
  server.stop(true);
  await app.close();
  process.exit(0);
});
