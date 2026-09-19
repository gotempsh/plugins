# Temps Plugins

Official external plugins for [Temps](https://temps.sh) — drop-in binaries that extend the platform without forking or rebuilding it.

Plugins in this repo use either the Rust [`temps-plugin-sdk`](https://github.com/gotempsh/temps/tree/main/crates/temps-plugin-sdk) or the TypeScript [`@temps-sdk/plugin`](https://github.com/gotempsh/temps/tree/main/sdks/node/packages/plugin-sdk). Both communicate with the Temps server over stdin/stdout and compile to standalone binaries.

## Plugins

| Plugin | Description |
| --- | --- |
| [`site-crawl-plugin`](./site-crawl-plugin) | Find broken internal routes, trace referring pages, and audit server-rendered SEO metadata. TypeScript; protocol v2. |
| [`example-plugin`](./example-plugin) | Minimal SEO crawler — the shortest path to understanding the plugin protocol, UI bundle layout, and SQLite-backed persistence. |
| [`lighthouse-plugin`](./lighthouse-plugin) | Runs Google Lighthouse audits after every deployment and tracks Core Web Vitals over time. |
| [`indexnow-plugin`](./indexnow-plugin) | Automatically submits deployed URLs to IndexNow-supporting search engines (Bing, Yandex, Seznam). |
| [`google-indexing-plugin`](./google-indexing-plugin) | Notifies the Google Indexing API when pages are published or removed. |
| [`deployment-pulse-plugin`](./deployment-pulse-plugin) | TypeScript reference plugin with a searchable, cross-project deployment health dashboard. |

## Install a prebuilt binary

Each GitHub Release publishes per-platform binaries for every plugin.

```bash
# 1. Download the binary for your platform from the Releases page
curl -L -o ~/.temps/plugins/temps-lighthouse-plugin \
  https://github.com/gotempsh/plugins/releases/latest/download/temps-lighthouse-plugin-x86_64-linux

# 2. Make it executable
chmod +x ~/.temps/plugins/temps-lighthouse-plugin

# 3. Open the Temps dashboard → Settings → Plugins → Reload Plugins
```

## Build from source

```bash
git clone https://github.com/gotempsh/plugins
cd plugins

# Build all plugins
cargo build --release

# Or build just one
cargo build --release -p temps-lighthouse-plugin

# Install the binary
cp target/release/temps-lighthouse-plugin ~/.temps/plugins/
chmod +x ~/.temps/plugins/temps-lighthouse-plugin
```

Open **Settings → Plugins** in the Temps dashboard and click **Reload Plugins**.

For the TypeScript example, use Bun:

```bash
cd deployment-pulse-plugin
bun install --frozen-lockfile
bun run test
bun run build
cp dist/temps-deployment-pulse-plugin ~/.temps/plugins/
chmod +x ~/.temps/plugins/temps-deployment-pulse-plugin
```

## Plugin structure

Rust plugins are standalone Cargo crates:

```
lighthouse-plugin/
├── Cargo.toml      # deps inherited from the workspace
├── build.rs        # bundles web/dist into the binary
├── src/            # Rust source
└── web/            # optional Vite + React UI (built into a static bundle)
```

The `build.rs` runs `bun install && bun run build` in `web/` when the `web/` directory exists, then the Rust code embeds the built assets with `include_dir!`.

TypeScript plugins follow the same single-binary model:

```
deployment-pulse-plugin/
├── package.json    # SDK dependency and Bun scripts
├── scripts/        # embeds the compiled UI
├── src/            # plugin process and tests
└── web/            # Vite + React UI
```

`bun run build` builds the UI, embeds it into TypeScript, and compiles the
plugin into one executable. Temps does not need Bun or Node.js at runtime.

## Write your own plugin

For Rust, copy `example-plugin`. For TypeScript, copy
`deployment-pulse-plugin`. See the [plugin system docs](https://temps.sh/docs/plugins)
for the full SDK reference, protocol details, and service registration patterns.

## Versioning

Rust plugins pin `temps-plugin-sdk = { git = "...", tag = "vX.Y.Z" }`.
The TypeScript SDK and individual plugins use their own semantic versions
because they can release independently from Temps. Compatibility is defined by
the external-plugin protocol version.

## License

Dual-licensed under Apache 2.0 or MIT, matching the main [Temps](https://github.com/gotempsh/temps) repo. See [`LICENSE`](./LICENSE) and [`LICENSE-MIT`](./LICENSE-MIT).

## Site Crawl

Site Crawl is an administrator-only crawler with a Temps sidebar UI and SQLite-backed reports. It follows same-origin links and up to five sitemap documents, respects robots.txt and nofollow, records redirects and HTTP/network errors, and checks titles, descriptions, canonicals, headings, language, and noindex/sitemap conflicts. Each affected URL includes its referring pages and suggested fixes. Reports can be cancelled, exported as JSON, or deleted; the newest 30 are retained. Interrupted crawls are marked after restart.

```sh
cd site-crawl-plugin
bun install --frozen-lockfile
bun run check
bun test src
bun run build
```

The native executable is `site-crawl-plugin/dist/site-crawl`. This version is a source implementation, not a published registry release. Install through the normal reviewed Temps plugin publishing/installation flow; it is not added to the public catalog by this change. The folder is self-contained for publication from a dedicated plugin repository. `bun run dev` starts a loopback-only development UI at `http://127.0.0.1:3198`; that entrypoint is not distributed as the plugin.

Crawls are limited to 500 URLs, one running job, a 20-minute job deadline, 10 seconds per HTTP request, 8 MiB per response, and at least 250 ms between requests (or a longer robots crawl delay). Only public HTTP/HTTPS origins on standard ports are supported. DNS results are validated and pinned for each connection; private, loopback, reserved addresses and off-origin redirects are not fetched. Manual crawls need no host API grants or AI provider. Automatic crawls require the `events_read` host permission. Native plugins still run with the host OS account's permissions; they are not sandboxed.

Checks analyze returned HTML, not a browser-rendered DOM. JavaScript-only routes, authenticated pages, external links, fragment targets, and orphan pages absent from links/sitemaps are outside this first version. Missing metadata is guidance, not a guarantee of ranking or indexing. Canonical and noindex rules follow [Google Search Central's crawling and indexing guidance](https://developers.google.com/search/docs/crawling-indexing).

### Crawl after deployments

Site Crawl subscribes to `deployment.succeeded`. Grant **Events read** in Temps **Settings → Plugins → Permissions**. The sidebar shows automation settings even when the permission is missing, with a direct setup link. Automatic crawling is enabled by default for successful **production** deployments. Uncheck **Production only** to include preview and other environments. Disable individual projects after their first deployment event arrives, or pause automation globally.

Each event queues the deployment URL after a five-second settling delay. Reports include project, environment, and deployment IDs. Crawls inspect the URL as served at crawl time; a later deployment can replace its contents before a queued crawl begins. Failed deployments are not crawled, and deployments without a supported public URL are reported as skipped.

One crawl runs at a time, including manual crawls. Up to 20 deployments wait in a persistent queue; overflow is skipped with a visible notice. The last 200 deployment identities are retained to suppress duplicate events. Queued work resumes after restart; interrupted active crawls are marked interrupted rather than silently restarted. Changing project/environment settings removes queued jobs that no longer qualify. Administrators can clear the queue and cancel the active crawl separately.

Live permission discovery is checked before each queued crawl. Revoking Events read pauses queued work and stops new host event delivery; an already-started crawl continues until completion or cancellation. Permissions are retried every 30 seconds. Older hosts without capability discovery can still run manual crawls but cannot activate this automation.

### Design system

The plugin UI uses React and an attributed snapshot of the Temps design-system components from the `design-system-ds` worktree: PageContainer, PageHeader, Button, Field, Callout, Status, PageState, and their Radix-based UI primitives. See `site-crawl-plugin/web/vendor/README.md` for provenance and update instructions. The Vite build embeds the UI into the native executable; no local-worktree dependency or external frontend service is required. Light/dark themes, keyboard-accessible dialogs and tabs, and responsive tables are supported.

The 8 MiB response bound accommodates larger documentation HTML. Responses above this limit retain their observed HTTP status and report an incomplete-inspection warning rather than claiming a broken route. Existing saved reports retain their original results; rerun a crawl to apply the new behavior.

### Tokenizer-based parsing

HTML analysis and sitemap discovery use `htmlparser2` callbacks instead of constructing a Cheerio DOM. Only bounded SEO fields and crawl targets are retained: titles up to 1,000 characters, descriptions up to 2,000, and at most 2,000 links per page. Script/template/noscript/SVG content cannot introduce phantom page metadata or crawl links. XML sitemap parsing preserves namespaced URL discovery and document/URL caps.

HTTP downloads still buffer at most 8 MiB before tokenization; this is not network-streaming analysis and does not execute JavaScript. HTML nesting over 128 levels and XML nesting over 64 levels stop inspection with a contextual warning/notice. Existing DNS, redirects, robots, scheduling and permission checks continue to apply.
