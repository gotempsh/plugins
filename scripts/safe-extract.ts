import { gunzipSync } from "node:zlib";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, posix } from "node:path";

const MAX_ARCHIVE = 20 * 1024 * 1024;
const MAX_EXPANDED = 100 * 1024 * 1024;
const MAX_ENTRIES = 10_000;

export async function extract(archivePath: string, destination: string) {
  const compressed = await Bun.file(archivePath).arrayBuffer();
  if (compressed.byteLength > MAX_ARCHIVE) throw new Error("Archive exceeds 20 MiB compressed limit");
  const tar = gunzipSync(Buffer.from(compressed), { maxOutputLength: MAX_EXPANDED });
  let offset = 0;
  let count = 0;
  const seen = new Set<string>();
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    if (++count > MAX_ENTRIES) throw new Error("Archive has too many entries");
    const string = (start: number, length: number) => header.subarray(start, start + length).toString("utf8").split("\0", 1)[0];
    const rawName = [string(345, 155), string(0, 100)].filter(Boolean).join("/");
    const sizeText = string(124, 12).trim();
    if (!/^[0-7]*$/.test(sizeText)) throw new Error("Invalid tar size");
    const size = parseInt(sizeText || "0", 8);
    const next = offset + 512 + Math.ceil(size / 512) * 512;
    if (!Number.isSafeInteger(size) || next > tar.length) throw new Error("Truncated or oversized tar entry");
    const type = string(156, 1);
    if (type === "g" || type === "x") {
      // PAX metadata is deliberately ignored; it cannot rewrite parsed paths.
      offset = next;
      continue;
    }
    if (type !== "0" && type !== "" && type !== "5") throw new Error(`Unsafe tar entry type: ${type}`);
    if (rawName.startsWith("/") || rawName.includes("\\")) throw new Error("Unsafe archive path");
    const parts = rawName.replace(/\/$/, "").split("/");
    if (parts.some(part => !part || part === "." || part === "..")) throw new Error("Unsafe archive path");
    const relative = parts.slice(1).join("/");
    if (relative) {
      if (posix.normalize(relative) !== relative || seen.has(relative)) throw new Error("Duplicate or unsafe archive path");
      seen.add(relative);
      const target = join(destination, relative);
      if (type === "5") await mkdir(target, { recursive: true });
      else {
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, tar.subarray(offset + 512, offset + 512 + size), { flag: "wx", mode: 0o600 });
      }
    }
    offset = next;
  }
  if (!seen.has("package.json") || !seen.has("bun.lock")) throw new Error("Archive requires root package.json and bun.lock");
}

if (import.meta.main) await extract(process.argv[2], process.argv[3]);
