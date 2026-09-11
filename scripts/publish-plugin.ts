// SPDX-FileCopyrightText: 2024-2026 Temps Contributors
// SPDX-License-Identifier: MIT OR Apache-2.0

import {
  closeSync,
  chmodSync,
  constants,
  copyFileSync,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeSync,
  writeFileSync,
} from "node:fs";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomBytes,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";
import { dirname, join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";

const KEYSET_SIGNATURE_DOMAIN = Buffer.from("temps-plugin-keyset-v1\0");
const CATALOG_SIGNATURE_DOMAIN = Buffer.from("temps-plugin-catalog-v1\0");
const KEYSET_AUDIENCE = "registry.temps.sh/plugins";
const REGISTRY_ORIGIN = "https://registry.temps.sh";
const LIVE_KEYSET_URL = `${REGISTRY_ORIGIN}/api/plugins/keys`;
const LIVE_CATALOG_URL = `${REGISTRY_ORIGIN}/api/plugins`;
const MAX_BINARY_BYTES = 256 * 1024 * 1024;
const MAX_CATALOG_BYTES = 1024 * 1024;
const MAX_KEYSET_BYTES = 64 * 1024;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;
const MAX_KEYSET_VALIDITY_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_CATALOG_KEY_VALIDITY_MS = 400 * 24 * 60 * 60 * 1000;
const MAX_CATALOG_VALIDITY_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_CATALOG_KEYS = 16;
const ROOT_THRESHOLD = 2;
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

const OFFICIAL_ROOT_KEYS = new Map<string, string>([
  [
    "root-2026-1",
    "da1494970e3241d5c2f4fc7947d5318faa7b6cd8940cc41a0fa620dfcbe3454c",
  ],
  [
    "root-2026-2",
    "3f2e40fd1b75bce1bdd662d625948ab20a690f4e71ae81c4cc21a5cb8415a36f",
  ],
  [
    "root-2026-3",
    "d6c06311af2737cc509629d8a15b78897ba10d5662539ebf82afa7b77a3b855b",
  ],
]);

const PLATFORM_ARTIFACTS = [
  ["linux-amd64-gnu", "x86_64-linux-gnu"],
  ["linux-amd64-musl", "x86_64-linux-musl"],
  ["linux-arm64-gnu", "aarch64-linux-gnu"],
  ["linux-arm64-musl", "aarch64-linux-musl"],
  ["darwin-amd64", "x86_64-darwin"],
  ["darwin-arm64", "aarch64-darwin"],
] as const;

type JsonRecord = Record<string, unknown>;

export type PluginPublishManifest = {
  name: string;
  version: string;
  binary: string;
  title: string;
  summary: string;
  description: string;
  author: string;
  category: string;
  keywords?: string[];
  repository?: string | null;
  docs_url?: string | null;
  logo_url?: string | null;
};

type PlatformRelease = { url: string; sha256: string };

type RegistryPlugin = Omit<PluginPublishManifest, "binary"> & {
  platforms: Record<string, PlatformRelease>;
};

type CatalogDocument = {
  schema_version: number;
  revision: number;
  issued_at: string;
  expires_at: string;
  plugins: RegistryPlugin[];
};

type CatalogEnvelope = {
  key_id: string;
  payload: string;
  signature: string;
};

type CatalogKey = {
  key_id: string;
  algorithm: string;
  public_key: string;
  not_before: string;
  not_after: string;
  status: "active" | "verify_only" | "revoked";
};

type KeysetDocument = {
  schema_version: number;
  audience: string;
  generation: number;
  issued_at: string;
  expires_at: string;
  keys: CatalogKey[];
};

export type PublishOptions = {
  manifestPath: string;
  artifactsDir: string;
  registryDir: string;
  signingKeyFile: string;
  keyId: string;
  dryRun?: boolean;
  now?: Date;
  /** Test-only trust override. The CLI always uses the official root keys. */
  rootKeys?: ReadonlyMap<string, string>;
  /** Test-only live-state injection. The CLI always fetches registry.temps.sh. */
  liveState?: { keyset: unknown; catalog: unknown };
};

export type PublishResult = {
  plugin: string;
  version: string;
  revision: number;
  artifacts: Record<string, PlatformRelease>;
  catalogPath: string;
  dryRun: boolean;
};

export class PublishError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublishError";
  }
}

function fail(message: string): never {
  throw new PublishError(message);
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJson(path: string, label: string): unknown {
  try {
    const metadata = lstatSync(path);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      fail(`${label} at ${path} must be a regular file, not a symlink`);
    }
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail(`${label} at ${path} is not readable JSON: ${errorMessage(error)}`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function decodeCanonicalBase64(value: unknown, label: string): Buffer {
  if (typeof value !== "string" || value.length === 0) {
    fail(`${label} must be a non-empty base64 string`);
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) {
    fail(`${label} is not canonical base64`);
  }
  return decoded;
}

function publicKeyFromRawHex(rawHex: string, label: string): KeyObject {
  if (!/^[a-f0-9]{64}$/.test(rawHex)) {
    fail(`${label} must be a lowercase 32-byte hexadecimal Ed25519 key`);
  }
  return createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(rawHex, "hex")]),
    format: "der",
    type: "spki",
  });
}

function rawPublicKeyHex(key: KeyObject): string {
  const der = createPublicKey(key).export({ format: "der", type: "spki" });
  const encoded = Buffer.from(der);
  if (
    encoded.length !== ED25519_SPKI_PREFIX.length + 32 ||
    !encoded.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)
  ) {
    fail("catalogue signing key is not an Ed25519 key");
  }
  return encoded.subarray(ED25519_SPKI_PREFIX.length).toString("hex");
}

function parseDate(value: unknown, label: string): Date {
  if (typeof value !== "string") fail(`${label} must be an ISO-8601 timestamp`);
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()))
    fail(`${label} is not a valid timestamp`);
  return date;
}

function parseKeyset(
  value: unknown,
  now: Date,
  rootKeys: ReadonlyMap<string, string>,
): KeysetDocument {
  if (!isRecord(value) || !Array.isArray(value.signatures)) {
    fail("registry keyset envelope is malformed");
  }
  const payload = decodeCanonicalBase64(value.payload, "keyset payload");
  const message = Buffer.concat([KEYSET_SIGNATURE_DOMAIN, payload]);
  const validRoots = new Set<string>();
  for (const candidate of value.signatures) {
    if (!isRecord(candidate) || typeof candidate.key_id !== "string") continue;
    const rawKey = rootKeys.get(candidate.key_id);
    if (!rawKey || validRoots.has(candidate.key_id)) continue;
    try {
      const signature = decodeCanonicalBase64(
        candidate.signature,
        `root signature ${candidate.key_id}`,
      );
      if (
        verify(
          null,
          message,
          publicKeyFromRawHex(rawKey, `root key ${candidate.key_id}`),
          signature,
        )
      ) {
        validRoots.add(candidate.key_id);
      }
    } catch {
      // An invalid candidate does not count toward the independent root quorum.
    }
  }
  if (validRoots.size < ROOT_THRESHOLD) {
    fail(
      `registry keyset has ${validRoots.size} valid root signatures; ${ROOT_THRESHOLD} are required`,
    );
  }

  const document = readPayloadJson(payload, "registry keyset payload");
  if (
    document.schema_version !== 1 ||
    document.audience !== KEYSET_AUDIENCE ||
    !Number.isSafeInteger(document.generation) ||
    Number(document.generation) < 1 ||
    !Array.isArray(document.keys)
  ) {
    fail("registry keyset document is malformed");
  }
  const issuedAt = parseDate(document.issued_at, "keyset issued_at");
  const expiresAt = parseDate(document.expires_at, "keyset expires_at");
  if (issuedAt.getTime() > now.getTime() + MAX_CLOCK_SKEW_MS) {
    fail("registry keyset issued_at is more than five minutes in the future");
  }
  if (
    expiresAt.getTime() <= issuedAt.getTime() ||
    expiresAt.getTime() - issuedAt.getTime() > MAX_KEYSET_VALIDITY_MS
  ) {
    fail(
      "registry keyset validity must be positive and no longer than seven days",
    );
  }
  if (expiresAt.getTime() <= now.getTime()) {
    fail(`registry keyset expired at ${expiresAt.toISOString()}`);
  }

  if (document.keys.length === 0 || document.keys.length > MAX_CATALOG_KEYS) {
    fail(
      `registry keyset must contain between 1 and ${MAX_CATALOG_KEYS} catalogue keys`,
    );
  }
  const keyIds = new Set<string>();
  let activeKeys = 0;
  for (const candidate of document.keys) {
    if (
      !isRecord(candidate) ||
      typeof candidate.key_id !== "string" ||
      !validKeyId(candidate.key_id) ||
      candidate.algorithm !== "ed25519" ||
      typeof candidate.public_key !== "string" ||
      typeof candidate.not_before !== "string" ||
      typeof candidate.not_after !== "string" ||
      !["active", "verify_only", "revoked"].includes(String(candidate.status))
    ) {
      fail("registry keyset contains a malformed catalogue key");
    }
    if (keyIds.has(candidate.key_id)) {
      fail(
        `registry keyset contains duplicate catalogue key ID ${candidate.key_id}`,
      );
    }
    keyIds.add(candidate.key_id);
    publicKeyFromRawHex(
      candidate.public_key,
      `catalogue key ${candidate.key_id}`,
    );
    const notBefore = parseDate(
      candidate.not_before,
      `catalogue key ${candidate.key_id} not_before`,
    );
    const notAfter = parseDate(
      candidate.not_after,
      `catalogue key ${candidate.key_id} not_after`,
    );
    if (
      notAfter.getTime() <= notBefore.getTime() ||
      notAfter.getTime() - notBefore.getTime() > MAX_CATALOG_KEY_VALIDITY_MS
    ) {
      fail(`catalogue key ${candidate.key_id} has an invalid validity window`);
    }
    if (candidate.status === "active") activeKeys += 1;
  }
  if (activeKeys === 0) {
    fail("registry keyset does not contain an active catalogue key");
  }
  return document as unknown as KeysetDocument;
}

function validKeyId(keyId: string): boolean {
  return (
    keyId.length > 0 && keyId.length <= 128 && /^[A-Za-z0-9._-]+$/.test(keyId)
  );
}

function readPayloadJson(payload: Buffer, label: string): JsonRecord {
  try {
    const value = JSON.parse(payload.toString("utf8"));
    if (!isRecord(value)) fail(`${label} must contain a JSON object`);
    return value;
  } catch (error) {
    if (error instanceof PublishError) throw error;
    fail(`${label} is not valid JSON: ${errorMessage(error)}`);
  }
}

function parseCatalog(
  value: unknown,
  keyset: KeysetDocument,
  now: Date,
): CatalogDocument {
  if (
    !isRecord(value) ||
    typeof value.key_id !== "string" ||
    typeof value.signature !== "string"
  ) {
    fail("registry catalogue envelope is malformed");
  }
  const key = keyset.keys.find(
    (candidate) => candidate.key_id === value.key_id,
  );
  if (!key || key.status !== "active" || key.algorithm !== "ed25519") {
    fail(`existing catalogue key ${value.key_id} is not active in the keyset`);
  }
  const payload = decodeCanonicalBase64(value.payload, "catalogue payload");
  const signature = decodeCanonicalBase64(
    value.signature,
    "catalogue signature",
  );
  if (
    !verify(
      null,
      Buffer.concat([CATALOG_SIGNATURE_DOMAIN, payload]),
      publicKeyFromRawHex(key.public_key, `catalogue key ${key.key_id}`),
      signature,
    )
  ) {
    fail("existing catalogue signature is invalid");
  }
  const document = readPayloadJson(payload, "registry catalogue payload");
  if (
    document.schema_version !== 1 ||
    !Number.isSafeInteger(document.revision) ||
    Number(document.revision) < 1 ||
    !Array.isArray(document.plugins)
  ) {
    fail("registry catalogue document is malformed");
  }
  const issuedAt = parseDate(document.issued_at, "catalogue issued_at");
  const expiresAt = parseDate(document.expires_at, "catalogue expires_at");
  const keyNotBefore = parseDate(
    key.not_before,
    `catalogue key ${key.key_id} not_before`,
  );
  const keyNotAfter = parseDate(
    key.not_after,
    `catalogue key ${key.key_id} not_after`,
  );
  if (issuedAt < keyNotBefore || issuedAt >= keyNotAfter) {
    fail(
      `existing catalogue issuance is outside key ${key.key_id}'s validity window`,
    );
  }
  if (issuedAt.getTime() > now.getTime() + MAX_CLOCK_SKEW_MS) {
    fail(
      "existing catalogue issued_at is more than five minutes in the future",
    );
  }
  if (
    expiresAt.getTime() <= now.getTime() ||
    expiresAt.getTime() <= issuedAt.getTime() ||
    expiresAt.getTime() - issuedAt.getTime() > MAX_CATALOG_VALIDITY_MS
  ) {
    fail(
      "existing catalogue validity must be current and no longer than 30 days",
    );
  }
  return document as unknown as CatalogDocument;
}

function parseManifest(value: unknown): PluginPublishManifest {
  if (!isRecord(value))
    fail("plugin publishing manifest must be a JSON object");
  for (const field of [
    "name",
    "version",
    "binary",
    "title",
    "summary",
    "description",
    "author",
    "category",
  ]) {
    if (typeof value[field] !== "string" || value[field].trim().length === 0) {
      fail(
        `plugin publishing manifest field ${field} must be a non-empty string`,
      );
    }
    if ((value[field] as string).length > 4_096) {
      fail(`plugin publishing manifest field ${field} is too long`);
    }
  }
  const name = value.name as string;
  const version = value.version as string;
  const binary = value.binary as string;
  parseVersion(version);
  if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(name)) {
    fail(
      "plugin name must contain only lowercase ASCII letters, digits, and hyphens",
    );
  }
  if (!/^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/.test(binary)) {
    fail(
      "plugin binary name must contain only lowercase ASCII letters, digits, and hyphens",
    );
  }
  const keywords = value.keywords ?? [];
  if (
    !Array.isArray(keywords) ||
    !keywords.every(
      (keyword) => typeof keyword === "string" && keyword.trim().length > 0,
    )
  ) {
    fail("plugin publishing manifest keywords must be non-empty strings");
  }
  for (const field of ["repository", "docs_url", "logo_url"] as const) {
    const candidate = value[field] ?? null;
    if (candidate !== null && typeof candidate !== "string") {
      fail(
        `plugin publishing manifest field ${field} must be a string or null`,
      );
    }
    if (
      typeof candidate === "string" &&
      field !== "logo_url" &&
      !isHttpsUrl(candidate)
    ) {
      fail(`plugin publishing manifest field ${field} must use HTTPS`);
    }
    if (
      typeof candidate === "string" &&
      field === "logo_url" &&
      !isSafeLogoUrl(candidate)
    ) {
      fail(
        "plugin publishing manifest logo_url must be root-relative or use HTTPS",
      );
    }
  }
  return {
    name,
    version,
    binary,
    title: value.title as string,
    summary: value.summary as string,
    description: value.description as string,
    author: value.author as string,
    category: value.category as string,
    keywords: keywords as string[],
    repository: (value.repository as string | null | undefined) ?? null,
    docs_url: (value.docs_url as string | null | undefined) ?? null,
    logo_url: (value.logo_url as string | null | undefined) ?? null,
  };
}

function isHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" && url.username === "" && url.password === ""
    );
  } catch {
    return false;
  }
}

function isSafeLogoUrl(value: string): boolean {
  if (isHttpsUrl(value)) return true;
  if (
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("\\")
  ) {
    return false;
  }
  return !value
    .split("/")
    .some((segment) => segment === ".." || segment === ".");
}

type ParsedVersion = {
  core: [bigint, bigint, bigint];
  prerelease: string[] | null;
};

function parseVersion(value: string): ParsedVersion {
  const match =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(
      value,
    );
  if (!match || value.length > 64)
    fail(`plugin version ${value} is not valid SemVer`);
  const prerelease = match[4]?.split(".") ?? null;
  if (
    prerelease?.some(
      (identifier) =>
        /^\d+$/.test(identifier) &&
        identifier.length > 1 &&
        identifier.startsWith("0"),
    )
  ) {
    fail(`plugin version ${value} is not valid SemVer`);
  }
  return {
    core: [BigInt(match[1]), BigInt(match[2]), BigInt(match[3])],
    prerelease,
  };
}

function compareVersions(left: string, right: string): number {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (let index = 0; index < 3; index += 1) {
    if (a.core[index] !== b.core[index])
      return a.core[index] < b.core[index] ? -1 : 1;
  }
  if (a.prerelease === null) return b.prerelease === null ? 0 : 1;
  if (b.prerelease === null) return -1;
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = a.prerelease[index];
    const rightPart = b.prerelease[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    if (leftPart === rightPart) continue;
    const leftNumber = /^\d+$/.test(leftPart) ? BigInt(leftPart) : null;
    const rightNumber = /^\d+$/.test(rightPart) ? BigInt(rightPart) : null;
    if (leftNumber !== null && rightNumber !== null) {
      if (leftNumber === rightNumber) continue;
      return leftNumber < rightNumber ? -1 : 1;
    }
    if (leftNumber !== null) return -1;
    if (rightNumber !== null) return 1;
    return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}

function readSigningKey(path: string): KeyObject {
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    fail("catalogue signing key must be a regular file, not a symlink");
  }
  if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) {
    fail(
      "catalogue signing key permissions must not grant group or world access",
    );
  }
  const noFollow = constants.O_NOFOLLOW ?? 0;
  const descriptor = openSync(path, constants.O_RDONLY | noFollow);
  try {
    const opened = fstatSync(descriptor);
    if (
      !opened.isFile() ||
      opened.dev !== metadata.dev ||
      opened.ino !== metadata.ino
    ) {
      fail("catalogue signing key changed while it was being opened");
    }
    const key = createPrivateKey(readFileSync(descriptor));
    if (key.asymmetricKeyType !== "ed25519") {
      fail(
        "catalogue signing key must be an Ed25519 private key in PEM format",
      );
    }
    return key;
  } finally {
    closeSync(descriptor);
  }
}

function assertInside(root: string, path: string, label: string): void {
  if (path !== root && !path.startsWith(`${root}${sep}`)) {
    fail(`${label} resolves outside ${root}`);
  }
}

function isInside(root: string, path: string): boolean {
  return path === root || path.startsWith(`${root}${sep}`);
}

async function fetchJsonCapped(
  url: string,
  label: string,
  limit: number,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    fail(`${label} request to ${url} failed: ${errorMessage(error)}`);
  }
  if (!response.ok) fail(`${label} returned HTTP ${response.status}`);
  const contentLength = response.headers.get("content-length");
  const declaredLength = contentLength === null ? null : Number(contentLength);
  if (
    declaredLength !== null &&
    Number.isFinite(declaredLength) &&
    declaredLength > limit
  ) {
    fail(`${label} exceeds the ${limit}-byte limit`);
  }
  if (!response.body) fail(`${label} returned an empty response body`);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) {
        await reader.cancel();
        fail(`${label} exceeds the ${limit}-byte limit`);
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof PublishError) throw error;
    fail(
      `${label} response from ${url} failed while streaming: ${errorMessage(error)}`,
    );
  } finally {
    reader.releaseLock();
  }
  const bytes = Buffer.concat(chunks, length);
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    fail(`${label} is not valid JSON: ${errorMessage(error)}`);
  }
}

async function loadLiveState(): Promise<{ keyset: unknown; catalog: unknown }> {
  const [keyset, catalog] = await Promise.all([
    fetchJsonCapped(LIVE_KEYSET_URL, "live registry keyset", MAX_KEYSET_BYTES),
    fetchJsonCapped(
      LIVE_CATALOG_URL,
      "live registry catalogue",
      MAX_CATALOG_BYTES,
    ),
  ]);
  return { keyset, catalog };
}

function envelopePayload(value: unknown, label: string): string {
  if (!isRecord(value) || typeof value.payload !== "string") {
    fail(`${label} envelope is malformed`);
  }
  return value.payload;
}

function fsyncDirectory(path: string): void {
  const descriptor = openSync(path, constants.O_RDONLY);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function ensureDirectoryTree(root: string, segments: string[]): string {
  let current = root;
  for (const segment of segments) {
    current = join(current, segment);
    if (existsSync(current)) {
      const metadata = lstatSync(current);
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        fail(`artifact directory ${current} must be a real directory`);
      }
      continue;
    }
    mkdirSync(current, { mode: 0o755 });
    fsyncDirectory(dirname(current));
  }
  assertInside(root, realpathSync(current), "artifact destination");
  return current;
}

function copyOpenedArtifact(
  sourceDescriptor: number,
  destination: string,
  size: number,
): string {
  const hasher = createHash("sha256");
  const destinationDescriptor = openSync(
    destination,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    0o600,
  );
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let position = 0;
  try {
    while (position < size) {
      const bytesRead = readSync(
        sourceDescriptor,
        buffer,
        0,
        Math.min(buffer.length, size - position),
        position,
      );
      if (bytesRead === 0)
        fail("release artifact changed size while being staged");
      hasher.update(buffer.subarray(0, bytesRead));
      let written = 0;
      while (written < bytesRead) {
        written += writeSync(
          destinationDescriptor,
          buffer,
          written,
          bytesRead - written,
        );
      }
      position += bytesRead;
    }
    if (readSync(sourceDescriptor, buffer, 0, 1, position) !== 0) {
      fail("release artifact grew while being staged");
    }
    fsyncSync(destinationDescriptor);
  } finally {
    closeSync(destinationDescriptor);
  }
  return hasher.digest("hex");
}

function collectArtifacts(
  manifest: PluginPublishManifest,
  version: string,
  artifactsDir: string,
): {
  stagingDirectory: string;
  artifacts: Array<{
    platform: string;
    source: string;
    release: PlatformRelease;
  }>;
} {
  const root = realpathSync(artifactsDir);
  const stagingDirectory = mkdtempSync(join(tmpdir(), "temps-plugin-publish-"));
  chmodSync(stagingDirectory, 0o700);
  const releases = [];
  try {
    for (const [platform, suffix] of PLATFORM_ARTIFACTS) {
      const source = join(root, `${manifest.binary}-${suffix}`);
      const metadata = lstatSync(source);
      if (metadata.isSymbolicLink() || !metadata.isFile()) {
        fail(`release artifact for ${platform} must be a regular file`);
      }
      const descriptor = openSync(
        source,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      );
      const staged = join(stagingDirectory, platform);
      try {
        const opened = fstatSync(descriptor);
        if (
          !opened.isFile() ||
          opened.dev !== metadata.dev ||
          opened.ino !== metadata.ino
        ) {
          fail(`release artifact for ${platform} changed while it was opened`);
        }
        if (opened.size > MAX_BINARY_BYTES) {
          fail(`${source} exceeds the ${MAX_BINARY_BYTES}-byte plugin limit`);
        }
        const sha256 = copyOpenedArtifact(descriptor, staged, opened.size);
        chmodSync(staged, 0o400);
        releases.push({
          platform,
          source: staged,
          release: {
            url: `${REGISTRY_ORIGIN}/artifacts/${manifest.name}/${version}/${platform}/plugin`,
            sha256,
          },
        });
      } finally {
        closeSync(descriptor);
      }
    }
    return { stagingDirectory, artifacts: releases };
  } catch (error) {
    rmSync(stagingDirectory, { recursive: true, force: true });
    throw error;
  }
}

function copyArtifactAtomically(
  registryRoot: string,
  plugin: string,
  version: string,
  platform: string,
  source: string,
  expectedHash: string,
): void {
  const directory = ensureDirectoryTree(registryRoot, [
    "public",
    "artifacts",
    plugin,
    version,
    platform,
  ]);
  const destination = join(directory, "plugin");
  if (existsSync(destination)) {
    const metadata = lstatSync(destination);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      fail(`artifact destination ${destination} is not a regular file`);
    }
    const existingHash = createHash("sha256")
      .update(readFileSync(destination))
      .digest("hex");
    if (existingHash !== expectedHash) {
      fail(
        `immutable artifact already exists with different bytes: ${destination}`,
      );
    }
    return;
  }
  const temporary = join(
    directory,
    `.plugin-${randomBytes(8).toString("hex")}.tmp`,
  );
  try {
    copyFileSync(source, temporary, constants.COPYFILE_EXCL);
    chmodSync(temporary, 0o600);
    const copiedHash = createHash("sha256")
      .update(readFileSync(temporary))
      .digest("hex");
    if (copiedHash !== expectedHash)
      fail(`copied artifact hash changed for ${platform}`);
    writeFileModeAndSync(temporary, 0o444);
    linkSync(temporary, destination);
    unlinkSync(temporary);
    fsyncDirectory(directory);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function writeFileModeAndSync(path: string, mode: number): void {
  const descriptor = openSync(path, constants.O_RDWR);
  try {
    fchmodSync(descriptor, mode);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function writeCatalogAtomically(
  path: string,
  serializedEnvelope: string,
): void {
  const temporary = join(
    dirname(path),
    `.catalog-${randomBytes(8).toString("hex")}.tmp`,
  );
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o644,
    );
    writeFileSync(descriptor, serializedEnvelope);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, path);
    fsyncDirectory(dirname(path));
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporary, { force: true });
  }
}

function samePlugin(left: RegistryPlugin, right: RegistryPlugin): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function publishPluginLocked(
  options: PublishOptions,
): Promise<PublishResult> {
  const now = options.now ?? new Date();
  if (!Number.isFinite(now.getTime())) fail("publish time is invalid");

  const registryRoot = realpathSync(options.registryDir);
  const registryDataDir = join(registryRoot, "src", "registry-data");
  assertInside(
    registryRoot,
    realpathSync(registryDataDir),
    "registry data directory",
  );
  const keysetPath = join(registryDataDir, "keyset.json");
  const catalogPath = join(registryDataDir, "catalog.json");
  const manifest = parseManifest(
    readJson(resolve(options.manifestPath), "plugin manifest"),
  );
  const localKeysetEnvelope = readJson(keysetPath, "registry keyset");
  const keyset = parseKeyset(
    localKeysetEnvelope,
    now,
    options.rootKeys ?? OFFICIAL_ROOT_KEYS,
  );
  const localCatalogEnvelope = readJson(catalogPath, "registry catalogue");
  const currentCatalog = parseCatalog(localCatalogEnvelope, keyset, now);
  const liveState = options.liveState ?? (await loadLiveState());
  const liveKeyset = parseKeyset(
    liveState.keyset,
    now,
    options.rootKeys ?? OFFICIAL_ROOT_KEYS,
  );
  const liveCatalog = parseCatalog(liveState.catalog, liveKeyset, now);
  if (
    liveKeyset.generation !== keyset.generation ||
    envelopePayload(liveState.keyset, "live keyset") !==
      envelopePayload(localKeysetEnvelope, "local keyset")
  ) {
    fail(
      "local keyset does not exactly match the live verified registry keyset",
    );
  }
  if (
    liveCatalog.revision !== currentCatalog.revision ||
    envelopePayload(liveState.catalog, "live catalogue") !==
      envelopePayload(localCatalogEnvelope, "local catalogue")
  ) {
    fail(
      "local catalogue does not exactly match the live verified registry catalogue",
    );
  }

  const signingKeyPath = realpathSync(resolve(options.signingKeyFile));
  const publisherRoot = realpathSync(join(import.meta.dir, ".."));
  if (
    isInside(registryRoot, signingKeyPath) ||
    isInside(publisherRoot, signingKeyPath)
  ) {
    fail(
      "catalogue signing key must be stored outside the plugins and registry checkouts",
    );
  }
  const signingKey = readSigningKey(signingKeyPath);
  const catalogKey = keyset.keys.find((key) => key.key_id === options.keyId);
  if (!catalogKey || catalogKey.status !== "active") {
    fail(
      `catalogue key ${options.keyId} is not active in the root-signed keyset`,
    );
  }
  if (catalogKey.algorithm !== "ed25519") {
    fail(`catalogue key ${options.keyId} does not use Ed25519`);
  }
  if (rawPublicKeyHex(signingKey) !== catalogKey.public_key) {
    fail(`catalogue signing key does not match keyset entry ${options.keyId}`);
  }
  const notBefore = parseDate(
    catalogKey.not_before,
    "catalogue key not_before",
  );
  const notAfter = parseDate(catalogKey.not_after, "catalogue key not_after");
  if (now < notBefore || now >= notAfter) {
    fail(`catalogue key ${options.keyId} is outside its validity window`);
  }

  const staged = collectArtifacts(
    manifest,
    manifest.version,
    resolve(options.artifactsDir),
  );
  const artifacts = staged.artifacts;
  try {
    const platforms = Object.fromEntries(
      artifacts.map(({ platform, release }) => [platform, release]),
    );
    const { binary: _binary, ...publicManifest } = manifest;
    const plugin: RegistryPlugin = {
      ...publicManifest,
      platforms,
    };
    const existing = currentCatalog.plugins.find(
      (candidate) => candidate.name === manifest.name,
    );
    if (existing && compareVersions(manifest.version, existing.version) < 0) {
      fail(
        `refusing to replace ${manifest.name} ${existing.version} with older ${manifest.version}`,
      );
    }
    if (existing && compareVersions(manifest.version, existing.version) === 0) {
      if (!samePlugin(existing, plugin)) {
        fail(
          `refusing to change immutable release ${manifest.name} ${manifest.version}`,
        );
      }
      if (!options.dryRun) {
        for (const artifact of artifacts) {
          copyArtifactAtomically(
            registryRoot,
            manifest.name,
            manifest.version,
            artifact.platform,
            artifact.source,
            artifact.release.sha256,
          );
        }
      }
      return {
        plugin: manifest.name,
        version: manifest.version,
        revision: currentCatalog.revision,
        artifacts: platforms,
        catalogPath,
        dryRun: options.dryRun ?? false,
      };
    }

    const expiresAt = new Date(now.getTime() + 29 * 24 * 60 * 60 * 1000);
    const nextDocument: CatalogDocument = {
      schema_version: 1,
      revision: currentCatalog.revision + 1,
      issued_at: now.toISOString(),
      expires_at: expiresAt.toISOString(),
      plugins: [
        ...currentCatalog.plugins.filter(
          (candidate) => candidate.name !== manifest.name,
        ),
        plugin,
      ].sort((left, right) =>
        left.name < right.name ? -1 : left.name === right.name ? 0 : 1,
      ),
    };
    const payload = Buffer.from(JSON.stringify(nextDocument));
    if (payload.length > MAX_CATALOG_BYTES) {
      fail(`catalogue payload exceeds the ${MAX_CATALOG_BYTES}-byte limit`);
    }
    const signature = sign(
      null,
      Buffer.concat([CATALOG_SIGNATURE_DOMAIN, payload]),
      signingKey,
    );
    const envelope: CatalogEnvelope = {
      key_id: options.keyId,
      payload: payload.toString("base64"),
      signature: signature.toString("base64"),
    };
    const serializedEnvelope = `${JSON.stringify(envelope)}\n`;
    if (Buffer.byteLength(serializedEnvelope) > MAX_CATALOG_BYTES) {
      fail(
        `signed catalogue exceeds the ${MAX_CATALOG_BYTES}-byte registry response limit`,
      );
    }
    if (options.dryRun) {
      return {
        plugin: manifest.name,
        version: manifest.version,
        revision: nextDocument.revision,
        artifacts: platforms,
        catalogPath,
        dryRun: true,
      };
    }

    for (const artifact of artifacts) {
      copyArtifactAtomically(
        registryRoot,
        manifest.name,
        manifest.version,
        artifact.platform,
        artifact.source,
        artifact.release.sha256,
      );
    }
    writeCatalogAtomically(catalogPath, serializedEnvelope);

    return {
      plugin: manifest.name,
      version: manifest.version,
      revision: nextDocument.revision,
      artifacts: platforms,
      catalogPath,
      dryRun: false,
    };
  } finally {
    rmSync(staged.stagingDirectory, { recursive: true, force: true });
  }
}

export async function publishPlugin(
  options: PublishOptions,
): Promise<PublishResult> {
  if (options.dryRun) return publishPluginLocked(options);

  const registryRoot = realpathSync(options.registryDir);
  const registryDataDir = realpathSync(
    join(registryRoot, "src", "registry-data"),
  );
  assertInside(registryRoot, registryDataDir, "registry data directory");
  const lockPath = join(registryDataDir, ".publish.lock");
  let lock: number;
  try {
    lock = openSync(
      lockPath,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
  } catch (error) {
    fail(
      `could not acquire publisher lock ${lockPath}: ${errorMessage(error)}. ` +
        "If a previous publisher crashed, confirm no publisher is running before removing the lock.",
    );
  }
  try {
    writeFileSync(
      lock,
      `${JSON.stringify({ pid: process.pid, created_at: new Date().toISOString() })}\n`,
    );
    fsyncSync(lock);
    return await publishPluginLocked(options);
  } finally {
    closeSync(lock);
    unlinkSync(lockPath);
  }
}

function usage(): string {
  return `Publish one signed plugin release into a temps-registry checkout.

Usage:
  bun scripts/publish-plugin.ts \\
    --manifest deployment-pulse-plugin/registry.json \\
    --artifacts-dir ./dist \\
    --registry-dir ../temps-registry \\
    --key-id catalog-2026-01 \\
    --signing-key-file /secure/catalog-ed25519.pem [--dry-run]

The version is read from the plugin manifest so the runtime and catalogue use
one source of truth. The signing key must be an Ed25519 PEM file with mode 0600;
its contents are never printed or copied. The registry checkout must already
contain a valid, root-signed keyset.json and signed catalog.json. This command
stages a local checkout only; production publication must use serialized,
protected deployment with compare-and-swap at the live commit boundary.`;
}

export function parseArguments(argv: string[]): PublishOptions | null {
  if (argv.includes("--help") || argv.includes("-h")) return null;
  const values = new Map<string, string>();
  let dryRun = false;
  const allowed = new Set([
    "--manifest",
    "--artifacts-dir",
    "--registry-dir",
    "--key-id",
    "--signing-key-file",
    "--dry-run",
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!allowed.has(argument)) fail(`unexpected argument ${argument}`);
    if (argument === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (!argument.startsWith("--")) fail(`unexpected argument ${argument}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) fail(`missing value for ${argument}`);
    if (values.has(argument)) fail(`duplicate argument ${argument}`);
    values.set(argument, value);
    index += 1;
  }
  const required = [
    "--manifest",
    "--artifacts-dir",
    "--registry-dir",
    "--key-id",
    "--signing-key-file",
  ];
  for (const name of required) {
    if (!values.has(name)) fail(`missing required argument ${name}`);
  }
  return {
    manifestPath: values.get("--manifest")!,
    artifactsDir: values.get("--artifacts-dir")!,
    registryDir: values.get("--registry-dir")!,
    keyId: values.get("--key-id")!,
    signingKeyFile: values.get("--signing-key-file")!,
    dryRun,
  };
}

if (import.meta.main) {
  try {
    const options = parseArguments(process.argv.slice(2));
    if (!options) {
      process.stdout.write(`${usage()}\n`);
      process.exit(0);
    }
    const result = await publishPlugin(options);
    process.stdout.write(
      `${result.dryRun ? "Validated" : "Published"} ${result.plugin} ${result.version} ` +
        `at catalogue revision ${result.revision}\n`,
    );
    for (const [platform, release] of Object.entries(result.artifacts)) {
      process.stdout.write(`${platform} ${release.sha256} ${release.url}\n`);
    }
    process.stdout.write(`Catalogue: ${result.catalogPath}\n`);
  } catch (error) {
    process.stderr.write(`Plugin publish failed: ${errorMessage(error)}\n`);
    process.exit(1);
  }
}
