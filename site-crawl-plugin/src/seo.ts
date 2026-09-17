// SPDX-FileCopyrightText: 2024-2026 Temps Contributors
// SPDX-License-Identifier: MIT OR Apache-2.0
import { load } from "cheerio";
import { normalize } from "./http";
import type { Issue } from "./types";
export function analyzeHtml(html: string, url: string, xRobots = "") {
  const $ = load(html);
  const issues: Issue[] = [];
  const add = (
    code: string,
    severity: Issue["severity"],
    message: string,
    fix: string,
  ) => issues.push({ code, severity, message, fix });
  const title = $("head title").first().text().trim().slice(0, 1000);
  const description =
    $('head meta[name="description" i]')
      .first()
      .attr("content")
      ?.trim()
      .slice(0, 2000) ?? "";
  if (!title)
    add(
      "missing_title",
      "warning",
      "No page title.",
      "Add a descriptive, unique <title> in the HTML head.",
    );
  if (!description)
    add(
      "missing_description",
      "warning",
      "No meta description.",
      "Describe this page in a meta description. Search engines may choose a different snippet.",
    );
  if ($("h1").length === 0)
    add(
      "missing_h1",
      "info",
      "No primary heading.",
      "Add a clear heading that describes this page.",
    );
  if (!$("html").attr("lang")?.trim())
    add(
      "missing_language",
      "info",
      "Document language is not declared.",
      "Set the appropriate lang attribute on <html>.",
    );
  const robots = [
    $('head meta[name="robots" i]')
      .map((_, el) => $(el).attr("content") ?? "")
      .get()
      .join(","),
    xRobots,
  ]
    .join(",")
    .toLowerCase();
  if (/\b(noindex|none)\b/.test(robots))
    add(
      "noindex",
      "warning",
      "Indexing is disabled by a robots directive.",
      "If this page should appear in search, remove its noindex directive. Keep it for intentionally private or excluded pages.",
    );
  const canonicals = $('head link[rel~="canonical" i]');
  let canonical: string | null = null;
  if (canonicals.length > 1)
    add(
      "multiple_canonicals",
      "warning",
      "Multiple canonical URLs are declared.",
      "Keep one consistent canonical URL for this page.",
    );
  const raw = canonicals.first().attr("href");
  if (raw) {
    try {
      canonical = normalize(raw, url).href;
      if (canonical !== url)
        add(
          "alternate_canonical",
          "info",
          "This page points to a different canonical URL.",
          "Verify the target is the intended preferred page and is reachable.",
        );
    } catch {
      add(
        "invalid_canonical",
        "warning",
        "Canonical URL is invalid or unsupported.",
        "Use a valid public HTTP or HTTPS canonical URL.",
      );
    }
  } else
    add(
      "missing_canonical",
      "info",
      "No canonical URL is declared.",
      "Consider a canonical URL where duplicate URLs could exist. This is not automatically an indexing error.",
    );
  let base = url;
  try {
    const rawBase = $("base[href]").first().attr("href");
    if (rawBase) base = normalize(rawBase, url).href;
  } catch {
    /* invalid base falls back to the document */
  }
  const links: string[] = [];
  const nofollow = /\b(nofollow|none)\b/.test(robots);
  if (!nofollow)
    $("a[href]")
      .slice(0, 2000)
      .each((_, el) => {
        if (/\bnofollow\b/i.test($(el).attr("rel") ?? "")) return;
        try {
          links.push(normalize($(el).attr("href") ?? "", base).href);
        } catch {
          /* non-HTTP/oversized links are not crawl targets */
        }
      });
  if ($("a[href]").length > 2000)
    add(
      "link_limit",
      "info",
      "Only the first 2,000 links were inspected.",
      "Split very large navigation lists across smaller pages.",
    );
  return { title, description, canonical, links: [...new Set(links)], issues };
}
