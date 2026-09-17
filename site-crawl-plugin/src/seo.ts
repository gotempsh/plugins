// SPDX-FileCopyrightText: 2024-2026 Temps Contributors
// SPDX-License-Identifier: MIT OR Apache-2.0
import { Parser } from "htmlparser2";
import { normalize } from "./http";
import { CrawlError, type Issue } from "./types";
export function analyzeHtml(html: string, url: string, xRobots = "") {
  const fields = extractHtml(html);
  const issues: Issue[] = [];
  const add = (
    code: string,
    severity: Issue["severity"],
    message: string,
    fix: string,
  ) => issues.push({ code, severity, message, fix });
  const title = fields.title.trim();
  const description = fields.description.trim();
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
  if (!fields.hasH1)
    add(
      "missing_h1",
      "info",
      "No primary heading.",
      "Add a clear heading that describes this page.",
    );
  if (!fields.language.trim())
    add(
      "missing_language",
      "info",
      "Document language is not declared.",
      "Set the appropriate lang attribute on <html>.",
    );
  const robots = [
    fields.noindex ? "noindex" : "",
    fields.nofollow ? "nofollow" : "",
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

  let canonical: string | null = null;
  if (fields.canonicalCount > 1)
    add(
      "multiple_canonicals",
      "warning",
      "Multiple canonical URLs are declared.",
      "Keep one consistent canonical URL for this page.",
    );
  const raw = fields.canonical;
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
    const rawBase = fields.base;
    if (rawBase) base = normalize(rawBase, url).href;
  } catch {
    /* invalid base falls back to the document */
  }
  const links: string[] = [];
  const nofollow = /\b(nofollow|none)\b/.test(robots);
  if (!nofollow)
    for (const link of fields.links) {
      if (/\bnofollow\b/i.test(link.rel)) continue;
      try {
        links.push(normalize(link.href, base).href);
      } catch {
        /* unsupported crawl target */
      }
    }
  if (fields.linkCount > 2000)
    add(
      "link_limit",
      "info",
      "Only the first 2,000 links were inspected.",
      "Split very large navigation lists across smaller pages.",
    );
  return { title, description, canonical, links: [...new Set(links)], issues };
}

/** Tokenizer callbacks retain only bounded SEO fields, never a document tree. */
function extractHtml(html: string) {
  const fields = {
    title: "",
    description: "",
    hasH1: false,
    language: "",
    noindex: false,
    nofollow: false,
    canonicalCount: 0,
    canonical: undefined as string | undefined,
    base: undefined as string | undefined,
    links: [] as { href: string; rel: string }[],
    linkCount: 0,
  };
  let inHead = true,
    titleOpen = false,
    titleSeen = false,
    descriptionSeen = false,
    languageSeen = false,
    baseSeen = false;
  let ignored = 0;
  let depth = 0;
  const suppressed = new Set([
    "script",
    "style",
    "noscript",
    "svg",
    "math",
    "template",
  ]);
  const headTags = new Set([
    "html",
    "head",
    "title",
    "base",
    "link",
    "meta",
    "script",
    "style",
    "noscript",
    "template",
  ]);
  const parser = new Parser(
    {
      onopentag(name, attrs) {
        if (++depth > 128)
          throw new CrawlError(
            "markup_depth",
            "Inspection incomplete: HTML nesting exceeds 128 levels.",
          );
        if (suppressed.has(name)) {
          ignored++;
          return;
        }
        if (ignored) return;
        // HTML permits an omitted <head>. Its first body element ends that head.
        if (name === "body" || !headTags.has(name)) inHead = false;
        if (name === "html" && !languageSeen) {
          fields.language = (attrs.lang ?? "").slice(0, 100);
          languageSeen = true;
        }
        if (name === "title" && inHead && !titleSeen) {
          titleSeen = true;
          titleOpen = true;
        }
        if (name === "h1") fields.hasH1 = true;
        if (name === "meta" && inHead) {
          const key = attrs.name?.toLowerCase();
          const content = attrs.content ?? "";
          if (key === "description" && !descriptionSeen) {
            fields.description = content.trim().slice(0, 2000);
            descriptionSeen = true;
          }
          if (key === "robots") {
            fields.noindex ||= /\b(noindex|none)\b/i.test(content);
            fields.nofollow ||= /\b(nofollow|none)\b/i.test(content);
          }
        }
        if (
          name === "link" &&
          inHead &&
          attrs.rel?.toLowerCase().split(/\s+/).includes("canonical")
        ) {
          if (fields.canonicalCount === 0)
            fields.canonical = attrs.href?.slice(0, 2049);
          fields.canonicalCount++;
        }
        if (name === "base" && attrs.href !== undefined && !baseSeen) {
          fields.base = attrs.href.slice(0, 2049);
          baseSeen = true;
        }
        if (name === "a" && attrs.href !== undefined) {
          fields.linkCount++;
          if (fields.linkCount <= 2000)
            fields.links.push({
              href: attrs.href.slice(0, 2049),
              rel: /\bnofollow\b/i.test(attrs.rel ?? "") ? "nofollow" : "",
            });
        }
      },
      ontext(text) {
        if (titleOpen && !ignored && fields.title.length < 1000)
          fields.title += (fields.title ? text : text.trimStart()).slice(
            0,
            1000 - fields.title.length,
          );
      },
      onclosetag(name) {
        depth = Math.max(0, depth - 1);
        if (suppressed.has(name) && ignored > 0) {
          ignored--;
          return;
        }
        if (ignored) return;
        if (name === "title") titleOpen = false;
        if (name === "head") inHead = false;
      },
    },
    { decodeEntities: true },
  );
  parser.end(html);
  return fields;
}
