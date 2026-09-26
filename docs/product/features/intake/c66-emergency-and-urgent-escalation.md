# c66 · Emergencies and time-sensitive matters go to a live person immediately

**Card:** `c66` Intake engine · Emergencies and time-sensitive matters go to a live person immediately (Product, P0)

## 1. Summary

Closes the gap c35 names: `safetyFlag` is hard-coded off in the mock classifier. This feature detects safety emergencies (domestic violence, threats, self-harm) and urgent legal situations (someone arrested or held now, a court date in the next few days, papers just served, an eviction or lockout today), and gets a live person involved at once. Safety emergencies get a 911 message, a DV-safe path and a staff alert; urgent legal matters page the on-call lawyer on the real clock with escalation if nobody acknowledges.

## 2. Users and problem

- **Prospective client in danger or under time pressure:** a chat bot that keeps asking intake questions is the wrong response.
- **On-call lawyer and staff:** need a clear, fast alert with just enough context to act.
- **Firm:** an unanswered emergency is the worst outcome for the person and a serious risk for the firm. Family Law (c103) makes DV signals common.

## 3. Scope

**In scope**
- Detection on every channel (c65), every message, from first contact.
- Two tracks: safety emergency, urgent legal.
- Deadline-risk flag to a lawyer only (e.g. incident long ago).
- On-call rota (firm-configurable) and real-clock escalation chain.
- DV-safe contact handling.

**Out of scope**
- Contacting police or emergency services on the person's behalf (the product tells the person to call 911; staff decide anything further).
- Telling anyone what their deadline is or whether they are too late (c44 rule).
- Crisis counselling by the AI.

## 4. Behaviour

**Detection**
1. Every inbound message runs through emergency detection (c35 classifier's `safetyFlag` plus an `urgency` category) and a firm-maintained keyword list as a backstop. Either one triggering counts (fail towards alerting).
2. Categories: `safety_dv`, `safety_threat`, `safety_self_harm`, `urgent_custody_or_arrest` (arrested/held now), `urgent_court_soon` (court date within the firm window), `urgent_served` (papers just served), `urgent_lockout` (eviction or lockout today), `deadline_risk` (possible time-bar, e.g. old incident).

**Safety track**
1. The AI immediately shows or says the firm's approved safety message: if you are in danger, call 911. Firm-approved crisis resources may follow (see compliance flags).
2. The AI asks one DV-safe question before any follow-up: is it safe to contact you at this number/email, and is there a safer way? Answer stored in contact preferences. Web chat shows a quick-exit button.
3. Staff alert fires at once (real clock) to the on-call staff member and on-call lawyer: in-app, email (c51, internal, minimal) and SMS/push to staff devices if configured.
4. Intake questions pause. If the person keeps writing, the AI acknowledges and says a person has been alerted. It does not ask for case details.
5. No follow-up message (c69 acknowledgement, c67 reminders, c70 follow-ups) goes to the person until safe-contact is confirmed.

**Urgent legal track**
1. AI acknowledges neutrally: "This sounds time-sensitive. I'm alerting a lawyer now." It never says whether anything is urgent in a legal sense or what will happen.
2. Page goes to the on-call lawyer from the rota, on the real clock (nights, weekends, holidays included).
3. Not acknowledged within the ack window (firm setting, default 15 minutes real time): page the backup lawyer; after a second window, page the firm owner/admin. Each step logged.
4. On phone during business hours: live transfer to staff/lawyer is attempted immediately (c65).
5. Acknowledgement = the lawyer clicks "I've got this" (in-app or link). It stops escalation; it does not by itself satisfy c69 human contact.

**Deadline risk**
1. If the facts suggest a time limit might matter (e.g. incident date long ago), a `deadline_risk` flag goes to the assigned or on-call lawyer (internal only). Business-hours clock unless combined with an urgent category.
2. The AI says nothing to the person about deadlines, limitations or being too late.

**Failure paths**
- Nobody acknowledges after the full chain: escalation repeats every ack window to the whole chain until acknowledged; the person is not told the firm failed; the session is marked `emergency_unacknowledged` for review.
- Rota empty for the current time: the page goes straight to the firm owner/admin and an internal flag says the rota has a gap. Rota gaps are also warned about 24 hours ahead.
- Detection false positive: staff can downgrade with a reason; logged. False positives are acceptable by design.
- Message delivery to staff fails: every channel is independent (c51); failures are logged and the next escalation step still fires.

## 5. Business rules

1. Detection runs on every inbound message on every channel, before disclosures complete.
2. Emergency routing runs on the real clock, never business hours.
3. The safety message (call 911) is shown before anything else once a safety category triggers.
4. The AI never tells a person their deadline, whether they are too late, or what legal step to take.
5. No outbound message to a safety-flagged person until safe-contact is confirmed (stored in contact preferences), and never to a channel they said is unsafe.
6. Firm-configurable: on-call rota (per day/time, primary and backup), ack window (default 15 min, minimum 5, maximum 30), urgent court window (default 3 calendar days), keyword list additions, crisis resources text.
7. Emergencies bypass the speed-to-lead queue (c69) and the unassigned queue (c48).
8. Every detection, message shown, page, acknowledgement, escalation and downgrade is logged in c6 with the detector (model or keyword) that fired.
9. Staff alerts carry minimal content: category, channel, a link. No case narrative in email or SMS to staff devices unless the firm opts in for internal emails (c51).
10. Detection being on cannot be disabled by a firm. Individual categories can be tuned but safety categories cannot be switched off.

## 6. Data model touchpoints

- **Reuse** `intake_sessions.classifier_output` (holds `safetyFlag`, urgency), `intake_events` (detections, pages, acks), `scheduled_tasks` (ack-window timers, `task_type = 'emergency_escalation'`, due in real time).
- **Proposed** `emergency_alerts` (id, tenant_id, intake_session_id, matter_id?, category, detector, raised_at, acknowledged_by, acknowledged_at, escalation_step, downgraded_by, downgrade_reason).
- **Proposed** `on_call_rota` (tenant_id, user_id, role `primary|backup`, starts_at, ends_at, recurrence).
- **Proposed** `contact_preferences` (party_id, safe_channels, unsafe_channels, safe_to_contact_confirmed_at, quiet_hours). Shared with c51, c69, c70.
- Existing `firm-config` keys `minimum_hearing_window_days` (14, diverts to review) and `urgent_capacity_sla_hours` (2) stay as they are; this card adds `emergency.urgent_court_window_days` and `emergency.ack_window_minutes`.

## 7. Notifications and visibility

- Person: safety message, safe-contact question, neutral acknowledgement. Never any internal flag, escalation state or deadline statement.
- On-call staff and lawyer: in-app, email (c51 internal) and optional SMS/push; escalation to backup and owner/admin.
- Deadline-risk: lawyer only.
- Ops queue (c37) shows open emergency alerts to firm admins.

## 8. Dependencies

- Needs: c35 (real classifier with `safetyFlag`), c65 (channels), c72 (the "not for emergencies, call 911" disclosure), c51 (delivery), c45 (task/flag mechanism), c34 (staff identities), rota UI.
- Feeds: c69 (bypass), c70 (suppression), c103 (Family Law pilot relies on it), c53.

## 9. Compliance and review flags

- **Attorney review (required before build):** detection categories and keyword lists; every script (safety message, safe-contact question, neutral acknowledgements) in English and Spanish (c36); confirm nothing reads as legal advice or a promise of representation.
- **Attorney review:** any crisis hotline numbers or resources the firm shows must be verified by the firm and approved; this spec does not include specific numbers.
- **Attorney review:** DV-safe practices (quick exit, no messages to shared devices, voicemail rules) against the firm's family-law practice.
- **Attorney review:** whether an unacknowledged emergency creates any duty to a prospective client under Rule 1.18, and what the firm should record.
- No trust money; no CPA review.

## 10. Acceptance criteria

1. Given a chat message "he just hit me and he's outside", when it is received, then the 911 safety message is shown before any other reply and the on-call staff and lawyer are alerted within 60 seconds.
2. Given a safety-flagged person who has not confirmed safe contact, when a c67 reminder or c70 follow-up would be sent, then it is suppressed and logged.
3. Given an urgent legal alert at 11 p.m. Saturday, when the on-call lawyer does not acknowledge within 15 minutes, then the backup lawyer is paged, and after another 15 minutes the firm owner/admin.
4. Given a person asks "am I too late to file?", when the AI replies, then it does not state any deadline or opinion and a `deadline_risk` flag goes to a lawyer.
5. Given no one is on the rota for Sunday, when Friday business hours end, then the firm admin receives a rota-gap warning.
6. Given staff downgrade a false-positive safety alert, when they save without a reason, then the save is refused.
7. Given any alert, when the client portal is viewed, then no escalation or alert status is visible.

## 11. Open questions for Clayton

1. Solo firms: who is the backup when the only lawyer is on call? Allow a non-lawyer staff member as backup for safety (not legal) alerts?
2. Should staff alerts go by SMS to personal phones (needs a vendor and staff consent) or in-app/email only in the pilot?
3. Urgent court window default: 3 calendar days proposed. Right for Texas family law?
