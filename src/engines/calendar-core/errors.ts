// Errors the calendar-core engine raises on purpose. Routes map them to HTTP
// statuses (see ./http.ts); anything else is a 500.

export class CalendarCoreError extends Error {
  constructor(
    message: string,
    readonly status: number = 422,
    readonly details: string[] = []
  ) {
    super(message);
    this.name = "CalendarCoreError";
  }
}

export function notFound(what: string): CalendarCoreError {
  return new CalendarCoreError(`${what} not found.`, 404);
}

export function forbidden(message: string): CalendarCoreError {
  return new CalendarCoreError(message, 403);
}

export function conflict(message: string, details: string[] = []): CalendarCoreError {
  return new CalendarCoreError(message, 409, details);
}

export function invalid(message: string, details: string[] = []): CalendarCoreError {
  return new CalendarCoreError(message, 422, details);
}
