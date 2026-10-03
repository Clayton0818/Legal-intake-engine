// Tiny JSON body readers for the All-engines routes. Pure.

import { AllEnginesError } from "./errors";

export type Body = Record<string, unknown>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID.test(v);
}

export async function readBody(req: Request): Promise<Body> {
  let parsed: unknown;
  try {
    parsed = await req.json();
  } catch {
    throw new AllEnginesError("The request body must be JSON.", 400);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new AllEnginesError("The request body must be a JSON object.", 400);
  return parsed as Body;
}

export function reqString(body: Body, key: string): string {
  const v = body[key];
  if (typeof v !== "string" || !v.trim()) throw new AllEnginesError(`'${key}' is required.`);
  return v.trim();
}

export function optString(body: Body, key: string): string | null {
  const v = body[key];
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") throw new AllEnginesError(`'${key}' must be text.`);
  return v.trim() || null;
}

export function reqUuid(body: Body, key: string): string {
  const v = body[key];
  if (!isUuid(v)) throw new AllEnginesError(`'${key}' must be an id.`);
  return v;
}

export function reqStringList(body: Body, key: string): string[] {
  const v = body[key];
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) throw new AllEnginesError(`'${key}' must be a list of text values.`);
  return v as string[];
}

export function reqBool(body: Body, key: string): boolean {
  const v = body[key];
  if (typeof v !== "boolean") throw new AllEnginesError(`'${key}' must be true or false.`);
  return v;
}
