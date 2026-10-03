// Errors the Document engine raises on purpose. Routes map them to HTTP
// statuses (see ./http.ts); anything else is a 500.

export class DocumentError extends Error {
  constructor(
    message: string,
    readonly status: number = 422,
    readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "DocumentError";
  }
}

export class NotFoundError extends DocumentError {
  constructor(what: string) {
    super(`${what} not found.`, 404);
    this.name = "NotFoundError";
  }
}

/**
 * Access refused. `reason` is a machine code that is logged in
 * document_access_log; the message shown to the user never says WHY a
 * screened matter is hidden (a screen's existence can itself be confidential).
 */
export class DocumentAccessDeniedError extends DocumentError {
  constructor(readonly reason: string) {
    super("You do not have access to this document.", 403, { reason });
    this.name = "DocumentAccessDeniedError";
  }
}
