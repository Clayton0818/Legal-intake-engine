// Application-level encryption for the in-DB stub storage adapter (c84:
// "encrypted"). AES-256-GCM; key from DOCUMENT_STORE_KEY (32 bytes, base64).
// Outside production a fixed development key is used so local work needs no
// setup; in production a missing key is a hard error (never store plaintext).

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

export interface EncryptedBlob {
  ciphertext: string; // base64
  iv: string; // base64
  authTag: string; // base64
  keyId: string;
}

interface Key {
  id: string;
  bytes: Buffer;
}

type Env = { DOCUMENT_STORE_KEY?: string; DOCUMENT_STORE_KEY_ID?: string; NODE_ENV?: string };

export function resolveStoreKey(env: Env = process.env as Env): Key {
  const raw = env.DOCUMENT_STORE_KEY?.trim();
  if (raw) {
    const bytes = Buffer.from(raw, "base64");
    if (bytes.byteLength !== 32) throw new Error("DOCUMENT_STORE_KEY must be 32 bytes, base64-encoded.");
    return { id: env.DOCUMENT_STORE_KEY_ID?.trim() || "k1", bytes };
  }
  if (env.NODE_ENV === "production") throw new Error("DOCUMENT_STORE_KEY is not set: refusing to store documents without encryption.");
  return { id: "dev", bytes: createHash("sha256").update("legal-intake-engine/dev-only-document-store-key").digest() };
}

export function encryptBytes(plain: Uint8Array, key: Key = resolveStoreKey()): EncryptedBlob {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key.bytes, iv);
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  return { ciphertext: ciphertext.toString("base64"), iv: iv.toString("base64"), authTag: cipher.getAuthTag().toString("base64"), keyId: key.id };
}

export function decryptBytes(blob: EncryptedBlob, key: Key = resolveStoreKey()): Uint8Array {
  if (blob.keyId !== key.id) throw new Error(`Document was encrypted with key '${blob.keyId}', but key '${key.id}' is configured.`);
  const decipher = createDecipheriv("aes-256-gcm", key.bytes, Buffer.from(blob.iv, "base64"));
  decipher.setAuthTag(Buffer.from(blob.authTag, "base64"));
  return new Uint8Array(Buffer.concat([decipher.update(Buffer.from(blob.ciphertext, "base64")), decipher.final()]));
}
