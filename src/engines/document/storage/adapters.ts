// File storage, malware scanning and OCR sit behind interfaces (c84). The
// object-storage vendor is still an open decision (scope memo: storage ADR
// addendum), so the product ships two INTERNAL adapters that keep bytes on
// our own infrastructure and a gate wrapper that every VENDOR adapter must go
// through:
//
//   MemoryStorageAdapter    tests and local demos (per-process, lost on restart)
//   LocalDiskStorageAdapter development: AES-256-GCM encrypted files on disk
//   gateVendor(...)         any vendor adapter → requireApproval('vendor.object_storage') on EVERY call
//
// Malware scanning and OCR are vendor services too. Their stubs record
// "not scanned" / "OCR not available" instead of pretending; nothing is sent
// anywhere until the shared vendor.object_storage gate is approved.

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { requireApproval } from "@/compliance/approvals";
import { VENDOR_GATES } from "@/compliance/gates";

export type AdapterKind = "internal" | "vendor";

export interface PutResult {
  key: string;
  /** Encryption applied at rest (never the key itself). */
  encryption: string;
}

export interface StorageAdapter {
  readonly name: string;
  readonly kind: AdapterKind;
  put(key: string, bytes: Uint8Array, meta: { contentType: string; sha256: string }): Promise<PutResult>;
  get(key: string): Promise<Uint8Array>;
  exists(key: string): Promise<boolean>;
}

export type ScanStatus = "clean" | "infected" | "error" | "not_scanned";

export interface ScanResult {
  status: ScanStatus;
  /** Scanner's signature name or error text — internal only, never shown to clients. */
  detail?: string;
}

export interface MalwareScanner {
  readonly name: string;
  readonly kind: AdapterKind;
  scan(bytes: Uint8Array, meta: { contentType: string; sha256: string }): Promise<ScanResult>;
}

export type OcrResult = { status: "ok"; text: string; pageCount: number | null } | { status: "not_available"; detail: string };

export interface OcrAdapter {
  readonly name: string;
  readonly kind: AdapterKind;
  recognize(bytes: Uint8Array, contentType: string): Promise<OcrResult>;
}

/** Keys are produced by storageKeyFor(); anything else is refused (no path tricks). */
export function assertSafeKey(key: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9/_.-]{0,400}$/.test(key) || key.includes("..") || key.includes("//")) {
    throw new Error("Invalid storage key.");
  }
}

export class StorageObjectMissingError extends Error {
  constructor(key: string) {
    super(`Stored file not found (${key}).`);
    this.name = "StorageObjectMissingError";
  }
}

// ---------------------------------------------------------------------------
// Internal adapters
// ---------------------------------------------------------------------------

export class MemoryStorageAdapter implements StorageAdapter {
  readonly name = "memory";
  readonly kind = "internal" as const;
  private readonly objects = new Map<string, Uint8Array>();

  async put(key: string, bytes: Uint8Array, _meta?: { contentType: string; sha256: string }): Promise<PutResult> {
    assertSafeKey(key);
    if (this.objects.has(key)) throw new Error("Refusing to overwrite an existing object.");
    this.objects.set(key, new Uint8Array(bytes));
    return { key, encryption: "none-memory" };
  }

  async get(key: string): Promise<Uint8Array> {
    assertSafeKey(key);
    const v = this.objects.get(key);
    if (!v) throw new StorageObjectMissingError(key);
    return new Uint8Array(v);
  }

  async exists(key: string): Promise<boolean> {
    assertSafeKey(key);
    return this.objects.has(key);
  }

  /** Tests only: simulate corruption at rest. */
  tamper(key: string, bytes: Uint8Array): void {
    this.objects.set(key, bytes);
  }
}

const MAGIC = Buffer.from("LIEDOC1");

/** AES-256-GCM: MAGIC | iv(12) | tag(16) | ciphertext. Pure. */
export function encryptBlob(plain: Uint8Array, key: Buffer): Buffer {
  if (key.length !== 32) throw new Error("Encryption key must be 32 bytes.");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), body]);
}

export function decryptBlob(blob: Uint8Array, key: Buffer): Uint8Array {
  const buf = Buffer.from(blob);
  if (buf.length < MAGIC.length + 28 || !buf.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error("Not an encrypted document blob.");
  const iv = buf.subarray(MAGIC.length, MAGIC.length + 12);
  const tag = buf.subarray(MAGIC.length + 12, MAGIC.length + 28);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return new Uint8Array(Buffer.concat([decipher.update(buf.subarray(MAGIC.length + 28)), decipher.final()]));
}

/** Development storage: encrypted files under `dir`. Never overwrites. */
export class LocalDiskStorageAdapter implements StorageAdapter {
  readonly name = "local";
  readonly kind = "internal" as const;

  constructor(
    private readonly dir: string,
    private readonly key: Buffer
  ) {
    if (key.length !== 32) throw new Error("LocalDiskStorageAdapter needs a 32-byte key (DOCUMENT_STORAGE_KEY, base64).");
  }

  private file(key: string): string {
    assertSafeKey(key);
    const full = path.resolve(this.dir, key);
    if (!full.startsWith(path.resolve(this.dir) + path.sep)) throw new Error("Invalid storage key.");
    return full;
  }

  async put(key: string, bytes: Uint8Array, _meta?: { contentType: string; sha256: string }): Promise<PutResult> {
    const file = this.file(key);
    if (await this.exists(key)) throw new Error("Refusing to overwrite an existing object.");
    await mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
    await writeFile(tmp, encryptBlob(bytes, this.key), { flag: "wx" });
    await rename(tmp, file);
    return { key, encryption: "aes-256-gcm" };
  }

  async get(key: string): Promise<Uint8Array> {
    let blob: Buffer;
    try {
      blob = await readFile(this.file(key));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") throw new StorageObjectMissingError(key);
      throw err;
    }
    return decryptBlob(blob, this.key);
  }

  async exists(key: string): Promise<boolean> {
    try {
      await stat(this.file(key));
      return true;
    } catch {
      return false;
    }
  }
}

/** Stub scanner: no approved scanning vendor yet, so it says so instead of claiming "clean". */
export class StubMalwareScanner implements MalwareScanner {
  readonly name = "stub";
  readonly kind = "internal" as const;
  async scan(): Promise<ScanResult> {
    return { status: "not_scanned", detail: "No malware scanner approved yet (vendor.object_storage)." };
  }
}

/** Stub OCR: scanned files wait in 'ocr_pending' until an OCR vendor is approved. */
export class StubOcrAdapter implements OcrAdapter {
  readonly name = "stub";
  readonly kind = "internal" as const;
  async recognize(): Promise<OcrResult> {
    return { status: "not_available", detail: "No OCR service approved yet (vendor.object_storage)." };
  }
}

// ---------------------------------------------------------------------------
// Vendor gate
// ---------------------------------------------------------------------------

export const STORAGE_VENDOR_GATE = VENDOR_GATES.objectStorage.key;

function gate(action: string, tenantId: string | undefined): void {
  requireApproval(STORAGE_VENDOR_GATE, { action, tenantId });
}

/**
 * Wrap a VENDOR adapter so every call first requires the shared
 * vendor.object_storage gate. Internal adapters are returned unchanged.
 * A pending gate throws PendingApprovalError (routes answer 423).
 */
export function gateStorage(adapter: StorageAdapter, tenantId?: string): StorageAdapter {
  if (adapter.kind !== "vendor") return adapter;
  return {
    name: adapter.name,
    kind: adapter.kind,
    put: async (key, bytes, meta) => {
      gate("document.storage.put", tenantId);
      return adapter.put(key, bytes, meta);
    },
    get: async (key) => {
      gate("document.storage.get", tenantId);
      return adapter.get(key);
    },
    exists: async (key) => {
      gate("document.storage.exists", tenantId);
      return adapter.exists(key);
    },
  };
}

export function gateScanner(scanner: MalwareScanner, tenantId?: string): MalwareScanner {
  if (scanner.kind !== "vendor") return scanner;
  return {
    name: scanner.name,
    kind: scanner.kind,
    scan: async (bytes, meta) => {
      gate("document.scan", tenantId);
      return scanner.scan(bytes, meta);
    },
  };
}

export function gateOcr(ocr: OcrAdapter, tenantId?: string): OcrAdapter {
  if (ocr.kind !== "vendor") return ocr;
  return {
    name: ocr.name,
    kind: ocr.kind,
    recognize: async (bytes, contentType) => {
      gate("document.ocr", tenantId);
      return ocr.recognize(bytes, contentType);
    },
  };
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export interface DocumentAdapters {
  storage: StorageAdapter;
  scanner: MalwareScanner;
  ocr: OcrAdapter;
}

export interface StorageEnv {
  NODE_ENV?: string;
  DOCUMENT_STORAGE?: string;
  DOCUMENT_STORAGE_DIR?: string;
  DOCUMENT_STORAGE_KEY?: string;
  /** Operator override to allow the local-disk adapter outside development (e.g. a single-server pilot). */
  DOCUMENT_STORAGE_ALLOW_LOCAL?: string;
}

/**
 * Build adapters from the environment. Pure apart from constructing objects.
 * - DOCUMENT_STORAGE=local + DOCUMENT_STORAGE_DIR + DOCUMENT_STORAGE_KEY → encrypted local disk
 * - otherwise memory.
 * In production neither internal adapter is a real document store: memory is
 * refused outright, local disk only with DOCUMENT_STORAGE_ALLOW_LOCAL=1.
 */
export function adaptersFromEnv(env: StorageEnv = process.env): DocumentAdapters {
  const production = env.NODE_ENV === "production";
  const mode = (env.DOCUMENT_STORAGE ?? "memory").toLowerCase();
  let storage: StorageAdapter;
  if (mode === "local") {
    if (production && env.DOCUMENT_STORAGE_ALLOW_LOCAL !== "1") {
      throw new Error("Local-disk document storage is not allowed in production (set DOCUMENT_STORAGE_ALLOW_LOCAL=1 to override).");
    }
    if (!env.DOCUMENT_STORAGE_DIR) throw new Error("DOCUMENT_STORAGE_DIR is required for DOCUMENT_STORAGE=local.");
    const key = Buffer.from(env.DOCUMENT_STORAGE_KEY ?? "", "base64");
    if (key.length !== 32) throw new Error("DOCUMENT_STORAGE_KEY must be 32 random bytes, base64-encoded.");
    storage = new LocalDiskStorageAdapter(env.DOCUMENT_STORAGE_DIR, key);
  } else if (mode === "memory") {
    if (production) throw new Error("In-memory document storage is not allowed in production. Configure a storage adapter.");
    storage = new MemoryStorageAdapter();
  } else {
    throw new Error(`Unknown DOCUMENT_STORAGE '${mode}'. No vendor adapter is wired yet (storage ADR addendum pending).`);
  }
  return { storage, scanner: new StubMalwareScanner(), ocr: new StubOcrAdapter() };
}

let current: DocumentAdapters | null = null;

/** The process's adapters (lazily built from the environment). */
export function getDocumentAdapters(): DocumentAdapters {
  current ??= adaptersFromEnv();
  return current;
}

/** Tests / wiring: replace some or all adapters. Pass null to reset to the environment. */
export function setDocumentAdapters(next: Partial<DocumentAdapters> | null): void {
  if (next === null) {
    current = null;
    return;
  }
  const base = current ?? { storage: new MemoryStorageAdapter(), scanner: new StubMalwareScanner(), ocr: new StubOcrAdapter() };
  current = { ...base, ...next };
}

/** Adapters for one tenant's request, with vendor gates applied. */
export function gatedAdapters(tenantId: string, adapters: DocumentAdapters = getDocumentAdapters()): DocumentAdapters {
  return {
    storage: gateStorage(adapters.storage, tenantId),
    scanner: gateScanner(adapters.scanner, tenantId),
    ocr: gateOcr(adapters.ocr, tenantId),
  };
}
