// SPDX-FileCopyrightText: 2024-2026 Temps Contributors
// SPDX-License-Identifier: MIT OR Apache-2.0
import { expect, test } from "bun:test";
import { analyzeHtml } from "./seo";
import { parseSitemap } from "./sitemap";
const url = "https://example.com/page";
test("extracts mixed-case metadata, decoded text, duplicate canonicals and relative links", () => {
  const r = analyzeHtml(
    '<HTML lang="en"><HEAD><TITLE>A &amp; B</TITLE><META NAME="DESCRIPTION" content="One &amp; two"><base href="/docs/"><link rel="CANONICAL alternate" href="/page"><link rel="canonical" href="/other"></HEAD><BODY><h1>Heading</h1><a href="next?a=1&amp;b=2">Next</a></BODY></HTML>',
    url,
  );
  expect(r.title).toBe("A & B");
  expect(r.description).toBe("One & two");
  expect(r.canonical).toBe(url);
  expect(r.links).toEqual(["https://example.com/docs/next?a=1&b=2"]);
  expect(r.issues.map((i) => i.code)).toEqual(["multiple_canonicals"]);
});
test("ignores script, template, SVG and noscript decoys", () => {
  const r = analyzeHtml(
    '<head><script>"<title>False</title><a href="/bad">"</script><template><title>False</title></template><title>Actual</title></head><body><svg><title>SVG</title><a href="/svg">X</a></svg><noscript><a href="/noscript">X</a></noscript><template><a href="/template">X</a><h1>False</h1></template><a href="/real">Real</a></body>',
    url,
  );
  expect(r.title).toBe("Actual");
  expect(r.links).toEqual(["https://example.com/real"]);
  expect(r.issues.some((i) => i.code === "missing_h1")).toBe(true);
});
test("honors all robots metadata and header directives even after link discovery", () => {
  const r = analyzeHtml(
    '<meta name="robots" content="index"><meta NAME="robots" content="NONE"><a href="/next">Next',
    url,
  );
  expect(r.links).toEqual([]);
  expect(r.issues.some((i) => i.code === "noindex")).toBe(true);
  expect(analyzeHtml('<a href="/next">Next', url, "nofollow").links).toEqual(
    [],
  );
  expect(
    analyzeHtml('<a href="/no" rel="NOFOLLOW">No</a><a href="/yes">Yes', url)
      .links,
  ).toEqual(["https://example.com/yes"]);
});
test("bounds title, description, URL collection and oversized hrefs", () => {
  const r = analyzeHtml(
    "<title>" +
      "x".repeat(10000) +
      '</title><meta name="description" content="' +
      "y".repeat(10000) +
      '">' +
      Array.from({ length: 2002 }, (_, i) => `<a href="/${i}">X</a>`).join(""),
    url,
  );
  expect(r.title.length).toBe(1000);
  expect(r.description.length).toBe(2000);
  expect(r.links.length).toBe(2000);
  expect(r.issues.some((i) => i.code === "link_limit")).toBe(true);
  expect(
    analyzeHtml('<a href="/' + "x".repeat(10000) + '">X', url).links,
  ).toEqual([]);
});
test("handles omitted head, malformed anchors, invalid base and body metadata", () => {
  const r = analyzeHtml(
    '<title>Title</title><base href="file:///bad"><a href="/one">One<a href="/two">Two<meta name="description" content="Body metadata">',
    url,
  );
  expect(r.title).toBe("Title");
  expect(r.description).toBe("");
  expect(r.links).toEqual([
    "https://example.com/one",
    "https://example.com/two",
  ]);
});
test("tokenizes sitemap XML with namespaces, decoded URLs, and bounded entries", () => {
  const r = parseSitemap(
    '<s:urlset xmlns:s="x"><s:url><s:loc>https://example.com/a?x=1&amp;y=2</s:loc><image:loc>https://example.com/image</image:loc></s:url><s:url><s:loc>https://example.com/b</s:loc></s:url></s:urlset>',
    1,
  );
  expect(r.kind).toBe("urlset");
  expect(r.locations).toEqual(["https://example.com/a?x=1&y=2"]);
  expect(r.limited).toBe(true);
  expect(
    parseSitemap(
      "<urlset><url><image:loc>https://example.com/image</image:loc><loc>https://example.com/page</loc></url></urlset>",
      10,
    ).locations,
  ).toEqual(["https://example.com/page"]);
  const index = parseSitemap(
    "<sitemapindex>" +
      Array.from(
        { length: 7 },
        (_, i) => `<sitemap><loc>https://example.com/${i}.xml</loc></sitemap>`,
      ).join("") +
      "</sitemapindex>",
    100,
  );
  expect(index.locations.length).toBe(5);
  expect(index.limited).toBe(true);
});

test("rejects excessive HTML and XML nesting before building deep parser stacks", () => {
  expect(() => analyzeHtml("<div>".repeat(130), url)).toThrow("128 levels");
  expect(() => parseSitemap("<urlset>" + "<x>".repeat(65), 100)).toThrow(
    "64-level",
  );
});
