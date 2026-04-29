import express from "express";
import fetch from "node-fetch";

const app = express();
// Cowork: CORS for /meta/capi from turturhomeloans.com (server-side Meta event from /thanks)
app.use(function (req, res, next) {
  if (req.path === "/meta/capi") {
    var origin = req.headers.origin || "";
    var allow = [
      "https://turturhomeloans.com",
      "https://www.turturhomeloans.com"
    ];
    if (allow.indexOf(origin) !== -1) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
      res.setHeader("Access-Control-Max-Age", "600");
    }
    if (req.method === "OPTIONS") return res.status(204).end();
  }
  next();
});

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

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
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Tags in Bonzo sometimes come back as objects. Normalize to tag-name strings.
function getTagNames(tags) {
  const arr = Array.isArray(tags) ? tags : [];
  return arr
    .map((t) => {
      if (!t) return "";
      if (typeof t === "string") return t.trim();
      if (typeof t === "object") return String(t.name || t.title || "").trim();
      return String(t).trim();
    })
    .filter(Boolean);
}
function uniqTags(tags) {
  return Array.from(new Set([].concat(tags || []).map((t) => String(t).trim()).filter(Boolean)));
}
function addTags(existing, toAdd) {
  return uniqTags([...(existing || []), ...(toAdd || [])]);
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

/**
 * Guardrail: Retry Bonzo on transient failures (5xx / 429 / network).
 * - Retries: BONZO_RETRY_MAX (default 3)
 * - Backoff: BONZO_RETRY_BASE_MS (default 350ms), exponential + jitter
 * - Timeout: BONZO_TIMEOUT_MS (default 15000ms)
 */
async function bonzoFetch(path, opts) {
  opts = opts || {};
  const url = bonzoBase() + path;

  const headers = Object.assign({}, bonzoHeaders(), opts.headers || {});
  const method = opts.method || "GET";

  const authPreview = headers.Authorization
    ? "Authorization: " + String(headers.Authorization).slice(0, 40) + "..."
    : "(none)";

  const maxRetries = Math.min(Math.max(Number(process.env.BONZO_RETRY_MAX || 3), 0), 8);
  const baseDelay = Math.min(Math.max(Number(process.env.BONZO_RETRY_BASE_MS || 350), 50), 5000);
  const timeoutMs = Math.min(Math.max(Number(process.env.BONZO_TIMEOUT_MS || 15000), 2000), 60000);

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const attemptNum = attempt + 1;

    try {
      console.log(`[bonzoFetch] ${method} ${url}`);
      console.log("[bonzoFetch] Auth preview: " + authPreview);

      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), timeoutMs);

      const r = await fetch(
        url,
        Object.assign({}, opts, {
          headers,
          signal: ac.signal,
        })
      );

      clearTimeout(t);

      const out = await readJsonOrText(r);
      console.log("[bonzoFetch] status: " + out.status);
      console.log("[bonzoFetch] body: " + JSON.stringify(out.json || out.text || "").slice(0, 500));

      // Retry rules: 429 + 5xx
      const shouldRetry =
        !out.ok && (out.status === 429 || (out.status >= 500 && out.status <= 599));

      if (!shouldRetry || attempt === maxRetries) return out;

      const jitter = Math.floor(Math.random() * 150);
      const delay = baseDelay * Math.pow(2, attempt) + jitter;
      console.log(`[bonzoFetch] retrying in ${delay}ms (attempt ${attemptNum}/${maxRetries + 1})`);
      await sleep(delay);
      continue;
    } catch (e) {
      const msg = String((e && e.message) || e);
      const transient = msg.includes("aborted") || msg.includes("network") || msg.includes("fetch");

      if (!transient || attempt === maxRetries) {
        console.log("[bonzoFetch] exception:", msg);
        return { ok: false, status: 0, json: null, text: msg };
      }

      const jitter = Math.floor(Math.random() * 150);
      const delay = baseDelay * Math.pow(2, attempt) + jitter;
      console.log(`[bonzoFetch] exception retry in ${delay}ms: ${msg}`);
      await sleep(delay);
    }
  }

  return { ok: false, status: 0, json: null, text: "unknown_error" };
}

async function bonzoGetProspectById(id) {
  const out = await bonzoFetch("/prospects/" + encodeURIComponent(id), { method: "GET" });
  // Unwrap v3 { data: {...} }
  if (out.ok && out.json && out.json.data) out.json = out.json.data;
  return out;
}

// --- PATCH-first updater (fixes your “PUT overwrote fields” issue) ---
function sanitizePatch(patch) {
  const p = Object.assign({}, patch || {});
  // Remove undefined keys so we don't accidentally send them
  for (const k of Object.keys(p)) {
    if (typeof p[k] === "undefined") delete p[k];
  }
  // Always keep tags as simple string names
  if (Array.isArray(p.tags)) p.tags = uniqTags(getTagNames(p.tags));
  return p;
}

async function bonzoPatchProspect(id, patch) {
  const clean = sanitizePatch(patch);
  const body = JSON.stringify(clean);
  console.log("[bonzoFetch] PATCH payload keys:", Object.keys(clean || {}));
  console.log("[bonzoFetch] PATCH payload preview:", body.slice(0, 1200));
  const out = await bonzoFetch("/prospects/" + encodeURIComponent(id), { method: "PATCH", body });
  if (out.ok && out.json && out.json.data) out.json = out.json.data;
  return out;
}

// Fallback only if Bonzo rejects PATCH. We keep it safe by GET+merge+PUT.
async function bonzoPutProspectFull(id, obj) {
  const body = JSON.stringify(obj);
  console.log("[bonzoFetch] PUT payload keys:", Object.keys(obj || {}));
  console.log("[bonzoFetch] PUT payload preview:", body.slice(0, 1200));
  const out = await bonzoFetch("/prospects/" + encodeURIComponent(id), { method: "PUT", body });
  if (out.ok && out.json && out.json.data) out.json = out.json.data;
  return out;
}

// If PATCH works, we never risk wiping other fields.
// If PATCH is not allowed by Bonzo, we safely fall back.
async function bonzoUpdateProspect(id, patch) {
  const patchOut = await bonzoPatchProspect(id, patch);
  if (patchOut.ok) return patchOut;

  // Only fallback on “method not allowed / unsupported”
  const maybeUnsupported = patchOut.status === 405 || patchOut.status === 404 || patchOut.status === 400;
  if (!maybeUnsupported) return patchOut;

  console.log("[bonzoUpdateProspect] PATCH may be unsupported; falling back to GET+PUT merge.");

  const getOut = await bonzoGetProspectById(id);
  if (!getOut.ok || !getOut.json) return getOut;

  const current = getOut.json;
  const merged = { ...current };

  const clean = sanitizePatch(patch);
  for (const k of Object.keys(clean)) merged[k] = clean[k];

  // Ensure tags are unioned when patch contains tags; do not overwrite silently.
  if (clean.tags) {
    merged.tags = uniqTags(addTags(getTagNames(current.tags), clean.tags));
  } else {
    // Keep whatever Bonzo gave us
    merged.tags = current.tags;
  }

  return bonzoPutProspectFull(id, merged);
}

/**
 * Find prospects by email (LIST endpoint).
 * NOTE: In your logs this often returns "generic list" with email=null.
 * We treat this ONLY as a candidate list and always verify by GET /prospects/:id.
 */
async function bonzoFindProspectCandidatesByEmail(email) {
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
    return list;
  }

  return [];
}

function getProspectIdMaybe(p) {
  return p && (p.id || p.prospectId || p.prospect_id);
}

/**
 * Guardrail resolver:
 * - Take candidate list (which may be broad / email=null)
 * - GET each candidate prospect (capped) and keep ONLY exact email matches
 */
async function bonzoResolveExactProspectsByEmail(email, opts) {
  const target = normalizeEmail(email);
  if (!target) return [];

  const maxCandidates = Math.min(Math.max(Number((opts && opts.maxCandidates) || 25), 1), 200);
  const maxDetailChecks = Math.min(Math.max(Number((opts && opts.maxDetailChecks) || 10), 1), 50);
  const perItemDelayMs = Math.min(Math.max(Number((opts && opts.perItemDelayMs) || 80), 0), 500);

  const candidates = (await bonzoFindProspectCandidatesByEmail(target)).slice(0, maxCandidates);

  const exact = [];
  let checked = 0;

  for (const c of candidates) {
    if (checked >= maxDetailChecks) break;

    const pid = getProspectIdMaybe(c);
    if (!pid) continue;

    const getOut = await bonzoGetProspectById(pid);
    checked++;

    if (!getOut.ok || !getOut.json) continue;

    const current = getOut.json;
    const currentEmail = normalizeEmail(current && current.email);

    if (currentEmail && currentEmail === target) {
      exact.push(current);
    }

    if (perItemDelayMs) await sleep(perItemDelayMs);
  }

  return exact;
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
// GOOGLE DELETE (FIXED)
// Delete Google contact(s) created for a Bonzo prospect ID.
// Safety: Only deletes contacts whose biography contains "Source: Bonzo | ID: <id>".
// Now searches by: bonzoId + email + phone + digits + last10 (because bio search isn't reliable).
// =========================
function personHasBonzoId(person, bonzoId) {
  const needle = "Source: Bonzo | ID: " + String(bonzoId || "").trim();
  const bios = (person && person.biographies) || [];
  return bios.some((b) => String(b && b.value).includes(needle));
}

async function deleteGoogleContact(resourceName, accessToken) {
  const rn = ensurePeopleResourceName(resourceName);
  const url = "https://people.googleapis.com/v1/" + rn + ":deleteContact";
  const r = await fetch(url, { method: "DELETE", headers: { Authorization: "Bearer " + accessToken } });
  const out = await readJsonOrText(r);
  if (!out.ok) throw new Error("deleteContact failed: " + out.status);
  return true;
}

function buildGoogleDeleteQueries(bonzoId, email, phone) {
  const id = String(bonzoId || "").trim();
  const e = normalizeEmail(email);
  const pStored = normalizePhoneForStore(phone);
  const pDigits = digitsOnly(pStored);
  const pLast10 = last10Digits(pDigits);

  const queries = [];
  if (id) queries.push(id);
  if (e) queries.push(e);

  if (pStored) queries.push(pStored);
  if (pDigits) queries.push(pDigits);
  if (pLast10 && pLast10.length === 10) queries.push(pLast10);

  return Array.from(new Set(queries)).filter(Boolean);
}

async function deleteGoogleContactsForBonzoProspect(bonzoId, email, phone) {
  const id = String(bonzoId || "").trim();
  if (!id) return { ok: false, reason: "no_id", deleted: 0, checked: 0, searched: 0, queries: [] };

  const accessToken = await getGoogleAccessToken();
  const queries = buildGoogleDeleteQueries(id, email, phone);

  let candidates = [];
  for (const q of queries) {
    const people = await searchGoogleContacts(q, accessToken);
    candidates = candidates.concat(people || []);
  }

  // de-dupe by resourceName
  const byRn = new Map();
  for (const p of candidates) {
    if (p && p.resourceName) byRn.set(p.resourceName, p);
  }
  const uniqCandidates = Array.from(byRn.values());

  let deleted = 0;
  let checked = 0;

  for (const p of uniqCandidates) {
    if (!p || !p.resourceName) continue;

    const full = await getPerson(p.resourceName, accessToken);
    checked++;

    // absolute safety: only delete if our Bonzo ID marker is present in biography
    if (!personHasBonzoId(full, id)) continue;

    await deleteGoogleContact(full.resourceName, accessToken);
    deleted++;
  }

  return { ok: true, deleted, checked, searched: uniqCandidates.length, queries };
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
 * Fix: PATCH-only updates so we never wipe email/tags accidentally.
 *
 * Also deletes the Google contact we created (by matching biography "Source: Bonzo | ID: <id>").
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

    // Capture BEFORE clearing (so Google search has email/phone)
    const emailBefore = normalizeEmail(current && current.email);
    const phoneBefore = normalizePhoneForStore(current && current.phone);

    const currentTags = getTagNames(current.tags);
    const nextTags = addTags(currentTags, ["bad_phone"]); // ✅ always union

    // Clear phone only; do NOT send email field at all.
    const updOut = await bonzoUpdateProspect(prospectId, {
      phone: "",
      phone_type: "invalid",
      tags: nextTags,
    });

    // Best-effort Google delete (never break webhook)
    if (updOut && updOut.ok) {
      try {
        const del = await deleteGoogleContactsForBonzoProspect(prospectId, emailBefore, phoneBefore);
        console.log("[googleDelete] result:", del);
      } catch (e) {
        console.log("[googleDelete] skipped/error:", String((e && e.message) || e));
      }
    }

    console.log("Cleanup result:", updOut.status, updOut.json || updOut.text);
    return res.status(200).json({ ok: true, cleaned: updOut.ok, status: updOut.status });
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
 *
 * Guardrails included:
 * - seenMessageIds (de-dupe within ~1 hr)
 * - maxCleans cap
 * - maxMatchesSafety cap
 * - ALWAYS verify exact email by GET /prospects/:id before clearing
 * - optional dryRun
 *
 * Fix: PATCH-only updates so we never wipe phone/tags accidentally.
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

    // Optional: dry run (no writes)
    const dryRun = Boolean(req.body && req.body.dryRun);

    // Extra guardrail: only scan messages from last N days (default 14)
    const maxAgeDays = Math.min(Math.max(Number((req.body && req.body.maxAgeDays) || 14), 1), 90);
    const cutoffMs = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;

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

      // Age guardrail
      const receivedTs = Date.parse(m.receivedDateTime || "");
      if (Number.isFinite(receivedTs) && receivedTs < cutoffMs) {
        results.push({ id: m.id, subject: m.subject, action: "skip_old_message", receivedDateTime: m.receivedDateTime });
        continue;
      }

      if (!isBounceSubject(m.subject)) continue;

      const extracted = extractEmailFromText(m.bodyPreview) || extractEmailFromText(m.subject);
      const bouncedEmail = normalizeEmail(extracted);

      if (!bouncedEmail) {
        results.push({ id: m.id, subject: m.subject, extractedEmail: "", action: "no_email_found" });
        continue;
      }

      // Resolve exact matches by GET /prospects/:id (capped)
      const exactProspects = await bonzoResolveExactProspectsByEmail(bouncedEmail, {
        maxCandidates: 50,
        maxDetailChecks: Math.max(10, maxMatchesSafety * 4),
        perItemDelayMs: 80,
      });

      if (!exactProspects.length) {
        results.push({
          id: m.id,
          subject: m.subject,
          extractedEmail: bouncedEmail,
          action: "no_exact_matches_after_verify",
          exactVerified: 0,
        });
        continue;
      }

      const toClean = exactProspects.slice(0, maxMatchesSafety);

      let cleanedCount = 0;
      const cleanedIds = [];

      for (const p of toClean) {
        if (totalCleans >= maxCleans) break;

        const pid = p && (p.id || p.prospectId || p.prospect_id);
        if (!pid) continue;

        // Always re-GET right before writing (guardrail)
        const getOut = await bonzoGetProspectById(pid);
        if (!getOut.ok || !getOut.json) continue;

        const current = getOut.json;
        const currentEmail = normalizeEmail(current && current.email);

        // Absolute safety: only clear if it matches the bounced email
        if (!currentEmail || currentEmail !== bouncedEmail) continue;

        const nextTags = addTags(getTagNames(current.tags), ["bad_email"]); // ✅ unions even if bad_phone already exists

        if (dryRun) {
          cleanedCount++;
          cleanedIds.push(pid);
          continue;
        }

        // Clear email only; do NOT send phone field at all.
        const updOut = await bonzoUpdateProspect(pid, {
          email: "",
          tags: nextTags,
        });

        if (updOut.ok) {
          cleanedCount++;
          cleanedIds.push(pid);
          totalCleans++;
        }
      }

      results.push({
        id: m.id,
        subject: m.subject,
        extractedEmail: bouncedEmail,
        action: cleanedCount ? (dryRun ? "dry_run_would_clean" : "cleaned") : "no_safe_matches",
        exactVerified: exactProspects.length,
        cleanedCount,
        cleanedIds,
      });
    }

    return res.json({
      ok: true,
      dryRun,
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

// ----- Cowork: phase 1 health check (added by deployment script) -----
app.get("/ping", (req, res) => {
  res.status(200).json({
    ok: true,
    service: "bonzo-sync",
    message: "alive",
    timestamp: new Date().toISOString(),
  });
});



// =========================================================
// ATTRIBUTION + ARIVE-READY ENDPOINTS (added by Cowork)
// =========================================================

// Helper: hash for Meta CAPI (SHA-256 of normalized email/phone)
async function sha256Lower(s) {
  if (!s) return "";
  const data = new TextEncoder().encode(String(s).trim().toLowerCase());
  const hash = await (globalThis.crypto?.subtle?.digest("SHA-256", data));
  if (!hash) {
    // Fallback to Node's crypto module if Web Crypto unavailable
    const c = require("crypto");
    return c.createHash("sha256").update(String(s).trim().toLowerCase()).digest("hex");
  }
  return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// POST /lead/inbound — generic inbound webhook receiver for any lead source
// (ARIVE, Morty, WordPress forms, manual). Stores attribution in Bonzo.
//
// Auth: x-lead-code header must match LEAD_INBOUND_CODE env var.
//
// Body shape:
//   {
//     first_name, last_name, email, phone,
//     source, lead_source, lead_id,        // who sent + their identifier
//     gclid, fbclid, gbraid, wbraid,       // click IDs
//     utm_source, utm_medium, utm_campaign,
//     utm_term, utm_content,
//     page_url, page_referrer,             // landing page context
//     loan_amount, loan_purpose,           // mortgage-specific
//     value                                 // expected $ value (optional)
//   }
// POST /meta/capi — server-side Meta Conversions API event sender.
// Sends a Lead/Purchase/CompleteRegistration event to your Meta Pixel,
// using hashed email/phone for matching, with optional click_id/fbp/fbc.
//
// Auth: x-meta-code header must match LEAD_INBOUND_CODE env var.
//
// Body shape:
//   {
//     event_name: "Lead" | "Purchase" | "CompleteRegistration",
//     email, phone, first_name, last_name,
//     fbclid, client_ip, client_user_agent,
//     event_source_url, value, currency,
//     custom_data: { ... }
//   }
app.post("/meta/capi", async (req, res) => {
  try {
    // Cowork: accept either x-meta-code header OR Origin in allowlist (for /thanks page server-side fire)
    const _capiOrigin = (req.headers.origin || "").toLowerCase();
    const _capiAllowed = ["https://turturhomeloans.com", "https://www.turturhomeloans.com"];
    const _capiCodeOk = req.header("x-meta-code") === process.env.LEAD_INBOUND_CODE;
    const _capiOriginOk = _capiAllowed.indexOf(_capiOrigin) !== -1;
    if (!_capiCodeOk && !_capiOriginOk) {
      return res.status(401).send("Unauthorized");
    }
    const b = req.body || {};
    const eventName = b.event_name || "Lead";

    if (!process.env.META_PIXEL_ID || !process.env.META_ACCESS_TOKEN) {
      return res.status(500).json({ ok: false, error: "META_PIXEL_ID or META_ACCESS_TOKEN not configured" });
    }

    const userData = {};
    if (b.email) userData.em = [await sha256Lower(b.email)];
    if (b.phone) {
      const ph = String(b.phone).replace(/\D/g, "");
      if (ph) userData.ph = [await sha256Lower(ph)];
    }
    if (b.first_name) userData.fn = [await sha256Lower(b.first_name)];
    if (b.last_name) userData.ln = [await sha256Lower(b.last_name)];
    if (b.client_ip) userData.client_ip_address = b.client_ip;
    if (b.client_user_agent) userData.client_user_agent = b.client_user_agent;
    if (b.fbclid) userData.fbc = `fb.1.${Date.now()}.${b.fbclid}`;

    const evt = {
      event_name: eventName,
      event_time: Math.floor(Date.now() / 1000),
      action_source: "website",
      user_data: userData,
    };
    if (b.event_source_url) evt.event_source_url = b.event_source_url;
    if (b.value || b.currency) {
      evt.custom_data = Object.assign({},
        b.custom_data || {},
        b.value !== undefined ? { value: Number(b.value) } : {},
        b.currency ? { currency: b.currency } : {},
      );
    } else if (b.custom_data) {
      evt.custom_data = b.custom_data;
    }

    const url = `https://graph.facebook.com/v22.0/${process.env.META_PIXEL_ID}/events?access_token=${encodeURIComponent(process.env.META_ACCESS_TOKEN)}`;
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data: [evt] }),
    });
    const out = await readJsonOrText(r);
    if (!out.ok) {
      console.log("[meta/capi] FAILED:", out.status, out.json || out.text);
      return res.status(500).json({ ok: false, status: out.status, body: out.json || out.text });
    }
    console.log("[meta/capi] sent", eventName, "events_received:", out.json?.events_received);
    return res.status(200).json({ ok: true, response: out.json });
  } catch (err) {
    console.error("[meta/capi] error:", err);
    return res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

// =========================================================


// === COWORK PATCH 2026-04-29: enhanced /lead/inbound with attribution -> custom fields ===

// Extract a flat key->value map from any of the three supported body shapes:
//   1. Direct JSON: {email, gclid, utm_source, ...}
//   2. Elementor structured JSON: {form_id, form_name, fields:{email:{value}, gclid:{value}, ...}}
//   3. form-encoded with `form_fields[KEY]=VALUE` (Elementor default webhook)
function _coworkExtractAttribution(body) {
  const flat = {};
  if (!body || typeof body !== "object") return flat;

  // Shape A: Elementor structured JSON {fields:{name:{value}}}
  if (body.fields && typeof body.fields === "object" && !Array.isArray(body.fields)) {
    for (const [k, v] of Object.entries(body.fields)) {
      flat[k] = (v && typeof v === "object") ? (v.value ?? v.raw_value ?? "") : v;
    }
    if (body.form_id) flat.form_id = body.form_id;
    if (body.form_name) flat.form_name = body.form_name;
    return flat;
  }

  // Shape B: form-encoded parsed by qs (extended:true) -> body.form_fields is an object
  if (body.form_fields && typeof body.form_fields === "object" && !Array.isArray(body.form_fields)) {
    for (const [k, v] of Object.entries(body.form_fields)) {
      flat[k] = (v && typeof v === "object") ? (v.value ?? v.raw_value ?? "") : v;
    }
    if (body.form_id) flat.form_id = body.form_id;
    if (body.form_name) flat.form_name = body.form_name;
    // Carry over any sibling top-level keys too
    for (const [k, v] of Object.entries(body)) {
      if (k !== "form_fields" && !(k in flat)) flat[k] = v;
    }
    return flat;
  }

  // Shape C: literal-key form-encoded (extended:false) OR flat JSON
  for (const [k, v] of Object.entries(body)) {
    const m = k.match(/^form_fields\[([^\]]+)\]$/);
    if (m) {
      flat[m[1]] = v;
    } else {
      flat[k] = v;
    }
  }
  return flat;
}

function _coworkAttributionTags(flat) {
  return {
    lead_source: flat.lead_source || flat.utm_source || flat.form_name || "website",
    gclid: flat.gclid || "",
    fbclid: flat.fbclid || "",
    utm_source: flat.utm_source || "",
    utm_medium: flat.utm_medium || "",
    utm_campaign: flat.utm_campaign || "",
    utm_term: flat.utm_term || "",
    utm_content: flat.utm_content || "",
    landing_page: flat.landing_page || flat.page_url || "",
    page_referrer: flat.page_referrer || "",
  };
}

async function _coworkHandleInbound(req, res) {
  try {
    const flat = _coworkExtractAttribution(req.body);
    const email = (flat.email || "").toString().trim();
    const phone = (flat.phone || flat.phone_number || "").toString().trim();
    if (!email && !phone) {
      return res.status(400).json({ ok: false, error: "email or phone required" });
    }
    const attr = _coworkAttributionTags(flat);
    const first_name = flat.first_name || "";
    const last_name = flat.last_name || "";

    const bonzoBase = process.env.BONZO_BASE_URL || "https://app.getbonzo.com/api";
    const bonzoToken = process.env.BONZO_TOKEN || process.env.BONZO_API_KEY;
    const headers = {
      "Authorization": `Bearer ${bonzoToken}`,
      "Content-Type": "application/json",
      "Accept": "application/json",
      "User-Agent": "Mozilla/5.0 (compatible) bonzo-sync",
    };

    // Look up existing prospect by email or phone to decide create-vs-update
    // Bonzo only honors `?search=` for filtering (other params return all prospects).
    // Search returns matches across multiple fields, so we re-verify the email/phone match.
    function _norm(s) { return (s || "").toString().trim().toLowerCase(); }
    function _normPhone(s) {
      return (s || "").toString().replace(/[^0-9]/g, "").replace(/^1(\d{10})$/, "$1");
    }
    let existing = null;
    async function _findBy(searchTerm, kind) {
      const r = await fetch(`${bonzoBase}/prospects?search=${encodeURIComponent(searchTerm)}&per_page=10`, { headers });
      if (!r.ok) return null;
      const j = await r.json();
      const data = Array.isArray(j.data) ? j.data : [];
      const want = _norm(searchTerm);
      const wantPhone = _normPhone(searchTerm);
      for (const p of data) {
        if (kind === "email" && _norm(p.email) === want) return p;
        if (kind === "phone" && _normPhone(p.phone) === wantPhone) return p;
      }
      return null;
    }
    if (email) existing = await _findBy(email, "email");
    if (!existing && phone) existing = await _findBy(phone, "phone");

    // Build prospect payload (top-level fields keyed by label_normalized — what Bonzo's API accepts)
    const prospectPayload = {
      first_name, last_name, email: email || undefined, phone: phone || undefined,
      lead_source: attr.lead_source,
      gclid: attr.gclid || undefined,
      fbclid: attr.fbclid || undefined,
      utm_source: attr.utm_source || undefined,
      utm_medium: attr.utm_medium || undefined,
      utm_campaign: attr.utm_campaign || undefined,
      utm_term: attr.utm_term || undefined,
      utm_content: attr.utm_content || undefined,
      landing_page: attr.landing_page || undefined,
      page_referrer: attr.page_referrer || undefined,
    };

    let prospectId = null;
    let action = null;
    if (existing) {
      prospectId = existing.id;
      action = "updated";
      const r = await fetch(`${bonzoBase}/prospects/${prospectId}`, {
        method: "PUT",
        headers,
        body: JSON.stringify(prospectPayload),
      });
      if (!r.ok) {
        const t = await r.text();
        console.error("PUT prospect failed", r.status, t.slice(0, 500));
      }
    } else {
      const r = await fetch(`${bonzoBase}/prospects`, {
        method: "POST",
        headers,
        body: JSON.stringify(prospectPayload),
      });
      if (r.ok) {
        const j = await r.json();
        prospectId = (j.data && j.data.id) || j.id;
        action = "created";
      } else {
        const t = await r.text();
        console.error("POST prospect failed", r.status, t.slice(0, 500));
        return res.status(502).json({ ok: false, error: "bonzo_create_failed", status: r.status, body: t.slice(0, 300) });
      }
    }

    // Also leave a note for safekeeping (audit trail)
    if (prospectId) {
      try {
        const noteBody = "Cowork attribution capture:\n" + JSON.stringify(attr, null, 2);
        await fetch(`${bonzoBase}/prospects/${prospectId}/notes`, {
          method: "POST",
          headers,
          body: JSON.stringify({ note: noteBody }),
        });
      } catch (e) { /* ignore */ }
    }

    return res.json({
      ok: true,
      prospect_id: prospectId,
      action,
      attribution: attr,
      received_at: new Date().toISOString(),
    });
  } catch (e) {
    console.error("inbound error", e && e.stack || e);
    return res.status(500).json({ ok: false, error: e.message || String(e) });
  }
}

// Legacy endpoint with header auth (kept for backward compat)
app.post("/lead/inbound", (req, res) => {
  if (req.header("x-lead-code") !== process.env.LEAD_INBOUND_CODE) return res.status(401).send("Unauthorized");
  return _coworkHandleInbound(req, res);
});

// New path-based variant: Elementor can call this without custom headers
app.post("/lead/inbound/:code", (req, res) => {
  if (req.params.code !== process.env.LEAD_INBOUND_CODE) return res.status(401).send("Unauthorized");
  return _coworkHandleInbound(req, res);
});
// === END COWORK PATCH ===


// === COWORK 2026-04-29: /calendly endpoint — Calendly invitee.created webhook ===
function _coworkExtractCalendly(body) {
  // Calendly v2 webhook payload shape:
  //   { event: "invitee.created" | "invitee.canceled",
  //     created_at, payload: { uri, name, first_name, last_name, email,
  //                            timezone, questions_and_answers, tracking,
  //                            scheduled_event: { uri, name, start_time, end_time, location } } }
  if (!body || typeof body !== "object") return {};
  const p = body.payload || {};
  const tracking = p.tracking || {};
  const evt = p.scheduled_event || {};
  const event_type_name = evt.name || "Calendly Booking";
  const start = evt.start_time || "";
  return {
    email: p.email || "",
    phone: p.text_reminder_number || "",
    first_name: p.first_name || (p.name || "").split(" ")[0] || "",
    last_name: p.last_name || (p.name || "").split(" ").slice(1).join(" ") || "",
    lead_source: event_type_name + (start ? (" @ " + start) : ""),
    gclid: tracking.salesforce_uuid || "",
    utm_source: tracking.utm_source || "",
    utm_medium: tracking.utm_medium || "",
    utm_campaign: tracking.utm_campaign || "",
    utm_term: tracking.utm_term || "",
    utm_content: tracking.utm_content || "",
    landing_page: p.routing_form_uri || "",
    page_referrer: "",
    fbclid: "",
    calendly_event_uri: evt.uri || "",
    calendly_event_start_time: start,
    calendly_event_name: event_type_name,
  };
}

async function _coworkHandleCalendly(req, res) {
  try {
    const event = (req.body || {}).event || "";
    if (event && event !== "invitee.created" && event !== "invitee.canceled") {
      return res.status(200).json({ ok: true, ignored: event });
    }
    const flat = _coworkExtractCalendly(req.body);
    if (!flat.email && !flat.phone) {
      return res.status(400).json({ ok: false, error: "email or phone required (Calendly payload missing)" });
    }
    // Reuse the same handler as /lead/inbound — it handles dedupe + Bonzo prospect upsert
    req.body = flat;
    return _coworkHandleInbound(req, res);
  } catch (e) {
    console.error("calendly error", e && e.stack || e);
    return res.status(500).json({ ok: false, error: e.message || String(e) });
  }
}

app.post("/calendly", (req, res) => {
  if (req.header("x-calendly-code") !== process.env.LEAD_INBOUND_CODE) return res.status(401).send("Unauthorized");
  return _coworkHandleCalendly(req, res);
});
app.post("/calendly/:code", (req, res) => {
  if (req.params.code !== process.env.LEAD_INBOUND_CODE) return res.status(401).send("Unauthorized");
  return _coworkHandleCalendly(req, res);
});
// === END COWORK CALENDLY PATCH ===

// === COWORK 2026-04-29: /google-ads/upload-conversion ===
let _coworkAdsToken = null;
let _coworkAdsTokenExp = 0;
async function _coworkGetAdsToken() {
  const now = Date.now();
  if (_coworkAdsToken && now < _coworkAdsTokenExp - 60000) return _coworkAdsToken;
  const body = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    client_secret: process.env.GOOGLE_CLIENT_SECRET,
    refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
    grant_type: "refresh_token",
  }).toString();
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });
  if (!r.ok) throw new Error("OAuth refresh failed: HTTP " + r.status + " " + (await r.text()).slice(0,200));
  const j = await r.json();
  _coworkAdsToken = j.access_token;
  _coworkAdsTokenExp = now + ((j.expires_in || 3600) * 1000);
  return _coworkAdsToken;
}

async function _coworkHandleAdsUpload(req, res) {
  try {
    const b = req.body || {};
    const gclid = b.gclid || b.GCLID;
    if (!gclid) return res.status(400).json({ ok: false, error: "gclid required" });
    const value = parseFloat(b.conversion_value || b.value || 0);
    const currency = (b.currency_code || b.currency || "USD").toUpperCase();
    // conversion_time required by Google: RFC3339 with timezone, e.g. "2026-04-29 12:34:56-04:00"
    let ct = b.conversion_time || b.timestamp;
    if (!ct) {
      // Build "YYYY-MM-DD HH:mm:ss-04:00" from now
      const d = new Date();
      const pad = n => String(n).padStart(2,"0");
      const tz = -d.getTimezoneOffset();
      const sign = tz >= 0 ? "+" : "-";
      const tzh = pad(Math.floor(Math.abs(tz)/60));
      const tzm = pad(Math.abs(tz)%60);
      ct = d.getFullYear()+"-"+pad(d.getMonth()+1)+"-"+pad(d.getDate())+" "+
           pad(d.getHours())+":"+pad(d.getMinutes())+":"+pad(d.getSeconds())+sign+tzh+":"+tzm;
    }
    const orderId = b.order_id || b.gclid + "-" + Date.now();
    const convResource = "customers/" + process.env.GOOGLE_ADS_CUSTOMER_ID +
      "/conversionActions/" + (b.conversion_action_id || process.env.GOOGLE_ADS_FUNDED_LOAN_CONV_ID);
    const access = await _coworkGetAdsToken();
    const url = "https://googleads.googleapis.com/v20/customers/" +
      process.env.GOOGLE_ADS_CUSTOMER_ID + ":uploadClickConversions";
    const payload = {
      conversions: [{
        gclid: gclid,
        conversionAction: convResource,
        conversionDateTime: ct,
        conversionValue: value,
        currencyCode: currency,
        orderId: orderId
      }],
      partialFailure: true,
      validateOnly: !!b.validate_only
    };
    const r = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + access,
        "developer-token": process.env.GOOGLE_ADS_DEVELOPER_TOKEN,
        "login-customer-id": process.env.GOOGLE_ADS_MCC_ID,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });
    const text = await r.text();
    let parsed; try { parsed = JSON.parse(text); } catch { parsed = { raw: text.slice(0,800) }; }
    return res.status(r.ok ? 200 : 502).json({
      ok: r.ok,
      http: r.status,
      conversion_action_id: b.conversion_action_id || process.env.GOOGLE_ADS_FUNDED_LOAN_CONV_ID,
      sent: { gclid, value, currency, conversion_time: ct, order_id: orderId },
      google: parsed
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e && e.message || e) });
  }
}

// Path-based auth (same shape as /lead/inbound/:code) plus header-based fallback
app.post("/google-ads/upload-conversion/:code", express.json({limit:'50mb'}), function(req, res) {
  if (req.params.code !== process.env.LEAD_INBOUND_CODE) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }
  return _coworkHandleAdsUpload(req, res);
});
app.post("/google-ads/upload-conversion", express.json(), function(req, res) {
  const code = req.headers["x-lead-code"] || "";
  if (code !== process.env.LEAD_INBOUND_CODE) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }
  return _coworkHandleAdsUpload(req, res);
});
// === END COWORK ===

// === COWORK 2026-04-29: Past-Client Customer Match infrastructure ===
const _PCM_DISK = "/tmp/past_clients.json";
let _pcmCache = null;

const _coworkCrypto = require("crypto");
function _coworkSha256Hex(s) {
  return _coworkCrypto.createHash("sha256").update(String(s||"").toLowerCase().trim()).digest("hex");
}

function _coworkPCMLoad() {
  if (_pcmCache) return _pcmCache;
  try {
    const fs = require("fs");
    if (fs.existsSync(_PCM_DISK)) {
      _pcmCache = JSON.parse(fs.readFileSync(_PCM_DISK, "utf8"));
      return _pcmCache;
    }
  } catch (e) { console.error("PCM load:", e.message); }
  _pcmCache = { records: [], by_email_hash: {}, by_phone_hash: {}, generated: null };
  return _pcmCache;
}

function _coworkPCMSave() {
  try {
    const fs = require("fs");
    fs.writeFileSync(_PCM_DISK, JSON.stringify(_pcmCache));
  } catch (e) { console.error("PCM save:", e.message); }
}

function _coworkComputeSavings(rec, todayRate) {
  // rec: {original_loan_amount, original_rate, closing_date, loan_term_months}
  // todayRate: e.g. 6.5 (percent)
  try {
    const P = parseFloat(rec.original_loan_amount || 0);
    const origR = parseFloat(rec.original_rate || 0);
    const todayR = parseFloat(todayRate || 6.5);
    const term = parseInt(rec.loan_term_months || 360);
    if (!P || !origR || origR <= todayR) return null;
    const monthsElapsed = rec.closing_date ?
      Math.min(term - 1, Math.max(0, Math.floor(
        (Date.now() - new Date(rec.closing_date).getTime()) / (1000*60*60*24*30.4375)
      ))) : 0;
    const r1 = origR / 100 / 12;
    const r2 = todayR / 100 / 12;
    // Monthly P&I on original
    const pmt1 = P * r1 / (1 - Math.pow(1+r1, -term));
    // Estimated current balance (amortization)
    const bal = P * (Math.pow(1+r1, term) - Math.pow(1+r1, monthsElapsed)) / (Math.pow(1+r1, term) - 1);
    const remTerm = term - monthsElapsed;
    // New monthly P&I on remaining balance, new term (assume 30yr)
    const newTerm = 360;
    const pmt2 = bal * r2 / (1 - Math.pow(1+r2, -newTerm));
    const monthlySavings = pmt1 - pmt2;
    const totalSavings = monthlySavings * remTerm;
    const closingCosts = bal * 0.025; // 2.5% est
    const breakEvenMonths = monthlySavings > 0 ? Math.ceil(closingCosts / monthlySavings) : null;
    return {
      estimated_balance: Math.round(bal),
      current_pi: Math.round(pmt1*100)/100,
      new_pi: Math.round(pmt2*100)/100,
      monthly_savings: Math.round(monthlySavings*100)/100,
      total_savings: Math.round(totalSavings),
      break_even_months: breakEvenMonths,
      todays_rate: todayR
    };
  } catch (e) { return null; }
}

function _coworkPCMatch(email, phone) {
  const c = _coworkPCMLoad();
  const eh = email ? _coworkSha256Hex(email) : null;
  const ph = phone ? _coworkSha256Hex(String(phone).replace(/\D/g,"")) : null;
  if (eh && c.by_email_hash[eh]) return c.records[c.by_email_hash[eh]];
  if (ph && c.by_phone_hash[ph]) return c.records[c.by_phone_hash[ph]];
  return null;
}

// POST /customer-match/upload/:code — receive past-client list
app.post("/customer-match/upload/:code", express.json({limit: "50mb"}), function(req, res) {
  try {
    if (req.params.code !== process.env.LEAD_INBOUND_CODE) return res.status(401).json({ok:false, error:"Unauthorized"});
    const todayRate = parseFloat(req.body.todays_rate || 6.5);
    const records = req.body.records || [];
    if (!Array.isArray(records)) return res.status(400).json({ok:false, error:"records[] required"});
    const cache = { records: [], by_email_hash: {}, by_phone_hash: {}, generated: new Date().toISOString() };
    for (let i = 0; i < records.length; i++) {
      try {
        const r = records[i];
        const email = (r.email || "").toLowerCase().trim();
        const phoneClean = String(r.phone || "").replace(/\D/g,"");
        let savings = null;
        try { savings = _coworkComputeSavings(r, todayRate); } catch (sx) { savings = null; }
        let eh = null, ph = null;
        if (email) { try { eh = _coworkSha256Hex(email); } catch (hx) {} }
        if (phoneClean) { try { ph = _coworkSha256Hex(phoneClean); } catch (hx) {} }
        const stored = {
          idx: i, eh: eh, ph: ph,
          first_name: r.first_name || "",
          last_name: r.last_name || "",
          original_loan_amount: r.original_loan_amount || null,
          original_rate: r.original_rate || null,
          closing_date: r.closing_date || null,
          original_property_address: r.original_property_address || r.property_address || "",
          loan_type: r.loan_type || "",
          loan_purpose: r.loan_purpose || "",
          savings: savings
        };
        cache.records.push(stored);
        if (eh) cache.by_email_hash[eh] = i;
        if (ph) cache.by_phone_hash[ph] = i;
      } catch (rowErr) {
        console.error("[PCM upload row " + i + "]", rowErr && rowErr.message);
      }
    }
    _pcmCache = cache;
    try { _coworkPCMSave(); } catch (sx) { console.error("[PCM save]", sx.message); }
    return res.status(200).json({
      ok: true,
      records_stored: cache.records.length,
      with_email: Object.keys(cache.by_email_hash).length,
      with_phone: Object.keys(cache.by_phone_hash).length,
      with_savings: cache.records.filter(rr=>rr.savings).length
    });
  } catch (err) {
    console.error("[PCM upload]", err && err.stack || err);
    return res.status(500).json({ok:false, error: String(err && err.message || err), stack: String(err && err.stack || "").slice(0,1500)});
  }
});

// GET /customer-match/status/:code — health/diagnostic
app.get("/customer-match/status/:code", function(req, res) {
  if (req.params.code !== process.env.LEAD_INBOUND_CODE) return res.status(401).json({ok:false});
  const c = _coworkPCMLoad();
  return res.status(200).json({
    ok: true,
    generated: c.generated,
    record_count: c.records.length,
    with_email: Object.keys(c.by_email_hash).length,
    with_phone: Object.keys(c.by_phone_hash).length
  });
});

// === END COWORK Past-Client Customer Match ===
// === COWORK 2026-04-29: PCM v3 — match enrichment + past-client conversion variant ===
const _coworkPCMv3 = true;

// Wrap _coworkExtractAttribution to also enrich with past-client data
if (typeof _coworkExtractAttribution === "function" && typeof _coworkPCMatch === "function") {
  const _origExtract = _coworkExtractAttribution;
  _coworkExtractAttribution = function(body) {
    const flat = _origExtract(body);
    try {
      const email = (flat.email || "").toLowerCase().trim();
      const phone = String(flat.phone || flat.phone_number || "").replace(/\D/g, "");
      const match = _coworkPCMatch(email, phone);
      if (match) {
        // Tag this submission as a past-client re-engagement
        flat.lead_source = "Past Client - Re-engaged";
        flat.past_client_match = "yes";
        // Populate built-in mortgage fields with stored data
        if (match.original_loan_amount) flat.loan_amount = match.original_loan_amount;
        if (match.original_rate) flat.interest_rate = match.original_rate;
        if (match.original_property_address) flat.property_address = match.original_property_address;
        if (match.loan_type) flat.loan_type = match.loan_type;
        // Savings custom fields
        if (match.savings) {
          if (match.savings.monthly_savings != null) flat.estimated_monthly_savings = match.savings.monthly_savings;
          if (match.savings.total_savings != null) flat.estimated_total_savings = match.savings.total_savings;
          if (match.savings.monthly_savings > 0) flat.refinder_eligible = "yes";
        }
        flat.past_client_meta = {
          first_name_orig: match.first_name,
          last_name_orig: match.last_name,
          closing_date: match.closing_date,
          loan_purpose: match.loan_purpose
        };
        console.log("[PCM] match enriched email=" + (email.slice(0,3) + "***") + " savings=" + (match.savings && match.savings.monthly_savings));
      }
    } catch (e) { console.error("[PCM] enrich error:", e.message); }
    return flat;
  };
}
// === END COWORK PCM v3 ===


app.listen(process.env.PORT || 3000, () => {
  console.log("Server running");
});
