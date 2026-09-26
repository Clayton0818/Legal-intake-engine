# c65 · Intake from every channel lands in one intake record

**Card:** `c65` Intake engine · Intake from every channel lands in one intake record (Product, P0)

## 1. Summary

Today only the web chat (c23) feeds intake. This adds phone (AI answering or transcription after hours, live transfer to staff in business hours), web forms, the firm's intake email inbox, text messages, lawyer and client referrals, and walk-ins or calls entered by staff. Every channel produces the same `intake_sessions` record and runs the same disclosures (c72), conflict check (c58), triage (c13/c35) and emergency detection (c66), so nothing depends on how the person reached the firm.

## 2. Users and problem

- **Prospective client:** reaches the firm however is natural or safe for them (a DV survivor may only be able to text, or call from a friend's phone).
- **Intake staff:** today re-key phone and email inquiries, or they never reach the system, so they skip the conflict check and the audit trail.
- **Firm:** needs one queue, one set of reports (c74) and one compliance trail regardless of channel.

## 3. Scope

**In scope**
- Channel adapters: web chat (existing), web form, phone (inbound calls), intake email inbox, SMS, referral entry (lawyer or client referral), staff-entered walk-in / call.
- Call announcement and recording consent captured up front.
- Channel-neutral pipeline: identity, disclosures, minimal conflict info, conflict check, triage, fit rules (c73), human response clock (c69).
- Spanish callers routed per c36.
- Linking repeat contacts via c71 (suggest, never auto-merge).

**Out of scope**
- Outbound calling or texting to people who have not contacted the firm (see c70 and rule 9).
- Embeddable widget packaging (c38).
- Existing-client service requests (they are routed out via `existing_caller_handoff`, not new intake).
- Choosing vendors (open question); each vendor is gated on a DPA.

## 4. Behaviour

**Common pipeline (all channels)**
1. Contact arrives. Adapter creates or resumes an `intake_sessions` row with `channel` set and writes an `intake_events` row `contact_received`.
2. c71 checks name / phone / email for a likely existing record and suggests a link to staff. The flow continues on a new session until staff confirm.
3. Disclosures (c72) are presented in the channel's form (spoken, texted, emailed, on-screen) and each acknowledgement is stored.
4. Minimal conflict information (the person's name, the other party's name) is collected and c58 runs before case details are invited.
5. Emergency detection (c66) runs on every inbound message or utterance from step 1 onward, including before disclosures finish.
6. Triage, fit rules (c73), speed-to-lead clock (c69), assignment (c48), booking (c67) follow as for chat.

**Phone**
1. Business hours, staff available: call rings staff; the call is announced as possibly recorded and the caller is asked to agree before recording starts. Staff enter answers in the console against the same session.
2. Business hours, nobody answers within N rings (firm setting, default 5): the AI assistant answers, gives disclosures, and offers a live transfer attempt when staff free up, or completes intake.
3. After hours: the AI assistant answers. If the caller mentions an emergency, c66 applies (on-call lawyer paged on the real clock).
4. Recording consent refused: the call continues without recording or AI transcription; the AI or staff takes notes only, or the caller is offered a callback / web form. Nothing is recorded retroactively.
5. Call drops mid-intake: session stays open, marked `interrupted`; follow-up only per c70 rules.

**Web form**
1. The form shows the c72 disclosures and consent checkboxes before any free-text field.
2. Only conflict-minimum fields and contact details are required; a long free-text "tell us what happened" box is not shown before the conflict check (see compliance flag).

**Intake email inbox**
1. Firm forwards or connects its intake address. Each new thread creates a session.
2. The person may already have written case details before seeing any disclosure. The system sends an automatic reply with the disclosures and a link to continue, extracts only the conflict-minimum fields and contact details for processing, and marks the original message `unsolicited_details_received` for staff. The AI does not triage the body until the conflict check is clear (see compliance flag).

**SMS**
1. An inbound text starts a session. The first reply gives short disclosures and a link, and asks for separate consent before any further texts (c72). STOP (and firm-configured equivalents, including Spanish) ends texting immediately.
2. Before any reply, if the number is on the firm's do-not-text list, no text is sent and staff are flagged.

**Referral**
1. Staff record a referral: who referred, the referred person's name and any contact details given.
2. The system creates a session in state `referral_awaiting_contact`. By default the firm does not contact the referred person first; the session activates when that person contacts the firm (matched by c71), or when staff record that the person asked to be contacted.
3. Referral source is stored for c74.

**Staff-entered walk-in / call**
1. Staff open "New intake", pick channel `walk_in` or `phone_manual`, read the disclosures aloud (scripted) and tick that each was given, then enter answers.

**Failure paths**
- Channel vendor down: the adapter queues the inbound event via `outbox` retries; after 3 failures an internal flag goes to the firm admin (c47). Phone falls back to voicemail with the disclosure recording.
- Transcription fails: the recording (if consented) is kept and staff are asked to write up the call.

## 5. Business rules

1. Every channel writes to `intake_sessions`; there is no separate table per channel.
2. `intake_sessions.channel` takes one of: `web_chat`, `web_form`, `phone_ai`, `phone_staff`, `email`, `sms`, `referral`, `walk_in`, `phone_manual`.
3. Disclosures (c72) must be acknowledged before any case-detail question, on every channel. The stored acknowledgement records channel, time and text version.
4. Conflict-minimum data is collected and c58 is run before case details are invited, on every channel.
5. Recording starts only after consent is captured; if any party does not agree, no recording (firm cannot turn this off). Consent standard per state is an attorney question (see flags); default is all-party consent.
6. Live transfer during business hours (firm hours and holidays); ring timeout firm setting, default 5 rings.
7. Texts after the first reply require the separate SMS opt-in (c72); STOP on any channel ends texting, and c70 treats it as ending all follow-up.
8. Spanish: language detected or chosen at first contact; the session continues in Spanish per c36, including disclosures.
9. No channel initiates first contact. Referral sessions wait for the person (firm-configurable only after attorney review).
10. Voice, SMS, email-inbox and transcription vendors are subprocessors: no real client data flows until each has a signed DPA and is on the subprocessor list (ADR-0001 D9 gate).
11. Every inbound and outbound message is stored against the session and every automated decision is logged in c6.

## 6. Data model touchpoints

- **Reuse** `intake_sessions` (`channel`, `language`, `collected_answers`, `current_node`, `terminal_state`), `intake_events`, `parties` (`email`, `phone`), `outbox`, `scheduled_tasks`.
- **Proposed** check constraint or enum on `intake_sessions.channel` with the values in rule 2.
- **Proposed** `intake_messages` (id, tenant_id, intake_session_id, direction, channel, author_type `caller|ai|staff`, body_encrypted, vendor_message_id, created_at).
- **Proposed** `call_recordings` (or rows in the real `documents` table once the storage ADR addendum exists): session, storage key, consent event id, duration.
- **Proposed** `consents` (shared with c72): type (`recording`, `sms`, `privacy_notice`...), channel, text_version, given_at, withdrawn_at.
- **Proposed** `referrals` (session id, referrer party or user, referrer type `lawyer|client|other`, notes).

## 7. Notifications and visibility

- Staff see all channels in one queue with a channel icon; transcripts and recordings are visible to firm roles only.
- The prospective client sees only their own messages on their channel. Nothing about conflict results, routing or internal flags.
- Vendor outages and failed deliveries: internal flag to firm admin, emailed per c51.

## 8. Dependencies

- Needs: c72 (disclosures and consent capture), c58/c3 (conflict check), c13/c35 (triage), c66 (emergency detection), c71 (repeat contacts), c36 (Spanish), c34 (staff auth for console entry), storage ADR addendum (recordings), vendor DPAs.
- Feeds: c69, c70, c73, c48, c67, c74 (source per channel), c47.

## 9. Compliance and review flags

- **Attorney review:** call-recording consent. Rules differ by state (some require every party to agree); callers may be outside Texas. Recommend all-party consent by default; attorney to confirm.
- **Attorney review:** TCPA consent for texts. Confirm that replying in the same conversation to someone who texted the firm first is acceptable, and what the separate opt-in must say.
- **Attorney review:** Rule 1.18 and unsolicited detail. Email and forms can deliver case details before the conflict check; confirm the handling in section 4 (minimise, do not triage until clear, keep limited) is adequate and how such information interacts with 1.18 screening.
- **Attorney review:** referrals. Whether the firm contacting a referred person first is solicitation (c1 §4 on Penal Code § 38.12 is research, itself pending review). Default here is wait for the person.
- **Attorney review:** AI voice disclosure that the caller is speaking with an automated assistant (c72 wording).
- No trust money; no CPA review.

## 10. Acceptance criteria

1. Given a person texts the firm's number, when the session starts, then an `intake_sessions` row with `channel = 'sms'` exists and the first reply contains the disclosures link and the text opt-in question.
2. Given an after-hours call, when the AI answers, then it states the call may be recorded and asks for agreement before recording; if the caller says no, then no audio is stored and the session is marked `recording_declined`.
3. Given an email to the intake inbox containing case details, when it is processed, then an auto-reply with disclosures is sent, only name/other-party/contact fields are extracted, and the body is not sent to the triage classifier until the conflict result is clear.
4. Given sessions from web chat, phone and email for the same person, when staff open the queue, then c71 suggests linking them and none are merged without a staff click.
5. Given a staff-entered walk-in, when staff try to enter case facts before ticking all disclosures, then the fields are locked.
6. Given a caller who says someone is threatening them right now, when the phrase is detected on any channel, then the c66 emergency path starts immediately.
7. Given a referral recorded by staff, when no contact from the referred person has occurred, then no message is sent to them.
8. Given a Spanish-speaking caller, when they choose Spanish, then disclosures and questions continue in Spanish.

## 11. Open questions for Clayton

1. Should the AI answer only after hours, or also as overflow during business hours when staff don't pick up?
2. Which voice/SMS and transcription vendors should go through the DPA gate first?
3. Referrals: keep "wait for the person to contact us" as the default until attorney review (recommended)?
4. Should the firm's main phone line be connected, or only a dedicated intake number, in the pilot?
