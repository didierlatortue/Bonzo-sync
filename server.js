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
  // IMPORTANT: BONZO_BASE_URL=https://app.getbonzo.com/api/v3
  return String(process.env.BONZO_BASE_URL || "https://app.getbonzo.com/api/v3").replace(/\/+$/, "");
}
function bonzoHeaders() {
  const key = String(process.env.BONZO_API_KEY || "").trim();
  const base = { "Content-Type": "application/json", Accept: "application/json" };
  if (!key) return base;
  // Your token works as Bearer against v3.
  return Object.assign({}, base, { Authorization: "Bearer " + key });
}
async function bonzoFetch(path, opts) {
  opts = opts || {};
  const url = bonzoBase() + path;
  const headers = Object.assign({}, bonzoHeaders(), opts.headers || {});

  const authPreview = headers.Authorization
    ? "Authorization: " + String(headers.Authorization).slice(0, 40) + "..."
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
  const out = await bonzoFetch("/prospects/" + encodeURIComponent(id), { method: "GET" });
  // Unwrap v3 { data: {...} }
  if (out.ok && out.json && out.json.data) out.json = out.json.data;
  return out;
}
async function bonzoPutProspectFull(id, obj) {
  const body = JSON.stringify(obj);
  console.log("[bonzoFetch] PUT payload keys:", Object.keys(obj || {}));
  console.log("[bonzoFetch] PUT payload preview:", body.slice(0, 1200));
  const out = await bonzoFetch("/prospects/" + encodeURIComponent(id), { method: "PUT", body });
  if (out.ok && out.json && out.json.data) out.json = out.json.data;
  return out;
}

/**
 * SAFE UPDATE:
 * Bonzo v3 behaves like PUT=replace, so we always GET, merge, then PUT full.
 * This prevents wiping fields (like the “deleted all emails” incident).
 */
async function bonzoSafeUpdateProspect(id, patch) {
  const getOut = await bonzoGetProspectById(id);
  if (!getOut.ok || !getOut.json) return getOut;

  const current = getOut.json;
  const updated = { ...current };

  // Merge patch (top-level only)
  for (const k of Object.keys(patch || {})) updated[k] = patch[k];

  // Ensure tags are de-duped if provided
  if (patch && patch.tags) {
    updated.tags = Array.from(new Set([].concat(patch.tags || []))).filter(Boolean);
  } else {
    updated.tags = Array.from(new Set([].concat(updated.tags || []))).filter(Boolean);
  }

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
  const out = await bonzoGetProspectById(id);
  return res.json({
    base,
    keyLen,
    status: out.status,
    ok: out.ok,
    body: JSON.stringify(out.json || out.text || "").slice(0, 1200),
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
    const tags = Array.from(new Set([...(current.tags || []), "bad_phone"]));

    // Some CRMs won’t clear with null; empty string is safer.
    const putOut = await bonzoSafeUpdateProspect(prospectId, {
      phone: "",
      phone_type: "invalid",
      tags,
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

      if (!isBounceSubject(m.subject)) continue;

      const extracted = extractEmailFromText(m.bodyPreview) || extractEmailFromText(m.subject);
      const bouncedEmail = normalizeEmail(extracted);

      if (!bouncedEmail) {
        results.push({ id: m.id, subject: m.subject, extractedEmail: "", action: "no_email_found" });
        continue;
      }

      let matches = await bonzoFindProspectsByEmail(bouncedEmail);

      // If search returned broad results, filter exact email matches again here
      const exactMatches = matches.filter((p) => normalizeEmail(p && p.email) === bouncedEmail);

      // Safety: if too many results and no exact matches, do nothing
      if (!exactMatches.length && matches.length > maxMatchesSafety) {
        console.log("[scan-bounces] SAFETY SKIP: too many matches for", bouncedEmail, matches.length);
        results.push({
          id: m.id,
          subject: m.subject,
          extractedEmail: bouncedEmail,
          action: "safety_skip_too_many_matches",
          matches: matches.length,
          exactMatches: 0,
        });
        continue;
      }

      // Prefer exact matches; otherwise, proceed with what we have (but capped)
      const toClean = (exactMatches.length ? exactMatches : matches).slice(0, maxMatchesSafety);

      let cleanedCount = 0;
      for (const p of toClean) {
        if (totalCleans >= maxCleans) break;

        const pid = p && (p.id || p.prospectId || p.prospect_id);
        if (!pid) continue;

        const getOut = await bonzoGetProspectById(pid);
        if (!getOut.ok || !getOut.json) continue;

        const current = getOut.json;
        const currentEmail = normalizeEmail(current && current.email);

        // Extra safety: only clear if it matches the bounced email
        if (currentEmail && currentEmail !== bouncedEmail) continue;

        const tags = Array.from(new Set([...(current.tags || []), "bad_email"]));

        const putOut = await bonzoSafeUpdateProspect(pid, {
          email: "",
          tags,
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
        action: cleanedCount ? "cleaned" : "no_safe_matches",
        matches: matches.length,
        exactMatches: exactMatches.length,
        cleanedCount,
      });
    }

    return res.json({
      ok: true,
      scanned: items.length,
      bouncesProcessed: results.length,
      totalCleans,
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
