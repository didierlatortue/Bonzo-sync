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
  if (out.ok && out.json && out.json.data) out.json = out.json.data; // unwrap v3
  return out;
}

/**
 * IMPORTANT:
 * We do NOT PUT the full object anymore.
 * We send a minimal PATCH-like payload: { data: { ...fields } }
 * to avoid wiping anything unintentionally.
 */
async function bonzoSafeUpdateProspect(id, dataFields) {
  const payload = { data: Object.assign({}, dataFields) };
  const body = JSON.stringify(payload);

  console.log("[bonzoFetch] PUT payload preview:", body.slice(0, 600));

  const out = await bonzoFetch("/prospects/" + id, { method: "PUT", body });
  if (out.ok && out.json && out.json.data) out.json = out.json.data;
  return out;
}

/**
 * Find prospects by email (Bonzo may return a page of results).
 * We will FILTER LOCALLY for exact email matches.
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
      (Array.isArray(j) && j) ||
      [];

    if (!Array.isArray(list) || !list.length) continue;

    // LOCAL EXACT-MATCH FILTER
    const exact = list.filter((p) => normalizeEmail(p && p.email) === e);
    if (exact.length) return exact;

    // If no exact matches, return empty (do NOT mass clean)
    return [];
  }

  return [];
}

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
  return ((out.json && out.json.results) || []).map((x) => x.person).filter(Boolean);
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
  return ((person && person.emailAddresses) || []).some((e) => normalizeEmail(e && e.value) === email);
}

function personHasPhone(person, phoneDigits) {
  if (!phoneDigits) return false;
  const targetDigits = digitsOnly(phoneDigits);
  const targetLast10 = last10Digits(targetDigits);
  return ((person && person.phoneNumbers) || []).some((p) => {
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
    queries.push(phoneStored, phoneDigits);
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

const seenMessageIds = new Map();
function markSeen(id) { if (id) seenMessageIds.set(id, Date.now()); }
function isSeen(id) { return id ? seenMessageIds.has(id) : false; }
setInterval(() => {
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
 * Auto-clean for SMS only (Bonzo knows SMS invalid).
 * Email is cleaned via Outlook scan-bounces only.
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

    // Only act on SMS failures (safe). Email handled by Outlook scan.
    const BAD = new Set(["failed", "bounced", "bounce", "undeliverable", "error", "rejected", "dropped", "blocked", "invalid", "spam"]);

    if (!prospectId) return res.status(200).json({ ok: true, skipped: true, reason: "no_prospect_id" });
    if (!BAD.has(status)) return res.status(200).json({ ok: true, skipped: true, reason: "status_not_bad" });
    if (type !== "sms") return res.status(200).json({ ok: true, skipped: true, reason: "only_sms_autoclean" });

    const getOut = await bonzoGetProspectById(prospectId);
    if (!getOut.ok || !getOut.json) return res.status(200).json({ ok: true, skipped: true, reason: "get_failed" });

    const current = getOut.json;
    const tags = Array.from(new Set([...(current.tags || []), "bad_phone"]));

    const putOut = await bonzoSafeUpdateProspect(prospectId, {
      phone: null,
      phone_type: "invalid",
      tags
    });

    console.log("Cleanup result:", putOut.status, putOut.json || putOut.text);
    return res.status(200).json({ ok: true, cleaned: putOut.ok, status: putOut.status });
  } catch (err) {
    console.error("Cleanup error:", err);
    return res.status(200).json({ ok: false, error: "exception" });
  }
});

app.post("/scan-bounces", async (req, res) => {
  const secret = req.header("x-scan-secret");
  if (!process.env.SCAN_SECRET) return res.status(500).send("Missing SCAN_SECRET");
  if (secret !== process.env.SCAN_SECRET) return res.status(401).send("Unauthorized");

  try {
    const mailbox = process.env.OUTLOOK_MAILBOX;
    if (!mailbox) return res.status(500).json({ ok: false, error: "Missing OUTLOOK_MAILBOX" });

    const top = Math.min(Math.max(Number((req.body && req.body.top) || 25), 1), 100);
    const maxCleans = Math.min(Math.max(Number((req.body && req.body.maxCleans) || 10), 1), 50);

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

      const bouncedEmail = extractEmailFromText(m.bodyPreview) || extractEmailFromText(m.subject);
      if (!bouncedEmail) {
        results.push({ id: m.id, subject: m.subject, extractedEmail: "", action: "no_email_found" });
        continue;
      }

      if (totalCleans >= maxCleans) {
        results.push({ id: m.id, subject: m.subject, extractedEmail: bouncedEmail, action: "limit_reached" });
        continue;
      }

      const prospects = await bonzoFindProspectsByEmail(bouncedEmail);
      console.log("[scan-bounces] email", bouncedEmail, "exactMatches", prospects.length);

      if (!prospects.length) {
        results.push({ id: m.id, subject: m.subject, extractedEmail: bouncedEmail, action: "no_exact_bonzo_match" });
        continue;
      }

      let cleanedCount = 0;
      for (const p of prospects) {
        if (totalCleans >= maxCleans) break;
        const pid = p && p.id;
        if (!pid) continue;

        const currentTags = Array.isArray(p.tags) ? p.tags : [];
        const tags = Array.from(new Set([...currentTags, "bad_email"]));

        const putOut = await bonzoSafeUpdateProspect(pid, {
          email: null,
          tags
        });

        if (putOut.ok) {
          cleanedCount++;
          totalCleans++;
        }
      }

      results.push({
        id: m.id,
        subject: m.subject,
        extractedEmail: bouncedEmail,
        action: cleanedCount ? "cleaned" : "no_changes",
        exactMatches: prospects.length,
        cleanedCount
      });
    }

    return res.json({
      ok: true,
      scanned: items.length,
      bouncesProcessed: results.length,
      totalCleans,
      maxCleans,
      results
    });
  } catch (e) {
    console.error("scan-bounces error:", e);
    return res.status(500).json({ ok: false, error: String((e && e.message) || e) });
  }
});

app.get("/", (req, res) => res.status(200).send("ok"));
app.listen(process.env.PORT || 3000, () => console.log("Server running"));
