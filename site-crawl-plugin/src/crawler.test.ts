// SPDX-FileCopyrightText: 2024-2026 Temps Contributors
// SPDX-License-Identifier: MIT OR Apache-2.0
import { describe, expect, test } from "bun:test";
import { crawl } from "./crawler";
import {
  normalize,
  publicAddress,
  type FetchPage,
  type HttpResult,
} from "./http";
import { analyzeHtml } from "./seo";
import type { Report } from "./types";
const result = (
  body: string,
  status = 200,
  headers: Record<string, string> = {},
): HttpResult => ({
  body,
  status,
  headers: { "content-type": "text/html", ...headers },
});
function report(maxPages = 50): Report {
  return {
    id: crypto.randomUUID(),
    url: "https://example.com/",
    maxPages,
    state: "running",
    startedAt: new Date().toISOString(),
    finishedAt: null,
    pages: [],
    notices: [],
    discovered: 0,
    limited: false,
    error: null,
  };
}
function fixture(routes: Record<string, HttpResult>) {
  const calls: string[] = [];
  const fetch: FetchPage = async (url) => {
    calls.push(url.href);
    return routes[url.pathname + url.search] ?? result("", 404);
  };
  return { calls, fetch };
}
async function run(routes: Record<string, HttpResult>, max = 50) {
  const f = fixture(routes),
    r = report(max);
  await crawl(r, new AbortController().signal, { fetch: f.fetch, delayMs: 0 });
  return { ...f, report: r };
}
describe("URL and network safety", () => {
  for (const ip of [
    "127.0.0.1",
    "10.0.0.1",
    "172.16.0.1",
    "192.168.0.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "224.0.0.1",
    "::1",
    "fc00::1",
    "fe80::1",
    "::ffff:127.0.0.1",
    "2001:db8::1",
  ])
    test(`blocks ${ip}`, () => expect(publicAddress(ip)).toBe(false));
  test("accepts public addresses", () => {
    expect(publicAddress("93.184.216.34")).toBe(true);
    expect(publicAddress("2606:4700:4700::1111")).toBe(true);
  });
  for (const url of [
    "file:///etc/passwd",
    "ftp://example.com",
    "https://user:secret@example.com",
    "http://example.com:3000",
  ])
    test(`rejects unsupported URL ${url}`, () =>
      expect(() => normalize(url)).toThrow());
  test("normalizes fragments while preserving distinct queries", () => {
    expect(normalize("/page?q=2#section", "https://example.com").href).toBe(
      "https://example.com/page?q=2",
    );
  });
});
describe("crawl evidence", () => {
  test("finds broken routes, source pages, sitemap noindex, duplicate titles and loops", async () => {
    const { report: r, calls } = await run({
      "/robots.txt": result(
        "User-agent: *\nDisallow: /private\nSitemap: https://example.com/sitemap.xml",
        200,
        { "content-type": "text/plain" },
      ),
      "/sitemap.xml": result(
        "<urlset><url><loc>https://example.com/hidden</loc></url></urlset>",
      ),
      "/": result(
        '<html lang="en"><head><title>Home</title></head><h1>Home</h1><a href="/broken#one">Broken</a><a href="/private">Private</a><a href="/other">Other</a><a href="/loop">Loop</a><a href="https://other.example/">External</a>',
      ),
      "/other": result('<title>Home</title><a href="/broken">Broken again</a>'),
      "/hidden": result(
        '<title>Hidden</title><meta name="robots" content="noindex">',
      ),
      "/loop": result("", 302, { location: "/loop" }),
    });
    expect(r.state).toBe("completed");
    const broken = r.pages.find((p) => p.url.endsWith("/broken"))!;
    expect(broken.status).toBe(404);
    expect(broken.sources).toEqual([
      "https://example.com/",
      "https://example.com/other",
    ]);
    expect(
      r.pages.find((p) => p.url.endsWith("/hidden"))!.issues.map((i) => i.code),
    ).toContain("sitemap_noindex");
    expect(r.pages.find((p) => p.url.endsWith("/loop"))!.issues[0]!.code).toBe(
      "redirect_loop",
    );
    expect(r.pages[0]!.issues.map((i) => i.code)).toContain("duplicate_title");
    expect(
      calls.some(
        (url) => url.includes("/private") || url.includes("other.example"),
      ),
    ).toBe(false);
  });
  test("follows same-origin redirects and records external destinations without fetching", async () => {
    const { report: r, calls } = await run({
      "/": result(
        '<title>Home</title><a href="/old">Old</a><a href="/out">Out</a>',
      ),
      "/old": result("", 301, { location: "/new" }),
      "/new": result("<title>New</title>"),
      "/out": result("", 302, { location: "http://169.254.169.254/latest" }),
    });
    expect(r.pages.find((p) => p.url.endsWith("/old"))!.finalUrl).toBe(
      "https://example.com/new",
    );
    expect(r.pages.find((p) => p.url.endsWith("/out"))!.issues[0]!.code).toBe(
      "external_redirect",
    );
    expect(calls.some((url) => url.includes("169.254"))).toBe(false);
  });
  test("fails closed when robots is unavailable", async () => {
    for (const status of [429, 500, 503, 401, 403]) {
      const { report: r, calls } = await run({
        "/robots.txt": result("", status),
      });
      expect(r.state).toBe("failed");
      expect(calls).toHaveLength(1);
    }
  });
  test("page limit and discovery queue stay bounded", async () => {
    const { report: r } = await run(
      {
        "/": result(
          Array.from(
            { length: 100 },
            (_, i) => `<a href="/page${i}">Link</a>`,
          ).join(""),
        ),
      },
      2,
    );
    expect(r.pages).toHaveLength(2);
    expect(r.discovered).toBeLessThanOrEqual(8);
    expect(r.limited).toBe(true);
  });
  test("honors nofollow and base URL", async () => {
    const { calls } = await run({
      "/": result(
        '<base href="/docs/"><a href="page">Page</a><a href="/skip" rel="nofollow">Skip</a>',
      ),
      "/docs/page": result(
        '<meta name="robots" content="nofollow"><a href="/skip-too">Skip</a>',
      ),
    });
    expect(calls).toContain("https://example.com/docs/page");
    expect(calls.some((url) => url.includes("skip"))).toBe(false);
  });
  test("restricts sitemap hosts and nested sitemap budget", async () => {
    const { calls } = await run({
      "/robots.txt": result(
        "Sitemap: http://169.254.169.254/map.xml\nSitemap: https://example.com/maps.xml",
      ),
      "/maps.xml": result(
        "<sitemapindex><sitemap><loc>https://example.com/child.xml</loc></sitemap></sitemapindex>",
      ),
      "/child.xml": result(
        "<urlset><url><loc>https://example.com/from-map</loc></url></urlset>",
      ),
      "/": result("<title>Home</title>"),
    });
    expect(calls).toContain("https://example.com/from-map");
    expect(calls.some((url) => url.includes("169.254"))).toBe(false);
  });
  test("cancellation preserves partial report", async () => {
    const r = report(),
      controller = new AbortController();
    const f = fixture({ "/": result('<a href="/next">Next</a>') });
    await crawl(r, controller.signal, {
      fetch: f.fetch,
      delayMs: 0,
      save: (report) => {
        if (report.pages.length === 1) controller.abort();
      },
    });
    expect(r.state).toBe("cancelled");
    expect(r.pages).toHaveLength(1);
    expect(r.finishedAt).not.toBeNull();
  });
  test("network errors are retained with route evidence", async () => {
    const r = report();
    const f = fixture({ "/": result('<a href="/timeout">Timeout</a>') });
    await crawl(r, new AbortController().signal, {
      delayMs: 0,
      fetch: async (url, signal) => {
        if (url.pathname === "/timeout")
          throw new Error("Connection timed out");
        return f.fetch(url, signal);
      },
    });
    expect(r.pages[1]!.issues[0]!.code).toBe("network_error");
    expect(r.pages[1]!.sources).toEqual(["https://example.com/"]);
  });
});
test("SEO detects absent and malformed metadata without claiming a ranking score", () => {
  const result = analyzeHtml(
    '<html><head><link rel="canonical" href="javascript:alert(1)"><link rel="canonical" href="/other"></head></html>',
    "https://example.com/",
    "noindex",
  );
  expect(result.issues.map((i) => i.code)).toEqual(
    expect.arrayContaining([
      "missing_title",
      "missing_description",
      "missing_h1",
      "missing_language",
      "noindex",
      "multiple_canonicals",
      "invalid_canonical",
    ]),
  );
});

test("oversized responses preserve HTTP status without claiming a broken route", async () => {
  const { CrawlError } = await import("./types");
  const r = report(1);
  await crawl(r, new AbortController().signal, {
    delayMs: 0,
    fetch: async (url) => {
      if (url.pathname !== "/") return result("", 404);
      throw new CrawlError(
        "body_limit",
        "Inspection incomplete: response exceeds the 8 MiB crawl limit.",
        200,
      );
    },
  });
  expect(r.pages[0]?.status).toBe(200);
  expect(r.pages[0]?.issues[0]?.severity).toBe("warning");
  expect(r.pages[0]?.issues[0]?.fix).toContain(
    "not evidence of a broken route",
  );
});
test("large documentation HTML still extracts routes and metadata", async () => {
  const { report: r } = await run(
    {
      "/": result(
        '<html lang="en"><title>CLI reference</title><meta name="description" content="Commands"><h1>CLI</h1><pre>' +
          "x".repeat(1343812) +
          '</pre><a href="/next">Next</a></html>',
      ),
      "/next": result("<title>Next</title>"),
    },
    2,
  );
  expect(r.pages[0]?.title).toBe("CLI reference");
  expect(r.pages.map((p) => new URL(p.url).pathname)).toEqual(["/", "/next"]);
});
