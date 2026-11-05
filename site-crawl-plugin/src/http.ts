// SPDX-FileCopyrightText: 2024-2026 Temps Contributors
// SPDX-License-Identifier: MIT OR Apache-2.0
import { lookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import ipaddr from "ipaddr.js";
import { CrawlError } from "./types";
export const USER_AGENT = "TempsSiteCrawl";
export const MAX_BODY = 8 * 1024 * 1024;
export interface HttpResult {
  status: number;
  headers: Record<string, string>;
  body: string;
}
export type FetchPage = (url: URL, signal: AbortSignal) => Promise<HttpResult>;
export function publicAddress(address: string): boolean {
  try {
    const parsed = ipaddr.process(address);
    return parsed.range() === "unicast";
  } catch {
    return false;
  }
}
export function normalize(input: string, base?: string): URL {
  let url: URL;
  try {
    url = new URL(input, base);
  } catch {
    throw new CrawlError("invalid_url", "Enter a complete HTTP or HTTPS URL.");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.port
  )
    throw new CrawlError(
      "invalid_url",
      "Use HTTP or HTTPS on the standard port, without credentials.",
    );
  if (url.href.length > 2048)
    throw new CrawlError("invalid_url", "URL exceeds 2,048 characters.");
  url.hash = "";
  return url;
}
/** Resolve once and pin the socket to a validated address; re-run for every redirect. */
export const fetchPublic: FetchPage = async (url, signal) => {
  normalize(url.href);
  if (signal.aborted) throw new CrawlError("cancelled", "Crawl cancelled.");
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = await Promise.race([
    lookup(hostname, { all: true }),
    new Promise<never>((_, reject) => {
      const timer = setTimeout(
        () => reject(new CrawlError("dns_timeout", "DNS lookup timed out.")),
        5000,
      );
      timer.unref();
    }),
  ]);
  if (
    !addresses.length ||
    addresses.some((item) => !publicAddress(item.address))
  )
    throw new CrawlError(
      "unsafe_address",
      "This host resolves to a private, local, or reserved address. Only public sites can be crawled.",
    );
  const address = addresses.find((item) => item.family === 4) ?? addresses[0]!;
  return new Promise((resolve, reject) => {
    const request = (url.protocol === "https:" ? https : http).request(
      url,
      {
        method: "GET",
        signal,
        agent: false,
        family: address.family,
        headers: {
          "User-Agent": `${USER_AGENT}/1.0`,
          Accept:
            "text/html,application/xhtml+xml,application/xml,text/plain;q=0.9,*/*;q=0.1",
          "Accept-Encoding": "identity",
        },
        lookup: (_host, options, callback) =>
          options.all
            ? callback(null, [address])
            : callback(null, address.address, address.family),
      },
      (response) => {
        const headers: Record<string, string> = {};
        for (const [key, value] of Object.entries(response.headers))
          if (value !== undefined)
            headers[key] = Array.isArray(value) ? value.join(", ") : value;
        const status = response.statusCode ?? 0;
        if (status >= 300 && status < 400 && headers.location) {
          response.destroy();
          resolve({ status, headers, body: "" });
          return;
        }
        const encoding = headers["content-encoding"];
        if (encoding && encoding !== "identity") {
          response.destroy();
          reject(
            new CrawlError(
              "encoding",
              "Server sent compressed data despite an identity request.",
            ),
          );
          return;
        }
        let size = 0;
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_BODY) {
            response.destroy(
              new CrawlError(
                "body_limit",
                "Inspection incomplete: response exceeds the 8 MiB crawl limit.",
                status,
              ),
            );
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () =>
          resolve({
            status,
            headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
        response.on("error", reject);
      },
    );
    const timer = setTimeout(
      () =>
        request.destroy(
          new CrawlError("timeout", "Request exceeded 10 seconds."),
        ),
      10_000,
    );
    request.on("close", () => clearTimeout(timer));
    request.on("error", reject);
    request.end();
  });
};
