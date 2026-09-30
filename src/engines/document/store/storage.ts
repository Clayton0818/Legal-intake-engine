// Where document bytes live (c84). Code talks to an ObjectStorage adapter;
// the in-DB stub (encrypted rows in `document_blobs`) is used until the
// object-storage vendor is approved (vendor.object_storage: DPA + the storage
// ADR addendum). A real adapter registered with setObjectStorage() is only
// used for NEW writes once that gate is approved; reads always go to the
// adapter recorded on the file, so switching never strands old documents.

import { and, eq } from "drizzle-orm";
import { isApproved } from "@/compliance/approvals";
import { VENDOR_GATES } from "@/compliance/gates";
import { documentBlobs } from "@/db/tables/document";
import type { TenantTx } from "@/tenancy/withTenant";
import { sha256Hex } from "../common";
import { decryptBytes, encryptBytes } from "./crypto";

export interface StoredObject {
  storageKey: string;
  sha256: string;
  sizeBytes: number;
  /** 'aes-256-gcm' (applied here) or 'provider' (vendor-side). */
  encryption: string;
}

export interface ObjectStorage {
  readonly name: string;
  readonly isStub: boolean;
  put(tx: TenantTx, tenantId: string, storageKey: string, bytes: Uint8Array): Promise<StoredObject>;
  get(tx: TenantTx, tenantId: string, storageKey: string): Promise<Uint8Array | null>;
  delete(tx: TenantTx, tenantId: string, storageKey: string): Promise<void>;
}

/** STUB adapter: AES-256-GCM ciphertext in Postgres (RLS applies like any tenant table). */
export class InDbStubStorage implements ObjectStorage {
  readonly name = "in_db_stub";
  readonly isStub = true;

  async put(tx: TenantTx, tenantId: string, storageKey: string, bytes: Uint8Array): Promise<StoredObject> {
    const sha256 = sha256Hex(bytes);
    const enc = encryptBytes(bytes);
    await tx.insert(documentBlobs).values({ tenantId, storageKey, ...enc, sizeBytes: bytes.byteLength, sha256 });
    return { storageKey, sha256, sizeBytes: bytes.byteLength, encryption: "aes-256-gcm" };
  }

  async get(tx: TenantTx, tenantId: string, storageKey: string): Promise<Uint8Array | null> {
    const [row] = await tx
      .select()
      .from(documentBlobs)
      .where(and(eq(documentBlobs.tenantId, tenantId), eq(documentBlobs.storageKey, storageKey)))
      .limit(1);
    if (!row) return null;
    const bytes = decryptBytes(row);
    if (sha256Hex(bytes) !== row.sha256) throw new Error(`Stored document ${storageKey} failed its integrity check.`);
    return bytes;
  }

  async delete(tx: TenantTx, tenantId: string, storageKey: string): Promise<void> {
    await tx.delete(documentBlobs).where(and(eq(documentBlobs.tenantId, tenantId), eq(documentBlobs.storageKey, storageKey)));
  }
}

const stub = new InDbStubStorage();
const adapters = new Map<string, ObjectStorage>([[stub.name, stub]]);
let preferred: ObjectStorage | null = null;

/** Register the vendor adapter (after the storage ADR addendum). */
export function setObjectStorage(adapter: ObjectStorage | null): void {
  preferred = adapter;
  if (adapter) adapters.set(adapter.name, adapter);
}

/** Adapter for new writes: the vendor one only when vendor.object_storage is approved. */
export function storageForWrite(): ObjectStorage {
  if (preferred && !preferred.isStub && isApproved(VENDOR_GATES.objectStorage.key)) return preferred;
  return stub;
}

export function storageByName(name: string): ObjectStorage {
  const a = adapters.get(name);
  if (!a) throw new Error(`No storage adapter named '${name}' is registered.`);
  return a;
}

/** Unguessable, tenant-prefixed key. */
export function newStorageKey(tenantId: string, matterId: string): string {
  return `t/${tenantId}/m/${matterId}/${crypto.randomUUID()}`;
}
