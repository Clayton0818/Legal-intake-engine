# c91 — The matter calendar (P0)

## What it does
- Builds on the shared `calendar_events` table (no redefinition). Side tables: `calendar_event_parties` (people attached), `calendar_sync_connections`, `calendar_sync_links`.
- Views: firm-wide, per lawyer (assigned users), per matter, grouped into days in the firm's time zone (`GET /api/calendar-core/events?view=…`). Proposed items are marked `needsConfirmation`.
- Confirmation queue: `GET /api/calendar-core/confirmations`.
- Rules (`calendar/events.ts`): AI suggestions, court notices (c64), calculator results (c92), imports and external-sync events always start `proposed`. A lawyer's own entry may be confirmed at once; staff entries wait. Deadlines and court dates: only an attorney confirms, cancels a confirmed one, or moves it without sending it back to `proposed`. Moving/cancelling a confirmed date needs a logged reason.
- A confirmed deadline creates a deadline-critical task (`calendar-core.deadline_due`, real clock) so c45 tracks it. Moving the event moves the task; an unconfirmed move keeps the earlier due time.
- Consult bookings (c67) written by the intake engine appear in every view without extra work.

## Sync (vendor-gated)
- `CalendarSyncProvider` interface + `StubCalendarSyncProvider`. While `vendor.calendar_sync` is pending, pending links are marked `held` with the visible placeholder; nothing is sent or fetched.
- Outbound payload is minimal (title, time, place, "[Proposed]" marker), never the description.
- Inbound events from a lawyer's own calendar come in as `proposed`, non-deadline busy time. External edits to events we pushed are logged and ignored: the product is the source of truth for court dates.

## Routes
`events` (GET/POST), `events/[id]` (GET/PATCH), `events/[id]/confirm|reschedule|cancel|parties`, `confirmations`, `sync/connections` (GET/POST), `sync/connections/[id]` (DELETE).

## Open
OAuth flow for connecting calendars is part of the vendor integration (only a secret-store `tokenRef` is stored).
