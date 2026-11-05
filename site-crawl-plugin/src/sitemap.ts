// SPDX-FileCopyrightText: 2024-2026 Temps Contributors
// SPDX-License-Identifier: MIT OR Apache-2.0
import { Parser } from "htmlparser2";
import { CrawlError } from "./types";
/** XML tokenizer: retain only direct loc children and bounded URL strings. */
export function parseSitemap(
  xml: string,
  maxUrls: number,
): {
  kind: "urlset" | "sitemapindex" | null;
  locations: string[];
  limited: boolean;
} {
  let kind: "urlset" | "sitemapindex" | null = null;
  const locations: string[] = [];
  const stack: string[] = [];
  let prefix = "";
  let text: string | null = null,
    count = 0;
  const parser = new Parser(
    {
      onopentag(name) {
        if (stack.length >= 64)
          throw new CrawlError(
            "markup_depth",
            "Sitemap nesting exceeds the 64-level inspection limit.",
          );
        const local = name.split(":").pop()!;
        stack.push(name);
        if (stack.length === 1)
          prefix = name.slice(0, name.length - local.length);
        if (
          stack.length === 1 &&
          (local === "urlset" || local === "sitemapindex")
        )
          kind = local;
        if (
          stack.length === 3 &&
          name === `${prefix}loc` &&
          stack[1] === `${prefix}${kind === "urlset" ? "url" : "sitemap"}`
        )
          text = "";
      },
      ontext(value) {
        if (text !== null && text.length < 2049)
          text += (text ? value : value.trimStart()).slice(
            0,
            2049 - text.length,
          );
      },
      onclosetag() {
        if (
          stack.length === 3 &&
          stack[2] === `${prefix}loc` &&
          text !== null
        ) {
          count++;
          if (locations.length < (kind === "sitemapindex" ? 5 : maxUrls))
            locations.push(text.trim());
          text = null;
        }
        stack.pop();
      },
    },
    { xmlMode: true, decodeEntities: true },
  );
  parser.end(xml);
  return {
    kind,
    locations,
    limited: count > (kind === "sitemapindex" ? 5 : maxUrls),
  };
}
