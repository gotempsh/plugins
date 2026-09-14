# Submit a plugin

Open a pull request adding `registry/<plugin-name>.json`:

```json
{
  "repo": "your-org/your-plugin",
  "categories": ["observability"]
}
```

The filename must match `temps.name` in the repository's root `package.json`.
Only public GitHub repositories with a root `package.json` and nonempty root
`README.md` are supported. Monorepo paths are deliberately not supported yet;
the installer must understand paths before listings may specify them. The
generator reads metadata from a pinned commit SHA, not a mutable branch URL.

Allowed categories: `analytics`, `automation`, `databases`, `developer-tools`,
`observability`, `seo`, `security`, `other`. The first is the primary category.

The `temps` manifest may supply `title`, `summary`, `description`, `platforms`,
`docsUrl`, `logo`, and `screenshots` (objects with relative `path`, `alt`, and
optional `caption`). Logo and screenshot paths are relative to repository root.
Other fields derive from `package.json` and GitHub repository metadata.

Pull-request validation checks metadata and README availability, then installs
dependencies with lifecycle scripts disabled and compiles the root manifest's
entrypoint in a capped, offline container. It does **not** execute the plugin or
audit its security. The generated catalog records `validation.build: "passed"`
only when the tested commit matches the catalog commit. Consumers must not
present build validation as a security guarantee.

The dependency-install phase has network access to download locked packages;
only the subsequent compile phase is offline. Lifecycle scripts are disabled
during installation. This is build validation, not full network isolation or
a malware review.
