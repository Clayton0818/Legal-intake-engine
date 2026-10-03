import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { InMemoryApprovalSource, PendingApprovalError, refreshApprovals, resetApprovalStateForTests, setApprovalSource } from "@/compliance/approvals";
import {
  LocalDiskStorageAdapter,
  MemoryStorageAdapter,
  STORAGE_VENDOR_GATE,
  StorageObjectMissingError,
  StubMalwareScanner,
  StubOcrAdapter,
  adaptersFromEnv,
  assertSafeKey,
  decryptBlob,
  encryptBlob,
  gateStorage,
  type StorageAdapter,
} from "./adapters";
import "../gates";

const bytes = new TextEncoder().encode("Final Decree of Divorce — confidential");
const meta = { contentType: "text/plain", sha256: "0".repeat(64) };

describe("assertSafeKey", () => {
  it("accepts generated keys and refuses traversal", () => {
    expect(() => assertSafeKey("t/abc/m/def/g/1/v1-x")).not.toThrow();
    expect(() => assertSafeKey("../etc/passwd")).toThrow();
    expect(() => assertSafeKey("/abs")).toThrow();
    expect(() => assertSafeKey("a//b")).toThrow();
    expect(() => assertSafeKey("a/../b")).toThrow();
  });
});

describe("MemoryStorageAdapter", () => {
  it("stores, returns copies, and never overwrites", async () => {
    const s = new MemoryStorageAdapter();
    await s.put("k1", bytes, meta);
    expect(await s.exists("k1")).toBe(true);
    const got = await s.get("k1");
    expect(Buffer.from(got).toString()).toBe(Buffer.from(bytes).toString());
    got[0] = 0;
    expect((await s.get("k1"))[0]).toBe(bytes[0]);
    await expect(s.put("k1", bytes, meta)).rejects.toThrow("overwrite");
    await expect(s.get("missing")).rejects.toBeInstanceOf(StorageObjectMissingError);
  });
});

describe("encryption at rest", () => {
  it("round-trips and detects tampering", () => {
    const key = randomBytes(32);
    const blob = encryptBlob(bytes, key);
    expect(Buffer.from(blob).includes(Buffer.from("Divorce"))).toBe(false);
    expect(Buffer.from(decryptBlob(blob, key)).toString()).toBe(Buffer.from(bytes).toString());
    blob[blob.length - 1] = blob[blob.length - 1]! ^ 0xff;
    expect(() => decryptBlob(blob, key)).toThrow();
    expect(() => decryptBlob(encryptBlob(bytes, key), randomBytes(32))).toThrow();
  });
});

describe("LocalDiskStorageAdapter", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "doc-store-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("writes encrypted files and reads them back", async () => {
    const s = new LocalDiskStorageAdapter(dir, randomBytes(32));
    const r = await s.put("t/a/m/b/v1-c", bytes, meta);
    expect(r.encryption).toBe("aes-256-gcm");
    const raw = await readFile(path.join(dir, "t/a/m/b/v1-c"));
    expect(raw.includes(Buffer.from("Divorce"))).toBe(false);
    expect(Buffer.from(await s.get("t/a/m/b/v1-c")).toString()).toBe(Buffer.from(bytes).toString());
    await expect(s.put("t/a/m/b/v1-c", bytes, meta)).rejects.toThrow("overwrite");
    await expect(s.get("t/a/missing")).rejects.toBeInstanceOf(StorageObjectMissingError);
  });

  it("refuses a short key", () => {
    expect(() => new LocalDiskStorageAdapter(dir, randomBytes(8))).toThrow("32-byte");
  });
});

describe("stubs say what they did not do", () => {
  it("scanner reports not_scanned, OCR reports not_available", async () => {
    expect((await new StubMalwareScanner().scan()).status).toBe("not_scanned");
    expect((await new StubOcrAdapter().recognize()).status).toBe("not_available");
  });
});

describe("vendor gate", () => {
  beforeEach(() => resetApprovalStateForTests());
  afterEach(() => resetApprovalStateForTests());

  const vendor = (): StorageAdapter & { calls: number } => {
    const inner = new MemoryStorageAdapter();
    const v = {
      name: "acme",
      kind: "vendor" as const,
      calls: 0,
      put: async (k: string, b: Uint8Array) => {
        v.calls++;
        return inner.put(k, b);
      },
      get: async (k: string) => inner.get(k),
      exists: async (k: string) => inner.exists(k),
    };
    return v;
  };

  it("blocks a vendor adapter while vendor.object_storage is pending", async () => {
    const v = vendor();
    await expect(gateStorage(v).put("k", bytes, meta)).rejects.toBeInstanceOf(PendingApprovalError);
    expect(v.calls).toBe(0);
  });

  it("lets it through once every reviewer approved", async () => {
    const src = new InMemoryApprovalSource();
    src.approve({ gateKey: STORAGE_VENDOR_GATE, reviewerKind: "vendor_dpa", approvedByName: "Test" });
    src.approve({ gateKey: STORAGE_VENDOR_GATE, reviewerKind: "founder_decision", approvedByName: "Test" });
    setApprovalSource(src);
    await refreshApprovals();
    const v = vendor();
    await gateStorage(v).put("k", bytes, meta);
    expect(v.calls).toBe(1);
  });

  it("leaves internal adapters ungated", async () => {
    const m = new MemoryStorageAdapter();
    expect(gateStorage(m)).toBe(m);
  });
});

describe("adaptersFromEnv", () => {
  it("defaults to memory outside production and refuses it in production", () => {
    expect(adaptersFromEnv({}).storage.name).toBe("memory");
    expect(() => adaptersFromEnv({ NODE_ENV: "production" })).toThrow("not allowed in production");
  });
  it("needs a dir and a 32-byte key for local, and an override in production", () => {
    const key = randomBytes(32).toString("base64");
    expect(adaptersFromEnv({ DOCUMENT_STORAGE: "local", DOCUMENT_STORAGE_DIR: "/tmp/x", DOCUMENT_STORAGE_KEY: key }).storage.name).toBe("local");
    expect(() => adaptersFromEnv({ DOCUMENT_STORAGE: "local", DOCUMENT_STORAGE_DIR: "/tmp/x", DOCUMENT_STORAGE_KEY: "short" })).toThrow("32");
    expect(() => adaptersFromEnv({ DOCUMENT_STORAGE: "local", DOCUMENT_STORAGE_KEY: key })).toThrow("DIR");
    expect(() => adaptersFromEnv({ NODE_ENV: "production", DOCUMENT_STORAGE: "local", DOCUMENT_STORAGE_DIR: "/x", DOCUMENT_STORAGE_KEY: key })).toThrow();
    expect(
      adaptersFromEnv({ NODE_ENV: "production", DOCUMENT_STORAGE: "local", DOCUMENT_STORAGE_DIR: "/x", DOCUMENT_STORAGE_KEY: key, DOCUMENT_STORAGE_ALLOW_LOCAL: "1" })
        .storage.name
    ).toBe("local");
    expect(() => adaptersFromEnv({ DOCUMENT_STORAGE: "s3" })).toThrow("No vendor adapter");
  });
});
