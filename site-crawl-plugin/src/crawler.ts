// SPDX-FileCopyrightText: 2024-2026 Temps Contributors
// SPDX-License-Identifier: MIT OR Apache-2.0
import robotsParser from "robots-parser";
import { parseSitemap } from "./sitemap";
import { setTimeout as delay } from "node:timers/promises";
import { fetchPublic, normalize, USER_AGENT, type FetchPage } from "./http";
import { analyzeHtml } from "./seo";
import { CrawlError, message, type Page, type Report } from "./types";
export interface CrawlOptions {
  fetch?: FetchPage;
  delayMs?: number;
  save?: (report: Report) => void;
}
const issue = (
  code: string,
  text: string,
  fix: string,
  severity: "error" | "warning" | "info" = "error",
) => ({ code, severity, message: text, fix });
export async function crawl(
  report: Report,
  signal: AbortSignal,
  options: CrawlOptions = {},
): Promise<void> {
  const fetcher = options.fetch ?? fetchPublic;
  const start = normalize(report.url);
  const origin = start.origin;
  const queue: string[] = [];
  const sources = new Map<string, Set<string>>();
  const visited = new Set<string>();
  const sitemapPages = new Set<string>();
  const save = () => {
    report.discovered = sources.size;
    options.save?.(report);
  };
  const notice = (text: string) => {
    if (report.notices.length < 30 && !report.notices.includes(text))
      report.notices.push(text);
  };
  const enqueue = (raw: string, source: string) => {
    let url: URL;
    try {
      url = normalize(raw, start.href);
    } catch {
      return;
    }
    if (url.origin !== origin) return;
    if (!sources.has(url.href)) {
      if (sources.size >= report.maxPages * 4) {
        report.limited = true;
        return;
      }
      sources.set(url.href, new Set());
      queue.push(url.href);
    }
    const refs = sources.get(url.href)!;
    if (refs.size < 20) refs.add(source);
  };
  let spacing = options.delayMs ?? 250;
  let lastRequest = 0;
  const request: FetchPage = async (url, requestSignal) => {
    await delay(Math.max(0, spacing - (Date.now() - lastRequest)), undefined, {
      signal: requestSignal,
    });
    lastRequest = Date.now();
    return fetcher(url, requestSignal);
  };
  let allowed = (_url: string) => true;
  const follow = async (input: string, checkRobots = true) => {
    let url = normalize(input);
    const chain: string[] = [];
    const seen = new Set<string>();
    for (let hop = 0; hop <= 5; hop++) {
      if (seen.has(url.href))
        throw new CrawlError("redirect_loop", `Redirect loop at ${url.href}`);
      if (checkRobots && !allowed(url.href))
        throw new CrawlError(
          "robots_blocked",
          "Crawling is disallowed by robots.txt.",
        );
      seen.add(url.href);
      const result = await request(url, signal);
      if (
        [301, 302, 303, 307, 308].includes(result.status) &&
        result.headers.location
      ) {
        chain.push(url.href);
        const target = normalize(result.headers.location, url.href);
        if (target.origin !== origin)
          return {
            ...result,
            finalUrl: url.href,
            chain,
            external: target.href,
          };
        url = target;
        continue;
      }
      return { ...result, finalUrl: url.href, chain, external: null };
    }
    throw new CrawlError("redirect_limit", "Redirect chain exceeds five hops.");
  };
  try {
    const robotsUrl = `${origin}/robots.txt`;
    const robotsResult = await follow(robotsUrl, false);
    if (robotsResult.external)
      throw new CrawlError(
        "robots_unavailable",
        "robots.txt redirects outside this origin. Crawl stopped rather than guessing its rules.",
      );
    if (
      robotsResult.status >= 500 ||
      robotsResult.status === 429 ||
      [401, 403].includes(robotsResult.status)
    )
      throw new CrawlError(
        "robots_unavailable",
        `robots.txt returned ${robotsResult.status}; crawl stopped. Try again after access is restored.`,
      );
    if (
      robotsResult.status !== 200 &&
      ![404, 410].includes(robotsResult.status)
    )
      throw new CrawlError(
        "robots_unavailable",
        `Cannot determine robots.txt rules (HTTP ${robotsResult.status}).`,
      );
    const robots = robotsParser(
      robotsUrl,
      robotsResult.status === 200 ? robotsResult.body : "",
    );
    allowed = (url) => robots.isAllowed(url, USER_AGENT) !== false;
    const crawlDelay = robots.getCrawlDelay(USER_AGENT);
    if (crawlDelay !== undefined && crawlDelay > 30)
      throw new CrawlError(
        "crawl_delay",
        "robots.txt requests a delay over 30 seconds; this interactive crawl cannot honor it.",
      );
    if (crawlDelay !== undefined)
      spacing = Math.max(spacing, crawlDelay * 1000);
    if (robotsResult.status !== 200)
      notice(
        "No robots.txt was found. Public internal URLs are eligible for this crawl.",
      );
    enqueue(start.href, "Start URL");
    const sitemapQueue = robots.getSitemaps().length
      ? robots.getSitemaps().slice(0, 5)
      : [`${origin}/sitemap.xml`];
    const mapsSeen = new Set<string>();
    while (sitemapQueue.length && mapsSeen.size < 5) {
      const raw = sitemapQueue.shift()!;
      let mapUrl: URL;
      try {
        mapUrl = normalize(raw, start.href);
      } catch {
        continue;
      }
      if (mapUrl.origin !== origin || mapsSeen.has(mapUrl.href)) continue;
      mapsSeen.add(mapUrl.href);
      try {
        const sitemap = await follow(mapUrl.href);
        if (sitemap.status !== 200 || sitemap.external) {
          notice(`Sitemap not read: ${mapUrl.href} (HTTP ${sitemap.status}).`);
          continue;
        }
        if (/<!DOCTYPE|<!ENTITY/i.test(sitemap.body)) {
          notice(
            `Sitemap with unsupported entity declarations skipped: ${mapUrl.href}`,
          );
          continue;
        }
        const xml = parseSitemap(sitemap.body, report.maxPages * 4);
        if (xml.kind === "sitemapindex") {
          for (const value of xml.locations)
            if (sitemapQueue.length < 5) sitemapQueue.push(value);
        } else if (xml.kind === "urlset") {
          for (const value of xml.locations) {
            try {
              const target = normalize(value, mapUrl.href);
              if (target.origin === origin) {
                sitemapPages.add(target.href);
                enqueue(target.href, mapUrl.href);
              }
            } catch {
              /* malformed sitemap URL */
            }
          }
          if (xml.limited) report.limited = true;
        } else
          notice(
            `Sitemap did not contain a urlset or sitemapindex: ${mapUrl.href}`,
          );
      } catch (error) {
        if (signal.aborted) throw error;
        notice(`Sitemap skipped: ${mapUrl.href}. ${message(error)}`);
      }
    }
    if (sitemapQueue.length) {
      report.limited = true;
      notice("Sitemap discovery stopped at five documents.");
    }
    while (queue.length && report.pages.length < report.maxPages) {
      if (signal.aborted) throw new CrawlError("cancelled", "Crawl cancelled.");
      const url = queue.shift()!;
      if (visited.has(url)) continue;
      visited.add(url);
      const page: Page = {
        url,
        finalUrl: url,
        status: null,
        durationMs: 0,
        title: "",
        description: "",
        canonical: null,
        sources: [],
        redirects: [],
        issues: [],
      };
      const began = Date.now();
      try {
        const result = await follow(url);
        page.status = result.status;
        page.finalUrl = result.finalUrl;
        page.redirects = result.chain;
        if (result.external)
          page.issues.push(
            issue(
              "external_redirect",
              `Redirect leaves the crawl origin: ${result.external}`,
              "Verify the destination; external redirects are recorded but not followed.",
              "info",
            ),
          );
        else if (result.status >= 400)
          page.issues.push(
            issue(
              "http_error",
              `Route returned HTTP ${result.status}.`,
              "Fix the route or update the pages linking to it. Redirect intentionally moved pages to their replacements.",
            ),
          );
        else if (result.status >= 300)
          page.issues.push(
            issue(
              "redirect_missing_location",
              `HTTP ${result.status} did not resolve to a page.`,
              "Return a valid redirect destination or a successful page response.",
              "warning",
            ),
          );
        else if (
          /text\/html|application\/xhtml\+xml/i.test(
            result.headers["content-type"] ?? "",
          )
        ) {
          const parsed = analyzeHtml(
            result.body,
            result.finalUrl,
            result.headers["x-robots-tag"],
          );
          page.title = parsed.title;
          page.description = parsed.description;
          page.canonical = parsed.canonical;
          page.issues.push(...parsed.issues);
          for (const link of parsed.links) enqueue(link, result.finalUrl);
          if (parsed.canonical && new URL(parsed.canonical).origin === origin)
            enqueue(parsed.canonical, `Canonical from ${result.finalUrl}`);
        }
        if (result.chain.length)
          page.issues.push(
            issue(
              "redirect",
              `${result.chain.length} redirect hop(s).`,
              "Link directly to the final URL where possible.",
              "info",
            ),
          );
      } catch (error) {
        if (signal.aborted) throw error;
        const code = error instanceof CrawlError ? error.code : "network_error";
        if (error instanceof CrawlError && error.status !== undefined)
          page.status = error.status;
        page.issues.push(
          issue(
            code,
            message(error),
            code === "body_limit" || code === "markup_depth"
              ? "The response exceeded an inspection resource limit; this is not evidence of a broken route. Reduce the HTML payload or inspect this page separately."
              : code === "robots_blocked"
                ? "Confirm this exclusion is intentional. Blocked pages were not inspected."
                : "Check the URL and server, then run another crawl.",
            code === "body_limit" || code === "markup_depth"
              ? "warning"
              : code === "robots_blocked"
                ? "info"
                : "error",
          ),
        );
      }
      page.durationMs = Date.now() - began;
      report.pages.push(page);
      save();
    }
    if (queue.length) {
      report.limited = true;
      notice(
        `Stopped at ${report.maxPages} URLs. Increase the limit to inspect more discovered routes.`,
      );
    }
    const titles = new Map<string, Set<string>>();
    for (const page of report.pages)
      if (page.title) {
        const group = titles.get(page.title) ?? new Set();
        group.add(page.finalUrl);
        titles.set(page.title, group);
      }
    const byUrl = new Map(report.pages.map((page) => [page.url, page]));
    for (const page of report.pages) {
      if ((titles.get(page.title)?.size ?? 0) > 1)
        page.issues.push(
          issue(
            "duplicate_title",
            "Another crawled page has the same title.",
            "Give distinct pages descriptive, unique titles.",
            "warning",
          ),
        );
      if (page.canonical && (byUrl.get(page.canonical)?.status ?? 0) >= 400)
        page.issues.push(
          issue(
            "broken_canonical",
            "Canonical target returned an HTTP error.",
            "Point the canonical to an accessible preferred page.",
            "warning",
          ),
        );
      if (
        sitemapPages.has(page.url) &&
        page.issues.some((item) => item.code === "noindex")
      )
        page.issues.push(
          issue(
            "sitemap_noindex",
            "Sitemap includes a page marked noindex.",
            "Remove intentionally excluded URLs from the sitemap or correct the indexing directive.",
            "warning",
          ),
        );
    }
    report.state = "completed";
  } catch (error) {
    report.state = signal.aborted ? "cancelled" : "failed";
    report.error = message(error);
  } finally {
    for (const page of report.pages)
      page.sources = [...(sources.get(page.url) ?? [])];
    report.finishedAt = new Date().toISOString();
    save();
  }
}
