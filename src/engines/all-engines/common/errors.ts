// Errors the All-engines services throw for the routes to map to HTTP.

import { PendingApprovalError } from "@/compliance/approvals";
import { PermissionDeniedError } from "../permissions/policy";

export const ENGINE = "all-engines" as const;

/** A refused request with a readable message and an HTTP status (400/404/409/422). */
export class AllEnginesError extends Error {
  constructor(
    message: string,
    readonly status: number = 422,
    readonly details?: string[]
  ) {
    super(message);
    this.name = "AllEnginesError";
  }
}

export interface MappedError {
  status: number;
  body: Record<string, unknown>;
}

/** Errors a route turns into a response itself (so audit rows for refusals are committed). null = unexpected (500). */
export function mapHandledError(err: unknown): MappedError | null {
  if (err instanceof PendingApprovalError) {
    return { status: 423, body: { error: "pending_approval", gate: err.gateKey, pendingReviewers: err.pendingReviewers, message: err.placeholder } };
  }
  if (err instanceof PermissionDeniedError) {
    return { status: 403, body: { error: err.message, right: err.decision.right, reason: err.decision.reason } };
  }
  if (err instanceof AllEnginesError) {
    return { status: err.status, body: { error: err.message, ...(err.details ? { details: err.details } : {}) } };
  }
  return null;
}
