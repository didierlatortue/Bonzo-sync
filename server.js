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

// =========================
// BONZO (v3)
// =========================
function bonzoBase() {
  // IMPORTANT: set BONZO_BASE_URL=https://app.getbonzo.com/api/v3
  return String(process.env.BONZO_BASE_URL || "https://app.getbonzo.com/api/v3").replace(/\/+$/, "");
}

function bonzoHeaders() {
  // Your token works as Bearer against v3. X-API-KEY does NOT work for this token.
  const mode = String(process.env.BONZO_AUTH_MODE || "bearer").toLowerCase();
  const key = String(process.env.BONZO_API_KEY || "").trim();
  const base = { "Content-Type": "application/json", Accept: "application/json" };
  if (!key) return base;

  if (mode === "bearer") return Object.assign({}, base, { Authorization: "Bearer " + key });
  if (mode === "xapikey") return Object.assign({}, base, { "X-API-KEY": key });

  return Object.assign({}, base, { Authorization: "Bearer " + key });
}

async function bonzoFetch(path, opts) {
  opts = opts || {};
  const url = bonzoBase() + path;
  const headers = Object.assign({}, bonzoHeaders(), opts.headers || {});

  const authPreview = headers.Authorization
    ? "Authorization: " + String(headers.Authorization).slice(0, 40) + "..."
    : headers["X-API-KEY"]
    ? "X-API-KEY: " + String(headers["X-API-KEY"]).slice(0, 8) + "..."
    : "(none)";

  console.log("[bonzoFetch] " + (opts.method || "GET") + " " + url);
  console.log("[bonzoFetch] Auth preview: " + authPreview);

  const r = await fetch(url, Object.assign({}, opts, { headers }));
  const out = await readJsonOrText(r);

  console.log("[bonzoFetch] status: " + out.status);
  console.log("[bonzoFetch] body: " + JSON.stringify(out.json || out.text || "").slice(0, 500));

  return out;
}

async function bonzoGetProspectById(id) {
  const out = await bonzoFetch("/prospects/" + id, { method: "GET" });
  // Unwrap v3 { data: {...} }
  if (out.ok && out.json && out.json.data) out.json = out.json.data;
  return out;
}

async function bonzoPutProspectFull(id, obj) {
  const body = JSON.stringify(obj);

  console.log("[bonzoFetch] PUT payload keys:", Object.keys(obj || {}));
  console.log("[bonzoFetch] PUT payload preview:", body.slice(0, 1200));

  const out = await bonzoFetch("/prospects/" + id, { method: "PUT", body });

  // Unwrap v3 { data: {...} }
  if (out.ok && out.json && out.json.data) out.json = out.json.data;

  return out;
}

/**
 * NOTE: v3 "search by email" may not be reliable.
 * We add SAFETY GUARDS in /scan-bounces so this can never wipe your CRM again.
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

    if (Array.isArray(list) && list.length) return list;
  }

  return [];
}

// DEBUG ENDPOINT - remove once stable
app.get("/debug-bonzo", async (req, res) => {
  const secret = req.header("x-scan-secret");
  if (secret !== process.env.SCAN_SECRET) return res.status(401).send("Unauthorized");
  const id = req.query.id || "98725114";
  const mode = String(process.env.BONZO_AUTH_MODE || "bearer").toLowerCase();
  const keyLen = String(process.env.BONZO_API_KEY || "").trim().length;
  const keyPreview = String(process.env.BONZO_API_KEY || "").trim().slice(0, 20) + "...";
  const base = bonzoBase();
  console.log("[debug-bonzo] mode=" + mode + " base=" + base + " keyLen=" + keyLen);
  const out = await bonzoGetProspectById(id);
  return res.json({
    mode,
    base,
    keyPreview,
    keyLen,
    status: out.status,
    ok: out.ok,
    body: JSON.stringify(out.json || out.text || "").slice(0, 1000),
  });
});

// TEMP: verify Bonzo auth/header style from a browser
app.get("/debug-bonzo-auth", async (req, res) => {
  const secret = req.header("x-scan-secret");
  if (secret !== process.env.SCAN_SECRET) return res.status(401).send("Unauthorized");

  const id = req.query.id || "98725114";
  const key = String(process.env.BONZO_API_KEY || "").trim();
  const baseUrl = bonzoBase();
  const url = baseUrl + "/prospects/" + encodeURIComponent(id);

  async function tryReq(label, headers) {
    const r = await fetch(url, { method: "GET", headers });
    const out = await readJsonOrText(r);
    return { label, status: out.status, ok: out.ok, body: out.json || out.text || null };
  }

  const tests = [];
  tests.push(await tryReq("bearer", { Accept: "application/json", Authorization: "Bearer " + key }));
  tests.push(await tryReq("x-api-key", { Accept: "application/json", "X-API-KEY": key }));
  tests.push(await tryReq("x-api-key-lower", { Accept: "application/json", "x-api-key": key }));

  res.json({ baseUrl, url, keyLen: key.length, keyStartsWith: key.slice(0, 3), results: tests });
});

// =========================
// GOOGLE AUTH
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

    const byPhone = phoneDigits
      ? people.find(function (p) {
          return personHasPhone(p, phoneDigits);
        })
      : null;
    if (byPhone && byPhone.resourceName) return byPhone;

    const byEmail = email
      ? people.find(function (p) {
          return personHasEmail(p, email);
        })
      : null;
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
    names: [
      {
        givenName: (prospect && prospect.first_name) || "",
        familyName: (prospect && prospect.last_name) || "",
      },
    ],
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
      if (out.ok) {
        console.log("Updated Google contact:", out.json.resourceName);
        return out.json;
      }
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
  console.log("Created Google contact:", out.json.resourceName);
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
// OUTLOOK BOUNCE DETECTION (SAFE)
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

/**
 * HARD bounce = mailbox/user doesn't exist (safe to clear email)
 * SOFT bounce = connection refused, blocked, rate limited, temporary, etc (DO NOT clear)
 *
 * We decide using subject+preview text. This is intentionally strict.
 */
const HARD_BOUNCE_PATTERNS = [
  "user not found",
  "recipient not found",
  "no such user",
  "mailbox unavailable",
  "invalid recipient",
  "address rejected",
  "recipient does not exist",
  "unknown recipient",
  "550 5.1.1",
  "5.1.1",
  "smtp; 550",
];

const SOFT_BOUNCE_PATTERNS = [
  "refused to accept a connection",
  "connection refused",
  "try again later",
  "temporary",
  "temporarily",
  "timed out",
  "timeout",
  "rate limit",
  "too many",
  "blocked",
  "blacklist",
  "greylist",
  "graylist",
  "dns",
  "server unavailable",
  "service unavailable",
  "mail server is not responding",
  "target computer actively refused",
  "actively refused",
];

function classifyBounce(subject, preview) {
  const text = (String(subject || "") + " " + String(preview || "")).toLowerCase();

  const hardHit = HARD_BOUNCE_PATTERNS.some((p) => text.includes(p));
  const softHit = SOFT_BOUNCE_PATTERNS.some((p) => text.includes(p));

  if (hardHit && !softHit) return { kind: "hard", reason: "hard_pattern" };
  if (softHit) return { kind: "soft", reason: "soft_pattern" };
  // Unknown -> treat as soft (safe)
  return { kind: "soft", reason: "unknown_treated_as_soft" };
}

// Dedupe scanned Outlook message IDs for 1 hour
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
 * SAFETY CHANGE:
 * - Only auto-clean PHONE from Bonzo status updates (because Bonzo knows SMS failed/invalid).
 * - DO NOT auto-clean email here. Email cleanup ONLY happens in /scan-bounces (Outlook hard bounces only).
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

    const BAD = new Set(["failed", "bounced", "bounce", "undeliverable", "error", "rejected", "dropped", "blocked", "invalid", "spam"]);

    if (!prospectId) return res.status(200).json({ ok: true, skipped: true, reason: "no_prospect_id" });
    if (!BAD.has(status)) return res.status(200).json({ ok: true, skipped: true, reason: "status_not_bad" });

    // Only handle SMS here
    if (type !== "sms") {
      return res.status(200).json({ ok: true, skipped: true, reason: "email_cleanup_disabled_use_scan_bounces" });
    }

    const getOut = await bonzoGetProspectById(prospectId);
    if (!getOut.ok || !getOut.json) {
      console.log("Phone cleanup skipped: could not GET prospect", getOut.status, getOut.json || getOut.text);
      return res.status(200).json({ ok: true, skipped: true, reason: "get_failed" });
    }

    const current = getOut.json;

    // Build updated FULL object (your v3 PUT works this way)
    const updated = { ...current };
    updated.phone = null;
    updated.phone_type = "invalid";
    updated.tags = Array.from(new Set([...(updated.tags || []), "bad_phone"]));

    // Extra safety: never accidentally blank email from this handler
    if (updated.email !== current.email) updated.email = current.email;

    const putOut = await bonzoPutProspectFull(prospectId, updated);
    console.log("Phone cleanup result:", putOut.status, putOut.json || putOut.text);

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
        preview: String(m.bodyPreview || "").slice(0, 200),
      };
    });
    return res.json({ ok: true, mailbox, count: messages.length, messages });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String((e && e.message) || e) });
  }
});

/**
 * SAFE EMAIL CLEANUP:
 * - Only processes Outlook bounces
 * - Only clears email on HARD bounces (mailbox/user doesn't exist)
 * - Requires exact match: bounced email must equal current.email in Bonzo
 * - Safety limits:
 *    - maxCleansPerRun (default 10)
 *    - if search returns "too many" prospects, it skips
 */
app.post("/scan-bounces", async (req, res) => {
  const secret = req.header("x-scan-secret");
  if (!process.env.SCAN_SECRET) return res.status(500).send("Missing SCAN_SECRET");
  if (secret !== process.env.SCAN_SECRET) return res.status(401).send("Unauthorized");

  try {
    const mailbox = process.env.OUTLOOK_MAILBOX;
    if (!mailbox) return res.status(500).json({ ok: false, error: "Missing OUTLOOK_MAILBOX" });

    const top = Math.min(Math.max(Number((req.body && req.body.top) || 25), 1), 100);
    const maxCleansPerRun = Math.min(Math.max(Number((req.body && req.body.maxCleans) || 10), 0), 50);
    const maxMatchesSafety = Math.min(Math.max(Number((req.body && req.body.maxMatchesSafety) || 10), 1), 50);

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
      if (isSeen(m.id)) continue;
      markSeen(m.id);

      if (!isBounceSubject(m.subject)) continue;

      const subject = m.subject || "";
      const preview = m.bodyPreview || "";
      const classification = classifyBounce(subject, preview);

      const bouncedEmail = extractEmailFromText(preview) || extractEmailFromText(subject);
      if (!bouncedEmail) {
        results.push({ id: m.id, subject, kind: classification.kind, reason: classification.reason, action: "no_email_found" });
        continue;
      }

      if (classification.kind !== "hard") {
        results.push({
          id: m.id,
          subject,
          extractedEmail: bouncedEmail,
          kind: classification.kind,
          reason: classification.reason,
          action: "soft_or_unknown_skip",
        });
        continue;
      }

      if (maxCleansPerRun === 0 || totalCleans >= maxCleansPerRun) {
        results.push({
          id: m.id,
          subject,
          extractedEmail: bouncedEmail,
          kind: classification.kind,
          reason: classification.reason,
          action: "safety_stop_maxCleans_reached",
        });
        continue;
      }

      const prospects = await bonzoFindProspectsByEmail(bouncedEmail);

      // BIG SAFETY: if the API returns too many results, skip to prevent mass wipes.
      if (prospects.length > maxMatchesSafety) {
        console.log("[scan-bounces] SAFETY SKIP: too many matches for", bouncedEmail, prospects.length);
        results.push({
          id: m.id,
          subject,
          extractedEmail: bouncedEmail,
          kind: classification.kind,
          reason: classification.reason,
          action: "safety_skip_too_many_matches",
          matches: prospects.length,
        });
        continue;
      }

      if (!prospects.length) {
        results.push({
          id: m.id,
          subject,
          extractedEmail: bouncedEmail,
          kind: classification.kind,
          reason: classification.reason,
          action: "no_bonzo_match_found",
        });
        continue;
      }

      let cleanedCount = 0;
      let exactMatchCount = 0;

      for (const p of prospects) {
        if (totalCleans >= maxCleansPerRun) break;

        const pid = p && (p.id || (p.data && p.data.id) || p.prospectId || p.prospect_id);
        if (!pid) continue;

        const getOut = await bonzoGetProspectById(pid);
        if (!getOut.ok || !getOut.json) continue;

        const current = getOut.json;
        const currentEmail = normalizeEmail(current && current.email);

        // CRITICAL SAFETY: only clear if the bounced email EXACTLY matches the email on the record.
        if (!currentEmail || currentEmail !== normalizeEmail(bouncedEmail)) {
          continue;
        }

        exactMatchCount++;

        const updated = { ...current };
        updated.email = null;
        updated.tags = Array.from(new Set([...(updated.tags || []), "bad_email"]));

        // Extra safety: never blank phone in this handler
        if (updated.phone !== current.phone) updated.phone = current.phone;

        const putOut = await bonzoPutProspectFull(pid, updated);
        if (putOut.ok) {
          cleanedCount++;
          totalCleans++;
        }
      }

      results.push({
        id: m.id,
        subject,
        extractedEmail: bouncedEmail,
        kind: classification.kind,
        reason: classification.reason,
        action: cleanedCount > 0 ? "cleaned" : "no_exact_match_skip",
        matches: prospects.length,
        exactMatchCount,
        cleanedCount,
      });
    }

    return res.json({
      ok: true,
      scanned: items.length,
      bouncesProcessed: results.length,
      totalCleans,
      maxCleansPerRun,
      maxMatchesSafety,
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
