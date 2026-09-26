# c51 — Every flag also sends an email to the affected party, separate from the in-app notification

**Card:** c51 · Calendar & deadline engine · P1 · Product
**Status:** Draft spec. Applies to every flag on the board (c40–c50 and later ones).

## 1. Summary

Every flag produces two independent deliveries: an in-app notification and an email to whoever the flag affects. The email is deliberately minimal, sent from the firm's own domain to a DV-safe address the client chose, and its delivery (sent, delivered, bounced) is logged so a flag never silently goes nowhere.

## 2. Users and problem

- **Clients** do not live in the portal; without email they miss what the firm needs from them.
- **Lawyers, admins, firm owners** also work from their inbox.
- **Clients at risk** (family law, domestic violence) can be endangered by a message landing in a shared or monitored inbox.
- Problem: in-app notifications alone are missed; careless email leaks confidential information and can put a client at risk.

## 3. Scope

**In scope**
- The delivery pipeline for all flags: recipient resolution, two independent deliveries, templates, contact preferences, quiet hours, sender identity, reply routing, delivery tracking, bounce handling, digests for non-urgent internal flags.
- Client safe-email address and per-flag-type email opt-out.
- The subprocessor/DPA gate for the email provider.

**Out of scope**
- Choosing the email vendor (founder decision, open question).
- SMS (each card that wants SMS carries its own TCPA review; see c42).
- The content of each flag (owned by the flag's card); c51 owns the envelope and the minimal-content rule.
- Client updates' own content rules (c54), which reuse this pipeline.

## 4. Behaviour

1. A flag is raised by any card. The flag carries `visibility` (internal or client) and its affected parties.
2. Recipient resolution:
   - Internal flag → firm users named by the flag (owner, supervising lawyer, admin, firm owner). Never a client.
   - Client-facing flag (c42, c46, c49, c50) → the client party on the matter, via their `contact_preferences`. Never the opposing party or any non-client party. The firm-side copy of the same flag goes to firm users as an internal flag.
3. For each recipient, two jobs are written in one transaction: an in-app `notifications` row, and an `outbox` row (`destination = 'email'`). They are processed separately; a failure in one does not block or roll back the other.
4. Email checks before sending, in order:
   a. Client has email turned off for this flag type (or the lawyer turned it off for this matter) → `suppressed`, logged; in-app still delivered.
   b. No safe email on file → `suppressed`, and an internal flag "client has no safe email" goes to the lawyer.
   c. Quiet hours (client-side only) → held until quiet hours end, then sent.
   d. Urgent flag (deadline-related, c44; deadline-linked, c45) → sent immediately; internal urgent emails ignore digests.
   e. Non-urgent internal flag and the firm chose digests → added to the recipient's daily digest instead.
5. Send from the firm's own verified domain, display name = firm name. Reply-To routes replies into the matter as an inbound message (which starts c43's clock) or, if the firm prefers, to the responsible lawyer's inbox.
6. Provider callbacks update `email_deliveries`: sent → delivered, or bounced/complained/failed. Each transition is logged in the audit trail.
7. Bounce to a client → internal flag to the responsible lawyer ("email to client bounced; confirm a safe address"), shown in-app and emailed to the lawyer. Bounce to a firm user → flag to firm admin.
8. Provider down → outbox retries with backoff (existing `outbox.attempts`, `last_error`); after the retry limit the row becomes `failed` and the firm admin is flagged in-app.

**Edge cases**
- Same flag escalates to a new level → a new email only for new recipients at that level; existing recipients are not re-emailed for the same flag unless the level is urgent.
- A client has several open flags in one day → each is delivered in-app; emails are coalesced to at most **3 per client per day** (firm setting) except urgent ones. (Proposed; open question 3.)
- A client changes their safe email while emails are queued → queued client emails re-resolve the address at send time.
- Client asks to stop all emails → honoured; the lawyer sees "client has opted out of email" on the matter.

## 5. Business rules

1. Every flag produces an in-app notification and, unless suppressed by rule 4a–4b, an email. Neither depends on the other.
2. Internal-only flags (c43, c44, c45, c47, c48, c53, and firm-side copies of c42/c46) never email a client. Testable: recipient resolver returns no party ids for internal flags.
3. Client email content is limited to: firm name, "there is an update on your matter" (or the flag's minimal action line, e.g. "a document is waiting for you"), and a portal link. No case facts, no party names, no court names, no amounts beyond what the flag strictly needs (c50 replenishment amount is the one allowed amount, and only if the firm keeps that option on).
4. Client email subject lines are generic and never contain the matter name, case type or opposing party (a subject line shows on lock screens).
5. Internal email detail: **firm setting, default minimal** (matter reference number + flag type + link). The firm may choose "include summary".
6. Quiet hours for clients: **firm default 20:00–08:00 client local time**, client can narrow or widen it. Internal emails are not subject to client quiet hours.
7. Digest for non-urgent internal flags: **firm setting, default off**; when on, sent daily at a firm-set time.
8. Sender is always the firm's verified domain. No client email is sent from an unverified domain (default; open question 2).
9. Every send, delivery, bounce, complaint and suppression is logged in the audit trail.
10. The email provider is a subprocessor: no real client data may flow through it until it is on the subprocessor list and a DPA is signed (c10 §3.5; ADR-0001 D9-style gate). Until then, synthetic data only.
11. For matters marked family law or DV-sensitive (c103), the client's email preference defaults to "safe address required" and "no email for sensitive flags" is offered at portal activation.

## 6. Data model touchpoints

- **Reuse:** `outbox` (existing: `destination`, `operation`, `payload`, `status`, `attempts`, `last_error`, `sent_at`) as the send queue; `parties.email` (existing) is *not* assumed safe and is only a starting value the client must confirm.
- **Proposed:** `notifications`, `email_deliveries`, `contact_preferences` (safe_email, safe_email_confirmed_at, email_enabled, disabled_flag_types[], quiet_hours, time_zone, sms_consent_evidence), firm sender-domain verification status in firm settings.
- **Firm config:** `email.internal_detail`, `email.digest`, `email.client_daily_cap`, `email.default_quiet_hours`, `email.reply_routing`.
- **Audit:** delivery events per README gap note.

## 7. Notifications and visibility

- Clients get client-facing flags only, minimal content, safe address, quiet hours respected.
- Firm users get internal flags and the firm-side copy of client flags, detail per firm setting.
- Bounces are visible to the responsible lawyer (client bounces) and the admin (user bounces). Clients never see delivery status of internal emails.

## 8. Dependencies

- **Needs first:** email vendor chosen and DPA signed (c10); c34 (who firm users and client principals are); c6 audit; the `flags` model from c45; c11 portal for the link target; firm domain verification in onboarding.
- **Feeds:** every flag card: c40, c41, c42, c43, c44, c45, c46, c47, c48, c49, c50, c52, c53, c54, c64.

## 9. Compliance and review flags (licensed Texas attorney)

- Confidentiality (TDRPC 1.05): approve the minimal-content rule and the list of what may appear in a client email and subject line; confirm internal-email detail options are acceptable.
- DV safety: approve the safe-address flow, the defaults for family-law matters (c103), and what the lawyer should be told when a client has no safe address.
- Whether any client emails count as advertising/solicitation or need specific content (the card treats them as transactional notices to the firm's own clients); flag for review rather than assume.
- Retention of delivery logs (c2).
- Subprocessor list and DPA terms (c10).
- No trust money: no CPA review (the c50 replenishment amount is displayed, not computed, here).

## 10. Acceptance criteria

1. **Given** an internal c45 overdue flag, **when** it is raised, **then** firm users receive an in-app notification and an email, and no email is queued for any party.
2. **Given** the email provider is failing, **when** a client-facing c46 flag is raised, **then** the in-app portal notification still appears immediately and the email retries, ending as `failed` with the admin flagged.
3. **Given** a client email is sent, **then** its subject and body contain no matter name, opposing party, court or case facts, and include a portal link.
4. **Given** a client's quiet hours are 20:00–08:00 and a non-urgent client flag is raised at 22:15, **then** the email is sent at 08:00 and the in-app notification appears at 22:15.
5. **Given** a client email bounces, **then** the bounce is logged and the responsible lawyer gets an internal flag in-app and by email.
6. **Given** the client turned off email for missing-document flags, **when** a c49 flag is raised, **then** the email is `suppressed` (logged) and the portal shows the flag.
7. **Given** a firm without a verified sender domain, **when** a client flag is raised, **then** no client email is sent and the admin sees "verify your email domain".

## 11. Open questions for Clayton

1. Which email provider? (It triggers the DPA/subprocessor gate.)
2. Unverified firm domain: block client emails (recommended) or send from a vendor subdomain with the firm's display name?
3. Cap on non-urgent client emails per day (proposed 3)?
4. Default reply routing: into the matter as a message (starts c43 clock), or to the lawyer's own inbox?
