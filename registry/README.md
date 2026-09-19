# Submit a plugin

Open a pull request adding `registry/<plugin-name>.json`:

```json
{
  "repo": "your-org/your-plugin",
  "categories": ["observability"],
  "path": "plugins/my-plugin",
  "ref": "release/v1"
}
```

The filename must match `temps.name` in the selected directory's `package.json`.
Only public GitHub repositories are supported. Optional `path` selects a plugin
subdirectory; omit it (or use an empty string) for the repository root. Optional
`ref` selects a branch, tag, or commit; omit it for the repository default branch.
The generator resolves this ref to an immutable commit before reading metadata or
building. Separate plugins in one repository use separate listing files and paths.
The same repository/path cannot be listed twice with different refs.

The selected directory must contain its own `package.json`, `bun.lock`, nonempty
`README.md`, and all sources and generated assets needed by the installer.
Only that subtree is passed to the builder: dependencies on parent workspace files
or sibling packages are not supported. Paths are relative, case-sensitive and
cannot contain empty segments, `.`, `..`, `.git`, backslashes or encoded separators.
Catalogs with subdirectory plugins use schema version 2, so older hosts fail closed
instead of silently installing the repository root. Upgrade Temps for these listings.
Catalog installation remains pinned to the reviewed commit; selecting a new ref
for an installed plugin is an explicit update action.

Allowed categories: `analytics`, `automation`, `databases`, `developer-tools`,
`observability`, `seo`, `security`, `other`. The first is the primary category.

The `temps` manifest may supply `title`, `summary`, `description`, `platforms`,
`docsUrl`, `logo`, and `screenshots` (objects with relative `path`, `alt`, and
optional `caption`). Logo and screenshot paths are relative to the selected plugin directory.
Other fields derive from `package.json` and GitHub repository metadata.

Pull-request validation checks metadata and README availability, then installs
dependencies with lifecycle scripts disabled and compiles the selected directory's manifest
entrypoint in a capped, offline container. It does **not** execute the plugin or
audit its security. The generated catalog records `validation.build: "passed"`
only when the tested commit matches the catalog commit. Consumers must not
present build validation as a security guarantee.

The dependency-install phase has network access to download locked packages;
only the subsequent compile phase is offline. Lifecycle scripts are disabled
during installation. This is build validation, not full network isolation or
a malware review.
