# Temps Plugins

Official external plugins for [Temps](https://temps.sh) — drop-in binaries that extend the platform without forking or rebuilding it.

Plugins in this repo use either the Rust [`temps-plugin-sdk`](https://github.com/gotempsh/temps/tree/main/crates/temps-plugin-sdk) or the TypeScript [`@temps-sdk/plugin`](https://github.com/gotempsh/temps/tree/main/sdks/node/packages/plugin-sdk). Both communicate with the Temps server over stdin/stdout and compile to standalone binaries.

## Plugins

| Plugin | Description |
| --- | --- |
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
bun install
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

SDK versions follow Temps releases. Rust plugins pin
`temps-plugin-sdk = { git = "...", tag = "vX.Y.Z" }`, and TypeScript plugins
depend on the matching `@temps-sdk/plugin` npm version. Individual plugins keep
their own versions because they can release independently from Temps.

## License

Dual-licensed under Apache 2.0 or MIT, matching the main [Temps](https://github.com/gotempsh/temps) repo. See [`LICENSE`](./LICENSE) and [`LICENSE-MIT`](./LICENSE-MIT).
