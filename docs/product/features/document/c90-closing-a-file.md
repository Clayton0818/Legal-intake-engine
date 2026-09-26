# c90 · Closing a file: final letter, return of papers, retention clock

**Card:** `c90` Document engine · Closing a file: final letter, return of papers, retention clock (Product, P2)

## 1. Summary

A matter closing checklist: final invoice done and the client's trust balance at zero, a closing letter to the client from a template, return of original documents, and a retention period after which the file may be destroyed, but only with a lawyer's approval. Closed matters stay in the conflict index (c56) permanently.

## 2. Users and problem

- **Responsible lawyer:** closing steps are skipped (no closing letter, originals left in a drawer, money left in trust).
- **Firm owner/admin:** needs to know when old files may be destroyed and proof that destruction was approved.
- **Former client:** needs their originals back and a clear end-of-representation letter.

## 3. Scope

**In scope**
- Closing checklist on a matter, run when the lawyer starts closing (c95 triggers it).
- Checks: final invoice (c79) issued and settled or written off; trust balance zero or a lawyer-recorded hold reason (c82); open tasks completed or cancelled with reason; future calendar events cancelled (c91); closing letter generated (c85), approved and delivered; originals returned or client instruction recorded.
- Setting `matters.closed_at` and `retention_years`, which drives `eligible_for_deletion_at` (existing trigger).
- Destruction review when the clock runs out; lawyer approval; destruction and tombstone.
- Reopening a closed matter.

**Out of scope**
- Refund calculation and trust movements (c82, c76).
- Invoice creation (c79).
- The firm-wide retention policy itself (c2).

## 4. Behaviour

1. **Start closing.** The lawyer clicks "Close matter" (or c95 reaches the closed stage). The closing checklist appears with each item's status and owner.
2. **Money items.** Final invoice status comes from c79/c81. Trust balance comes from c76; if not zero, c82's refund flow must finish or the lawyer records a hold reason (e.g. disputed amount). Until c75/c76 are live, the lawyer attests the trust balance is zero outside the product, with who and when recorded.
3. **Closing letter.** Generated from the firm's approved closing template (c85), reviewed and approved by the lawyer, delivered through the portal and the safe email address, or marked sent another way (c40 delivery tracking).
4. **Originals.** Every document flagged "original held" (c84) must be marked returned (method, date, recipient), kept at client's written instruction, or other with a reason.
5. **Retention period.** The lawyer confirms the retention period (default from firm setting by practice area). The system shows the date the file becomes eligible for destruction review.
6. **Close.** Only when all items are done or waived with a reason, an `attorney` confirms. In one transaction: `matters.stage` = `closed`, `closed_at` set, `retention_years` set (the existing trigger computes `eligible_for_deletion_at`), open client tasks closed with a neutral message, c56 party index marked "former client" and kept.
7. **Retention clock.** A `scheduled_tasks` row fires at `eligible_for_deletion_at` (real clock date). It creates a destruction review task for the responsible lawyer (or a firm-designated records attorney if that lawyer has left).
8. **Destruction review.** The reviewer sees: legal hold status (c2 §6), any client instructions, originals status, open disputes, and whether minors' orders exist (c103). Options: approve destruction, extend by N years with reason, or place on hold.
9. **Destroy.** On approval, the worker deletes the matter's stored files and content (documents, filed email, portal messages, intake answers) and keeps a tombstone: matter id, parties in the conflict index, open/close dates, who approved destruction and when. Audit events are kept under the audit log's own retention. Trust records are never destroyed by this flow; they follow the trust-record retention in the scope memo §3 (c76).
10. **Reopen.** An `attorney` can reopen with a reason: stage returns to `retained`, `closed_at` is cleared (the trigger clears `eligible_for_deletion_at`) and the pending destruction task is cancelled.

**Edge cases**
- Client asks for their file before or after closing: firm task to the lawyer; the product can export the matter's documents; the lawyer decides what goes out (Opinion 627 notes limits to protect other persons).
- Legal hold placed after closing: destruction review cannot approve; hold reason shown.
- Responsible lawyer has left the firm: review goes to the firm-designated records attorney.
- Physical originals cannot be located: the lawyer records it; the item can be waived only with a reason and the supervising lawyer is notified.
- Backups: destroyed content disappears from backups on the backup retention cycle; the tombstone records the expected purge date.

## 5. Business rules

1. A matter cannot close while the client's trust balance is above zero unless a lawyer records a hold reason (c82, c95).
2. Every checklist item must be done or waived with a logged reason before closing.
3. Only an `attorney` closes, reopens, or approves destruction.
4. Retention period: firm setting per practice area. **No product default is shipped** (proposed; open question 1); the firm must set one during setup, with guidance to decide with counsel and their malpractice carrier.
5. Nothing is destroyed automatically; destruction always needs a lawyer's approval at review time.
6. A legal hold blocks destruction approval.
7. Destruction deletes file content but keeps the tombstone and the conflict-index entries permanently (c56).
8. Trust account records are excluded from file destruction.
9. The closing letter is always a lawyer-approved template output; the AI does not write its legal content.
10. Every closing step, reopen, extension and destruction is logged in c6.
11. The retention clock uses the real calendar date, not business hours (it is a date, not a response timer).

## 6. Data model touchpoints

- **Reuse (existing):** `matters.stage` (`closed` value exists), `matters.closed_at`, `matters.retention_years`, `matters.eligible_for_deletion_at` with its trigger `matters_set_eligible_for_deletion`, index `matters_tenant_deletion_idx`, `scheduled_tasks`, `documents`, `parties`/`matter_parties`, audit trail (c6).
- **Proposed** `matters.legal_hold` (boolean) and `legal_hold_reason` (or a `legal_holds` table), as called for in c2 §6.
- **Proposed** `matter_closings` (matter_id, tenant_id, started_at, started_by, checklist jsonb with item status and waiver reasons, closed_by, closed_at).
- **Proposed** `document_originals` or a flag on `documents` (`is_original_held`, `returned_at`, `return_method`, `returned_to`).
- **Proposed** `matter_destructions` (matter_id, tenant_id, approved_by, approved_at, executed_at, backup_purge_expected_at, tombstone jsonb).

## 7. Notifications and visibility

- **Client:** closing letter in the portal and a minimal c51 email; portal access after closing: read-only for a firm-set period (proposed default 90 days), then closed. Client never sees retention or destruction information unless the letter states the firm's retention policy.
- **Lawyer:** closing checklist tasks (c45 rules), destruction review task, reopen notices.
- **Firm admin:** matters stuck in closing, upcoming destruction reviews on the ops queue (c37).

## 8. Dependencies

- **Needs:** c95 (closing stage trigger), c79/c81 (final invoice), c82 + c76 + c75 (trust at zero, refunds), c85 (closing letter), c84 (originals flag, deletion), c40 (delivery tracking), c91 (cancel events), c2 (retention and legal hold), c56 (conflict index kept), c6, c99.
- **Feeds:** c56 (former client status), c101 (reports), c63 (conflicts log).

## 9. Compliance and review flags

- **Retention period (attorney review):** Texas Ethics Opinion 627 says the Texas Disciplinary Rules do not themselves set a retention period for closed files, and permits destruction when time, the nature of the file and the absence of contrary client instructions justify a reasonable conclusion that destruction is not likely to harm the client's material interests, provided reasonable steps are taken to avoid destroying client property such as original documents. It also notes the client normally has the right to obtain the file. The product's lawyer-approved destruction review is designed around that; an attorney must confirm the review screen and the Family Law guidance (minors' orders).
- **Termination duties (attorney review):** Texas Rule 1.16(d) (declining or terminating representation) includes surrendering papers and property to which the client is entitled and refunding unearned advance fees; the closing checklist is meant to support, not replace, that duty.
- **Trust (attorney and CPA review):** trust balance at zero, hold reasons for disputed funds, and keeping trust records outside file destruction (Texas Rules of Disciplinary Procedure 17.10, five years after representation ends, per the scope memo §3). Advance fees belong in trust until earned (*Cluck*, 214 S.W.3d 736; Opinion 611).
- **Privacy (c2):** destruction and backup purge timing; legal hold override.
- **Conflicts (Rules 1.09, 1.10):** former-client data kept permanently in the conflict index even after destruction.

## 10. Acceptance criteria

1. Given a matter with a client trust balance of $300 and no hold reason, when the lawyer tries to close, then closing is blocked with "Trust balance must be zero or a hold reason recorded".
2. Given all checklist items done and retention of 5 years, when the lawyer closes on 2026-10-01, then stage is `closed` and `eligible_for_deletion_at` is 2031-10-01 via the existing trigger.
3. Given a document flagged as an original held, when the lawyer tries to close without marking it returned or waived with a reason, then closing is blocked.
4. Given `eligible_for_deletion_at` is reached, when the worker runs, then a destruction review task is created and nothing is deleted.
5. Given a matter under legal hold, when the reviewer opens the destruction review, then "Approve destruction" is disabled with the hold reason.
6. Given destruction is approved, when it runs, then documents and content are removed, the tombstone and conflict-index entries remain, and trust records are untouched.
7. Given a closed matter, when a lawyer reopens it with a reason, then `closed_at` and `eligible_for_deletion_at` are cleared and the pending review task is cancelled.
8. Given a firm has not set a retention period for Family Law, when a lawyer closes a Family Law matter, then they must enter one before closing.

## 11. Open questions for Clayton

1. Retention default: ship none and make the firm choose at setup (proposed), or suggest a value?
2. Family Law files with custody or support orders for minors: should the pack suggest a longer retention or a "review when youngest child turns 18" rule?
3. Physical originals: track only, or also generate a return receipt for the client to sign?
4. How long should the client keep read-only portal access after closing (proposed 90 days)?
