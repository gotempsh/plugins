import { describe, expect, test } from "bun:test";
import { parseListing, resolvePlugin, parsePermissions } from "./catalog";

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
  test("rejects path overrides and traversal", () => {
    expect(() => parseListing("my-plugin", { ...listing, path: "subdir" })).toThrow("only repo and categories");
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


test('permission metadata preserves legacy unknown, explicit none and author requirements', async () => {
  expect(parsePermissions(undefined, 'demo')).toBeUndefined();
  expect(parsePermissions([], 'demo')).toEqual([]);
  const permissions = [{permission:'events_read', required:false, reason:'  Enables deployment crawls.  '}];
  const result = await resolvePlugin('my-plugin', listing, fixture({...pkg, temps:{...pkg.temps, permissions}}));
  expect(result.permissions).toEqual([{permission:'events_read', required:false, reason:'Enables deployment crawls.'}]);
  expect(parsePermissions([{permission:'projects_read', required:true, reason:'Lists projects.'}], 'demo')?.[0].required).toBe(true);
});

test('permission metadata rejects malformed, duplicate, unknown and oversized requirements', () => {
  const valid = {permission:'events_read', required:false, reason:'Deployment crawls.'};
  for (const value of [null, {}, [null], [valid,valid], [{...valid,permission:'secrets_read'}], [{...valid,required:'yes'}], [{...valid,reason:' '}], [{...valid,reason:'x'.repeat(501)}], Array(8).fill(valid), [{...valid,extra:true}]]) {
    expect(() => parsePermissions(value, 'demo')).toThrow();
  }
});
