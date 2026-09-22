// Shared 10DLC compliance footer (2026-09-22, per practice request) --
// carriers require every message sent on a registered 10DLC campaign to
// carry a clear, working opt-out instruction. This is appended
// SERVER-SIDE, in exactly two places (api/send-sms.js and the sendTier()
// helper in api/send-appointment-reminders.js) -- those are the only two
// code paths that actually call Telnyx, so appending it there guarantees
// every message gets it exactly once, regardless of which composer or
// automation produced the message body, and it can't be bypassed by
// forgetting to add it to some future new send path in the UI.
//
// The keyword itself is "UNSUBSCRIBE" (not the more common carrier
// default "STOP") per explicit practice request. Note carriers also honor
// their own standard keywords (STOP/CANCEL/END/QUIT/UNSUBSCRIBE, etc.) at
// the network level regardless of what this app does -- a patient texting
// "STOP" instead of "UNSUBSCRIBE" will still be blocked by the carrier
// itself, but won't be recorded in this app's own SMS Opt-Outs list (see
// smsOptOutLib.js) since only "UNSUBSCRIBE" is what api/sms-webhook.js
// watches for.
export const SMS_COMPLIANCE_FOOTER = "Type UNSUBSCRIBE to stop receiving messages from your doctor's office.";

// How much of the 1600-char Telnyx/carrier segment limit the footer
// reserves (the footer itself plus the blank line separating it from the
// message body) -- composers subtract this from the limit they show staff
// while typing, so the on-screen counter matches what's actually enforced
// server-side after the footer is appended.
export const SMS_COMPLIANCE_FOOTER_RESERVE = SMS_COMPLIANCE_FOOTER.length + 2;
export const SMS_USER_TEXT_LIMIT = 1600 - SMS_COMPLIANCE_FOOTER_RESERVE;

// Appends the footer once -- a no-op if it's somehow already present, so
// nothing can end up with it doubled.
export function appendComplianceFooter(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return trimmed;
  if (trimmed.includes(SMS_COMPLIANCE_FOOTER)) return trimmed;
  return `${trimmed}\n\n${SMS_COMPLIANCE_FOOTER}`;
}

// Sent back automatically by api/sms-webhook.js the moment someone texts
// UNSUBSCRIBE -- exact wording per explicit practice request (2026-09-22).
// Deliberately plain text with no footer of its own appended: it would be
// nonsensical to tell someone who just unsubscribed to "type UNSUBSCRIBE
// to stop receiving messages."
export const SMS_UNSUBSCRIBE_CONFIRMATION =
  "You will no longer receive appointment reminders from us. If you wish to receive messages, type START.";

// Sent back automatically when a previously-unsubscribed number texts
// START (see smsOptOutLib.js's removeOptOut). Wording is a judgment call,
// not something explicitly specified -- it exists only so START isn't a
// silent no-op from the patient's side, mirroring the unsubscribe
// confirmation above. Worth revisiting the exact copy if the practice
// wants something different.
export const SMS_RESUBSCRIBE_CONFIRMATION =
  "You're resubscribed and will receive appointment reminders again. Type UNSUBSCRIBE at any time to stop.";
