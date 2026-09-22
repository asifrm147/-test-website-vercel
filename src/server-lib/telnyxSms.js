// Minimal, direct Telnyx send -- used ONLY by api/sms-webhook.js to reply
// to an UNSUBSCRIBE/START keyword (2026-09-22). Deliberately separate from
// api/send-sms.js's flow: those replies must NOT go through
// appendComplianceFooter (telling someone who just unsubscribed to "type
// UNSUBSCRIBE to stop" is nonsensical) or the isPhoneOptedOut() gate
// (which would block the very "you're unsubscribed" confirmation it's
// trying to send, since that number is now on the opt-out list).
//
// Same env vars as api/send-sms.js: TELNYX_API_KEY and
// TELNYX_SMS_FROM_NUMBER (falling back to TELNYX_FAX_FROM_NUMBER). Fails
// silently (returns false) if either is unset, matching this codebase's
// usual "optional feature, don't block on it" convention -- a webhook
// reply is a nice-to-have, not something that should ever throw and risk
// Telnyx retrying the whole webhook delivery.
export async function sendRawTelnyxSms({ to, text }) {
  const apiKey = process.env.TELNYX_API_KEY;
  const fromNumber = process.env.TELNYX_SMS_FROM_NUMBER || process.env.TELNYX_FAX_FROM_NUMBER;
  if (!apiKey || !fromNumber || !to || !text) return false;
  try {
    const res = await fetch("https://api.telnyx.com/v2/messages", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: fromNumber, to, text }),
    });
    return res.ok;
  } catch (e) {
    console.error("telnyxSms: could not send reply:", e.message);
    return false;
  }
}
