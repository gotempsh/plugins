# Deployment Pulse TypeScript Plugin

A useful, read-only Temps plugin built with `@temps-sdk/plugin`. It gives an
operator one compact view of deployment health across every project:

- latest deployment state, branch, commit, and age;
- projects needing attention sorted first;
- recent deployment success rate per project;
- search and health filters;
- automatic refresh every 30 seconds; and
- partial results when one project's history cannot be read.

The Bun build embeds the React UI and SDK into a single executable. The Temps
host does not need Bun or Node.js installed.

## Build and test

Once `@temps-sdk/plugin@0.1.0-beta.1` has been published:

```bash
bun install
bun run test
bun run build
```

The executable is written to `dist/temps-deployment-pulse-plugin`.

Before the first SDK release is published, link it from a local checkout of
`gotempsh/temps`:

```bash
cd ../temps/sdks/node
bun install --frozen-lockfile
cd packages/plugin-sdk
bun run build
bun link

cd ../../../../plugins/deployment-pulse-plugin
bun link @temps-sdk/plugin
bun run test
bun run build
```

## Install locally

```bash
mkdir -p ~/.temps/plugins
cp dist/temps-deployment-pulse-plugin ~/.temps/plugins/
chmod +x ~/.temps/plugins/temps-deployment-pulse-plugin
```

Open **Settings → Plugins** and select **Reload Plugins**, or restart Temps.
The plugin contributes one **Deployment Pulse** navigation item and mounts its
read-only API at `/api/x/deployment-pulse/overview`.

## Permissions and data

Deployment Pulse declares no raw API capability, database access, or host-data
access. It reads only the caller-scoped `list_projects` and `list_deployments`
methods exposed by the signed protocol-v2 SDK channel.

Project links use the public `/projects/<project_slug>` route. Internal project
IDs are never exposed in dashboard URLs.
