import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const API = "https://api.github.com";
const categoryLabels: Record<string, string> = { analytics: "Analytics", automation: "Integrations", databases: "Data", "developer-tools": "Development", observability: "Observability", seo: "SEO", security: "Security", other: "Other" };
const categories = new Set(Object.keys(categoryLabels));
const repoPattern = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,38})\/[a-zA-Z0-9._-]{1,100}$/;
const namePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const shaPattern = /^[a-f0-9]{40}$/;

export type Listing = { repo: string; categories: string[]; path?: string; ref?: string };
export type CatalogPlugin = {
  name: string; title: string; summary: string; description: string; author: string;
  category: string; repository: string; path?: string; ref?: string; docsUrl: string | null; logoUrl: string | null;
  screenshots: { url: string; alt: string; caption: string }[];
  latestVersion: string; platforms: string[]; commit: string; readmeUrl: string;
  validation: { metadata: "passed"; build: "not_run" | "passed" };
};

/** Same canonical, repository-relative selector accepted by the host installer. */
export function validPath(path: string): boolean {
  return path.length <= 512 && (path === "" || path.split("/").every(part =>
    /^[A-Za-z0-9_.-]+$/.test(part) && ![".", "..", ".git"].includes(part.toLowerCase())));
}

export function validRef(ref: string): boolean {
  return ref.length > 0 && ref.length <= 128 && !ref.startsWith("-") &&
    /^[A-Za-z0-9_./-]+$/.test(ref) && !ref.includes("..");
}

export function buildPlan(plugins: CatalogPlugin[]) {
  return plugins.map(plugin => ({ repository: plugin.repository, path: plugin.path ?? "", ref: plugin.ref, commit: plugin.commit }));
}

export function parseListing(filename: string, value: unknown): Listing {
  if (!namePattern.test(filename)) throw new Error(`Invalid listing filename: ${filename}`);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${filename}: expected object`);
  const data = value as Record<string, unknown>;
  if (Object.keys(data).some(key => !["categories", "repo", "path", "ref"].includes(key))) throw new Error(`${filename}: only repo, categories, path and ref are allowed`);
  if (data.path !== undefined && (typeof data.path !== "string" || !validPath(data.path))) throw new Error(`${filename}: invalid plugin path`);
  if (data.ref !== undefined && (typeof data.ref !== "string" || !validRef(data.ref))) throw new Error(`${filename}: invalid Git ref`);
  if (typeof data.repo !== "string" || !repoPattern.test(data.repo) || data.repo.includes("..")) throw new Error(`${filename}: invalid GitHub owner/repo`);
  if (!Array.isArray(data.categories) || data.categories.length === 0 || data.categories.some(c => typeof c !== "string" || !categories.has(c)) || new Set(data.categories).size !== data.categories.length) throw new Error(`${filename}: invalid categories`);
  return data as Listing;
}

async function githubJson(url: string, fetcher: typeof fetch): Promise<any> {
  const response = await fetcher(url, { headers: { Accept: "application/vnd.github+json", "User-Agent": "temps-plugin-catalog", ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}) } });
  if (!response.ok) throw new Error(`GitHub request failed (${response.status}): ${url}`);
  return response.json();
}

async function githubText(repo: string, sha: string, path: string, fetcher: typeof fetch): Promise<string> {
  const response = await fetcher(`https://raw.githubusercontent.com/${repo}/${sha}/${path}`);
  if (!response.ok) throw new Error(`${repo}@${sha}: missing ${path} (${response.status})`);
  const contentLength = Number(response.headers.get("content-length") ?? 0);
  if (contentLength > 1024 * 1024) throw new Error(`${repo}@${sha}: ${path} too large`);
  const text = await response.text();
  if (text.length > 1024 * 1024) throw new Error(`${repo}@${sha}: ${path} too large`);
  return text;
}

function requiredString(value: unknown, context: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${context}: missing nonempty string`);
  return value.trim();
}

export async function resolvePlugin(name: string, listing: Listing, fetcher: typeof fetch = fetch): Promise<CatalogPlugin> {
  const repo = await githubJson(`${API}/repos/${listing.repo}`, fetcher);
  if (repo.private || repo.full_name?.toLowerCase() !== listing.repo.toLowerCase()) throw new Error(`${listing.repo}: repository is private or renamed`);
  const branch = requiredString(listing.ref ?? repo.default_branch, `${listing.repo} default branch`);
  const commit = await githubJson(`${API}/repos/${listing.repo}/commits/${encodeURIComponent(branch)}`, fetcher);
  const sha = requiredString(commit.sha, `${listing.repo} commit`);
  if (!shaPattern.test(sha)) throw new Error(`${listing.repo}: invalid commit SHA`);
  const prefix = listing.path ? `${listing.path}/` : "";
  const pkg = JSON.parse(await githubText(listing.repo, sha, `${prefix}package.json`, fetcher));
  const manifest = pkg?.temps;
  if (!manifest || typeof manifest !== "object") throw new Error(`${listing.repo}: package.json missing temps manifest`);
  if (requiredString(manifest.name, `${listing.repo} temps.name`) !== name) throw new Error(`${listing.repo}: temps.name must match ${name}`);
  const readme = await githubText(listing.repo, sha, `${prefix}README.md`, fetcher);
  if (!readme.trim()) throw new Error(`${listing.repo}: README.md is empty`);
  const title = requiredString(manifest.title ?? pkg.displayName ?? name, `${listing.repo} title`);
  const summary = requiredString(manifest.summary ?? pkg.description, `${listing.repo} summary`);
  const description = requiredString(manifest.description ?? pkg.description, `${listing.repo} description`);
  const author = typeof pkg.author === "string" ? pkg.author : pkg.author?.name;
  const version = requiredString(pkg.version, `${listing.repo} version`);
  const platforms = Array.isArray(manifest.platforms) ? manifest.platforms : [];
  if (platforms.some((p: unknown) => typeof p !== "string" || !/^[a-z0-9_-]+$/.test(p))) throw new Error(`${listing.repo}: invalid platforms`);
  const rawBase = `https://raw.githubusercontent.com/${listing.repo}/${sha}${listing.path ? `/${listing.path}` : ""}`;
  const asset = (path: unknown): string | null => {
    if (path == null) return null;
    if (typeof path !== "string" || !path || !validPath(path)) throw new Error(`${listing.repo}: invalid asset path`);
    return `${rawBase}/${path}`;
  };
  const shots = manifest.screenshots ?? [];
  if (!Array.isArray(shots) || shots.length > 8) throw new Error(`${listing.repo}: invalid screenshots`);
  return {
    name, title, summary, description, author: requiredString(author ?? repo.owner?.login, `${listing.repo} author`),
    category: categoryLabels[listing.categories[0]], repository: `https://github.com/${listing.repo}`,
    ...(listing.path ? { path: listing.path } : {}), ref: branch,
    docsUrl: typeof manifest.docsUrl === "string" && /^https:\/\//.test(manifest.docsUrl) ? manifest.docsUrl : null,
    logoUrl: asset(manifest.logo), screenshots: shots.map((shot: any) => {
      const url = asset(shot?.path);
      if (!url) throw new Error(`${listing.repo}: screenshot needs path`);
      return { url, alt: requiredString(shot.alt, `${listing.repo} screenshot alt`), caption: shot.caption ?? "" };
    }),
    latestVersion: version, platforms, commit: sha, readmeUrl: `${rawBase}/README.md`,
    validation: { metadata: "passed", build: "not_run" },
  };
}

export async function generate(root: string, fetcher: typeof fetch = fetch) {
  const registry = join(root, "registry");
  const names = (await readdir(registry)).filter(name => name.endsWith(".json") && name !== "catalog.json").sort();
  const plugins: CatalogPlugin[] = [];
  const repos = new Set<string>();
  for (const filename of names) {
    const name = filename.slice(0, -5);
    const listing = parseListing(name, JSON.parse(await readFile(join(registry, filename), "utf8")));
    const identity = `${listing.repo.toLowerCase()}#${listing.path ?? ""}`;
    if (repos.has(identity)) throw new Error(`${filename}: duplicate repository and path`);
    repos.add(identity);
    plugins.push(await resolvePlugin(name, listing, fetcher));
  }
  return { schema_version: plugins.some(plugin => plugin.path) ? 2 : 1, generated_at: new Date().toISOString(), plugins };
}

if (import.meta.main) {
  const root = join(import.meta.dir, "..");
  const mode = process.argv[2];
  if (mode !== "--check" && mode !== "--write" && mode !== "--plan") throw new Error("Usage: bun scripts/catalog.ts --check|--write|--plan");
  const catalog = await generate(root);
  if (mode === "--plan") {
    console.log(JSON.stringify(buildPlan(catalog.plugins)));
    process.exit(0);
  }
  if (mode === "--write") {
    if (process.env.CATALOG_BUILD_VERIFIED === "1") {
      const plan = JSON.parse(await readFile(join(root, ".catalog-build-plan.json"), "utf8"));
      if (!Array.isArray(plan) || JSON.stringify(plan) !== JSON.stringify(buildPlan(catalog.plugins))) {
        throw new Error("Build plan does not match resolved catalog commits");
      }
      for (const plugin of catalog.plugins) plugin.validation.build = "passed";
    }
    await writeFile(join(root, "registry/catalog.json"), `${JSON.stringify(catalog, null, 2)}\n`);
  }
  console.log(`Validated ${catalog.plugins.length} plugin listing(s)`);
}
