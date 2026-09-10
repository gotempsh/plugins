// SPDX-FileCopyrightText: 2024-2026 Temps Contributors
// SPDX-License-Identifier: MIT OR Apache-2.0

import { afterEach, describe, expect, test } from "bun:test";
import {
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseArguments,
  publishPlugin,
  type PublishOptions,
} from "./publish-plugin";

const KEYSET_DOMAIN = Buffer.from("temps-plugin-keyset-v1\0");
const CATALOG_DOMAIN = Buffer.from("temps-plugin-catalog-v1\0");
const SPKI_PREFIX_BYTES = 12;
const PLATFORMS = [
  "x86_64-linux",
  "aarch64-linux",
  "x86_64-darwin",
  "aarch64-darwin",
];
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function rawPublicKey(key: KeyObject): string {
  const publicKey = key.type === "public" ? key : createPublicKey(key);
  const der = Buffer.from(publicKey.export({ format: "der", type: "spki" }));
  return der.subarray(SPKI_PREFIX_BYTES).toString("hex");
}

function envelope(
  domain: Buffer,
  document: unknown,
  keyId: string,
  privateKey: KeyObject,
) {
  const payload = Buffer.from(JSON.stringify(document));
  return {
    key_id: keyId,
    payload: payload.toString("base64"),
    signature: sign(
      null,
      Buffer.concat([domain, payload]),
      privateKey,
    ).toString("base64"),
  };
}

function rootSignedKeyset(
  document: unknown,
  roots: Array<{ privateKey: KeyObject }>,
) {
  const payload = Buffer.from(JSON.stringify(document));
  const message = Buffer.concat([KEYSET_DOMAIN, payload]);
  return {
    payload: payload.toString("base64"),
    signatures: roots.map(({ privateKey }, index) => ({
      key_id: `test-root-${index + 1}`,
      signature: sign(null, message, privateKey).toString("base64"),
    })),
  };
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "temps-registry-publisher-"));
  temporaryDirectories.push(root);
  const registryDir = join(root, "registry");
  const dataDir = join(registryDir, "src", "registry-data");
  const artifactsDir = join(root, "release");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(join(registryDir, "public"), { recursive: true });
  mkdirSync(artifactsDir, { recursive: true });

  const roots = [
    generateKeyPairSync("ed25519"),
    generateKeyPairSync("ed25519"),
  ];
  const catalog = generateKeyPairSync("ed25519");
  const now = new Date("2026-09-10T12:00:00.000Z");
  const keysetDocument = {
    schema_version: 1,
    audience: "registry.temps.sh/plugins",
    generation: 1,
    issued_at: "2026-09-10T11:59:00.000Z",
    expires_at: "2026-09-16T12:00:00.000Z",
    keys: [
      {
        key_id: "catalog-test-1",
        algorithm: "ed25519",
        public_key: rawPublicKey(catalog.publicKey),
        not_before: "2026-09-09T12:00:00.000Z",
        not_after: "2027-09-10T12:00:00.000Z",
        status: "active",
      },
    ],
  };
  const keysetEnvelope = rootSignedKeyset(keysetDocument, roots);
  writeFileSync(join(dataDir, "keyset.json"), JSON.stringify(keysetEnvelope));
  const catalogEnvelope = envelope(
    CATALOG_DOMAIN,
    {
      schema_version: 1,
      revision: 1,
      issued_at: "2026-09-10T11:59:00.000Z",
      expires_at: "2026-10-09T11:59:00.000Z",
      plugins: [],
    },
    "catalog-test-1",
    catalog.privateKey,
  );
  writeFileSync(join(dataDir, "catalog.json"), JSON.stringify(catalogEnvelope));

  const signingKeyFile = join(root, "catalog.pem");
  writeFileSync(
    signingKeyFile,
    catalog.privateKey.export({ format: "pem", type: "pkcs8" }),
    { mode: 0o600 },
  );
  chmodSync(signingKeyFile, 0o600);
  const manifestPath = join(root, "registry.json");
  writeFileSync(
    manifestPath,
    JSON.stringify({
      name: "deployment-pulse",
      version: "0.1.0",
      binary: "temps-deployment-pulse-plugin",
      title: "Deployment Pulse",
      summary: "Monitor deployments.",
      description: "Monitor deployment health across projects.",
      author: "Temps",
      category: "Observability",
      keywords: ["deployments"],
      repository: "https://example.com/plugins/deployment-pulse",
      docs_url: null,
      logo_url: "/plugin-logos/deployment-pulse.svg",
    }),
  );
  for (const platform of PLATFORMS) {
    writeFileSync(
      join(artifactsDir, `temps-deployment-pulse-plugin-${platform}`),
      `standalone plugin for ${platform}`,
    );
  }
  const rootKeys = new Map(
    roots.map(({ publicKey }, index) => [
      `test-root-${index + 1}`,
      rawPublicKey(publicKey),
    ]),
  );
  const options: PublishOptions = {
    manifestPath,
    artifactsDir,
    registryDir,
    signingKeyFile,
    keyId: "catalog-test-1",
    now,
    rootKeys,
    liveState: { keyset: keysetEnvelope, catalog: catalogEnvelope },
  };
  return {
    options,
    catalog,
    registryDir,
    artifactsDir,
    dataDir,
    keysetEnvelope,
    keysetDocument,
    roots,
  };
}

function setManifestVersion(options: PublishOptions, version: string): void {
  const manifest = JSON.parse(readFileSync(options.manifestPath, "utf8"));
  manifest.version = version;
  writeFileSync(options.manifestPath, JSON.stringify(manifest));
}

describe("single-plugin registry publisher", () => {
  test("copies four immutable artifacts and atomically signs the next catalogue", async () => {
    const { options, catalog, registryDir, dataDir } = fixture();
    const result = await publishPlugin(options);

    expect(result).toMatchObject({
      plugin: "deployment-pulse",
      version: "0.1.0",
      revision: 2,
      dryRun: false,
    });
    expect(Object.keys(result.artifacts)).toEqual([
      "linux-amd64",
      "linux-arm64",
      "darwin-amd64",
      "darwin-arm64",
    ]);
    for (const platform of Object.keys(result.artifacts)) {
      expect(
        readFileSync(
          join(
            registryDir,
            "public",
            "artifacts",
            "deployment-pulse",
            "0.1.0",
            platform,
            "plugin",
          ),
          "utf8",
        ),
      ).toContain("standalone plugin");
    }

    const published = JSON.parse(
      readFileSync(join(dataDir, "catalog.json"), "utf8"),
    );
    const payload = Buffer.from(published.payload, "base64");
    expect(
      verify(
        null,
        Buffer.concat([CATALOG_DOMAIN, payload]),
        catalog.publicKey,
        Buffer.from(published.signature, "base64"),
      ),
    ).toBe(true);
    const document = JSON.parse(payload.toString("utf8"));
    expect(document.revision).toBe(2);
    expect(document.plugins[0]).toMatchObject({
      name: "deployment-pulse",
      version: "0.1.0",
      platforms: {
        "linux-amd64": {
          url: "https://registry.temps.sh/artifacts/deployment-pulse/0.1.0/linux-amd64/plugin",
        },
      },
    });
  });

  test("rejects a signing key that is not authorized by the root-signed keyset", async () => {
    const { options, dataDir } = fixture();
    const before = readFileSync(join(dataDir, "catalog.json"), "utf8");
    const unrelated = generateKeyPairSync("ed25519");
    writeFileSync(
      options.signingKeyFile,
      unrelated.privateKey.export({ format: "pem", type: "pkcs8" }),
      { mode: 0o600 },
    );

    await expect(publishPlugin(options)).rejects.toThrow(
      "does not match keyset entry catalog-test-1",
    );
    expect(readFileSync(join(dataDir, "catalog.json"), "utf8")).toBe(before);
  });

  test("refuses to mutate an already published version", async () => {
    const { options, artifactsDir, dataDir } = fixture();
    await publishPlugin(options);
    const before = readFileSync(join(dataDir, "catalog.json"), "utf8");
    options.liveState = {
      keyset: options.liveState!.keyset,
      catalog: JSON.parse(before),
    };
    writeFileSync(
      join(artifactsDir, "temps-deployment-pulse-plugin-x86_64-linux"),
      "tampered replacement",
    );

    await expect(publishPlugin(options)).rejects.toThrow(
      "refusing to change immutable release deployment-pulse 0.1.0",
    );
    expect(readFileSync(join(dataDir, "catalog.json"), "utf8")).toBe(before);
  });

  test("dry-run validates and signs in memory without changing registry files", async () => {
    const { options, registryDir, dataDir } = fixture();
    const before = readFileSync(join(dataDir, "catalog.json"), "utf8");

    const result = await publishPlugin({ ...options, dryRun: true });

    expect(result).toMatchObject({ revision: 2, dryRun: true });
    expect(readFileSync(join(dataDir, "catalog.json"), "utf8")).toBe(before);
    expect(
      existsSync(
        join(
          registryDir,
          "public",
          "artifacts",
          "deployment-pulse",
          "0.1.0",
          "linux-amd64",
          "plugin",
        ),
      ),
    ).toBe(false);
  });

  test("an idempotent publish restores a missing immutable artifact", async () => {
    const { options, registryDir, dataDir } = fixture();
    await publishPlugin(options);
    const catalogBefore = readFileSync(join(dataDir, "catalog.json"), "utf8");
    const artifact = join(
      registryDir,
      "public",
      "artifacts",
      "deployment-pulse",
      "0.1.0",
      "linux-amd64",
      "plugin",
    );
    unlinkSync(artifact);
    options.liveState = {
      keyset: options.liveState!.keyset,
      catalog: JSON.parse(catalogBefore),
    };

    const result = await publishPlugin(options);

    expect(result.revision).toBe(2);
    expect(readFileSync(artifact, "utf8")).toContain("standalone plugin");
    expect(readFileSync(join(dataDir, "catalog.json"), "utf8")).toBe(
      catalogBefore,
    );
  });

  test("rejects an existing catalogue signed by a verify-only key", async () => {
    const { options, dataDir, keysetDocument, roots } = fixture();
    keysetDocument.keys[0].status = "verify_only";
    const replacement = generateKeyPairSync("ed25519");
    keysetDocument.keys.push({
      key_id: "catalog-test-2",
      algorithm: "ed25519",
      public_key: rawPublicKey(replacement.publicKey),
      not_before: "2026-09-09T12:00:00.000Z",
      not_after: "2027-09-10T12:00:00.000Z",
      status: "active",
    });
    const retiredKeyset = rootSignedKeyset(keysetDocument, roots);
    writeFileSync(join(dataDir, "keyset.json"), JSON.stringify(retiredKeyset));
    options.liveState = {
      keyset: retiredKeyset,
      catalog: options.liveState!.catalog,
    };

    await expect(publishPlugin(options)).rejects.toThrow(
      "existing catalogue key catalog-test-1 is not active",
    );
  });

  test("rejects an existing catalogue issued outside its key window", async () => {
    const { options, catalog, dataDir } = fixture();
    const outOfWindow = envelope(
      CATALOG_DOMAIN,
      {
        schema_version: 1,
        revision: 1,
        issued_at: "2026-09-08T12:00:00.000Z",
        expires_at: "2026-10-07T12:00:00.000Z",
        plugins: [],
      },
      "catalog-test-1",
      catalog.privateKey,
    );
    writeFileSync(join(dataDir, "catalog.json"), JSON.stringify(outOfWindow));
    options.liveState = {
      keyset: options.liveState!.keyset,
      catalog: outOfWindow,
    };

    await expect(publishPlugin(options)).rejects.toThrow(
      "existing catalogue issuance is outside key catalog-test-1's validity window",
    );
  });

  test("rejects stale live state without changing the local catalogue", async () => {
    const { options, dataDir } = fixture();
    await publishPlugin(options);
    const before = readFileSync(join(dataDir, "catalog.json"), "utf8");
    await expect(publishPlugin(options)).rejects.toThrow(
      "local catalogue does not exactly match the live verified registry catalogue",
    );
    expect(readFileSync(join(dataDir, "catalog.json"), "utf8")).toBe(before);
  });

  test("rejects a signing key stored inside the registry checkout", async () => {
    const { options, registryDir, dataDir } = fixture();
    const before = readFileSync(join(dataDir, "catalog.json"), "utf8");
    const exposedKey = join(registryDir, "catalog-private.pem");
    writeFileSync(exposedKey, readFileSync(options.signingKeyFile), {
      mode: 0o600,
    });
    chmodSync(exposedKey, 0o600);
    options.signingKeyFile = exposedKey;

    await expect(publishPlugin(options)).rejects.toThrow(
      "catalogue signing key must be stored outside the plugins and registry checkouts",
    );
    expect(readFileSync(join(dataDir, "catalog.json"), "utf8")).toBe(before);
  });

  test("rejects a root-signed keyset issued too far in the future", async () => {
    const { options, dataDir, keysetDocument, roots } = fixture();
    keysetDocument.issued_at = "2026-09-10T12:06:00.000Z";
    keysetDocument.expires_at = "2026-09-16T12:06:00.000Z";
    const futureKeyset = rootSignedKeyset(keysetDocument, roots);
    writeFileSync(join(dataDir, "keyset.json"), JSON.stringify(futureKeyset));
    options.liveState = {
      keyset: futureKeyset,
      catalog: options.liveState!.catalog,
    };

    await expect(publishPlugin(options)).rejects.toThrow(
      "registry keyset issued_at is more than five minutes in the future",
    );
  });

  test("uses ASCII SemVer ordering for prerelease identifiers", async () => {
    const { options, dataDir } = fixture();
    setManifestVersion(options, "1.0.0-a");
    await publishPlugin(options);
    const before = readFileSync(join(dataDir, "catalog.json"), "utf8");
    options.liveState = {
      keyset: options.liveState!.keyset,
      catalog: JSON.parse(before),
    };
    setManifestVersion(options, "1.0.0-A");

    await expect(publishPlugin(options)).rejects.toThrow(
      "refusing to replace deployment-pulse 1.0.0-a with older 1.0.0-A",
    );
    expect(readFileSync(join(dataDir, "catalog.json"), "utf8")).toBe(before);
  });

  test("compares large numeric SemVer identifiers without precision loss", async () => {
    const { options, dataDir } = fixture();
    setManifestVersion(options, "1.0.0-9007199254740993");
    await publishPlugin(options);
    const before = readFileSync(join(dataDir, "catalog.json"), "utf8");
    options.liveState = {
      keyset: options.liveState!.keyset,
      catalog: JSON.parse(before),
    };
    setManifestVersion(options, "1.0.0-9007199254740992");

    await expect(publishPlugin(options)).rejects.toThrow(
      "refusing to replace deployment-pulse 1.0.0-9007199254740993 with older 1.0.0-9007199254740992",
    );
    expect(readFileSync(join(dataDir, "catalog.json"), "utf8")).toBe(before);
  });

  test("rejects a symlinked release artifact before staging it", async () => {
    const { options, artifactsDir, dataDir } = fixture();
    const before = readFileSync(join(dataDir, "catalog.json"), "utf8");
    const artifact = join(
      artifactsDir,
      "temps-deployment-pulse-plugin-x86_64-linux",
    );
    unlinkSync(artifact);
    symlinkSync(options.signingKeyFile, artifact);

    await expect(publishPlugin(options)).rejects.toThrow(
      "release artifact for linux-amd64 must be a regular file",
    );
    expect(readFileSync(join(dataDir, "catalog.json"), "utf8")).toBe(before);
  });

  test("caps chunked live responses while streaming", async () => {
    const { options, dataDir } = fixture();
    const before = readFileSync(join(dataDir, "catalog.json"), "utf8");
    options.liveState = undefined;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(64 * 1024 + 1));
            controller.close();
          },
        }),
        { status: 200 },
      )) as unknown as typeof fetch;

    try {
      await expect(publishPlugin(options)).rejects.toThrow(
        "live registry keyset exceeds the 65536-byte limit",
      );
      expect(readFileSync(join(dataDir, "catalog.json"), "utf8")).toBe(before);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("rejects a signed catalogue envelope larger than the client response cap", async () => {
    const { options, catalog, dataDir } = fixture();
    const makeDocument = (fillerLength: number) => ({
      schema_version: 1,
      revision: 1,
      issued_at: "2026-09-10T11:59:00.000Z",
      expires_at: "2026-10-09T11:59:00.000Z",
      plugins: [
        {
          name: "existing-plugin",
          version: "1.0.0",
          title: "Existing plugin",
          summary: "x".repeat(fillerLength),
          description: "Existing signed catalogue entry.",
          author: "Temps",
          category: "Utilities",
          keywords: [],
          repository: null,
          docs_url: null,
          logo_url: null,
          platforms: {},
        },
      ],
    });
    const serializedSize = (fillerLength: number) => {
      const candidate = envelope(
        CATALOG_DOMAIN,
        makeDocument(fillerLength),
        "catalog-test-1",
        catalog.privateKey,
      );
      return Buffer.byteLength(`${JSON.stringify(candidate)}\n`);
    };
    let low = 0;
    let high = 1024 * 1024;
    while (low + 1 < high) {
      const middle = Math.floor((low + high) / 2);
      if (serializedSize(middle) <= 1024 * 1024) low = middle;
      else high = middle;
    }
    const currentEnvelope = envelope(
      CATALOG_DOMAIN,
      makeDocument(low),
      "catalog-test-1",
      catalog.privateKey,
    );
    writeFileSync(
      join(dataDir, "catalog.json"),
      `${JSON.stringify(currentEnvelope)}\n`,
    );
    options.liveState = {
      keyset: options.liveState!.keyset,
      catalog: currentEnvelope,
    };
    const before = readFileSync(join(dataDir, "catalog.json"), "utf8");

    await expect(publishPlugin(options)).rejects.toThrow(
      "signed catalogue exceeds the 1048576-byte registry response limit",
    );
    expect(readFileSync(join(dataDir, "catalog.json"), "utf8")).toBe(before);
  });

  test("rejects unknown CLI flags instead of accidentally publishing", () => {
    expect(() =>
      parseArguments([
        "--manifest",
        "deployment-pulse-plugin/registry.json",
        "--artifacts-dir",
        "dist",
        "--registry-dir",
        "../temps-registry",
        "--key-id",
        "catalog-test-1",
        "--signing-key-file",
        "/secure/catalog.pem",
        "--dry-rnu",
        "true",
      ]),
    ).toThrow("unexpected argument --dry-rnu");
  });

  test("reports a stale publisher lock without removing it", async () => {
    const { options, dataDir } = fixture();
    const lockPath = join(dataDir, ".publish.lock");
    writeFileSync(lockPath, '{"pid":123,"created_at":"earlier"}\n', {
      mode: 0o600,
    });

    await expect(publishPlugin(options)).rejects.toThrow(
      "confirm no publisher is running before removing the lock",
    );
    expect(existsSync(lockPath)).toBe(true);
  });
});
