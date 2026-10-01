// Errors raised by intake domain services. They extend HttpError so
// tenantRoute() turns them into the right status code; PendingApprovalError
// (from requireApproval) is mapped to 423 by tenantRoute() as well.

import { HttpError } from "@/tenancy/route";

/** 404: the record does not exist for this firm. */
export class IntakeNotFoundError extends HttpError {
  constructor(what: string) {
    super(404, `${what} not found.`);
    this.name = "IntakeNotFoundError";
  }
}

/** 403: the acting user's role may not do this. */
export class IntakeForbiddenError extends HttpError {
  constructor(message: string) {
    super(403, message);
    this.name = "IntakeForbiddenError";
  }
}

/** 409: a business rule refuses the action (with a reason a person can act on). */
export class IntakeRuleError extends HttpError {
  readonly details: Record<string, unknown>;
  constructor(message: string, details: Record<string, unknown> = {}) {
    super(409, message);
    this.name = "IntakeRuleError";
    this.details = details;
  }
}

/** 400: the input is malformed. */
export class IntakeValidationError extends HttpError {
  constructor(message: string) {
    super(400, message);
    this.name = "IntakeValidationError";
  }
}

/** Require a non-empty human reason (no silent overrides / downgrades). */
export function requireReason(reason: string | null | undefined, what: string): string {
  const r = reason?.trim();
  if (!r) throw new IntakeValidationError(`${what}: a reason is required and is logged.`);
  return r;
}
