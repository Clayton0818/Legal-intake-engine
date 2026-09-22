# integrations/

Practice-management-tool integration layer (board card `c5`). Drains the `outbox` table (`src/db/schema.ts`) — never calls an external system directly from request-handling code, per ADR-0001 §D6's transactional-outbox guarantee ("the record is written BEFORE the appointment is treated as booked").

`destination` values on `outbox` rows map to `firm-config.example.yaml`'s `systems` block (`intake_crm`, `client_portal`, `scheduling`, `overflow_reception`) — each becomes an adapter under this directory once `c5` is picked up.
