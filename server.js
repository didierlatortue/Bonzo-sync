import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json({ limit: "1mb" }));

// =========================
// HELPERS
// =========================
function digitsOnly(p) {
  return String(p || "").replace(/\D/g, "");
}
function normalizeEmail(e) {
  return String(e || "").trim().toLowerCase();
}
function normalizePhoneForStore(p) {
  if (!p) return "";
  const raw = String(p).trim();
  const hasPlus = raw.startsWith("+");
  const d = digitsOnly(raw);
  if (!d) return "";
  return hasPlus ? "+" + d : d;
}
function last10Digits(d) {
  const s = String(d || "");
  return s.length <= 10 ? s : s.slice(-10);
}
function ensurePeopleResourceName(r) {
  if (!r) return r;
  return r.startsWith("people/") ? r : "people/" + r;
}
async function readJsonOrText(r) {
  const text = await r.text();
  try {
    return { ok: r.ok, status: r.status, json: JSON.parse(text), text: null };
  } catch (_) {
    return { ok: r.ok, status: r.status, json: null, text };
  }
}
function nameLooksLikePhone(first, last) {
  const full = ((first || "") + " " + (last || "")).trim();
  if (!full) return true;
  const cleaned = full.replace(/[\s-()]/g, "");
  const digitCount = (cleaned.match(/\d/g) || []).length;
  if (cleaned.length > 0 && digitCount / cleaned.length > 0.7) return true;
  if (/^\d+$/.test(cleaned)) return true;
  return false;
}
function dedupeStrings(arr) {
  return Array.from(new Set([].concat(arr || []).map((x) => String(x || "").trim()).filter(Boolean)));
}
function safeStr(x, max = 500) {
  const s = String(x || "");
  return s.length > max ? s.slice(0, max) + "…" : s;
}

// Try to extract a destination phone from various Bonzo message shapes
function extractPhoneFromMessage(message) {
  const candidates = [
    message && message.to,
    message && message.to_number,
    message && message.toNumber,
    message && message.destination,
    message && message.destination_number,
    message && message.destinationNumber,
    message && message.phone,
    message && message.phone_number,
    message && message.phoneNumber,
    message && message.recipient,
    message && message.recipient_phone,
    message && message.recipientPhone,
    message && message.contact && message.contact.phone,
    message && message.contact && message.contact.phone_number,
    message && message.contact && message.contact.phoneNumber,
  ];
  for (const c of candidates) {
    const d = digitsOnly(c);
    if (d && d.length >= 7) return d;
  }
  return "";
}

// =========================
// BONZO (v3)
// =========================
function bonzoBase() {
  // IMPORTANT: BONZO_BASE_URL=https://app.getbonzo.com/api/v3
  return String(process.env.BONZO_BASE_URL || "https://app.getbonzo.com/api/v3").replace(/\/+$/, "");
}

/**
 * AUTH MODES
 * - bearer (default): Authorization: Bearer <token>
 * - x-api-key: X-API-KEY: <token>
 * - auto: try bearer; if 401/403 retry once with X-API-KEY (or vice versa if forced)
 */
function bonzoAuthMode() {
  return String(process.env.BONZO_AUTH_MODE || "bearer").trim().toLowerCase(); // bearer|x-api-key|auto
}

function bonzoHeaders(mode) {
  const key = String(process.env.BONZO_API_KEY || "").trim();
  const base = { "Content-Type": "application/json", Accept: "application/json" };
  if (!key) return base;

  const m = String(mode || bonzoAuthMode()).toLowerCase();
  if (m === "x-api-key" || m === "x_api_key" || m === "xapikey") {
    return Object.assign({}, base, { "X-API-KEY": key });
  }
  // default: bearer
  return Object.assign({}, base, { Authorization: "Bearer " + key });
}

function authPreview(headers) {
  if (headers.Authorization) return "Authorization: " + String(headers.Authorization).slice(0, 40) + "...";
  if (headers["X-API-KEY"]) return "X-API-KEY: " + String(headers["X-API-KEY"]).slice(0, 8) + "...";
  if (headers["x-api-key"]) return "x-api-key: " + String(headers["x-api-key"]).slice(0, 8) + "...";
  return "(none)";
}

async function bonzoFetch(path, opts) {
  opts = opts || {};
  const url = bonzoBase() + path;

  const mode = opts._authMode || bonzoAuthMode();
  const headers = Object.assign({}, bonzoHeaders(mode), opts.headers || {});

  console.log("[bonzoFetch] " + (opts.method || "GET") + " " + url);
  console.log("[bonzoFetch] Auth preview:", authPreview(headers));

  const r = await fetch(url, Object.assign({}, opts, { headers }));
  const out = await readJsonOrText(r);

  console.log("[bonzoFetch] status:", out.status);
  console.log("[bonzoFetch] body:", safeStr(JSON.stringify(out.json || out.text || ""), 1200));

  // AUTO fallback auth retry ONCE if unauthorized/forbidden
  const shouldRetry =
    String(mode).toLowerCase() === "auto" &&
    (out.status === 401 || out.status === 403) &&
    !opts._authRetried &&
    String(process.env.BONZO_API_KEY || "").trim();

  if (shouldRetry) {
    const retryMode = headers.Authorization ? "x-api-key" : "bearer";
    console.log("[bonzoFetch] AUTH RETRY with:", retryMode);
    return bonzoFetch(path, Object.assign({}, opts, { _authRetried: true, _authMode: retryMode }));
  }

  return out;
}

async function bonzoGetProspectById(id) {
  const out = await bonzoFetch("/prospects/" + encodeURIComponent(id), { method: "GET" });
  // Unwrap v3 { data: {...} }
  if (out.ok && out.json && out.json.data) out.json = out.json.data;
  return out;
}

async function bonzoPutProspectFull(id, obj) {
  const body = JSON.stringify(obj);
  console.log("[bonzoFetch] PUT payload keys:", Object.keys(obj || {}));
  console.log("[bonzoFetch] PUT payload preview:", safeStr(body, 1400));
  const out = await bonzoFetch("/prospects/" + encodeURIComponent(id), { method: "PUT", body });
  if (out.ok && out.json && out.json.data) out.json = out.json.data;
  return out;
}

/**
 * SAFE UPDATE:
 * Bonzo v3 behaves like PUT=replace, so we always GET, merge, then PUT full.
 * Guardrails included:
 * - Never drop existing tags: patch.tags are MERGED with current tags
 * - Dedupe tags always
 */
async function bonzoSafeUpdateProspect(id, patch) {
  const getOut = await bonzoGetProspectById(id);
  if (!getOut.ok || !getOut.json) return getOut;

  const current = getOut.json;
  const updated = { ...current };

  // Merge patch (top-level only)
  for (const k of Object.keys(patch || {})) updated[k] = patch[k];

  // TAGS GUARDRAIL: always merge, never replace
  const currentTags = [].concat(current && current.tags ? current.tags : []);
  const patchTags = patch && patch.tags ? [].concat(patch.tags) : [];
  updated.tags = dedupeStrings(currentTags.concat(patchTags));

  return bonzoPutProspectFull(id, updated);
}

/**
 * Find prospects by email.
 * NOTE: Bonzo may return broad results; we filter exact matches before cleaning.
 */
async function bonzoFindProspectsByEmail(email) {
  const e = normalizeEmail(email);
  if (!e) return [];

  const paths = [
    "/prospects?email=" + encodeURIComponent(e),
    "/prospects?query=" + encodeURIComponent(e),
    "/prospects?search=" + encodeURIComponent(e),
  ];

  for (const path of paths) {
    const out = await bonzoFetch(path, { method: "GET" });
    if (!out.ok) continue;

    const j = out.json || {};
    const list =
      (Array.isArray(j.data) && j.data) ||
      (j.data && Array.isArray(j.data.data) && j.data.data) ||
      (Array.isArray(j.prospects) && j.prospects) ||
      (Array.isArray(j.results) && j.results) ||
      [];

    if (!Array.isArray(list) || !list.length) continue;

    // Exact email matches only (super important!)
    const exact = list.filter((p) => normalizeEmail(p && p.email) === e);
    if (exact.length) return exact;

    // If API doesn’t include emails in the list, return the raw list (caller must safety-check)
    return list;
  }

  return [];
}

// DEBUG ENDPOINT (optional)
app.get("/debug-bonzo", async (req, res) => {
  const secret = req.header("x-scan-secret");
  if (secret !== process.env.SCAN_SECRET) return res.status(401).send("Unauthorized");
  const id = req.query.id || "98725114";
  const base = bonzoBase();
  const keyLen = String(process.env.BONZO_API_KEY || "").trim().length;
  const mode = bonzoAuthMode();
  const out = await bonzoGetProspectById(id);
  return res.json({
    base,
    keyLen,
    mode,
    status: out.status,
    ok: out.ok,
    body: safeStr(JSON.stringify(out.json || out.text || ""), 1200),
  });
});

// =========================
// GOOGLE AUTH (unchanged)
// =========================
async function getGoogleAccessToken() {
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    client_secret: process.env.GOOGLE_CLIENT_SECRET,
    refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
    grant_type: "refresh_token",
  });
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  const out = await readJsonOrText(r);
  if (!out.ok) throw new Error("Failed to refresh Google token: " + out.status);
  return out.json.access_token;
}
async function searchGoogleContacts(query, accessToken) {
  const url =
    "https://people.googleapis.com/v1/people:searchContacts" +
    "?query=" +
    encodeURIComponent(query) +
    "&readMask=names,emailAddresses,phoneNumbers,biographies,metadata&pageSize=10";
  const r = await fetch(url, { headers: { Authorization: "Bearer " + accessToken } });
  const out = await readJsonOrText(r);
  if (!out.ok) throw new Error("searchContacts failed: " + out.status);
  return ((out.json && out.json.results) || [])
    .map(function (x) {
      return x.person;
    })
    .filter(Boolean);
}
async function getPerson(resourceName, accessToken) {
  const rn = ensurePeopleResourceName(resourceName);
  const url =
    "https://people.googleapis.com/v1/" +
    rn +
    "?personFields=names,emailAddresses,phoneNumbers,biographies,organizations";
  const r = await fetch(url, { headers: { Authorization: "Bearer " + accessToken } });
  const out = await readJsonOrText(r);
  if (!out.ok) throw new Error("getPerson failed: " + out.status);
  return out.json;
}
function personHasEmail(person, email) {
  if (!email) return false;
  return ((person && person.emailAddresses) || []).some(function (e) {
    return normalizeEmail(e && e.value) === email;
  });
}
function personHasPhone(person, phoneDigits) {
  if (!phoneDigits) return false;
  const targetDigits = digitsOnly(phoneDigits);
  const targetLast10 = last10Digits(targetDigits);
  return ((person && person.phoneNumbers) || []).some(function (p) {
    const pd = digitsOnly((p && p.value) || "");
    if (!pd) return false;
    if (pd === targetDigits) return true;
    if (last10Digits(pd) === targetLast10 && targetLast10.length === 10) return true;
    return false;
  });
}
async function findExistingContact(prospect, accessToken) {
  const email = normalizeEmail(prospect && prospect.email);
  const phoneStored = normalizePhoneForStore(prospect && prospect.phone);
  const phoneDigits = digitsOnly(phoneStored);
  const phoneLast10 = last10Digits(phoneDigits);
  const queries = [];
  if (phoneDigits) {
    queries.push(phoneStored);
    queries.push(phoneDigits);
    if (phoneLast10 && phoneLast10.length === 10) queries.push(phoneLast10);
  }
  if (email) queries.push(email);
  const uniq = Array.from(new Set(queries)).filter(Boolean);
  for (const q of uniq) {
    const people = await searchGoogleContacts(q, accessToken);
    if (!people.length) continue;
    const byPhone = phoneDigits ? people.find((p) => personHasPhone(p, phoneDigits)) : null;
    if (byPhone && byPhone.resourceName) return byPhone;
    const byEmail = email ? people.find((p) => personHasEmail(p, email)) : null;
    if (byEmail && byEmail.resourceName) return byEmail;
    if (people.length === 1 && people[0] && people[0].resourceName) return people[0];
  }
  return null;
}
async function upsertGoogleContact(prospect) {
  if (nameLooksLikePhone(prospect && prospect.first_name, prospect && prospect.last_name)) return;
  const phoneStored = normalizePhoneForStore(prospect && prospect.phone);
  const phoneDigits = digitsOnly(phoneStored);
  if (!phoneDigits) return;
  const email = normalizeEmail(prospect && prospect.email);
  const accessToken = await getGoogleAccessToken();
  const body = {
    names: [{ givenName: (prospect && prospect.first_name) || "", familyName: (prospect && prospect.last_name) || "" }],
    emailAddresses: email ? [{ value: email }] : [],
    phoneNumbers: [{ value: phoneStored || phoneDigits }],
    biographies: [{ value: "Source: Bonzo | ID: " + ((prospect && prospect.id) || "") }],
    organizations: [{ name: "Home Loans", title: "Lead" }],
  };
  const found = await findExistingContact(prospect, accessToken);
  if (found && found.resourceName) {
    const person = await getPerson(found.resourceName, accessToken);
    const rn = ensurePeopleResourceName(person.resourceName);
    const updateUrl =
      "https://people.googleapis.com/v1/" +
      rn +
      ":updateContact" +
      "?updatePersonFields=names,emailAddresses,phoneNumbers,biographies,organizations";
    for (let attempt = 1; attempt <= 2; attempt++) {
      const etag = attempt === 1 ? person.etag : (await getPerson(rn, accessToken)).etag;
      const hdrs = Object.assign(
        { Authorization: "Bearer " + accessToken, "Content-Type": "application/json" },
        etag ? { "If-Match": etag } : {}
      );
      const r = await fetch(updateUrl, {
        method: "PATCH",
        headers: hdrs,
        body: JSON.stringify(Object.assign({}, body, { etag })),
      });
      const out = await readJsonOrText(r);
      if (out.ok) return out.json;
      if (out.status === 412 && attempt === 1) continue;
      throw new Error("updateContact failed: " + out.status);
    }
  }
  const r = await fetch("https://people.googleapis.com/v1/people:createContact", {
    method: "POST",
    headers: { Authorization: "Bearer " + accessToken, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const out = await readJsonOrText(r);
  if (!out.ok) throw new Error("createContact failed: " + out.status);
  return out.json;
}

// =========================
// MICROSOFT GRAPH
// =========================
async function getMsGraphToken() {
  const tenant = process.env.MS_TENANT_ID;
  const clientId = process.env.MS_CLIENT_ID;
  const clientSecret = process.env.MS_CLIENT_SECRET;
  if (!tenant || !clientId || !clientSecret) throw new Error("Missing MS env vars");
  const params = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "client_credentials",
    scope: "https://graph.microsoft.com/.default",
  });
  const r = await fetch("https://login.microsoftonline.com/" + tenant + "/oauth2/v2.0/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  const out = await readJsonOrText(r);
  if (!out.ok) throw new Error("MS token failed: " + out.status);
  return out.json.access_token;
}
async function graphGet(path, token) {
  const url = "https://graph.microsoft.com/v1.0" + path;
  const r = await fetch(url, { headers: { Authorization: "Bearer " + token } });
  const out = await readJsonOrText(r);
  if (!out.ok) throw new Error("Graph GET failed " + out.status + ": " + url);
  return out.json;
}

// =========================
// BOUNCE DETECTION (Outlook)
// =========================
function extractEmailFromText(text) {
  const m = String(text || "").match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi);
  return m && m.length ? normalizeEmail(m[0]) : "";
}
function isBounceSubject(subject) {
  const s = String(subject || "").toLowerCase();
  return (
    s.includes("undeliverable") ||
    s.includes("delivery has failed") ||
    s.includes("delivery failed") ||
    s.includes("returned mail") ||
    s.includes("failure notice") ||
    s.includes("mail delivery subsystem") ||
    s.includes("delivery status notification") ||
    s.includes("could not be delivered") ||
    s.includes("message blocked") ||
    s.includes("bounce")
  );
}
function isLikelyBounceSender(fromAddress) {
  const a = String(fromAddress || "").toLowerCase();
  return a.includes("mailer-daemon") || a.includes("postmaster") || a.includes("msprvs1") || a.includes("mail delivery");
}
const seenMessageIds = new Map();
function markSeen(id) {
  if (id) seenMessageIds.set(id, Date.now());
}
function isSeen(id) {
  return id ? seenMessageIds.has(id) : false;
}
setInterval(function () {
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const [id, ts] of seenMessageIds.entries()) {
    if (ts < cutoff) seenMessageIds.delete(id);
  }
}, 10 * 60 * 1000);

// =========================
// ROUTES
// =========================
app.post("/bonzo/events", async (req, res) => {
  try {
    if (req.header("x-bonzo-code") !== process.env.BONZO_CODE) return res.status(401).send("Unauthorized");
    const { event, prospect } = req.body;
    console.log("Bonzo event:", event);
    if (["prospects.created", "prospects.updated"].includes(event)) await upsertGoogleContact(prospect);
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error("Webhook error:", err);
    res.status(500).send("Server error");
  }
});

/**
 * Phone cleanup via Bonzo message status (SMS only)
 * Guardrails:
 * - ONLY for SMS types AND bad statuses
 * - Confirm the failed message destination phone matches the prospect phone (last10)
 *   If we can’t confidently match, we SKIP instead of wiping.
 * - Tags are MERGED, so "bad_phone" won’t delete existing tags
 */
app.post("/bonzo/event-hook", async (req, res) => {
  try {
    if (req.header("x-bonzo-code") !== process.env.BONZO_CODE) return res.status(401).send("Unauthorized");
    const { event, additional, prospect } = req.body;
    if (event !== "messages.outgoing.updated") return res.status(200).json({ ok: true, ignored: true });

    const message = additional && additional.message;
    if (!message) return res.status(200).json({ ok: true, ignored: true, reason: "no_message" });

    const status = String(message.status || "").toLowerCase();
    const type = String(message.type || "").toLowerCase();
    const prospectId = (message.prospect && message.prospect.id) || (prospect && prospect.id) || message.prospect_id;

    console.log("Message update:", { status, type, prospectId, messageId: message.id });

    // Only auto-clean SMS here
    const SMS_TYPES = new Set(["sms", "text", "mms"]);
    const BAD = new Set(["failed", "bounced", "bounce", "undeliverable", "error", "rejected", "dropped", "blocked", "invalid", "spam"]);

    if (!prospectId) return res.status(200).json({ ok: true, skipped: true, reason: "no_prospect_id" });
    if (!SMS_TYPES.has(type)) return res.status(200).json({ ok: true, skipped: true, reason: "type_not_sms" });
    if (!BAD.has(status)) return res.status(200).json({ ok: true, skipped: true, reason: "status_not_bad" });

    const getOut = await bonzoGetProspectById(prospectId);
    if (!getOut.ok || !getOut.json) {
      console.log("Cleanup skipped: could not GET prospect", getOut.status, getOut.json || getOut.text);
      return res.status(200).json({ ok: true, skipped: true, reason: "get_failed" });
    }

    const current = getOut.json;

    // GUARDRAIL: match message destination phone to current phone (last10)
    const currentDigits = digitsOnly(normalizePhoneForStore(current && current.phone));
    const msgDigits = extractPhoneFromMessage(message);
    const currentLast10 = last10Digits(currentDigits);
    const msgLast10 = last10Digits(msgDigits);

    if (!currentDigits) {
      return res.status(200).json({ ok: true, skipped: true, reason: "no_current_phone" });
    }
    if (!msgDigits) {
      return res.status(200).json({ ok: true, skipped: true, reason: "no_message_phone_for_match" });
    }
    if (currentLast10 && msgLast10 && currentLast10.length === 10 && msgLast10.length === 10 && currentLast10 !== msgLast10) {
      console.log("[bad_phone] SKIP mismatch:", { currentLast10, msgLast10 });
      return res.status(200).json({ ok: true, skipped: true, reason: "phone_mismatch_guardrail" });
    }

    const putOut = await bonzoSafeUpdateProspect(prospectId, {
      phone: "", // empty string clears more reliably than null
      phone_type: "invalid",
      tags: ["bad_phone"], // MERGED with existing tags inside bonzoSafeUpdateProspect
    });

    console.log("Cleanup result:", putOut.status, putOut.json || putOut.text);
    return res.status(200).json({ ok: true, cleaned: putOut.ok, status: putOut.status });
  } catch (err) {
    console.error("Cleanup error:", err);
    return res.status(200).json({ ok: false, error: "exception" });
  }
});

app.get("/test-outlook", async (req, res) => {
  try {
    const mailbox = process.env.OUTLOOK_MAILBOX;
    if (!mailbox) return res.status(500).json({ ok: false, error: "Missing OUTLOOK_MAILBOX" });
    const token = await getMsGraphToken();
    const data = await graphGet(
      "/users/" +
        encodeURIComponent(mailbox) +
        "/mailFolders/Inbox/messages?$top=5&$select=id,subject,receivedDateTime,from,bodyPreview",
      token
    );
    const messages = ((data && data.value) || []).map(function (m) {
      return {
        id: m.id,
        subject: m.subject,
        receivedDateTime: m.receivedDateTime,
        from: (m.from && m.from.emailAddress && m.from.emailAddress.address) || "",
        preview: String(m.bodyPreview || "").slice(0, 140),
      };
    });
    return res.json({ ok: true, mailbox, count: messages.length, messages });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String((e && e.message) || e) });
  }
});

/**
 * Email cleanup via Outlook bounce scan (manual trigger)
 * Guardrails:
 * - SECRET required
 * - Exact-email match required for clearing (hard stop)
 * - Cap broad matches with maxMatchesSafety
 * - Cap total cleans with maxCleans
 * - Optional dryRun (default false): compute actions but do not PUT
 * - Tags are MERGED so "bad_email" is added even if "bad_phone" already exists
 */
app.post("/scan-bounces", async (req, res) => {
  const secret = req.header("x-scan-secret");
  if (!process.env.SCAN_SECRET) return res.status(500).send("Missing SCAN_SECRET");
  if (secret !== process.env.SCAN_SECRET) return res.status(401).send("Unauthorized");

  try {
    const mailbox = process.env.OUTLOOK_MAILBOX;
    if (!mailbox) return res.status(500).json({ ok: false, error: "Missing OUTLOOK_MAILBOX" });

    const top = Math.min(Math.max(Number((req.body && req.body.top) || 25), 1), 100);
    const maxMatchesSafety = Math.min(Math.max(Number((req.body && req.body.maxMatchesSafety) || 5), 1), 25);
    const maxCleans = Math.min(Math.max(Number((req.body && req.body.maxCleans) || 10), 1), 50);
    const dryRun = Boolean(req.body && req.body.dryRun);

    const token = await getMsGraphToken();
    const data = await graphGet(
      "/users/" +
        encodeURIComponent(mailbox) +
        "/mailFolders/Inbox/messages?$top=" +
        top +
        "&$select=id,subject,receivedDateTime,from,bodyPreview",
      token
    );

    const items = (data && data.value) || [];
    const results = [];
    let totalCleans = 0;

    for (const m of items) {
      if (totalCleans >= maxCleans) break;

      if (isSeen(m.id)) continue;
      markSeen(m.id);

      const fromAddr = (m.from && m.from.emailAddress && m.from.emailAddress.address) || "";
      const subjectBounce = isBounceSubject(m.subject);
      const senderBounce = isLikelyBounceSender(fromAddr);

      // If it doesn't look like a bounce by subject, skip (sender heuristic is secondary)
      if (!subjectBounce && !senderBounce) continue;

      const extracted = extractEmailFromText(m.bodyPreview) || extractEmailFromText(m.subject);
      const bouncedEmail = normalizeEmail(extracted);

      if (!bouncedEmail) {
        results.push({ id: m.id, subject: m.subject, from: fromAddr, extractedEmail: "", action: "no_email_found" });
        continue;
      }

      let matches = await bonzoFindProspectsByEmail(bouncedEmail);

      // Hard safety: require exact matches for clearing
      const exactMatches = matches.filter((p) => normalizeEmail(p && p.email) === bouncedEmail);

      // Safety: if too many results and no exact matches, do nothing
      if (!exactMatches.length && matches.length > maxMatchesSafety) {
        console.log("[scan-bounces] SAFETY SKIP: too many matches for", bouncedEmail, matches.length);
        results.push({
          id: m.id,
          subject: m.subject,
          from: fromAddr,
          extractedEmail: bouncedEmail,
          action: "safety_skip_too_many_matches",
          matches: matches.length,
          exactMatches: 0,
        });
        continue;
      }

      // If no exact matches, do not clean (guardrail)
      if (!exactMatches.length) {
        results.push({
          id: m.id,
          subject: m.subject,
          from: fromAddr,
          extractedEmail: bouncedEmail,
          action: "no_exact_matches_guardrail",
          matches: matches.length,
          exactMatches: 0,
          cleanedCount: 0,
        });
        continue;
      }

      const toClean = exactMatches.slice(0, maxMatchesSafety);

      let cleanedCount = 0;
      for (const p of toClean) {
        if (totalCleans >= maxCleans) break;

        const pid = p && (p.id || p.prospectId || p.prospect_id);
        if (!pid) continue;

        const getOut = await bonzoGetProspectById(pid);
        if (!getOut.ok || !getOut.json) continue;

        const current = getOut.json;
        const currentEmail = normalizeEmail(current && current.email);

        // Extra safety: only clear if it matches the bounced email (required)
        if (!currentEmail || currentEmail !== bouncedEmail) continue;

        if (dryRun) {
          cleanedCount++;
          continue;
        }

        const putOut = await bonzoSafeUpdateProspect(pid, {
          email: "",
          tags: ["bad_email"], // MERGED with existing tags inside bonzoSafeUpdateProspect
        });

        if (putOut.ok) {
          cleanedCount++;
          totalCleans++;
        }
      }

      results.push({
        id: m.id,
        subject: m.subject,
        from: fromAddr,
        extractedEmail: bouncedEmail,
        action: dryRun ? (cleanedCount ? "dry_run_would_clean" : "dry_run_no_safe_matches") : cleanedCount ? "cleaned" : "no_safe_matches",
        matches: matches.length,
        exactMatches: exactMatches.length,
        cleanedCount,
        dryRun,
      });
    }

    return res.json({
      ok: true,
      scanned: items.length,
      bouncesProcessed: results.length,
      totalCleans: dryRun ? 0 : totalCleans,
      dryRun,
      results,
    });
  } catch (e) {
    console.error("scan-bounces error:", e);
    return res.status(500).json({ ok: false, error: String((e && e.message) || e) });
  }
});

app.get("/", (req, res) => res.status(200).send("ok"));
app.listen(process.env.PORT || 3000, () => {
  console.log("Server running");
});
