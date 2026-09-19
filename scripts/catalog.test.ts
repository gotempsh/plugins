import { describe, expect, test } from "bun:test";
import { parseListing, resolvePlugin, generate, buildPlan } from "./catalog";

const sha = "a".repeat(40);
const listing = { repo: "gotempsh/temps-plugin-template", categories: ["developer-tools"] };
const pkg = { name: "@your-scope/my-plugin", version: "0.1.0", description: "A hello-world native Temps plugin", author: "Your team", temps: { name: "my-plugin", title: "My plugin", category: "Development", platforms: ["linux-amd64-gnu"] } };

function fixture(packageJson: object = pkg, readme = "# My plugin\n") {
  const fetcher = (async (input: RequestInfo | URL) => {
    const url = String(input);
    const body = url.endsWith("/repos/gotempsh/temps-plugin-template")
      ? { full_name: listing.repo, private: false, default_branch: "main", owner: { login: "gotempsh" } }
      : url.endsWith("/commits/main") ? { sha }
      : url.endsWith("/package.json") ? packageJson : readme;
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
  return fetcher;
}

describe("catalog submissions", () => {
  test("accepts minimal exact listing", () => expect(parseListing("my-plugin", listing)).toEqual(listing));
  test("rejects unknown keys and traversal", () => {
    expect(() => parseListing("my-plugin", { ...listing, directory: "subdir" })).toThrow("only repo, categories");
    expect(() => parseListing("my-plugin", { ...listing, repo: "gotempsh/../evil" })).toThrow("invalid GitHub");
  });
  test("resolves real template-shaped manifest at immutable commit", async () => {
    const result = await resolvePlugin("my-plugin", listing, fixture());
    expect(result.commit).toBe(sha);
    expect(result.readmeUrl).toContain(`/${sha}/README.md`);
    expect(result.validation).toEqual({ metadata: "passed", build: "not_run" });
  });
  test("rejects mismatched manifest identity", async () => {
    await expect(resolvePlugin("my-plugin", listing, fixture({ ...pkg, temps: { ...pkg.temps, name: "other" } }))).rejects.toThrow("temps.name must match");
  });
  test("rejects absent README", async () => {
    await expect(resolvePlugin("my-plugin", listing, fixture(pkg, ""))).rejects.toThrow("README.md is empty");
  });
  test("rejects asset traversal", async () => {
    await expect(resolvePlugin("my-plugin", listing, fixture({ ...pkg, temps: { ...pkg.temps, logo: "../secret" } }))).rejects.toThrow("invalid asset path");
  });
});

for (const path of ["../evil", "/absolute", "a//b", "a/./b", "a/../b", "a/", "a\\b", "%2e%2e/x", ".git/x", "a/.GIT/x", "x".repeat(513)]) {
  test(`rejects unsafe path ${path}`, () => expect(() => parseListing("my-plugin", { ...listing, path })).toThrow("invalid plugin path"));
}
for (const ref of ["", "--upload-pack=evil", "x..y", "main:evil", "a b"]) {
  test(`rejects unsafe ref ${ref}`, () => expect(() => parseListing("my-plugin", { ...listing, ref })).toThrow("invalid Git ref"));
}
test("pins a subdirectory at a slash-containing ref and makes assets directory-relative", async () => {
  const calls: string[] = [];
  const fetcher = (async (input: RequestInfo | URL) => {
    const url = String(input); calls.push(url);
    if (url.endsWith(`/repos/${listing.repo}`)) return Response.json({ full_name: listing.repo, default_branch: "main", private: false });
    if (url.endsWith("/commits/release%2Fv1")) return Response.json({ sha });
    if (url.endsWith(`/${sha}/plugins/demo/package.json`)) return Response.json({ ...pkg, temps: { ...pkg.temps, logo: "assets/logo.png" } });
    if (url.endsWith(`/${sha}/plugins/demo/README.md`)) return new Response("# Demo");
    return new Response("missing", { status: 404 });
  }) as typeof fetch;
  const result = await resolvePlugin("my-plugin", { ...listing, path: "plugins/demo", ref: "release/v1" }, fetcher);
  expect(result.path).toBe("plugins/demo");
  expect(result.ref).toBe("release/v1");
  expect(result.logoUrl).toEndWith(`/${sha}/plugins/demo/assets/logo.png`);
  expect(result.readmeUrl).toEndWith(`/${sha}/plugins/demo/README.md`);
  expect(buildPlan([result])[0]).toEqual({ repository: result.repository, commit: sha, path: "plugins/demo", ref: "release/v1" });
  expect(calls.some(url => url.endsWith("/commits/main"))).toBe(false);
});
test("missing custom ref fails without falling back to default branch", async () => {
  const fetcher = (async (input: RequestInfo | URL) => String(input).includes("/commits/")
    ? new Response("missing", { status: 404 }) : Response.json({ full_name: listing.repo, default_branch: "main" })) as typeof fetch;
  await expect(resolvePlugin("my-plugin", { ...listing, ref: "missing" }, fetcher)).rejects.toThrow("404");
});

test("multiple paths in one repository generate v2, but duplicate source paths fail", async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = await mkdtemp(join(tmpdir(), "catalog-paths-"));
  try {
    await mkdir(join(root, "registry"));
    await writeFile(join(root, "registry/my-plugin.json"), JSON.stringify({ ...listing, path: "plugins/a" }));
    await writeFile(join(root, "registry/other.json"), JSON.stringify({ ...listing, path: "plugins/b" }));
    const fetcher = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/plugins/b/package.json")) return Response.json({ ...pkg, temps: { ...pkg.temps, name: "other" } });
      return fixture()(input);
    }) as typeof fetch;
    const catalog = await generate(root, fetcher);
    expect(catalog.schema_version).toBe(2);
    expect(catalog.plugins.map(p => p.path)).toEqual(["plugins/a", "plugins/b"]);
    await writeFile(join(root, "registry/other.json"), JSON.stringify({ ...listing, path: "plugins/a", ref: "v2" }));
    await expect(generate(root, fetcher)).rejects.toThrow("duplicate repository and path");
  } finally { await rm(root, { recursive: true, force: true }); }
});
