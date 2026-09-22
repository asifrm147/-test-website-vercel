// Server-side helper for the "SMS Opt-Outs" list (object_33, added
// 2026-09-22) -- mirrors smsLogLib.js's pattern (Knack REST API via the
// privileged KNACK_API_KEY secret). A phone number lands here when it
// texts back "UNSUBSCRIBE" (see api/sms-webhook.js's inbound handling);
// every outbound send path (api/send-sms.js, api/send-appointment-
// reminders.js's sendTier()) checks isPhoneOptedOut() before sending and
// refuses with OPTED_OUT_ERROR_MESSAGE if the destination is on this list.
//
// A number opts back in by texting START -- api/sms-webhook.js calls
// removeOptOut() below and sends SMS_RESUBSCRIBE_CONFIRMATION. A practice
// admin can still remove a record manually in Knack Builder if needed.
export const KNACK_APP_ID = "6a9f7a12b6577f098d9bcfd2";
export const SMS_OPT_OUT_OBJECT_KEY = "object_33";
export const SMS_OPT_OUT_FIELDS = {
  phone: "field_456",
  optedOutAt: "field_457",
  rawMessage: "field_458",
};

export const OPTED_OUT_ERROR_MESSAGE =
  "This number has texted UNSUBSCRIBE and opted out of text messages. It can't be texted again until the patient texts START to that number, or a practice admin removes it from the SMS Opt-Outs list in Knack.";

function knackHeaders(apiKey) {
  return {
    "X-Knack-Application-Id": KNACK_APP_ID,
    "X-Knack-REST-API-Key": apiKey,
    "Content-Type": "application/json",
  };
}

function toKnackDateTime(date) {
  // Same Pacific-time fix as smsLogLib.js -- see that file's comment.
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(date);
  const get = (type) => Number(parts.find((p) => p.type === type)?.value);
  const mm = String(get("month")).padStart(2, "0");
  const dd = String(get("day")).padStart(2, "0");
  const yyyy = get("year");
  let hours = get("hour");
  if (hours === 24) hours = 0;
  const minutes = String(get("minute")).padStart(2, "0");
  const ampm = hours >= 12 ? "PM" : "AM";
  hours = hours % 12 || 12;
  return `${mm}/${dd}/${yyyy} ${hours}:${minutes}${ampm}`;
}

// True if this E.164 number has an SMS Opt-Outs record. Fails OPEN (false)
// on a read error or when logging isn't configured at all -- an outage in
// this lookup should never silently become "everyone can be texted" being
// treated as "no one can" and blocking all sends practice-wide; the
// tradeoff (a rare transient error means a genuinely-unsubscribed number
// might get one more text) is the safer failure direction for a
// non-safety-critical compliance check like this one.
export async function isPhoneOptedOut(phoneE164) {
  const apiKey = process.env.KNACK_API_KEY;
  if (!apiKey || !phoneE164) return false;
  const filters = encodeURIComponent(
    JSON.stringify({ match: "and", rules: [{ field: SMS_OPT_OUT_FIELDS.phone, operator: "is", value: phoneE164 }] })
  );
  try {
    const res = await fetch(
      `https://api.knack.com/v1/objects/${SMS_OPT_OUT_OBJECT_KEY}/records?filters=${filters}&rows_per_page=1`,
      { headers: knackHeaders(apiKey) }
    );
    if (!res.ok) return false;
    const data = await res.json().catch(() => null);
    return Boolean(data?.records?.length);
  } catch (e) {
    console.error("smsOptOutLib: could not check opt-out status, failing open:", e.message);
    return false;
  }
}

// Records an opt-out. Idempotent -- checks first so texting UNSUBSCRIBE
// twice doesn't create duplicate records. Returns true if a record now
// exists (whether created just now or already there).
export async function recordOptOut(phoneE164, rawMessage) {
  const apiKey = process.env.KNACK_API_KEY;
  if (!apiKey || !phoneE164) return false;
  try {
    if (await isPhoneOptedOut(phoneE164)) return true;
    const res = await fetch(`https://api.knack.com/v1/objects/${SMS_OPT_OUT_OBJECT_KEY}/records`, {
      method: "POST",
      headers: knackHeaders(apiKey),
      body: JSON.stringify({
        [SMS_OPT_OUT_FIELDS.phone]: phoneE164,
        [SMS_OPT_OUT_FIELDS.rawMessage]: rawMessage || "",
        [SMS_OPT_OUT_FIELDS.optedOutAt]: toKnackDateTime(new Date()),
      }),
    });
    return res.ok;
  } catch (e) {
    console.error("smsOptOutLib: could not record opt-out:", e.message);
    return false;
  }
}

// Removes every SMS Opt-Outs record for this phone (normally just one,
// since recordOptOut is idempotent -- deletes defensively in case any
// duplicates ever exist). Returns true if the number is opted back in
// afterward, including when it was never on the list to begin with.
export async function removeOptOut(phoneE164) {
  const apiKey = process.env.KNACK_API_KEY;
  if (!apiKey || !phoneE164) return false;
  const filters = encodeURIComponent(
    JSON.stringify({ match: "and", rules: [{ field: SMS_OPT_OUT_FIELDS.phone, operator: "is", value: phoneE164 }] })
  );
  try {
    const res = await fetch(
      `https://api.knack.com/v1/objects/${SMS_OPT_OUT_OBJECT_KEY}/records?filters=${filters}&rows_per_page=100`,
      { headers: knackHeaders(apiKey) }
    );
    if (!res.ok) return false;
    const data = await res.json().catch(() => null);
    const records = data?.records || [];
    if (!records.length) return true; // wasn't opted out in the first place
    const results = await Promise.all(
      records.map((r) =>
        fetch(`https://api.knack.com/v1/objects/${SMS_OPT_OUT_OBJECT_KEY}/records/${r.id}`, {
          method: "DELETE",
          headers: knackHeaders(apiKey),
        }).then((res) => res.ok).catch(() => false)
      )
    );
    return results.every(Boolean);
  } catch (e) {
    console.error("smsOptOutLib: could not remove opt-out:", e.message);
    return false;
  }
}
