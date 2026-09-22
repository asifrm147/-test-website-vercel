// Vercel Function (Node runtime, ESM). Receives Telnyx's async SMS
// notifications -- both delivery status updates (existing behavior) and,
// added 2026-09-22, inbound texts from patients: "UNSUBSCRIBE" records the
// number in the SMS Opt-Outs list (object_33 -- see smsOptOutLib.js) and
// texts back SMS_UNSUBSCRIBE_CONFIRMATION; "START" from an opted-out
// number removes it from that list and texts back
// SMS_RESUBSCRIBE_CONFIRMATION. Both replies go out via telnyxSms.js's
// bare send, bypassing the compliance footer and opt-out gate that every
// other outgoing message goes through -- see that file's header comment
// for why.
//
// Set this function's URL as the inbound webhook on the Telnyx Messaging
// Profile used for TELNYX_SMS_FROM_NUMBER (Mission Control Portal ->
// Messaging -> your Messaging Profile -> Inbound Settings):
//   https://<your-project>.vercel.app/api/sms-webhook
// The same webhook URL carries both delivery-status events
// ("message.finalized") and inbound-message events ("message.received")
// -- Telnyx doesn't need two separate URLs configured for this.
//
// Always responds 200 even when nothing matched or logging isn't
// configured, same reasoning as fax-webhook.js. The confirmation replies
// are logged to the SMS Log too (status "Queued", sentBy "System (auto
// opt-out reply)") so they show up in the same audit trail as everything
// else, but a logging failure never blocks recording the opt-out/opt-in
// itself -- that's the part that actually has to be right.
import { createSmsLogRecord, findSmsLogRecordByMessageId, updateSmsLogStatus } from "../src/server-lib/smsLogLib.js";
import { recordOptOut, removeOptOut, isPhoneOptedOut } from "../src/server-lib/smsOptOutLib.js";
import { sendRawTelnyxSms } from "../src/server-lib/telnyxSms.js";
import { SMS_UNSUBSCRIBE_CONFIRMATION, SMS_RESUBSCRIBE_CONFIRMATION } from "../src/lib/smsCompliance.js";

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

// Telnyx's "message.finalized" event carries the real delivery outcome in
// payload.to[0].status ("delivered" / "delivery_failed" /
// "delivery_unconfirmed"); "message.sent" just means the carrier accepted
// it, which isn't a terminal state worth recording over "Queued".
function statusForPayload(eventType, payload) {
  if (eventType !== "message.finalized") return null;
  const toStatus = payload?.to?.[0]?.status;
  if (toStatus === "delivered") return "Delivered";
  if (toStatus === "delivery_failed") return "Failed";
  return null; // delivery_unconfirmed -- Telnyx couldn't confirm either way, leave as Queued
}

// Exact-match (case/whitespace-insensitive) keyword checks -- deliberately
// not a "contains" check, so a message that merely mentions the word in
// passing doesn't trigger an opt-out/opt-in by accident.
function isUnsubscribeKeyword(text) {
  return String(text || "").trim().toUpperCase() === "UNSUBSCRIBE";
}
function isStartKeyword(text) {
  return String(text || "").trim().toUpperCase() === "START";
}

// Sends a reply and logs it to the SMS Log for the audit trail -- a
// logging failure is swallowed (never blocks the reply), and a reply
// failure (e.g. Telnyx not configured) is swallowed too, since the opt-out
// state change itself already happened by the time this runs.
async function sendConfirmation(toNumber, text, context) {
  const sent = await sendRawTelnyxSms({ to: toNumber, text }).catch(() => false);
  await createSmsLogRecord({
    destination: toNumber,
    context,
    status: sent ? "Queued" : "Failed",
    errorDetail: sent ? "" : "Could not send opt-out/opt-in confirmation (Telnyx not configured or reply failed).",
    sentBy: "System (auto opt-out reply)",
  }).catch(() => null);
}

// Named export -- see send-prior-auth-fax.js for why: this Vercel project's
// runtime doesn't honor `export default (req) => Response`, it silently
// discards the return value and hangs the request until the platform kills
// it. Named POST export is what actually gets a response sent back.
export async function POST(req) {
  let body;
  try {
    body = await req.json();
  } catch {
    return json({ ok: true, ignored: "invalid JSON" });
  }

  const eventType = body?.data?.event_type || "";
  const payload = body?.data?.payload || {};

  // Inbound text from a patient -- checked before the delivery-status
  // handling below, since it's a completely different kind of event.
  if (eventType === "message.received") {
    const fromNumber = payload?.from?.phone_number || "";
    const text = payload?.text || "";

    if (fromNumber && isUnsubscribeKeyword(text)) {
      const recorded = await recordOptOut(fromNumber, text).catch(() => false);
      await sendConfirmation(fromNumber, SMS_UNSUBSCRIBE_CONFIRMATION, "Unsubscribe confirmation");
      return json({ ok: true, optedOut: recorded });
    }

    if (fromNumber && isStartKeyword(text)) {
      // Only reply "you're resubscribed" if they actually were opted out
      // -- someone texting "START" who was never on the list gets no
      // confirmation, rather than a confusing one.
      const wasOptedOut = await isPhoneOptedOut(fromNumber).catch(() => false);
      if (wasOptedOut) {
        const removed = await removeOptOut(fromNumber).catch(() => false);
        await sendConfirmation(fromNumber, SMS_RESUBSCRIBE_CONFIRMATION, "Resubscribe confirmation");
        return json({ ok: true, resubscribed: removed });
      }
      return json({ ok: true, ignored: "START from a number that wasn't opted out" });
    }

    return json({ ok: true, ignored: "inbound message, not an opt-out/opt-in keyword" });
  }

  const messageId = payload.id || null;
  const status = statusForPayload(eventType, payload);

  if (!status || !messageId) {
    return json({ ok: true, ignored: true, eventType });
  }

  const record = await findSmsLogRecordByMessageId(messageId);
  if (!record) return json({ ok: true, matched: false });

  const errorDetail = status === "Failed" ? payload.errors?.[0]?.detail || "" : "";
  const updated = await updateSmsLogStatus(record.id, { status, errorDetail });
  return json({ ok: true, matched: true, updated });
}
