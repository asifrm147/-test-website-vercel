import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

const MAIL_FROM = process.env.MAIL_FROM || (process.env.MAILGUN_DOMAIN ? `noreply@${process.env.MAILGUN_DOMAIN}` : "noreply@psychiatrygroup.com");

// Crash-test isolation. Set TEST_MODE=1 (+ TEST_EMAIL) ONLY on the test
// deployment. When on, every outgoing email is redirected to TEST_EMAIL and
// tagged [TEST], so no real provider is ever contacted from the sandbox.
const TEST_MODE = /^(1|true|yes|on)$/i.test(process.env.TEST_MODE || "");
const TEST_EMAIL = process.env.TEST_EMAIL || "";

// Email goes over Mailgun's HTTPS API (not SMTP) -- no app password, no SMTP
// socket, nothing Google Workspace can block. Requires MAILGUN_API_KEY and
// MAILGUN_DOMAIN, and (for real PHI) a paid Mailgun plan with a signed BAA.
// Set MAILGUN_BASE_URL to the EU endpoint if your Mailgun domain is EU-region.
async function sendViaMailgun(opts: { to: string; cc?: string; replyTo?: string; subject: string; text: string; attachments?: { filename: string; content: Buffer; contentType?: string }[] }): Promise<void> {
  const key = process.env.MAILGUN_API_KEY;
  const domain = process.env.MAILGUN_DOMAIN;
  if (!key || !domain) throw new Error("Mailgun is not configured (MAILGUN_API_KEY / MAILGUN_DOMAIN)");
  let to = opts.to, cc = opts.cc, subject = opts.subject, text = opts.text;
  if (TEST_MODE) {
    to = TEST_EMAIL || MAIL_FROM;
    cc = undefined;
    subject = "[TEST] " + subject;
    text = "*** TEST SUBMISSION - not a real patient (crash-test environment). ***\n\n" + text;
  }
  const base = process.env.MAILGUN_BASE_URL || "https://api.mailgun.net";
  const list = (v?: string) => (v ? v.split(",").map((x) => x.trim()).filter(Boolean) : []);
  const form = new FormData();
  form.set("from", `The Psychiatry Group <${MAIL_FROM}>`);
  for (const a of list(to)) form.append("to", a);
  for (const a of list(cc)) form.append("cc", a);
  if (opts.replyTo) form.set("h:Reply-To", opts.replyTo);
  form.set("subject", subject);
  form.set("text", text);
  for (const att of opts.attachments || []) {
    form.append("attachment", new Blob([att.content], { type: att.contentType || "application/octet-stream" }), att.filename);
  }
  const res = await fetch(`${base}/v3/${domain}/messages`, {
    method: "POST",
    headers: { Authorization: `Basic ${Buffer.from(`api:${key}`).toString("base64")}` },
    body: form,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Mailgun ${res.status}: ${detail.slice(0, 300)}`);
  }
}

/* ------------------------------------------------------------------ */
/*  Provider emails — authoritative mapping. Never trust an email      */
/*  address sent from the browser; always look it up here by name.     */
/*  Keep names in sync with PROVIDERS in the portal source.             */
/* ------------------------------------------------------------------ */
// A permissive US-or-international phone check: strips common formatting
// (spaces, dashes, dots, parens, an optional leading +), then requires the
// remainder to be all digits within E.164's 7-15 digit range. Deliberately
// not strict-US-only, since the practice serves patients who may have an
// international number. This runs both client-side (immediate feedback)
// and here server-side (defense in depth -- never trust client-only
// validation for something that determines whether staff can actually
// reach a patient or their emergency contact).
function isValidPhone(raw: string): boolean {
  if (!raw) return false;
  const stripped = raw.replace(/[\s\-.()]/g, "");
  return /^\+?\d{7,15}$/.test(stripped);
}

function normalizePhone(raw: string): string {
  return (raw || "").replace(/[\s\-.()+]/g, "");
}

const PROVIDER_EMAILS: Record<string, string> = {
  "Beth Hewes": "beth.hewes@psychiatrygroup.com",
  "Heather Sanudo": "heather.sanudo@psychiatrygroup.com",
  "Asif Malik": "asif.malik@psychiatrygroup.com",
  "Penny Goudelock": "penny.goudelock@psychiatrygroup.com",
  "Salman Kazim": "salman.kazim@psychiatrygroup.com",
  "Cesar Bustamante": "cesar.bustamante@psychiatrygroup.com",
  "Unknown": "falza@qntmed.com",
};

// General inbox recipients for appointment/referral leads (unrelated to assessments).
const LEAD_RECIPIENTS = ["asif.malik@psychiatrygroup.com"];

const LETTERHEAD =
  "THE PSYCHIATRY GROUP PLLC\n" +
  "5904 N Division St, Spokane, WA 99208\n" +
  "(844) 495-4357  ·  Fax (844) 584-3428  ·  info@psychiatrygroup.com\n" +
  "──────────────────────────────────────────\n\n";

// Knack app id — not secret, safe to hardcode (it identifies the app, not a credential).
const KNACK_APP_ID = "6a9f7a12b6577f098d9bcfd2";
const KNACK_API_BASE = "https://api.knack.com/v1";
const OBJ_PATIENTS = "object_3";
const OBJ_ASSESSMENTS = "object_20";

const clean = (v: unknown) =>
  Array.isArray(v) ? v.join(", ") : typeof v === "boolean" ? (v ? "Yes" : "No") : (v ?? "").toString();

// Dates are stored as plain ISO strings (YYYY-MM-DD) in short_text fields —
// this sorts correctly as plain text (alphabetical order = chronological
// order for ISO dates) and needs no format conversion or compound-object
// shape, unlike Knack's native date_time write format which this app's
// date fields were rejecting even with well-formed payloads.

function knackHeaders() {
  const key = process.env.KNACK_API_KEY;
  return {
    "Content-Type": "application/json",
    "X-Knack-Application-Id": KNACK_APP_ID,
    "X-Knack-REST-API-Key": key as string,
  };
}

// Cheap, always-on instrumentation: one line per outgoing Knack call, so a
// future "why did our API usage spike" question can be answered by grepping
// Vercel's function logs instead of reading source under time pressure the
// way this one had to be. Matches the same "KNACK_CALL source=... op=..."
// shape used elsewhere in this codebase's cron functions.
function logKnackCall(op: string, path: string) {
  console.log(`KNACK_CALL source=website_submit op=${op} path=${path}`);
}

async function knackRequest(path: string, init: RequestInit = {}) {
  logKnackCall(init.method || "GET", path);
  const res = await fetch(`${KNACK_API_BASE}${path}`, {
    ...init,
    headers: { ...knackHeaders(), ...(init.headers || {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`Knack ${path} failed (${res.status}): ${JSON.stringify(body)}`);
    (err as any).status = res.status;
    throw err;
  }
  return body;
}

async function findOrCreatePatient(firstName: string, lastName: string, claimNumber: string): Promise<string> {
  // Only attempt to match an EXISTING patient when there's a real claim
  // number to match on. Matching on an empty string would incorrectly
  // merge any two self-pay/no-claim patients who happen to submit
  // separately -- always create a new record in that case instead.
  if (claimNumber && claimNumber.trim()) {
    const filters = encodeURIComponent(JSON.stringify({
      match: "and",
      rules: [{ field: "field_261", operator: "is", value: claimNumber }],
    }));
    const list = await knackRequest(`/objects/${OBJ_PATIENTS}/records?filters=${filters}&rows_per_page=1`);
    if (list.records && list.records.length > 0) return list.records[0].id;
  }

  const created = await knackRequest(`/objects/${OBJ_PATIENTS}/records`, {
    method: "POST",
    body: JSON.stringify({
      field_23: { first: firstName, last: lastName },
      field_261: claimNumber || "",
    }),
  });
  return created.id;
}

async function findPriorAssessments(patientId: string): Promise<any[]> {
  const filters = encodeURIComponent(JSON.stringify({
    match: "and",
    rules: [{ field: "field_262", operator: "is", value: patientId }],
  }));
  const list = await knackRequest(
    `/objects/${OBJ_ASSESSMENTS}/records?filters=${filters}&sort_field=field_273&sort_order=asc&rows_per_page=100`
  );
  return list.records || [];
}

async function createAssessmentRecord(patientId: string, d: any, narrative: string) {
  // Signatures (especially drawn ones) are the dominant size contributor in
  // the payload -- storing them inline inside the combined JSON blob risks
  // Knack truncating that field and corrupting EVERY other piece of data
  // in it (itemized answers, attestations, all of it) along with the
  // signature itself. Each signature gets its own field instead; the
  // combined JSON blob keeps a short placeholder in their place so it
  // stays small and reliably parses.
  const aiSig = d.consent?.aiSig || "";
  const tmSig = d.consent?.tmSig || "";
  const trimmed = {
    ...d,
    consent: d.consent ? { ...d.consent, aiSig: aiSig ? "[see AI Consent Signature field]" : null, tmSig: tmSig ? "[see Telemedicine Signature field]" : null } : d.consent,
  };
  try {
    return await knackRequest(`/objects/${OBJ_ASSESSMENTS}/records`, {
      method: "POST",
      body: JSON.stringify({
        field_239: { first: d.firstName, last: d.lastName },
        field_240: d.claimNumber,
        field_272: d.dateOfInjury || "",
        field_273: d.dateCompleted,
        field_243: d.providerName,
        field_244: d.phq9.total,
        field_245: d.phq9.severity,
        field_246: d.phq9.item9 > 0 ? "Yes" : "No",
        field_247: d.gad7.total,
        field_248: d.gad7.severity,
        field_249: d.whodas.total,
        field_250: d.whodas.max,
        field_251: d.whodas.summary100,
        field_252: d.whodas.topDomains,
        field_253: narrative,
        field_254: JSON.stringify(trimmed),
        field_262: [{ id: patientId }],
        field_302: aiSig,
        field_303: tmSig,
      }),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`${msg} | raw dateOfInjury=${JSON.stringify(d.dateOfInjury)} raw dateCompleted=${JSON.stringify(d.dateCompleted)}`);
  }
}

function fmtDelta(cur: number, prev: number, label: string): string {
  const diff = Math.round((cur - prev) * 10) / 10;
  if (diff === 0) return `unchanged vs ${label}`;
  return `${diff > 0 ? "+" : ""}${diff} vs ${label} (${diff < 0 ? "improved" : "worsened"})`;
}

function buildNarrative(d: any, priors: any[]): string {
  const who = `${d.firstName} ${d.lastName}`.trim();
  const L: string[] = [];
  L.push(`BEHAVIORAL HEALTH ASSESSMENT SUMMARY`);
  L.push(`Patient: ${who}   Claim #: ${d.claimNumber}`);
  L.push(`Date of injury: ${d.dateOfInjury || "n/a"}   Date completed: ${d.dateCompleted}`);
  L.push(`Routed to: ${d.providerName}`);
  L.push(``);
  L.push(`TOTAL SCORES`);
  L.push(`PHQ-9 (depression) total score: ${d.phq9.total}/27 — ${d.phq9.severity}.`);
  if (d.phq9.item9 > 0) L.push(`  *** ALERT: PHQ-9 Item 9 (thoughts of self-harm) endorsed. Clinical safety assessment indicated. ***`);
  L.push(`GAD-7 (anxiety) total score: ${d.gad7.total}/21 — ${d.gad7.severity}.` + (d.gad7.total >= 10 ? " Score >=10 — further evaluation for anxiety disorder warranted." : ""));
  L.push(`WHODAS 2.0 (36-item) total score: ${d.whodas.total}/${d.whodas.max} raw; summary ${d.whodas.summary100}/100. Highest-impairment domains: ${d.whodas.topDomains}.`);
  L.push(``);

  // prior visits, excluding a record with the exact same completion date as the current one (defensive against double-submit)
  const priorFiltered = priors.filter((p) => (p.field_273 || "") !== d.dateCompleted);
  const oldest = priorFiltered[0];
  const preceding = priorFiltered[priorFiltered.length - 1];

  L.push(`COMPARISON TO PRIOR VISITS`);
  if (!priorFiltered.length) {
    L.push(`This is the first assessment on file for this patient/claim — no baseline for comparison yet.`);
  } else {
    const pDate = preceding.field_273 || "prior visit";
    L.push(`Vs. preceding visit (${pDate}): PHQ-9 ${fmtDelta(d.phq9.total, preceding.field_244, pDate)}; GAD-7 ${fmtDelta(d.gad7.total, preceding.field_247, pDate)}; WHODAS ${fmtDelta(d.whodas.summary100, preceding.field_251, pDate)}.`);
    if (oldest !== preceding) {
      const oDate = oldest.field_273 || "baseline";
      L.push(`Vs. baseline (${oDate}): PHQ-9 ${fmtDelta(d.phq9.total, oldest.field_244, oDate)}; GAD-7 ${fmtDelta(d.gad7.total, oldest.field_247, oDate)}; WHODAS ${fmtDelta(d.whodas.summary100, oldest.field_251, oDate)}.`);
    }
  }
  L.push(``);

  L.push(`NARRATIVE`);
  const trendWord = !priorFiltered.length ? "This is a baseline assessment." :
    (d.phq9.total <= preceding.field_244 && d.gad7.total <= preceding.field_247) ? "Symptom burden appears stable or improved relative to the prior visit." :
    "Symptom burden appears to have increased relative to the prior visit.";
  L.push(`${who} reports ${d.phq9.severity.toLowerCase()} depressive symptoms (PHQ-9 ${d.phq9.total}/27) and ${d.gad7.severity.toLowerCase()} anxiety symptoms (GAD-7 ${d.gad7.total}/21), with a WHODAS 2.0 functional-impairment summary score of ${d.whodas.summary100}/100. ${trendWord} The most affected functional domains are ${d.whodas.topDomains}. ${d.phq9.item9 > 0 ? "Item 9 of the PHQ-9 was endorsed and requires a documented safety assessment. " : ""}This is a self-report screening result; interpret in the context of clinical interview and the claim record.`);

  return L.join("\n");
}

/* ------------------------------------------------------------------ */
// Builds the FULL assessment PDF for the provider: every instrument item with the
// patient's response, plus scores. Deliberately omits the AI narrative summary.
// Helvetica is WinAnsi-encoded, so all text is sanitized to Latin-1.
const PHQ_ITEMS: string[] = ["Little interest or pleasure in doing things","Feeling down, depressed, or hopeless","Trouble falling or staying asleep, or sleeping too much","Feeling tired or having little energy","Poor appetite or overeating","Feeling bad about yourself \u2014 or that you are a failure or have let yourself or your family down","Trouble concentrating on things, such as reading the newspaper or watching television","Moving or speaking so slowly that other people could have noticed \u2014 or the opposite, being so fidgety or restless that you have been moving around a lot more than usual","Thoughts that you would be better off dead, or of hurting yourself in some way"];
const GAD_ITEMS: string[] = ["Feeling nervous, anxious, or on edge","Not being able to stop or control worrying","Worrying too much about different things","Trouble relaxing","Being so restless that it is hard to sit still","Becoming easily annoyed or irritable","Feeling afraid, as if something awful might happen"];
const WHODAS_DOMAINS: { key: string; label: string; conditional?: boolean; items: string[] }[] = [{key:"cognition",label:"Understanding & communicating",items:["Concentrating on doing something for ten minutes?","Remembering to do important things?","Analysing and finding solutions to problems in day-to-day life?","Learning a new task, for example, learning how to get to a new place?","Generally understanding what people say?","Starting and maintaining a conversation?"]},{key:"mobility",label:"Getting around",items:["Standing for long periods, such as 30 minutes?","Standing up from sitting down?","Moving around inside your home?","Getting out of your home?","Walking a long distance, such as a kilometre?"]},{key:"selfcare",label:"Self-care",items:["Washing your whole body?","Getting dressed?","Eating?","Staying by yourself for a few days?"]},{key:"gettingalong",label:"Getting along with people",items:["Dealing with people you do not know?","Maintaining a friendship?","Getting along with people who are close to you?","Making new friends?","Sexual activities?"]},{key:"lifehousehold",label:"Life activities \u2014 household",items:["Taking care of your household responsibilities?","Doing your most important household tasks well?","Getting all the household work done that you needed to do?","Getting your household work done as quickly as needed?"]},{key:"lifework",label:"Life activities \u2014 work / school",conditional:!0,items:["Your day-to-day work / school?","Doing your most important work / school tasks well?","Getting all the work done that you need to do?","Getting your work done as quickly as needed?"]},{key:"participation",label:"Participation in society",items:["Joining in community activities (festivities, religious or other) in the same way as anyone else?","Barriers or hindrances in the world around you?","Living with dignity because of the attitudes and actions of others?","Time spent on your health condition, or its consequences?","Being emotionally affected by your health condition?","Your health being a drain on the financial resources of you or your family?","Your family having problems because of your health?","Doing things by yourself for relaxation or pleasure?"]}];
const PHQ_OPTS = ["Not at all", "Several days", "More than half the days", "Nearly every day"];
const WHO_OPTS = ["None", "Mild", "Moderate", "Severe", "Extreme / cannot do"];

async function buildAssessmentPdf(data: any): Promise<Buffer> {
  const safe = (t: any) => String(t == null ? "" : t).replace(/[\u2012-\u2015]/g, "-").replace(/[^\x00-\xFF]/g, "");
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const M = 54, W = 612, H = 792, RIGHT = W - M;
  const green = rgb(0.18, 0.56, 0.39), ink = rgb(0.09, 0.14, 0.17), muted = rgb(0.36, 0.42, 0.44), rule = rgb(0.9, 0.9, 0.88), red = rgb(0.7, 0.15, 0.1);
  let page = doc.addPage([W, H]);
  let y = H - M;
  const need = (h: number) => { if (y < M + h) { page = doc.addPage([W, H]); y = H - M; } };
  // wrapped text; returns nothing, advances y
  const T = (t: any, o: any = {}) => {
    const f = o.bold ? bold : font, sz = o.size || 10, color = o.color || ink, indent = o.indent || 0;
    const maxW = RIGHT - M - indent, words = safe(t).split(/\s+/);
    let lineStr = "";
    const flush = () => { need(sz + 3); page.drawText(lineStr, { x: M + indent, y, size: sz, font: f, color }); y -= (sz + 3); lineStr = ""; };
    for (const w of words) {
      const trial = lineStr ? lineStr + " " + w : w;
      if (f.widthOfTextAtSize(trial, sz) > maxW && lineStr) flush();
      lineStr = lineStr ? lineStr + " " + w : w;
    }
    if (lineStr) flush();
    y -= (o.gap || 3);
  };
  const HR = () => { need(16); page.drawLine({ start: { x: M, y }, end: { x: RIGHT, y }, thickness: 0.7, color: rule }); y -= 14; };
  const item = (n: number, q: string, ans: string) => {
    T(`${n}. ${q}`, { size: 9.5, gap: 0 });
    T(ans, { size: 9, color: muted, indent: 16, gap: 6 });
  };

  // Header
  T("The Psychiatry Group PLLC", { bold: true, size: 14, color: green, gap: 2 });
  T("5904 N Division St, Spokane, WA 99208  \u00B7  (844) 495-4357  \u00B7  Fax (844) 584-3428", { size: 8, color: muted, gap: 2 });
  HR();
  T("Behavioral Health Assessment", { bold: true, size: 13, gap: 6 });
  T(`Patient: ${data.firstName} ${data.lastName}`, { bold: true, size: 11, gap: 2 });
  T(`Claim #: ${data.claimNumber || "-"}     Date of injury: ${data.dateOfInjury || "-"}     Completed: ${data.dateCompleted || "-"}`, { size: 9, color: muted, gap: 2 });
  T(`Provider: ${data.providerName || "-"}`, { size: 9, color: muted, gap: 8 });
  const c = data.consent || {};
  T(`Consents: AI-tools disclosure ${c.aiChecked ? "acknowledged" : "NOT acknowledged"}${c.aiName ? " (signed: " + c.aiName + ")" : ""}; Telemedicine ${c.tmChecked ? "consented" : "NOT consented"}${c.tmName ? " (signed: " + c.tmName + ")" : ""}.`, { size: 8.5, color: muted, gap: 10 });

  if (data.language === "es") T("Translated from Spanish.", { bold: true, size: 9, color: muted, gap: 10 });

  // PHQ-9
  const p = data.phq9 || {}, pa = p.answers || {};
  T("PHQ-9  \u2014  Depression", { bold: true, size: 12, color: green, gap: 2 });
  T("Over the last 2 weeks, how often have you been bothered by any of the following problems?", { size: 8.5, color: muted, gap: 6 });
  PHQ_ITEMS.forEach((q, i) => { const v = pa[i]; item(i + 1, q, v == null ? "No response" : `${PHQ_OPTS[v] ?? "?"} (${v})`); });
  T(`PHQ-9 total: ${p.total ?? "-"} / 27      Severity: ${p.severity ?? "-"}`, { bold: true, size: 10, gap: 2 });
  if (Number(p.item9) > 0) T("ITEM 9 ENDORSED - documented safety assessment required.", { bold: true, size: 10, color: red, gap: 12 }); else y -= 8;

  // GAD-7
  const g = data.gad7 || {}, ga = g.answers || {};
  need(60);
  T("GAD-7  \u2014  Anxiety", { bold: true, size: 12, color: green, gap: 2 });
  T("Over the last 2 weeks, how often have you been bothered by the following problems?", { size: 8.5, color: muted, gap: 6 });
  GAD_ITEMS.forEach((q, i) => { const v = ga[i]; item(i + 1, q, v == null ? "No response" : `${PHQ_OPTS[v] ?? "?"} (${v})`); });
  T(`GAD-7 total: ${g.total ?? "-"} / 21      Severity: ${g.severity ?? "-"}`, { bold: true, size: 10, gap: 12 });

  // WHODAS 2.0
  const w = data.whodas || {}, wa = w.answers || {};
  need(60);
  T("WHODAS 2.0  \u2014  Functioning & disability (past 30 days)", { bold: true, size: 12, color: green, gap: 2 });
  T(`Work/school items: ${w.worksOrStudies ? "included" : "excluded"}. Higher = more difficulty.`, { size: 8.5, color: muted, gap: 6 });
  let qn = 0;
  for (const dom of WHODAS_DOMAINS) {
    if (dom.conditional && !w.worksOrStudies) continue;
    need(30);
    T(dom.label, { bold: true, size: 10, color: ink, gap: 3 });
    dom.items.forEach((q, i) => { qn += 1; const v = wa[`${dom.key}_${i}`]; item(qn, q, v == null ? "No response" : `${WHO_OPTS[v] ?? "?"} (${v})`); });
    y -= 4;
  }
  T(`WHODAS summary: ${w.summary100 ?? "-"} / 100      Raw: ${w.total ?? "-"} / ${w.max ?? "-"}`, { bold: true, size: 10, gap: 10 });

  HR();
  T("This is a self-reported questionnaire; interpretation should be made in the context of the situation and clinical correlation should be made.", { size: 7.5, color: muted, gap: 4 });
  return Buffer.from(await doc.save());
}

async function handleAssessment(data: any) {
  const providerEmail = PROVIDER_EMAILS[data.providerName];
  if (!providerEmail) return { error: "Unknown provider.", status: 400 } as const;

  let narrative: string;
  const hasKnack = !!process.env.KNACK_API_KEY;

  if (hasKnack) {
    try {
      const patientId = await findOrCreatePatient(data.firstName, data.lastName, data.claimNumber);
      const priors = await findPriorAssessments(patientId);
      narrative = buildNarrative(data, priors);
      await createAssessmentRecord(patientId, data, narrative);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      console.error("Knack integration failed:", err);
      // Degrade gracefully: still email the provider with current-visit data only.
      // The raw error is included here (not shown to the patient) so a failure is
      // diagnosable straight from the email, without needing server log access.
      narrative = buildNarrative(data, []) + `\n\n(Note: this result could not be saved to the practice record system. Please verify manually.\nTechnical detail: ${detail})`;
    }
  } else {
    narrative = buildNarrative(data, []) + `\n\n(Note: practice record system is not yet connected — no prior-visit comparison available.)`;
  }

  if (!process.env.MAILGUN_API_KEY || !process.env.MAILGUN_DOMAIN) return { error: "Email is not configured yet. Please call the office.", status: 500 } as const;

  let attachments: any;
  try {
    const pdfBuffer = await buildAssessmentPdf(data);
    const safeName = `${data.lastName || "patient"}-${data.claimNumber || "form"}`.replace(/[^A-Za-z0-9._-]+/g, "_");
    attachments = [{ filename: `assessment-${safeName}.pdf`, content: pdfBuffer, contentType: "application/pdf" }];
  } catch (e) {
    console.error("assessment PDF generation failed:", e);
    attachments = undefined;
  }

  const flagged = Number(data && data.phq9 && data.phq9.item9) > 0;
  try {
    await sendViaMailgun({
      to: providerEmail,
      cc: flagged ? "asif.malik@psychiatrygroup.com" : undefined,
      subject: `${flagged ? "⚠ SAFETY FLAG — " : ""}New assessment — ${data.firstName} ${data.lastName} (Claim ${data.claimNumber})`,
      text: LETTERHEAD + narrative,
      attachments,
    });
  } catch (err) {
    console.error("provider email failed:", err);
    if (flagged) {
      // Safety net: a self-harm flag must reach a clinician even if the
      // provider-addressed send failed. Try Dr. Malik directly before giving up.
      try {
        await sendViaMailgun({
          to: "asif.malik@psychiatrygroup.com",
          subject: `⚠ SAFETY FLAG (fallback) — ${data.firstName} ${data.lastName} (Claim ${data.claimNumber})`,
          text: LETTERHEAD + narrative,
          attachments,
        });
      } catch (err2) {
        console.error("fallback safety email failed:", err2);
      }
    }
    return { error: "We couldn't send this to the provider just now. Please call the office.", status: 502 } as const;
  }

  return { ok: true } as const;
}

async function handleLead(formName: string, data: any) {
  if (!process.env.MAILGUN_API_KEY || !process.env.MAILGUN_DOMAIN) return { error: "Email is not configured yet. Please call the office.", status: 500 } as const;

  const label = formName === "referral" ? "New referral" : "New appointment request";
  const who = data.patientName || [data.firstName, data.lastName].filter(Boolean).join(" ") || "website visitor";
  const subject = `${label} — ${who}`;
  const lines = Object.entries(data).map(([k, v]) => `${k}: ${clean(v)}`);
  const text = LETTERHEAD + `${label} submitted from the website.\n\n${lines.join("\n")}\n`;

  try {
    await sendViaMailgun({
      to: LEAD_RECIPIENTS.join(", "),
      replyTo: data.email || data.refEmail || undefined,
      subject,
      text,
    });
  } catch (err) {
    console.error("lead email failed:", err);
    return { error: "We couldn't send your request just now. Please call the office.", status: 502 } as const;
  }
  return { ok: true } as const;
}

/* ------------------------------------------------------------------ */
const OBJ_INTAKE = "object_22";

async function createIntakeRecord(patientId: string, d: any) {
  const aiSig = d.consent?.aiSig || "";
  const tmSig = d.consent?.tmSig || "";
  const noShowSig = d.noShowAcknowledgment?.sig || "";
  const erSig = d.emergencyDisclosure?.sig || "";
  const trimmed = {
    ...d,
    consent: d.consent ? { ...d.consent, aiSig: aiSig ? "[see AI Consent Signature field]" : null, tmSig: tmSig ? "[see Telemedicine Signature field]" : null } : d.consent,
    noShowAcknowledgment: d.noShowAcknowledgment ? { ...d.noShowAcknowledgment, sig: noShowSig ? "[see No-Show Signature field]" : null } : d.noShowAcknowledgment,
    emergencyDisclosure: d.emergencyDisclosure ? { ...d.emergencyDisclosure, sig: erSig ? "[see Emergency Disclosure Signature field]" : null } : d.emergencyDisclosure,
  };
  return knackRequest(`/objects/${OBJ_INTAKE}/records`, {
    method: "POST",
    body: JSON.stringify({
      field_275: { first: d.firstName, last: d.lastName },
      field_276: d.dob || "",
      field_277: d.address || "",
      field_278: d.phone || "",
      field_279: d.email || "",
      field_280: d.preferredContact || "",
      field_281: d.emergencyContactName || "",
      field_282: d.emergencyContactPhone || "",
      field_283: d.emergencyContactRelationship || "",
      field_284: d.insurancePayer || "",
      field_285: d.claimNumber || "",
      field_286: d.currentMedications || "",
      field_287: d.allergies || "",
      field_288: d.psychiatricHistory || "",
      field_289: d.substanceUseHistory || "",
      field_290: d.familyPsychiatricHistory || "",
      field_291: d.reasonForReferral || "",
      field_292: d.language || "English",
      field_293: JSON.stringify(trimmed),
      field_294: d.providerName || "",
      field_301: [{ id: patientId }],
      field_304: aiSig,
      field_305: tmSig,
      field_306: noShowSig,
      field_366: erSig,
      field_367: d.smsConsent ? "Yes" : "No",
    }),
  });
}

async function handleIntakePacket(data: any) {
  if (!process.env.MAILGUN_API_KEY || !process.env.MAILGUN_DOMAIN) return { error: "Email is not configured yet. Please call the office.", status: 500 } as const;

  if (!isValidPhone(data.phone)) {
    return { error: "Phone number must be a valid US or international number (digits only).", status: 400 } as const;
  }
  if (!isValidPhone(data.emergencyContactPhone)) {
    return { error: "Emergency contact phone number must be a valid US or international number (digits only).", status: 400 } as const;
  }
  if (normalizePhone(data.phone) === normalizePhone(data.emergencyContactPhone)) {
    return { error: "Emergency contact phone number cannot be the same as your own phone number.", status: 400 } as const;
  }

  const hasKnack = !!process.env.KNACK_API_KEY;
  let saveNote = "";
  if (hasKnack) {
    try {
      const patientId = await findOrCreatePatient(data.firstName, data.lastName, data.claimNumber);
      await createIntakeRecord(patientId, data);
    } catch (err) {
      console.error("Knack integration failed (intake packet):", err);
      saveNote = `\n\n(Note: this intake packet could not be saved to the practice record system. Please verify manually.\nTechnical detail: ${err instanceof Error ? err.message : String(err)})`;
    }
  } else {
    saveNote = "\n\n(Note: practice record system is not yet connected -- this intake packet was only emailed, not saved.)";
  }

  const lines = [
    `NEW PATIENT INTAKE PACKET`,
    `Patient: ${data.firstName} ${data.lastName}   DOB: ${data.dob || "n/a"}`,
    `Phone: ${data.phone || "n/a"}   Email: ${data.email || "n/a"}   Preferred contact: ${data.preferredContact || "n/a"}`,
    `SMS consent: ${data.smsConsent ? "Yes" : "No"}`,
    `Address: ${data.address || "n/a"}`,
    ``,
    `Emergency contact: ${data.emergencyContactName || "n/a"} (${data.emergencyContactRelationship || "n/a"}) — ${data.emergencyContactPhone || "n/a"}`,
    ``,
    `Insurance/payer: ${data.insurancePayer || "n/a"}   Claim #: ${data.claimNumber || "n/a"}   Provider: ${data.providerName || "not specified"}`,
    ``,
    `Reason for visit: ${data.reasonForReferral || "n/a"}`,
    `Current medications: ${data.currentMedications || "n/a"}`,
    `Allergies: ${data.allergies || "n/a"}`,
    `Psychiatric history: ${data.psychiatricHistory || "n/a"}`,
    `Substance use history: ${data.substanceUseHistory || "n/a"}`,
    `Family psychiatric history: ${data.familyPsychiatricHistory || "n/a"}`,
    ``,
    `AI-disclosure consent attested: ${data.consent?.aiChecked ? "Yes" : "No"} (signed: ${data.consent?.aiName || "n/a"})`,
    `Telemedicine consent attested: ${data.consent?.tmChecked ? "Yes" : "No"} (signed: ${data.consent?.tmName || "n/a"})`,
    `Emergency services disclosure attested: ${data.emergencyDisclosure?.checked ? "Yes" : "No"} (signed: ${data.emergencyDisclosure?.name || "n/a"})`,
    `No-show policy acknowledged: ${data.noShowAcknowledgment?.checked ? "Yes" : "No"} (signed: ${data.noShowAcknowledgment?.name || "n/a"})`,
  ];
  const text = LETTERHEAD + lines.join("\n") + saveNote;

  try {
    await sendViaMailgun({
      to: LEAD_RECIPIENTS.join(", "),
      subject: `New patient intake packet — ${data.firstName} ${data.lastName}`,
      text,
    });
  } catch (err) {
    console.error("intake email failed:", err);
    return { error: "We couldn't submit this just now. Please call the office.", status: 502 } as const;
  }
  return { ok: true } as const;
}

// This endpoint is public (it has to be -- it's what the site's own
// unauthenticated forms POST to) and, until now, had no defense at all
// against something other than a real browser hitting it directly and
// repeatedly: no origin check, no rate limiting, no CAPTCHA/bot check, no
// submission idempotency. A script (or an aggressive crawler) hammering
// this URL directly could rack up real Knack API calls and outbound email
// with nothing here to slow it down. Added 2026-09-19 while investigating
// unexplained Knack usage.
//
// What's below is deliberately modest, not a complete solution:
//  - Origin/Referer check: a real submission from the site's own forms
//    always carries a matching Origin (or, failing that, Referer) header;
//    a script POSTing straight to this URL usually won't bother setting
//    one that matches. This costs legitimate users nothing.
//  - A best-effort in-memory rate limit per IP: catches a rapid burst from
//    the same client while this function instance stays warm. It resets on
//    every cold start and isn't shared across concurrent instances, so it
//    is NOT a real guarantee against a determined or distributed abuser --
//    just cheap friction against the common case. A robust version needs a
//    shared store (e.g. Vercel KV/Upstash) or Vercel's own Attack
//    Challenge/WAF rate limiting, which needs to be turned on in the
//    Vercel dashboard rather than in this file.
//  - No honeypot field: that needs a matching hidden field added on the
//    client side, and this repo only has the built/minified forms bundle
//    (forms/index.html), not its source -- add one at the same time you
//    next touch that form's source, if you still have it, checking here
//    for e.g. `data._hp` being non-empty and returning a fake "ok" without
//    calling Knack or sending mail.
const ALLOWED_ORIGINS = new Set([
  "https://psychiatrygroup.com",
  "https://www.psychiatrygroup.com",
  "https://forms.psychiatrygroup.com",
]);

// A same-origin form POST is always legitimate: the form is served from the
// very same host it posts to. Allowing self-host covers the production forms
// domain (forms.psychiatrygroup.com) AND Vercel preview URLs (*.vercel.app)
// without hardcoding each one, while a cross-origin browser script still
// carries its own (blocked) Origin and a header-less direct script still
// fails closed.
function hostMatchesSelf(urlStr: string, selfHost: string | null): boolean {
  if (!selfHost) return false;
  try {
    return new URL(urlStr).host === selfHost;
  } catch {
    return false;
  }
}

function originIsAllowed(req: Request): boolean {
  const selfHost = req.headers.get("host");
  const origin = req.headers.get("origin");
  if (origin) return ALLOWED_ORIGINS.has(origin) || hostMatchesSelf(origin, selfHost);
  // Some legitimate requests (older browsers, some in-app browsers) omit
  // Origin on a same-origin POST -- fall back to Referer before rejecting.
  const referer = req.headers.get("referer");
  if (referer) {
    try {
      const r = new URL(referer);
      return ALLOWED_ORIGINS.has(r.origin) || r.host === selfHost;
    } catch {
      return false;
    }
  }
  // Neither header present at all is unusual for a real browser form POST
  // and typical of a script hitting the endpoint directly -- fail closed.
  return false;
}

// Reset each cold start; see the caveats above.
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_PER_WINDOW = 5;
const recentSubmissionsByIp = new Map<string, number[]>();

function tooManyRequestsFrom(ip: string): boolean {
  const now = Date.now();
  const timestamps = (recentSubmissionsByIp.get(ip) || []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  timestamps.push(now);
  recentSubmissionsByIp.set(ip, timestamps);
  // Bound memory in a long-lived warm instance -- don't let this map grow
  // forever if it's ever hit from many distinct IPs.
  if (recentSubmissionsByIp.size > 5000) recentSubmissionsByIp.clear();
  return timestamps.length > RATE_LIMIT_MAX_PER_WINDOW;
}

function clientIp(req: Request): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0].trim() || req.headers.get("x-real-ip") || "unknown";
}

export async function POST(req: Request): Promise<Response> {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  if (!originIsAllowed(req)) {
    console.warn(`submit: rejected request with disallowed origin/referer (ip=${clientIp(req)})`);
    return Response.json({ error: "Request not allowed." }, { status: 403 });
  }

  const ip = clientIp(req);
  if (tooManyRequestsFrom(ip)) {
    console.warn(`submit: rate-limited ip=${ip}`);
    return Response.json({ error: "Too many submissions. Please wait a moment and try again." }, { status: 429 });
  }

  let payload: any;
  try { payload = await req.json(); } catch { return Response.json({ error: "Bad request." }, { status: 400 }); }
  const { formName, data } = payload || {};
  if (!data || typeof data !== "object") return Response.json({ error: "Missing form data." }, { status: 400 });

  const result = formName === "assessment" ? await handleAssessment(data)
    : formName === "intakePacket" ? await handleIntakePacket(data)
    : await handleLead(formName, data);
  if ("error" in result) return Response.json({ error: result.error }, { status: result.status });
  return Response.json(result);
}
