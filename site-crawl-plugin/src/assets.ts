// SPDX-FileCopyrightText: 2024-2026 Temps Contributors
// SPDX-License-Identifier: MIT OR Apache-2.0
import html from "../web/index.html" with { type: "text" };
import css from "../web/style.css" with { type: "text" };
import js from "../web/app.js" with { type: "text" };
export const assets = new Map([
  [
    "index.html",
    {
      content: Buffer.from(html as unknown as string),
      contentType: "text/html; charset=utf-8",
      immutable: false,
    },
  ],
  [
    "style.css",
    {
      content: Buffer.from(css),
      contentType: "text/css; charset=utf-8",
      immutable: false,
    },
  ],
  [
    "app.js",
    {
      content: Buffer.from(js),
      contentType: "application/javascript; charset=utf-8",
      immutable: false,
    },
  ],
]);
