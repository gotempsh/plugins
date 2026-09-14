import { test, expect } from "bun:test";
import { gzipSync } from "node:zlib";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extract } from "./safe-extract";

function entry(name: string, content: string, type = "0") {
  const bytes = Buffer.from(content);
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  header.write(bytes.length.toString(8).padStart(11, "0") + "\0", 124, 12, "ascii");
  header.write(type, 156, 1, "ascii");
  return Buffer.concat([header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512)]);
}

async function run(entries: Buffer[]) {
  const base = await mkdtemp(join(tmpdir(), "temps-catalog-test-"));
  const archive = join(base, "source.tar.gz");
  const output = join(base, "output");
  await writeFile(archive, gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)])));
  return { archive, output };
}

test("extracts only root regular files", async () => {
  const { archive, output } = await run([entry("source/package.json", "{}"), entry("source/bun.lock", "lock")]);
  await extract(archive, output);
  expect(await readFile(join(output, "package.json"), "utf8")).toBe("{}");
});

test("rejects traversal", async () => {
  const { archive, output } = await run([entry("source/../escape", "no")]);
  await expect(extract(archive, output)).rejects.toThrow("Unsafe archive path");
});

test("rejects symlinks", async () => {
  const { archive, output } = await run([entry("source/link", "", "2")]);
  await expect(extract(archive, output)).rejects.toThrow("Unsafe tar entry type");
});
