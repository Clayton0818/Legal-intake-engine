// Approval gates owned by the Intake engine (c14, c48, c65–c70, c73).
//
// Nothing here is approved. Every gate stays closed until a reviewer's
// sign-off is recorded (`npm run compliance -- approve …`). Until then:
//  - client-facing wording renders as a visible "[PENDING ATTORNEY REVIEW …]"
//    placeholder via legalCopy(), and outbound messages using it are HELD;
//  - rule gates make the gated action fail safe (blocked + logged).
// Drafts below are proposals for the reviewer, not approved wording and not
// legal advice. Shared vendor/rule gates (vendor.*, rules.trust_accounting …)
// are reused from src/compliance/gates.ts, never redefined here.

import { defineGate, type Gate } from "@/compliance/approvals";
import { NOTIFY_COPY_GATES, RULE_GATES, VENDOR_GATES } from "@/compliance/gates";

export { NOTIFY_COPY_GATES, RULE_GATES, VENDOR_GATES };

export type IntakeLanguage = "en" | "es";

/** Define an English gate plus its Spanish twin (c36). Returns both. */
function bilingual(def: {
  key: string;
  cardIds: string[];
  description: string;
  draft: string;
  draftEs: string;
}): { en: Gate; es: Gate } {
  return {
    en: defineGate({ key: def.key, cardIds: def.cardIds, reviewers: ["attorney"], description: def.description, draft: def.draft }),
    es: defineGate({
      key: `${def.key}_es`,
      cardIds: [...def.cardIds, "c36"],
      reviewers: ["attorney"],
      description: `${def.description} (Spanish)`,
      draft: def.draftEs,
    }),
  };
}

/** The gate key for a bilingual copy item in the given language. */
export function copyKeyFor(base: { en: Gate; es: Gate }, language: string | null | undefined): string {
  return language === "es" ? base.es.key : base.en.key;
}

// ---------------------------------------------------------------------------
// c65 — every channel
// ---------------------------------------------------------------------------

export const CHANNEL_COPY = {
  disclosure: bilingual({
    key: "copy.intake.channel_disclosure",
    cardIds: ["c65", "c72"],
    description: "Intake disclosures shown on every channel before any case-detail question",
    draft:
      "Subject: Before we continue — {firmName}\n\n" +
      "You are contacting {firmName}. Contacting us does not make us your lawyer, and nothing in this conversation is legal advice. " +
      "Please do not share details of your situation until we have checked that we can help you. " +
      "If you are in danger, call 911. You can continue here: {portalUrl}",
    draftEs:
      "Subject: Antes de continuar — {firmName}\n\n" +
      "Usted se está comunicando con {firmName}. Comunicarse con nosotros no nos convierte en su abogado y nada en esta conversación es asesoría legal. " +
      "Por favor no comparta detalles de su situación hasta que confirmemos que podemos ayudarle. " +
      "Si está en peligro, llame al 911. Puede continuar aquí: {portalUrl}",
  }),
  smsFirstReply: bilingual({
    key: "copy.intake.sms_first_reply",
    cardIds: ["c65", "c72"],
    description: "First reply to an inbound text: short disclosures, link, and a separate opt-in question for further texts",
    draft:
      "{firmName}: thanks for texting. This is not legal advice and does not make us your lawyer. Continue securely: {portalUrl}. " +
      "May we text you about your inquiry? Reply YES to agree or STOP to end texts.",
    draftEs:
      "{firmName}: gracias por su mensaje. Esto no es asesoría legal y no nos convierte en su abogado. Continúe de forma segura: {portalUrl}. " +
      "¿Podemos enviarle mensajes sobre su consulta? Responda SÍ para aceptar o ALTO para no recibir más mensajes.",
  }),
  recordingPrompt: bilingual({
    key: "copy.intake.recording_consent_prompt",
    cardIds: ["c65", "c72"],
    description: "Call announcement: automated assistant disclosure and request for recording consent (all-party default)",
    draft:
      "You have reached {firmName}. You are speaking with an automated assistant. This call may be recorded and transcribed so our team can follow up. " +
      "Do you agree to the call being recorded? Please say yes or no.",
    draftEs:
      "Se ha comunicado con {firmName}. Está hablando con un asistente automatizado. Esta llamada puede ser grabada y transcrita para que nuestro equipo pueda darle seguimiento. " +
      "¿Está de acuerdo con que se grabe la llamada? Por favor diga sí o no.",
  }),
  emailAutoReply: bilingual({
    key: "copy.intake.email_auto_reply",
    cardIds: ["c65", "c72"],
    description: "Automatic reply to a new email to the intake inbox (disclosures + link; no discussion of details sent)",
    draft:
      "Subject: We received your message — {firmName}\n\n" +
      "Thank you for contacting {firmName}. Contacting us does not make us your lawyer, and we have not yet reviewed your message. " +
      "Before we can discuss your situation we need to check that we are able to help. Please continue here: {portalUrl}\n\n" +
      "If you are in danger, call 911.",
    draftEs:
      "Subject: Recibimos su mensaje — {firmName}\n\n" +
      "Gracias por comunicarse con {firmName}. Comunicarse con nosotros no nos convierte en su abogado y aún no hemos revisado su mensaje. " +
      "Antes de hablar de su situación necesitamos confirmar que podemos ayudarle. Por favor continúe aquí: {portalUrl}\n\n" +
      "Si está en peligro, llame al 911.",
  }),
} as const;

export const CHANNEL_RULE_GATES = {
  smsConversationReply: defineGate({
    key: "rules.intake.sms_conversation_reply",
    cardIds: ["c65", "c72"],
    reviewers: ["attorney"],
    description: "TCPA: replying by text in the same conversation to someone who texted the firm first, before separate opt-in",
  }),
  unsolicitedDetailsTriage: defineGate({
    key: "rules.intake.unsolicited_details_triage",
    cardIds: ["c65"],
    reviewers: ["attorney"],
    description: "Rule 1.18: handling of case details received by email/form before the conflict check (minimise, triage only after clear)",
  }),
  referralOutreach: defineGate({
    key: "rules.intake.referral_outreach",
    cardIds: ["c65"],
    reviewers: ["attorney"],
    description: "Whether the firm may contact a referred person first (solicitation, Penal Code § 38.12 research pending review)",
  }),
} as const;

// ---------------------------------------------------------------------------
// c66 — emergencies
// ---------------------------------------------------------------------------

export const EMERGENCY_COPY = {
  safety911: bilingual({
    key: "copy.intake.safety_911",
    cardIds: ["c66"],
    description: "Safety message shown first when a safety emergency is detected (call 911)",
    draft: "If you are in danger right now, please call 911. We have alerted a member of our team.",
    draftEs: "Si está en peligro en este momento, por favor llame al 911. Hemos avisado a un miembro de nuestro equipo.",
  }),
  safeContactQuestion: bilingual({
    key: "copy.intake.safe_contact_question",
    cardIds: ["c66", "c103"],
    description: "DV-safe question: is it safe to contact you at this number/email, and is there a safer way?",
    draft: "Is it safe for us to contact you at this number or email? If not, please tell us a safer way to reach you.",
    draftEs: "¿Es seguro comunicarnos con usted a este número o correo? Si no, por favor díganos una forma más segura de contactarle.",
  }),
  urgentAcknowledgement: bilingual({
    key: "copy.intake.urgent_acknowledgement",
    cardIds: ["c66"],
    description: "Neutral acknowledgement for a time-sensitive message (no statement about urgency in a legal sense)",
    draft: "This sounds time-sensitive. I'm alerting a lawyer now.",
    draftEs: "Esto parece urgente. Estoy avisando a un abogado ahora.",
  }),
  personAlerted: bilingual({
    key: "copy.intake.person_alerted",
    cardIds: ["c66"],
    description: "Reply while intake questions are paused during an emergency: a person has been alerted",
    draft: "Thank you. A member of our team has been alerted and will contact you as soon as possible.",
    draftEs: "Gracias. Un miembro de nuestro equipo ha sido avisado y se comunicará con usted lo antes posible.",
  }),
} as const;

/**
 * Emergency detection phrase list (c66). Format: one line per category,
 * `category: phrase | phrase | …`. Matching is case- and accent-insensitive
 * on whole words. THIS LIST IS A DRAFT FOR ATTORNEY AND DOMAIN-EXPERT REVIEW.
 * While pending, detection still runs on the draft (it only ever pages staff:
 * fail towards alerting), and every detection records that the list was
 * unapproved; nothing client-facing depends on it without its own copy gate.
 */
export const EMERGENCY_DETECTION_GATE = defineGate({
  key: "rules.intake.emergency_detection",
  cardIds: ["c66", "c35"],
  reviewers: ["attorney"],
  description: "Emergency and urgent-matter detection categories and phrase list (English and Spanish)",
  draft: [
    "safety_dv: hit me | hits me | beat me | beating me | choked me | he hurt me | she hurt me | abusing me | abuses me | domestic violence | protective order | restraining order | me pegó | me golpea | violencia doméstica | orden de protección",
    "safety_threat: threatened to kill | going to kill me | he has a gun | she has a gun | outside my house | outside my door | following me | stalking me | me amenazó | me va a matar | tiene una pistola",
    "safety_self_harm: kill myself | end my life | suicide | hurt myself | want to die | matarme | suicidio | quiero morir",
    "urgent_custody_or_arrest: was arrested | been arrested | in jail | being held | took my kids | taken my children | won't return my child | kidnapped | lo arrestaron | está en la cárcel | se llevó a mis hijos",
    "urgent_court_soon: court tomorrow | hearing tomorrow | court today | hearing today | court this week | hearing this week | audiencia mañana | corte mañana",
    "urgent_served: just served | was served | got served | served with papers | me entregaron papeles | me notificaron",
    "urgent_lockout: locked me out | changed the locks | evicted today | eviction today | me dejaron afuera | cambiaron la cerradura",
    "deadline_risk: years ago | too late | statute of limitations | deadline passed | missed the deadline | hace años | demasiado tarde",
  ].join("\n"),
});

// ---------------------------------------------------------------------------
// c67 — consultation booking
// ---------------------------------------------------------------------------

export const BOOKING_COPY = {
  confirmation: defineGate({
    key: "copy.intake.consult_confirmation",
    cardIds: ["c67"],
    reviewers: ["attorney"],
    description: "Consultation booking confirmation (states a booked consult does not create an attorney-client relationship)",
    draft:
      "Subject: Your consultation with {firmName} is booked\n\n" +
      "Your consultation is booked. The date, time and how to join are in your secure portal: {portalUrl}\n\n" +
      "Booking a consultation does not make {firmName} your lawyer. You can reschedule or cancel from the portal.",
  }),
  reminder: defineGate({
    key: "copy.intake.consult_reminder",
    cardIds: ["c67"],
    reviewers: ["attorney"],
    description: "Consultation reminder (no case facts; reschedule/cancel link)",
    draft:
      "Subject: Reminder: your consultation with {firmName}\n\n" +
      "This is a reminder of your upcoming consultation. Details and reschedule/cancel options: {portalUrl}",
  }),
  changed: defineGate({
    key: "copy.intake.consult_changed",
    cardIds: ["c67"],
    reviewers: ["attorney"],
    description: "Notice that a consultation was rescheduled or cancelled (no reason details)",
    draft:
      "Subject: Your consultation with {firmName} has changed\n\n" +
      "There is a change to your consultation. Please see your secure portal for details: {portalUrl}",
  }),
  rebookOffer: defineGate({
    key: "copy.intake.consult_rebook_offer",
    cardIds: ["c67"],
    reviewers: ["attorney"],
    description: "Single re-book offer after a missed consultation (no pressure language)",
    draft:
      "Subject: We missed you — {firmName}\n\n" +
      "We were sorry to miss you. If you would still like a consultation, you can choose a new time here: {portalUrl}",
  }),
  followUpLater: defineGate({
    key: "copy.intake.booking_follow_up_later",
    cardIds: ["c67"],
    reviewers: ["attorney"],
    description: "Shown instead of booking slots when booking cannot be offered yet (no reason given)",
    draft: "Thank you. A member of our team will follow up with you about next steps.",
  }),
} as const;

export const BOOKING_RULE_GATES = {
  consultFeeTerms: defineGate({
    key: "rules.intake.consult_fee_terms",
    cardIds: ["c67", "c75"],
    reviewers: ["attorney", "cpa"],
    description: "Paid consultation terms: operating vs trust destination, refunds, what the fee covers",
  }),
  videoMeetings: defineGate({
    key: "vendor.intake.video_meetings",
    cardIds: ["c67"],
    reviewers: ["vendor_dpa"],
    description: "Video-meeting provider for consultations (subprocessor)",
  }),
} as const;

// ---------------------------------------------------------------------------
// c68 — open matter
// ---------------------------------------------------------------------------

export const OPEN_MATTER_GATES = {
  openGates: defineGate({
    key: "rules.intake.matter_open_gates",
    cardIds: ["c68"],
    reviewers: ["attorney"],
    description: "The gates that must be met before a matter opens (when representation begins)",
  }),
  retainerAttestation: defineGate({
    key: "rules.intake.retainer_attestation",
    cardIds: ["c68", "c75"],
    reviewers: ["attorney", "cpa"],
    description: "Pre-c75 staff attestation that a retainer was deposited to trust outside the product; what counts as 'received'",
  }),
  portalInvite: defineGate({
    key: "copy.intake.portal_invite",
    cardIds: ["c68", "c11"],
    reviewers: ["attorney"],
    description: "Client portal invitation sent when a matter opens",
    draft:
      "Subject: Your secure client portal — {firmName}\n\n" +
      "{firmName} has set up a secure client portal for you. Please sign in here: {portalUrl}",
  }),
  matterOpened: defineGate({
    key: "copy.intake.matter_opened",
    cardIds: ["c68", "c54"],
    reviewers: ["attorney"],
    description: "First client update after the lawyer opens the matter",
    draft:
      "Subject: Your matter with {firmName} is open\n\n" +
      "Your matter is now open. Your next steps and updates will appear in your secure portal: {portalUrl}",
  }),
} as const;

// ---------------------------------------------------------------------------
// c69 — speed to lead
// ---------------------------------------------------------------------------

export const SPEED_TO_LEAD_COPY = {
  aiAcknowledgement: bilingual({
    key: "copy.intake.ai_acknowledgement",
    cardIds: ["c69"],
    description: "Immediate AI acknowledgement of a new inquiry (does not promise a time; does not imply representation)",
    draft: "Thank you for contacting us. A member of our team will contact you.",
    draftEs: "Gracias por comunicarse con nosotros. Un miembro de nuestro equipo se comunicará con usted.",
  }),
} as const;

// ---------------------------------------------------------------------------
// c70 — follow-up sequences
// ---------------------------------------------------------------------------

export const FOLLOW_UP_GATES = {
  outreach: defineGate({
    key: "rules.intake.follow_up_outreach",
    cardIds: ["c70", "c1", "c17"],
    reviewers: ["attorney"],
    description: "Automated follow-ups to people who contacted the firm first (barratry § 38.12, Texas Part VII advertising, TCPA)",
  }),
  personalInjury: defineGate({
    key: "rules.intake.follow_up_personal_injury",
    cardIds: ["c70"],
    reviewers: ["attorney"],
    description: "Follow-ups for personal-injury inquiries (§ 38.12 31-day rule research pending review)",
  }),
  stopConfirmation: defineGate({
    key: "copy.intake.follow_up_stop_confirmation",
    cardIds: ["c70"],
    reviewers: ["attorney"],
    description: "Single confirmation that follow-up messages have stopped",
    draft: "{firmName}: you will not receive further follow-up messages about this inquiry.",
  }),
} as const;

export const FOLLOW_UP_TEMPLATES = {
  abandoned_chat: defineGate({
    key: "copy.intake.follow_up_abandoned_chat",
    cardIds: ["c70"],
    reviewers: ["attorney"],
    description: "Follow-up to someone who stopped part-way through intake (no case facts, no pressure, how to stop)",
    draft:
      "Subject: You started an inquiry with {firmName}\n\n" +
      "You recently started an inquiry with {firmName}. If you would like to continue, you can pick up where you left off: {portalUrl}\n\n" +
      "If you do not want further messages, reply STOP.",
  }),
  not_booked: defineGate({
    key: "copy.intake.follow_up_not_booked",
    cardIds: ["c70"],
    reviewers: ["attorney"],
    description: "Follow-up to someone who completed intake but has not booked (no case facts, no pressure, how to stop)",
    draft:
      "Subject: Booking your consultation with {firmName}\n\n" +
      "You recently contacted {firmName}. If you would like to book a consultation, you can choose a time here: {portalUrl}\n\n" +
      "If you do not want further messages, reply STOP.",
  }),
  not_signed: defineGate({
    key: "copy.intake.follow_up_not_signed",
    cardIds: ["c70"],
    reviewers: ["attorney"],
    description: "Follow-up to someone who had a consultation and has an agreement waiting (no pressure, how to stop)",
    draft:
      "Subject: Your documents from {firmName}\n\n" +
      "There are documents waiting for you in your secure portal: {portalUrl}\n\n" +
      "If you do not want further messages, reply STOP.",
  }),
} as const;

// ---------------------------------------------------------------------------
// c73 — case acceptance
// ---------------------------------------------------------------------------

export const ACCEPTANCE_GATES = {
  autoDecline: defineGate({
    key: "rules.intake.auto_decline",
    cardIds: ["c73", "c62"],
    reviewers: ["attorney", "founder_decision"],
    description: "Which fit-rule types may decline a prospect automatically without a lawyer",
  }),
  declineNotice: defineGate({
    key: "copy.intake.decline_notice",
    cardIds: ["c73", "c62"],
    reviewers: ["attorney"],
    description: "Non-engagement notice for a declined inquiry (neutral, no merits, time limits may apply)",
    draft:
      "Subject: Your inquiry with {firmName}\n\n" +
      "Thank you for contacting {firmName}. We are unable to take this matter, and we have not formed an attorney-client relationship with you. " +
      "This is not a statement about the merits of your situation. Legal matters can be subject to time limits, so if you wish to pursue this, " +
      "please consult another lawyer promptly. Referral options, if any, are available here: {portalUrl}",
  }),
  referralList: defineGate({
    key: "rules.intake.referral_list",
    cardIds: ["c73"],
    reviewers: ["attorney"],
    description: "Showing the firm's own referral list to declined prospects (Rule 1.04 referral fees are outside the product)",
  }),
} as const;

// ---------------------------------------------------------------------------
// c14 — client-facing generic status per system stage
// ---------------------------------------------------------------------------

const CLIENT_STATUS_DRAFTS: Record<string, string> = {
  prospective: "We have received your inquiry.",
  consultation_scheduled: "Your consultation is scheduled.",
  consult_completed_manual_follow_up: "We will be in touch about next steps.",
  pending_review: "We are reviewing your inquiry.",
  did_not_schedule: "Your inquiry is closed. You are welcome to contact us again.",
  did_not_hire_referred_out: "Your inquiry is closed.",
  declined_conflict: "Your inquiry is closed.",
  retained: "Your matter is open.",
  closed: "Your matter is closed.",
};

export const CLIENT_STATUS_GATES: Readonly<Record<string, Gate>> = Object.freeze(
  Object.fromEntries(
    Object.entries(CLIENT_STATUS_DRAFTS).map(([stage, draft]) => [
      stage,
      defineGate({
        key: `copy.intake.client_status.${stage}`,
        cardIds: ["c14", "c11"],
        reviewers: ["attorney"],
        description: `Generic client-facing status for the '${stage}' stage (must not reveal conflicts or imply representation early)`,
        draft,
      }),
    ])
  )
);

/** Every gate this engine defines (for the admin page and tests). */
export const INTAKE_GATE_KEYS: readonly string[] = [
  ...Object.values(CHANNEL_COPY).flatMap((g) => [g.en.key, g.es.key]),
  ...Object.values(CHANNEL_RULE_GATES).map((g) => g.key),
  ...Object.values(EMERGENCY_COPY).flatMap((g) => [g.en.key, g.es.key]),
  EMERGENCY_DETECTION_GATE.key,
  ...Object.values(BOOKING_COPY).map((g) => g.key),
  ...Object.values(BOOKING_RULE_GATES).map((g) => g.key),
  ...Object.values(OPEN_MATTER_GATES).map((g) => g.key),
  ...Object.values(SPEED_TO_LEAD_COPY).flatMap((g) => [g.en.key, g.es.key]),
  ...Object.values(FOLLOW_UP_GATES).map((g) => g.key),
  ...Object.values(FOLLOW_UP_TEMPLATES).map((g) => g.key),
  ...Object.values(ACCEPTANCE_GATES).map((g) => g.key),
  ...Object.values(CLIENT_STATUS_GATES).map((g) => g.key),
];

/** Shared gates this engine relies on (defined in src/compliance/gates.ts). */
export const INTAKE_SHARED_GATE_KEYS: readonly string[] = [
  VENDOR_GATES.voice.key,
  VENDOR_GATES.sms.key,
  VENDOR_GATES.email.key,
  VENDOR_GATES.mailboxAccess.key,
  VENDOR_GATES.calendarSync.key,
  VENDOR_GATES.paymentProcessor.key,
  VENDOR_GATES.aiModel.key,
  RULE_GATES.trustAccounting.key,
  NOTIFY_COPY_GATES.genericUpdate.key,
];
