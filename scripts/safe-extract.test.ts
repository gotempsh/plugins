import { test, expect, afterEach } from "bun:test";
import { gzipSync } from "node:zlib";
import { mkdtemp, readFile, writeFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extract } from "./safe-extract";

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

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
  temporary.push(base);
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

test("extracts selected subtree without exposing siblings or root workspace", async () => {
  const { archive, output } = await run([
    entry("source/package.json", "root"), entry("source/bun.lock", "root lock"),
    entry("source/plugins/demo/package.json", "plugin"), entry("source/plugins/demo/bun.lock", "plugin lock"),
    entry("source/plugins/demo/src/index.ts", "console.log('plugin')"),
    entry("source/plugins/other/private.txt", "sibling"),
  ]);
  await extract(archive, output, "plugins/demo");
  expect(await readFile(join(output, "package.json"), "utf8")).toBe("plugin");
  expect((await readdir(output)).sort()).toEqual(["bun.lock", "package.json", "src"]);
});
test("missing subtree cannot fall back to root manifests", async () => {
  const { archive, output } = await run([entry("source/package.json", "{}"), entry("source/bun.lock", "lock")]);
  await expect(extract(archive, output, "missing")).rejects.toThrow("Selected plugin directory");
});
test("subtree selector rejects traversal before opening archive", async () => {
  await expect(extract("missing", "unused", "../escape")).rejects.toThrow("Invalid plugin path");
});
