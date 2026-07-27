import express from "express";
import fs from "fs";
import fetch from "node-fetch";

import { createHash as _coworkCreateHash } from "crypto";
const app = express();
// Cowork: CORS for /meta/capi from turturhomeloans.com (server-side Meta event from /thanks)
app.use(function (req, res, next) {
  if (req.path === "/meta/capi" || req.path.indexOf("/lead/inbound") === 0) {
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

// === COWORK 2026-05-11: read attribution (gclid/fbclid/utm) from Bonzo prospect notes ===
// /lead/inbound writes a note prefixed "Cowork attribution capture:" with JSON.
// Returns {gclid, fbclid, utm_source, utm_medium, utm_campaign, utm_term, utm_content, landing_page}
// or {} if no matching note found.
// Read attribution (gclid/fbclid/utm) from a Bonzo prospect.
// Source priority: 1) prospect.tags (set by /lead/inbound as "gclid:VALUE" etc.),
//                  2) prospect notes scan (legacy audit trail), if no tags found.
// Pass the prospect object if you already have it (avoids one API call).
// Cowork 2026-06-04: extract a click-id (gclid/gbraid/wbraid) from a landing-page URL.
function _coworkClickIdFromUrl(url, key) {
  try { return new URL(String(url)).searchParams.get(key) || ""; } catch (e) { return ""; }
}
function _coworkFillClickIdsFromLandingPage(obj) {
  const lp = (obj && (obj.landing_page || obj.page_url)) || "";
  if (!lp) return obj;
  for (const k of ["gclid", "gbraid", "wbraid"]) {
    if (!obj[k]) { const v = _coworkClickIdFromUrl(lp, k); if (v) obj[k] = v; }
  }
  return obj;
}

async function bonzoGetAttribution(prospectId, prospect) {
  // 1. Tag-based lookup (preferred — no extra API call needed)
  try {
    let tags = null;
    if (prospect && Array.isArray(prospect.tags)) {
      tags = getTagNames(prospect.tags);
    } else {
      const fetched = await bonzoGetProspectById(prospectId);
      if (fetched.ok && fetched.json && Array.isArray(fetched.json.tags)) {
        tags = getTagNames(fetched.json.tags);
      }
    }
    if (tags && tags.length) {
      const out = {};
      const hexdecode = (s) => { try { return Buffer.from(String(s), "hex").toString("utf8"); } catch (e) { return ""; } };
      for (const t of tags) {
        // Match "key:value" or "key:hex:hexvalue".
        // Bonzo lowercases tag values; gclids are case-sensitive — so we hex-encode them.
        // Hex output is [0-9a-f], already lowercase, so survives Bonzo's normalization.
        const m = String(t).match(/^(gclid|gbraid|wbraid|fbclid|utm_source|utm_medium|utm_campaign|utm_term|utm_content):(hex:)?(.+)$/i);
        if (m) {
          const key = m[1].toLowerCase();
          out[key] = m[2] ? hexdecode(m[3]) : m[3];
        }
      }
      if (out.gclid || out.gbraid || out.wbraid || out.fbclid || out.utm_source) {
        console.log("[bonzoGetAttribution] tag-based hit for prospect " + prospectId + " keys=" + Object.keys(out).join(","));
        return out;
      }
    }
  } catch (e) {
    console.warn("[bonzoGetAttribution] tag lookup error:", e && e.message);
  }
  // 2. Notes fallback (legacy)
  try {
    const out = await bonzoFetch("/prospects/" + encodeURIComponent(prospectId) + "/notes?per_page=50", { method: "GET" });
    if (!out.ok) return {};
    const list = (out.json && (out.json.data || out.json)) || [];
    if (!Array.isArray(list)) return {};
    for (const n of list) {
      const rawBody = (n && (n.note || n.body || n.content || n.text)) || "";
      // Cowork 2026-06-04: Bonzo HTML-escapes note bodies (&#34; &#61; &amp;) — decode before JSON.parse
      const body = String(rawBody)
        .replace(/&#34;|&quot;/g, '"').replace(/&#61;/g, "=")
        .replace(/&#39;/g, "'").replace(/&amp;/g, "&");
      const m = String(body).match(/Cowork attribution capture:\s*([\s\S]+)$/);
      if (m) {
        try {
          let obj = JSON.parse(m[1]);
          // Cowork 2026-06-04: iOS clicks carry gbraid (not gclid) — recover braid ids from the landing_page URL
          obj = _coworkFillClickIdsFromLandingPage(obj);
          if (obj && (obj.gclid || obj.gbraid || obj.wbraid || obj.fbclid || obj.utm_source || obj.lead_source)) {
            console.log("[bonzoGetAttribution] notes-based hit for prospect " + prospectId);
            return obj;
          }
        } catch (e) { /* not JSON, skip */ }
      }
    }
    return {};
  } catch (e) {
    console.warn("[bonzoGetAttribution] notes lookup error:", e && e.message);
    return {};
  }
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
// === COWORK 2026-06-03: Postgres-keyed dedupe helpers (google_contacts cache) ===
// Bypasses People API searchContacts (~30s–min indexing lag) by caching
// (bonzo_id -> resource_name, etag) in Neon. See feedback_googlecontacts_searchcontacts_lag.
async function pgGetGoogleContactByBonzoId(bonzoId) {
  if (!bonzoId) return null;
  const pool = await _pgGetPool();
  if (!pool) return null;
  try {
    const { rows } = await pool.query(
      "SELECT resource_name, etag FROM google_contacts WHERE bonzo_id = $1",
      [String(bonzoId)]
    );
    return rows[0] || null;
  } catch (e) {
    console.error("[GC-cache] get failed:", e.message);
    return null;
  }
}
async function pgUpsertGoogleContactCache(bonzoId, resourceName, email, phoneLast10, etag) {
  if (!bonzoId || !resourceName) return;
  const pool = await _pgGetPool();
  if (!pool) return;
  try {
    await pool.query(
      `INSERT INTO google_contacts (bonzo_id, resource_name, email, phone_last10, etag, updated_at)
       VALUES ($1,$2,$3,$4,$5, NOW())
       ON CONFLICT (bonzo_id) DO UPDATE
         SET resource_name = EXCLUDED.resource_name,
             email = EXCLUDED.email,
             phone_last10 = EXCLUDED.phone_last10,
             etag = EXCLUDED.etag,
             updated_at = NOW()`,
      [String(bonzoId), resourceName, email || null, phoneLast10 || null, etag || null]
    );
  } catch (e) {
    console.error("[GC-cache] upsert failed:", e.message);
  }
}
async function pgDeleteGoogleContactCache(bonzoId) {
  if (!bonzoId) return;
  const pool = await _pgGetPool();
  if (!pool) return;
  try {
    await pool.query("DELETE FROM google_contacts WHERE bonzo_id = $1", [String(bonzoId)]);
  } catch (e) {
    console.error("[GC-cache] delete failed:", e.message);
  }
}

async function upsertGoogleContact(prospect) {
  if (nameLooksLikePhone(prospect && prospect.first_name, prospect && prospect.last_name)) return;
  const phoneStored = normalizePhoneForStore(prospect && prospect.phone);
  const phoneDigits = digitsOnly(phoneStored);
  if (!phoneDigits) return;
  const email = normalizeEmail(prospect && prospect.email);
  const bonzoId = (prospect && prospect.id) ? String(prospect.id) : "";
  const phoneLast10 = last10Digits(phoneDigits);
  const accessToken = await getGoogleAccessToken();
  const body = {
    names: [{ givenName: (prospect && prospect.first_name) || "", familyName: (prospect && prospect.last_name) || "" }],
    emailAddresses: email ? [{ value: email }] : [],
    phoneNumbers: [{ value: phoneStored || phoneDigits }],
    biographies: [{ value: "Source: Bonzo | ID: " + bonzoId }],
    organizations: [{ name: "Home Loans", title: "Lead" }],
  };

  // === COWORK 2026-06-03: Postgres cache fast path ===
  // Look up resource_name by bonzo_id. If present, PATCH directly — skips
  // searchContacts entirely (which has eventual-consistency indexing lag
  // that produced duplicate contacts under back-to-back Bonzo events).
  const cached = await pgGetGoogleContactByBonzoId(bonzoId);
  if (cached && cached.resource_name) {
    try {
      const rn = ensurePeopleResourceName(cached.resource_name);
      const updateUrl =
        "https://people.googleapis.com/v1/" + rn + ":updateContact" +
        "?updatePersonFields=names,emailAddresses,phoneNumbers,biographies,organizations";
      let fastPathDone = false;
      for (let attempt = 1; attempt <= 2; attempt++) {
        let etag = (attempt === 1 && cached.etag) ? cached.etag : null;
        if (!etag) {
          try { const p = await getPerson(rn, accessToken); etag = p && p.etag; }
          catch (gpErr) {
            // 404 from getPerson means the contact was deleted out-of-band
            if (/404/.test(String(gpErr && gpErr.message))) {
              await pgDeleteGoogleContactCache(bonzoId);
              fastPathDone = "fallthrough";
              break;
            }
            throw gpErr;
          }
        }
        const r = await fetch(updateUrl, {
          method: "PATCH",
          headers: Object.assign(
            { Authorization: "Bearer " + accessToken, "Content-Type": "application/json" },
            etag ? { "If-Match": etag } : {}
          ),
          body: JSON.stringify(Object.assign({}, body, { etag })),
        });
        const out = await readJsonOrText(r);
        if (out.ok) {
          await pgUpsertGoogleContactCache(bonzoId, rn, email, phoneLast10, out.json && out.json.etag);
          return out.json;
        }
        if (out.status === 412 && attempt === 1) continue;
        if (out.status === 404) {
          await pgDeleteGoogleContactCache(bonzoId);
          fastPathDone = "fallthrough";
          break;
        }
        console.warn("[GC-fast-path] PATCH failed status=" + out.status + " — falling through");
        fastPathDone = "fallthrough";
        break;
      }
      if (fastPathDone !== "fallthrough") {
        // Shouldn't reach here, but be defensive
        console.warn("[GC-fast-path] exited unexpectedly — falling through");
      }
    } catch (e) {
      console.warn("[GC-fast-path] threw:", e && e.message, "— falling through");
    }
  }

  // === Slow path (legacy) — searchContacts dedupe + create ===
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
        await pgUpsertGoogleContactCache(bonzoId, rn, email, phoneLast10, out.json && out.json.etag);
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
  await pgUpsertGoogleContactCache(
    bonzoId,
    out.json && out.json.resourceName,
    email,
    phoneLast10,
    out.json && out.json.etag
  );
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

  // COWORK 2026-06-03: clear Postgres cache row so next event re-creates cleanly
  try { await pgDeleteGoogleContactCache(id); } catch (e) {}

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
// COWORK 2026-05-14: GA4 Measurement Protocol helper
// =========================
// Fires server-side events to GA4. Requires GA4_MP_API_SECRET in Render env
// (created in GA4 Admin → Data Streams → Measurement Protocol API secrets).
// Safe no-op if the secret isn't set — logs a warning and returns { skipped: true }.
async function postGa4Event(clientId, eventName, params) {
  const mid = process.env.GA4_MEASUREMENT_ID || "G-W459HY2LVE";
  const sec = process.env.GA4_MP_API_SECRET;
  if (!sec) { console.warn("[GA4-MP] skip " + eventName + " — missing GA4_MP_API_SECRET"); return { skipped: true }; }
  const url = "https://www.google-analytics.com/mp/collect?measurement_id=" + mid +
              "&api_secret=" + sec;
  const body = {
    client_id: String(clientId || "anonymous"),
    events: [{ name: eventName, params: params || {} }]
  };
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    console.log("[GA4-MP] " + eventName + " status=" + r.status + " client_id=" + body.client_id);
    return { ok: r.ok, status: r.status };
  } catch (e) {
    console.error("[GA4-MP] " + eventName + " err:", e && e.message);
    return { ok: false, error: e && e.message };
  }
}

// =========================
// ROUTES
// =========================
app.post("/bonzo/events", async (req, res) => {
  try {
    if (req.header("x-bonzo-code") !== process.env.BONZO_CODE) return res.status(401).send("Unauthorized");
    const { event, prospect } = req.body;
    console.log("Bonzo event:", event);
    if (["prospects.created", "prospects.updated"].includes(event)) {
      await upsertGoogleContact(prospect);

      // === COWORK 2026-05-11: detect ARIVE-driven prospects via pipeline routing ===
      // The Zapier "Create Prospect in Pipeline Stage" action does NOT expose a lead_source
      // field — Bonzo's "Google Ads Lead to Loan" pipeline (id 44539) is the signal that the
      // prospect came via the ARIVE flow. Stage names tell us which event:
      //   "Application Completed*"   → 1003 submitted, fire qualified_application conv
      //   "Funded*"                  → funded loan, fire funded_loan conv (revenue uplift)
      // Phase 2.5 will read gclid (from prior /lead/inbound form submission, looked up by email)
      // and fire Google Ads offline conv + Meta CAPI from here.
      try {
        const pipeline = prospect && prospect.pipeline || {};
        const stage    = prospect && prospect.pipeline_stage || {};
        const isAriveLoanPipeline =
          pipeline.id === 44539 ||
          /Google Ads Lead to Loan/i.test(pipeline.name || "");
        if (isAriveLoanPipeline) {
          const stageName = String(stage.name || "");
          let kind = "ARIVE_UNKNOWN";
          if (/Application\s*Completed/i.test(stageName)) kind = "ARIVE_APPLICATION";
          else if (/Funded/i.test(stageName))              kind = "ARIVE_FUNDED";
          else if (/Approved|CTC|Clear\s*to\s*Close/i.test(stageName)) kind = "ARIVE_APPROVED";
          console.log("[ARIVE-source prospect detected]", JSON.stringify({
            kind,
            event,
            prospect_id: prospect.id,
            email: prospect.email,
            phone: prospect.phone,
            source_field: prospect.source,
            pipeline: pipeline,
            pipeline_stage: stage,
            tags: prospect.tags,
            custom: prospect.custom,
            mortgage_loan_amount: prospect.mortgage && prospect.mortgage.loan_amount,
          }));
          // Phase 2.5: fan out to Google Ads offline conv + Meta CAPI
          // Look up gclid from the original /lead/inbound attribution note (form submission)
          setImmediate(async () => {
            try {
              const attr = await bonzoGetAttribution(prospect.id, prospect);
              const gclid = attr.gclid || "";
              const gbraid = attr.gbraid || "";
              const wbraid = attr.wbraid || "";
              if (!gclid && !gbraid && !wbraid) {
                console.log("[ARIVE-fanout] no gclid/gbraid/wbraid for prospect " + prospect.id + " (no prior form submission attribution found) — skipping Google Ads conv");
                return; // Without a click id, uploadClickConversions has nothing to attribute against
              }
              // Pick conv ID + value + Meta event name by kind
              let convId, value, metaEvent;
              if (kind === "ARIVE_APPLICATION") {
                convId = process.env.GOOGLE_ADS_QUALIFIED_APPLICATION_CONV_ID;
                value = 2;   // standard QA conversion value (Didier, 2026-06-04 — was 50)
                metaEvent = "Lead";
              } else if (kind === "ARIVE_FUNDED") {
                convId = process.env.GOOGLE_ADS_FUNDED_LOAN_CONV_ID;
                value = (prospect.mortgage && prospect.mortgage.loan_amount) ? Number(prospect.mortgage.loan_amount) : 250000;
                metaEvent = "Purchase";
              } else {
                console.log("[ARIVE-fanout] " + kind + " — no conv mapping, skipping");
                return;
              }
              if (!convId) {
                console.warn("[ARIVE-fanout] missing conv env var for kind=" + kind);
                return;
              }
              // Call our own /google-ads/upload-conversion handler synthetically
              const fakeReq = {
                params: { code: process.env.LEAD_INBOUND_CODE },
                headers: {},
                header: () => null,
                body: {
                  gclid: gclid,
                  gbraid: gbraid,
                  wbraid: wbraid,
                  fbclid: attr.fbclid || "",
                  email: prospect.email,
                  phone: prospect.phone,
                  conversion_action_id: convId,
                  value: value,
                  currency: "USD",
                  // Cowork 2026-06-04: deterministic order_id — MANY_PER_CLICK counting dedupes
                  // ONLY by order_id, so a Bonzo stage re-fire must produce the same id.
                  order_id: "arive-" + prospect.id + "-" + kind,
                  meta_event_name: metaEvent,
                  // COWORK 2026-05-14: tell _coworkHandleAdsUpload which GA4 event to fire
                  ga4_event_name: (kind === "ARIVE_APPLICATION") ? "close_convert_lead"
                                : (kind === "ARIVE_FUNDED")      ? "purchase"
                                : null,
                }
              };
              let captured = null;
              const fakeRes = {
                status: function(c) { this.code = c; return this; },
                json: function(j) { captured = j; return this; },
                send: function() { return this; },
              };
              await _coworkHandleAdsUpload(fakeReq, fakeRes);
              console.log("[ARIVE-fanout] " + kind + " prospect=" + prospect.id +
                " click_id=" + (gclid || gbraid || wbraid).slice(0,8) + "… conv=" + convId +
                " ok=" + (captured && captured.ok) +
                " google_http=" + (captured && captured.http) +
                " meta_status=" + (captured && captured.meta_capi && captured.meta_capi.status));
            } catch (e) {
              console.error("[ARIVE-fanout] error for prospect " + prospect.id + ":", e && e.stack || e);
            }
          });
        }
      } catch (e) {
        console.error("[ARIVE-detect] non-fatal:", e && e.message);
      }

      // === COWORK 2026-05-14: Valid Lead tag → GA4 qualify_lead ===
      // Idempotent: once we fire, we stamp the prospect with "ga4_qualify_fired" tag
      // so subsequent prospects.updated events for the same prospect don't double-count.
      try {
        const _tagNames = getTagNames(prospect && prospect.tags);
        const _isValidLead   = _tagNames.some(t => /^valid[\s_-]*lead$/i.test(String(t)));
        const _alreadyFired  = _tagNames.some(t => /^ga4[_-]qualify[_-]fired$/i.test(String(t)));
        if (_isValidLead && !_alreadyFired) {
          console.log("[VALID-LEAD] prospect=" + prospect.id + " — firing GA4 qualify_lead");
          await postGa4Event(prospect.id, "qualify_lead", {
            prospect_id: String(prospect.id),
            email: prospect.email || "",
            phone: prospect.phone || ""
          });
          // Stamp sentinel tag (best-effort, never throw)
          try {
            await bonzoUpdateProspect(prospect.id, { tags: addTags(_tagNames, ["ga4_qualify_fired"]) });
          } catch (eStamp) {
            console.warn("[VALID-LEAD] sentinel stamp failed:", eStamp && eStamp.message);
          }
        }
      } catch (e) {
        console.error("[VALID-LEAD] non-fatal:", e && e.message);
      }
    }
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
    // Cowork 2026-05-11: form_name wins over utm_source so /purchase pages with utm_source=google still route to Purchase Bonzo webhook
    lead_source: flat.lead_source || flat.form_name || flat.utm_source || "website",
    gclid: flat.gclid || _coworkClickIdFromUrl(flat.landing_page || flat.page_url || "", "gclid"),
    gbraid: flat.gbraid || _coworkClickIdFromUrl(flat.landing_page || flat.page_url || "", "gbraid"),
    wbraid: flat.wbraid || _coworkClickIdFromUrl(flat.landing_page || flat.page_url || "", "wbraid"),
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

function _coworkHandleInbound(req, res) {
  // Cowork 2026-06-01: ACK fast (<100ms) so Elementor's 5s wp_remote_post doesn't time out.
  // The Bonzo upsert + tag merge + note POST chain still runs — just detached.
  try {
    const flat = _coworkExtractAttribution(req.body || {});
    const email = (flat.email || "").toString().trim();
    const phone = (flat.phone || flat.phone_number || "").toString().trim();
    if (!email && !phone) {
      return res.status(400).json({ ok: false, error: "email or phone required" });
    }
    res.json({ ok: true, queued: true, received_at: new Date().toISOString() });
    setImmediate(() => {
      _coworkHandleInboundWork(req, flat).catch(e =>
        console.error("[lead/inbound] async work error:", e && e.stack || e));
    });
    // COWORK 2026-06-11: timed appointment checks (T+2/8/16/30m) — if this lead
    // books a Calendly appointment right after the form, detach routing drips
    // before the first send.
    if (email) _coworkScheduleAppointmentChecks(email);
  } catch (e) {
    console.error("[lead/inbound] sync ack error:", e && e.stack || e);
    if (!res.headersSent) {
      return res.status(500).json({ ok: false, error: e.message || String(e) });
    }
  }
}

async function _coworkHandleInboundWork(req, preFlat) {
  const res = { /* no-op stub: response already sent by sync wrapper */
    json: () => {},
    status: () => ({ json: () => {}, send: () => {} }),
    send: () => {},
  };
  try {
    const flat = preFlat || _coworkExtractAttribution(req.body);
    const email = (flat.email || "").toString().trim();
    const phone = (flat.phone || flat.phone_number || "").toString().trim();
    const attr = _coworkAttributionTags(flat);
    const first_name = flat.first_name || "";
    const last_name = flat.last_name || "";

    // === COWORK 2026-07-14: durable raw lead log + server-side partial dedupe ===
    // Partials ("Abandoned Form") historically posted straight to Bonzo's webhook from
    // page JS; they now come through here. Log EVERY inbound payload to Neon
    // (lead_events) so no field is ever lost, and suppress duplicate partials:
    //   - any prior FULL for the same email/lead_id -> lead already completed; never
    //     re-inject them as abandoned (the didiertest revisit loop, 2026-07-14)
    //   - a prior PARTIAL for the same email/lead_id within 7 days -> Bonzo already
    //     has this abandon; don't create another submission
    const _leadId = (flat.lead_id || "").toString().trim();
    const _emailLc = email.toLowerCase();
    const _isPartial = String(flat.lead_status || "") === "Partial" ||
                       /^Abandoned/i.test(String((flat.lead_source || "")));
    let _kind = _isPartial ? "partial" : "full";
    try {
      if (_isPartial) {
        const _lePool = await _pgGetPool();
        if (_lePool) {
          const dup = await _lePool.query(
            `SELECT kind FROM lead_events
             WHERE ( (email IS NOT NULL AND email = $1) OR (lead_id IS NOT NULL AND lead_id = $2) )
               AND ( kind = 'full' OR (kind = 'partial' AND created_at > now() - interval '7 days') )
             LIMIT 1`,
            [_emailLc || null, _leadId || null]
          );
          if (dup.rows.length > 0) {
            _kind = "partial_suppressed";
            console.log("[lead/inbound] partial suppressed (prior " + dup.rows[0].kind + ") email=" + _emailLc + " lead_id=" + _leadId);
          }
        }
      }
    } catch (e) { console.warn("[lead/inbound] partial dedupe check failed (continuing):", e && e.message); }
    try {
      const _lePool2 = await _pgGetPool();
      if (_lePool2) await _lePool2.query(
        "INSERT INTO lead_events (lead_id, email, kind, lead_source, payload) VALUES ($1,$2,$3,$4,$5)",
        [_leadId || null, _emailLc || null, _kind, String(flat.lead_source || flat.form_name || ""), JSON.stringify(flat)]
      );
    } catch (e) { console.warn("[lead/inbound] lead_events insert failed:", e && e.message); }
    if (_kind === "partial_suppressed") return; // logged; skip Bonzo forward entirely

    const bonzoBase = process.env.BONZO_BASE_URL || "https://app.getbonzo.com/api/v3";
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

    // Forward to the appropriate Bonzo webhook URL so the prospect lands in
    // Buffer / Lead Entered with full Got Lead routing chain.
    // Webhook hashes (from .cowork.env / earlier audit):
    //   Refinance:  ddb05f5431f315e374231b2597e1da01
    //   Purchase:   3ec807d03f29ec10046232c3e1a55670
    // Choose based on the (possibly enriched) lead_source.
    const _ls = (attr.lead_source || "").toString();
    // Cowork 2026-05-11: match all purchase-style funnels (Purchase, FHA, VA, Jumbo, DSCR all live on Purchase Bonzo webhook)
    // Cowork 2026-07-14: partials arrive with generic lead_source "Abandoned Form" —
    // pick the funnel webhook from the landing page instead (refi/cashout vs purchase family).
    const _isPurchase = _isPartial
      ? !/refinance|cashout/i.test(String(attr.landing_page || flat.page_url || ""))
      : /Purchase|FHA Form|VA Form|Jumbo|DSCR/i.test(_ls);
    const _whRefi = process.env.BONZO_WEBHOOK_REFINANCE_HASH || "ddb05f5431f315e374231b2597e1da01";
    const _whPurch = process.env.BONZO_WEBHOOK_PURCHASE_HASH || "3ec807d03f29ec10046232c3e1a55670";
    const _whHash = _isPurchase ? _whPurch : _whRefi;
    const _whUrl = "https://app.getbonzo.com/api/webhook/" + _whHash;

    // Cowork 2026-06-01 (#2): passthrough forwardBody. Bonzo's webhook field
    // mapping is the real gate — any key not mapped on Bonzo's side is silently
    // ignored. So we pass through all flat form keys and override only the
    // normalized/derived values. New form fields "just work" as long as the
    // matching Bonzo mapping is configured.
    const forwardBody = {
      ...flat,
      first_name, last_name,
      email: email || undefined,
      phone: phone || undefined,
      phone_number: phone || undefined,
      lead_source: attr.lead_source,
      form_name: flat.form_name || attr.lead_source,
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
    let _whStatus = null;
    try {
      const wr = await fetch(_whUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Accept": "application/json", "User-Agent": "Mozilla/5.0 (compatible) bonzo-sync" },
        body: JSON.stringify(forwardBody),
      });
      _whStatus = wr.status;
      if (!wr.ok) {
        const t = await wr.text();
        console.error("Webhook forward failed", wr.status, t.slice(0, 400));
      } else {
        action = "forwarded_to_webhook";
        // Resolve prospect id by lookup (webhook is async, so we re-search)
        await new Promise(r => setTimeout(r, 1500));
        if (email) {
          const found = await _findBy(email, "email");
          if (found) prospectId = found.id;
        }
        if (!prospectId && phone) {
          const found = await _findBy(phone, "phone");
          if (found) prospectId = found.id;
        }
      }
    } catch (e) {
      console.error("Webhook forward exception", e && e.message);
    }
    // Fallback: if forward failed, still create via REST so we don't drop the lead
    if (!prospectId) {
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
      if (existing) {
        prospectId = existing.id; action = action || "updated_rest_fallback";
        await fetch(`${bonzoBase}/prospects/${prospectId}`, { method: "PUT", headers, body: JSON.stringify(prospectPayload) });
      } else {
        const r = await fetch(`${bonzoBase}/prospects`, { method: "POST", headers, body: JSON.stringify(prospectPayload) });
        if (r.ok) {
          const j = await r.json();
          prospectId = (j.data && j.data.id) || j.id;
          action = action || "created_rest_fallback";
        } else {
          const t = await r.text();
          console.error("POST prospect fallback failed", r.status, t.slice(0, 500));
          return res.status(502).json({ ok: false, error: "bonzo_create_failed", status: r.status, body: t.slice(0, 300), webhook_status: _whStatus });
        }
      }
    }

    // Cowork 2026-05-11: store gclid/fbclid as Bonzo tags (durable, ride along in webhooks + REST).
    // IMPORTANT: Bonzo lowercases tag values, and gclids are case-sensitive — so we base64-encode
    // the raw click-ID before storing it. bonzoGetAttribution decodes on read.
    // Bonzo v3 doesn't support PATCH on /prospects/{id} (405) — must GET + merge + PUT.
    if (prospectId) {
      try {
        const hexenc = (s) => Buffer.from(String(s), "utf8").toString("hex");
        const attrTags = [];
        if (attr.gclid)  attrTags.push("gclid:hex:" + hexenc(attr.gclid));
        if (attr.gbraid) attrTags.push("gbraid:hex:" + hexenc(attr.gbraid));
        if (attr.wbraid) attrTags.push("wbraid:hex:" + hexenc(attr.wbraid));
        if (attr.fbclid) attrTags.push("fbclid:hex:" + hexenc(attr.fbclid));
        if (attr.utm_source)   attrTags.push("utm_source:"   + attr.utm_source);
        if (attr.utm_campaign) attrTags.push("utm_campaign:" + attr.utm_campaign);
        if (attrTags.length > 0) {
          // GET fresh — existing may be stale (we just created/updated via webhook)
          const fresh = await bonzoGetProspectById(prospectId);
          const freshP = (fresh.ok && fresh.json) ? fresh.json : (existing || {});
          const cur = getTagNames(freshP.tags || []);
          const merged = uniqTags(cur.concat(attrTags));
          // PUT requires the full object; preserve identity fields. Bonzo will keep the rest.
          const putBody = {
            email:      freshP.email      || email || undefined,
            phone:      freshP.phone      || phone || undefined,
            first_name: freshP.first_name || first_name || undefined,
            last_name:  freshP.last_name  || last_name || undefined,
            tags: merged,
          };
          const putRes = await bonzoPutProspectFull(prospectId, putBody);
          console.log("[lead/inbound] tag merge for prospect " + prospectId + " PUT status=" + putRes.status + " added=" + JSON.stringify(attrTags));
        }
      } catch (e) {
        console.warn("[lead/inbound] tag merge error:", e && e.message);
      }
      // Audit-trail note (separate try; failure is non-fatal)
      try {
        const noteBody = "Cowork attribution capture:\n" + JSON.stringify(attr, null, 2);
        // COWORK 2026-05-14: Bonzo's /notes endpoint requires 'content', not 'note' (was 422).
        const nr = await fetch(`${bonzoBase}/prospects/${prospectId}/notes`, {
          method: "POST",
          headers,
          body: JSON.stringify({ content: noteBody }),
        });
        if (!nr.ok) {
          const nt = await nr.text();
          console.warn("[lead/inbound] note POST failed " + nr.status + ": " + nt.slice(0, 200));
        }
      } catch (e) { console.warn("[lead/inbound] note POST exception:", e && e.message); }
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

// === COWORK 2026-06-02: /calendly/clientside-attr ===
// Client-side attribution bridge for Calendly bookings on Basic plan.
// Page-side: listener on /consultation/ captures utm/gclid from page URL +
// invitee_uri from Calendly postMessage, POSTs here. We resolve the invitee
// via Calendly REST (PAT in CALENDLY_PAT env), find the Bonzo prospect by
// email/phone, then PATCH attribution tags + a Calendly-source note.
// Why: Basic Calendly plan blocks /webhook_subscriptions, so we can't run
// the existing /calendly server-webhook path. This recreates the same
// attribution flow from the client side using the PAT we have.
async function _coworkResolveCalendlyInvitee(invitee_uri) {
  const pat = String(process.env.CALENDLY_PAT || "").trim();
  if (!pat) throw new Error("CALENDLY_PAT env var not set");
  if (!/^https:\/\/api\.calendly\.com\/scheduled_events\/[^/]+\/invitees\/[^/]+$/.test(invitee_uri || "")) {
    throw new Error("invitee_uri shape unexpected: " + invitee_uri);
  }
  const r = await fetch(invitee_uri, { headers: { Authorization: "Bearer " + pat, Accept: "application/json" } });
  if (!r.ok) throw new Error("Calendly invitee fetch " + r.status);
  const j = await r.json();
  const res = (j && j.resource) || {};
  return {
    email: (res.email || "").trim().toLowerCase(),
    phone: (res.text_reminder_number || "").trim(),
    first_name: (res.first_name || ((res.name || "").split(" ")[0]) || "").trim(),
    last_name: (res.last_name || ((res.name || "").split(" ").slice(1).join(" ")) || "").trim(),
    event_uri: (res.event || ""),
    cancel_url: (res.cancel_url || ""),
    reschedule_url: (res.reschedule_url || ""),
    tracking: (res.tracking || {}),
  };
}

async function _coworkHandleCalendlyClientsideAttr(req, res) {
  try {
    const body = req.body || {};
    const inv_uri = String(body.invitee_uri || "").trim();
    if (!inv_uri) return res.status(400).json({ ok: false, error: "invitee_uri required" });

    const inv = await _coworkResolveCalendlyInvitee(inv_uri);
    if (!inv.email && !inv.phone) {
      return res.status(404).json({ ok: false, error: "Calendly invitee has no email or phone", invitee_uri: inv_uri });
    }

    // Merge UTMs: prefer page-supplied (truthful intent), fall back to Calendly tracking field
    const utm = {
      utm_source: body.utm_source || inv.tracking.utm_source || "",
      utm_medium: body.utm_medium || inv.tracking.utm_medium || "",
      utm_campaign: body.utm_campaign || inv.tracking.utm_campaign || "",
      utm_term: body.utm_term || inv.tracking.utm_term || "",
      utm_content: body.utm_content || inv.tracking.utm_content || "",
      gclid: body.gclid || inv.tracking.salesforce_uuid || "",
      fbclid: body.fbclid || "",
    };

    // Find Bonzo prospect by email then phone
    const bonzoBase = process.env.BONZO_BASE_URL || "https://app.getbonzo.com/api/v3";
    const bonzoToken = process.env.BONZO_TOKEN || process.env.BONZO_API_KEY;
    const headers = {
      "Authorization": "Bearer " + bonzoToken,
      "Content-Type": "application/json",
      "Accept": "application/json",
      "User-Agent": "Mozilla/5.0 (compatible) bonzo-sync",
    };
    function _norm(s) { return (s || "").toString().trim().toLowerCase(); }
    function _normPhone(s) { return (s || "").toString().replace(/[^0-9]/g, "").replace(/^1(\d{10})$/, "$1"); }
    async function _findBy(term, kind) {
      const r = await fetch(bonzoBase + "/prospects?search=" + encodeURIComponent(term) + "&per_page=10", { headers });
      if (!r.ok) return null;
      const j = await r.json();
      const data = Array.isArray(j.data) ? j.data : [];
      const want = _norm(term);
      const wantPhone = _normPhone(term);
      for (const p of data) {
        if (kind === "email" && _norm(p.email) === want) return p;
        if (kind === "phone" && _normPhone(p.phone) === wantPhone) return p;
      }
      return null;
    }
    let prospect = null;
    if (inv.email) prospect = await _findBy(inv.email, "email");
    if (!prospect && inv.phone) prospect = await _findBy(inv.phone, "phone");

    if (!prospect) {
      // Bonzo's native Calendly push handles invitee.created, so the prospect should appear
      // shortly. Schedule a retry on a short delay before giving up.
      await new Promise(r => setTimeout(r, 4000));
      if (inv.email) prospect = await _findBy(inv.email, "email");
      if (!prospect && inv.phone) prospect = await _findBy(inv.phone, "phone");
    }

    if (!prospect) {
      return res.status(202).json({ ok: false, queued_note: "Prospect not found yet (Bonzo native Calendly push may not have completed)", email: inv.email, phone: inv.phone });
    }

    // Build attribution patch — tags only (Bonzo custom-field mapping varies)
    const newTags = ["source:calendly", "calendly_consultation"];
    if (utm.utm_source) newTags.push("utm_source:" + utm.utm_source.slice(0, 40));
    if (utm.utm_medium) newTags.push("utm_medium:" + utm.utm_medium.slice(0, 40));
    if (utm.utm_campaign) newTags.push("utm_campaign:" + utm.utm_campaign.slice(0, 40));
    if (utm.gclid) newTags.push("gclid_present");

    const existingTags = getTagNames(prospect.tags || []);
    const merged = addTags(existingTags, newTags);

    const patch = { tags: merged };
    // COWORK 2026-06-11: only set lead_source when the prospect has none —
    // a form lead's "Purchase Options Form" etc. must survive a later booking.
    const _existingLeadSource = prospect.lead_source || (prospect.mortgage && prospect.mortgage.lead_source) || "";
    if (!_existingLeadSource) {
      patch.lead_source = "Calendly Consultation" + (utm.utm_source ? (" (" + utm.utm_source + ")") : "");
    }

    const upd = await bonzoUpdateProspect(prospect.id, patch);

    // COWORK 2026-06-11: a booking means no drip should run — suppress now and
    // re-check on timers so a late Got Lead routing assignment can't win.
    let suppression = null;
    try {
      const appt = await _coworkFindCalendlyAppointment(inv.email);
      if (appt) suppression = await _coworkSuppressDripsForAppointment(prospect, appt, {});
    } catch (e) { console.warn("[clientside-attr] suppression error:", e && e.message); }
    if (inv.email) _coworkScheduleAppointmentChecks(inv.email);

    return res.json({ ok: true, prospect_id: prospect.id, tags_added: newTags, suppression: suppression });
  } catch (e) {
    console.error("[clientside-attr] error:", e && e.stack || e);
    return res.status(500).json({ ok: false, error: e.message || String(e) });
  }
}

app.post("/calendly/clientside-attr/:code", express.json({ limit: "256kb" }), (req, res) => {
  if (req.params.code !== process.env.LEAD_INBOUND_CODE) return res.status(401).send("Unauthorized");
  return _coworkHandleCalendlyClientsideAttr(req, res);
});
// === END COWORK 2026-06-02 ===



// === COWORK 2026-06-11: Appointment-aware drip suppression ===
// When a lead books a Calendly appointment, no routing drip should touch them.
// Calendly Basic plan has no webhooks, so we poll: timed checks after every
// /lead/inbound, a page-side booking ping (/calendly/booked), and a reconcile
// sweep (/appointments/reconcile/:code) on GHA cron for bookings made later or
// from email links. Suppression = detach routing drips + status "responded"
// (mirrors Didier's manual move) + tag appointment_set + audit note.

const TURTUR_ROUTING_DRIP_IDS = [
  212081, // Ad — Purchase Instant Response
  215828, // Ad — Refi Instant Response updated
  216141, // Ad - Abandoned Lead bring back
  225522, // Past Client - Refi Outreach
];
const APPT_CHECK_DELAYS_MIN = [2, 8, 16, 30];
// Appointment Set wiring (2026-06-11): stage created by Didier in Bonzo UI.
// Confirm + day-before go out as DIRECT SMS (POST /prospects/:id/sms) — campaign
// 238891 exists but its 9:00 AM day-anchor never fires for same-day enrollments,
// so the system doesn't rely on it.
const TURTUR_APPT_STAGE_ID = 458538;            // "Calendly Appt 🦆" in Buffer pipeline 45428
const TURTUR_APPT_CONFIRM_SMS = (first) =>
  "Hi " + (first || "there") + ", your appointment has been set. Save my number so we don't miss each other. Thanks";
const TURTUR_APPT_DAYBEFORE_SMS = (first, dayWord, timeStr) =>
  "Hi " + (first || "there") + ", Didier here — quick reminder about our call " + dayWord + " at " + timeStr +
  ". I'll be calling from 754-224-5704. Need to move it? Use the reschedule link in your Calendly email. See you then!";
function _coworkApptTimeParts(startIso) {
  const d = new Date(startIso);
  const timeStr = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" }).format(d);
  const dayOf = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const dayWord = dayOf === today ? "today" : "tomorrow";
  const etHour = parseInt(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hour12: false }).format(new Date()), 10);
  return { timeStr, dayWord, etHour };
}
// Stages it is safe to yank a prospect OUT of when they book. Deeper stages (Engaging,
// Hot Lead, Pre-Approved, ...) are manually managed — tag + detach only, no stage move.
const TURTUR_EARLY_FUNNEL_STAGE_IDS = [420176, 420120, 420154, 411901, 411869, 411990, 420226];

async function _coworkFindCalendlyAppointment(email) {
  const pat = String(process.env.CALENDLY_PAT || "").trim();
  const e = String(email || "").trim().toLowerCase();
  if (!pat || !e) return null;
  const h = { Authorization: "Bearer " + pat, Accept: "application/json" };
  const me = await fetch("https://api.calendly.com/users/me", { headers: h });
  if (!me.ok) throw new Error("calendly /users/me " + me.status);
  const meJ = await me.json();
  const userUri = meJ && meJ.resource && meJ.resource.uri;
  if (!userUri) return null;
  const qs = new URLSearchParams({
    user: userUri,
    invitee_email: e,
    status: "active",
    min_start_time: new Date().toISOString(),
    count: "5",
  });
  const ev = await fetch("https://api.calendly.com/scheduled_events?" + qs.toString(), { headers: h });
  if (!ev.ok) throw new Error("calendly scheduled_events " + ev.status);
  const evJ = await ev.json();
  const list = (evJ && evJ.collection) || [];
  if (!list.length) return null;
  list.sort((a, b) => String(a.start_time || "").localeCompare(String(b.start_time || "")));
  const e0 = list[0];
  return { name: e0.name || "Calendly appointment", start_time: e0.start_time || "", uri: e0.uri || "" };
}

async function _coworkSuppressDripsForAppointment(prospect, appt, opts) {
  opts = opts || {};
  const out = { prospect_id: prospect.id, removed: [], actions: [], dry_run: !!opts.dryRun };
  const attached = (prospect.campaigns || []).map(c => (typeof c === "object" ? c.id : c));
  const attachedDrips = attached.filter(id => TURTUR_ROUTING_DRIP_IDS.indexOf(id) !== -1);
  const tagsL = getTagNames(prospect.tags || []).map(t => String(t).toLowerCase());
  const confirmAlreadySent = tagsL.indexOf("appt_confirm_sent") !== -1;

  if (opts.dryRun) {
    out.removed = attachedDrips.map(id => String(id) + ":dry_run");
    out.actions.push(confirmAlreadySent ? "would_detach_only" : "would_enroll_confirm");
    return out;
  }

  // 1) Tags first (idempotent union via GET+merge+PUT).
  try {
    await bonzoUpdateProspect(prospect.id, { tags: ["appointment_set", "source:calendly"] });
    out.actions.push("tags");
  } catch (e) { out.actions.push("tags_err:" + (e && e.message || e)); }

  // 2) Stage move — only out of early-funnel stages. Route: POST /prospects/:id/pipeline-stage/:stage
  try {
    const curStage = (prospect.pipeline_stage && prospect.pipeline_stage.id) || null;
    if (curStage === TURTUR_APPT_STAGE_ID) {
      out.actions.push("stage_already_set");
    } else if (curStage && TURTUR_EARLY_FUNNEL_STAGE_IDS.indexOf(curStage) !== -1) {
      const r = await bonzoFetch("/prospects/" + prospect.id + "/pipeline-stage/" + TURTUR_APPT_STAGE_ID, { method: "POST" });
      out.actions.push(r && r.ok ? "moved_to_appt_stage" : "stage_move_failed:" + (r && r.status));
    } else {
      out.actions.push("stage_kept:" + curStage);
    }
  } catch (e) { out.actions.push("stage_err:" + (e && e.message || e)); }

  // 3) Confirm SMS (direct send — deterministic, unlike campaign day-anchors),
  // then cancel any queued drip events and flip status to responded (proven halt).
  if (!confirmAlreadySent) {
    try {
      const sms = await bonzoFetch("/prospects/" + prospect.id + "/sms", {
        method: "POST",
        body: JSON.stringify({ message: TURTUR_APPT_CONFIRM_SMS(prospect.first_name), send_as: "owner" }),
      });
      if (sms && sms.ok) {
        out.actions.push("confirm_sms_sent");
        try { await bonzoUpdateProspect(prospect.id, { tags: ["appt_confirm_sent"] }); } catch (e) {}
      } else {
        out.actions.push("confirm_sms_failed:" + (sms && sms.status));
      }
    } catch (e) { out.actions.push("confirm_sms_err:" + (e && e.message || e)); }
  }
  if (attachedDrips.length) {
    for (let i = 0; i < 6; i++) {
      try {
        const ne = await bonzoFetch("/campaigns/" + prospect.id + "/next-event", { method: "POST" });
        const pred = ne && ne.ok && ne.json && (ne.json.predict || ne.json);
        const evId = pred && (pred.id || (pred.data && pred.data.id));
        if (!evId) break;
        const del = await bonzoFetch("/campaigns/" + prospect.id + "/next-event?next_event_id=" + encodeURIComponent(evId), { method: "DELETE" });
        if (!del || !del.ok) break;
        out.actions.push("event_canceled:" + evId);
      } catch (e) { out.actions.push("event_cancel_err:" + (e && e.message || e)); break; }
    }
    out.removed = attachedDrips;
  }
  try {
    const st = await bonzoFetch("/prospects/" + prospect.id + "/status", { method: "POST", body: JSON.stringify({ status: "responded" }) });
    out.actions.push(st && st.ok ? "status_responded" : "status_failed:" + (st && st.status));
  } catch (e) { out.actions.push("status_err:" + (e && e.message || e)); }

  // 4) Audit note.
  try {
    const bonzoBaseN = process.env.BONZO_BASE_URL || "https://app.getbonzo.com/api/v3";
    const bonzoTokenN = process.env.BONZO_TOKEN || process.env.BONZO_API_KEY;
    const nr = await fetch(bonzoBaseN + "/prospects/" + prospect.id + "/notes", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + bonzoTokenN,
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": "Mozilla/5.0 (compatible) bonzo-sync",
      },
      body: JSON.stringify({ content: "Calendly appointment detected — drip suppression ran.\nEvent: " + appt.name + "\nStart: " + appt.start_time + "\nDetached: " + (out.removed.join(", ") || "none") + "\nActions: " + out.actions.join(", ") }),
    });
    if (nr.ok) out.actions.push("note");
  } catch (e) { out.actions.push("note_err:" + (e && e.message || e)); }

  // 5) Day-before reminder schedule (fired by the reconcile cron).
  try {
    if (appt && appt.start_time) {
      const pool = await _pgGetPool();
      if (pool) {
        // Reminder fires DAY-OF at 08:30 ET (Didier 2026-06-11; column names are legacy
        // "daybefore_*"). If 08:30 already passed when the booking lands (same-day late
        // booking), mark sent — the confirm SMS just went out, no second text needed.
        await pool.query(
          `INSERT INTO appointment_reminders (prospect_id, email, start_time, daybefore_due, daybefore_sent)
           VALUES ($1, $2, $3::timestamptz,
             ((($3::timestamptz AT TIME ZONE 'America/New_York')::date)::timestamp + interval '8 hours 30 minutes') AT TIME ZONE 'America/New_York',
             ((($3::timestamptz AT TIME ZONE 'America/New_York')::date)::timestamp + interval '8 hours 30 minutes') AT TIME ZONE 'America/New_York' <= now())
           ON CONFLICT (prospect_id) DO UPDATE SET
             email = EXCLUDED.email,
             start_time = EXCLUDED.start_time,
             daybefore_due = EXCLUDED.daybefore_due,
             daybefore_sent = CASE WHEN appointment_reminders.start_time IS DISTINCT FROM EXCLUDED.start_time THEN EXCLUDED.daybefore_sent ELSE appointment_reminders.daybefore_sent END`,
          [String(prospect.id), String(prospect.email || ""), appt.start_time]
        );
        out.actions.push("reminder_scheduled");
      }
    }
  } catch (e) { out.actions.push("reminder_schedule_err:" + (e && e.message || e)); }

  // 6) COWORK 2026-07-27: offline conversion upload for the booked appointment.
  // WHY: the client-side path (GTM tag 33 -> Ads "Consultation Booked", a WEBPAGE
  // conversion action) misses roughly a third of paid sessions — Aniyah Wellington
  // (prospect 131896914, 2026-07-20) booked AND held an appointment off a gbraid/iOS
  // click and Google Ads recorded nothing at all, because her GTM container never ran.
  // The ARIVE fan-out in /bonzo/events only fires on stages "Application Completed*"
  // and "Funded*", so an appointment had no server-side path. This closes that gap for
  // every detection route at once, because all three (T+ timers, /appointments/booked,
  // the reconcile cron) funnel through this function.
  // Guarded by the appt_conv_uploaded tag AND a deterministic order_id, so a re-entry
  // can neither double-charge the API nor double-count the conversion (MANY_PER_CLICK
  // dedupes on order_id).
  try {
    const _convIdAppt = process.env.GOOGLE_ADS_CONSULTATION_CONV_ID;
    const _alreadyUploaded = getTagNames(prospect.tags || [])
      .map(t => String(t).toLowerCase())
      .indexOf("appt_conv_uploaded") !== -1;
    if (!_convIdAppt) {
      out.actions.push("appt_conv_skipped:no_env");
    } else if (_alreadyUploaded) {
      out.actions.push("appt_conv_skipped:already_uploaded");
    } else {
      const attr = await bonzoGetAttribution(prospect.id, prospect);
      const _g = attr.gclid || "", _gb = attr.gbraid || "", _wb = attr.wbraid || "";
      if (!_g && !_gb && !_wb) {
        // Organic/direct booking — nothing to attribute against. Not an error.
        out.actions.push("appt_conv_skipped:no_click_id");
      } else {
        const fakeReq = {
          params: { code: process.env.LEAD_INBOUND_CODE },
          headers: {},
          header: () => null,
          body: {
            gclid: _g, gbraid: _gb, wbraid: _wb,
            fbclid: attr.fbclid || "",
            email: prospect.email,
            phone: prospect.phone,
            conversion_action_id: _convIdAppt,
            value: 1,
            currency: "USD",
            order_id: "appt-" + prospect.id,
            meta_event_name: "Schedule",
            ga4_event_name: null,
          },
        };
        let captured = null;
        const fakeRes = {
          status: function (c) { this.code = c; return this; },
          json: function (j) { captured = j; return this; },
          send: function () { return this; },
        };
        await _coworkHandleAdsUpload(fakeReq, fakeRes);
        const _ok = !!(captured && captured.ok);
        out.actions.push("appt_conv_upload:" + (_ok ? "ok" : "failed") +
          ":" + (captured && captured.http));
        console.log("[appt-conv] prospect=" + prospect.id +
          " click_id=" + (_g || _gb || _wb).slice(0, 10) + "\u2026" +
          " conv=" + _convIdAppt + " ok=" + _ok +
          " google_http=" + (captured && captured.http) +
          " meta_status=" + (captured && captured.meta_capi && captured.meta_capi.status));
        if (_ok) {
          try { await bonzoUpdateProspect(prospect.id, { tags: ["appt_conv_uploaded"] }); } catch (e) {}
        }
      }
    }
  } catch (e) {
    out.actions.push("appt_conv_err:" + (e && e.message || e));
    console.warn("[appt-conv] error:", e && e.message);
  }

  return out;
}

async function _coworkAppointmentCheckByEmail(email, opts) {
  opts = opts || {};
  const appt = await _coworkFindCalendlyAppointment(email);
  if (!appt) return { found: false, email: email };
  const candidates = await bonzoFindProspectCandidatesByEmail(email);
  const want = String(email || "").trim().toLowerCase();
  let prospect = null;
  for (const c of candidates) {
    if (String(c.email || "").trim().toLowerCase() === want) { prospect = c; break; }
  }
  if (!prospect && candidates.length === 1) prospect = candidates[0];
  if (!prospect) return { found: true, prospect: false, email: email };
  const tagNamesL = getTagNames(prospect.tags || []).map(t => String(t).toLowerCase());
  const attachedDrips = (prospect.campaigns || []).map(c => (typeof c === "object" ? c.id : c)).filter(id => TURTUR_ROUTING_DRIP_IDS.indexOf(id) !== -1);
  if (tagNamesL.indexOf("appointment_set") !== -1 && attachedDrips.length === 0) {
    return { found: true, already_done: true, prospect_id: prospect.id };
  }
  const suppression = await _coworkSuppressDripsForAppointment(prospect, appt, opts);
  return { found: true, appt: appt, suppression: suppression };
}

function _coworkScheduleAppointmentChecks(email) {
  const e = String(email || "").trim();
  if (!e) return;
  for (const min of APPT_CHECK_DELAYS_MIN) {
    const t = setTimeout(() => {
      _coworkAppointmentCheckByEmail(e, {})
        .then(r => {
          if (r && r.found) console.log("[appt-check] t+" + min + "m " + e + " → " + JSON.stringify(r.suppression || { already_done: r.already_done, prospect: r.prospect }));
        })
        .catch(err => console.warn("[appt-check] t+" + min + "m error:", err && err.message));
    }, min * 60 * 1000);
    if (t && typeof t.unref === "function") t.unref();
  }
}

// Page-side booking ping — no :code (the invitee_uri must resolve via our
// Calendly PAT, which is the real auth: forged URIs do nothing). Rate-limited.
const _coworkBookedHits = new Map();
function _coworkBookedRateOk(ip) {
  const now = Date.now();
  const rec = _coworkBookedHits.get(ip) || { count: 0, reset: now + 3600 * 1000 };
  if (now > rec.reset) { rec.count = 0; rec.reset = now + 3600 * 1000; }
  rec.count += 1;
  _coworkBookedHits.set(ip, rec);
  if (_coworkBookedHits.size > 5000) _coworkBookedHits.clear();
  return rec.count <= 30;
}

app.post("/appointments/booked", express.json({ limit: "64kb" }), async (req, res) => {
  try {
    const ip = String(req.headers["x-forwarded-for"] || req.ip || "?").split(",")[0].trim();
    if (!_coworkBookedRateOk(ip)) return res.status(429).json({ ok: false, error: "rate limited" });
    const inv_uri = String((req.body || {}).invitee_uri || "").trim();
    if (!/^https:\/\/api\.calendly\.com\/scheduled_events\/[^/]+\/invitees\/[^/]+$/.test(inv_uri)) {
      return res.status(400).json({ ok: false, error: "invitee_uri shape invalid" });
    }
    const inv = await _coworkResolveCalendlyInvitee(inv_uri);
    if (!inv.email) return res.status(404).json({ ok: false, error: "invitee has no email" });
    res.json({ ok: true, queued: true });
    setImmediate(() => {
      _coworkAppointmentCheckByEmail(inv.email, {})
        .then(r => console.log("[appointments/booked] " + inv.email + " → " + JSON.stringify(r.suppression || r)))
        .catch(e => console.warn("[appointments/booked] error:", e && e.message));
      // Re-assert after Bonzo's routing delay so a late campaign assignment can't win.
      _coworkScheduleAppointmentChecks(inv.email);
    });
  } catch (e) {
    console.error("[appointments/booked] error:", e && e.stack || e);
    if (!res.headersSent) res.status(500).json({ ok: false, error: e.message || String(e) });
  }
});

// Fire day-before reminders that have come due. Called from the reconcile cron.
async function _coworkFireDueReminders(dryRun) {
  const out = { due: 0, fired: 0, skipped: [], dry_run: !!dryRun };
  const pool = await _pgGetPool();
  if (!pool) { out.skipped.push("no_database_url"); return out; }
  // Recompute due for unsent rows from the current rule (day-of 08:30 ET) so a rule
  // change applies to already-scheduled reminders without a migration.
  await pool.query(
    `UPDATE appointment_reminders
     SET daybefore_due = (((start_time AT TIME ZONE 'America/New_York')::date)::timestamp + interval '8 hours 30 minutes') AT TIME ZONE 'America/New_York'
     WHERE NOT daybefore_sent`
  );
  const { rows } = await pool.query(
    "SELECT prospect_id, email, start_time FROM appointment_reminders WHERE NOT daybefore_sent AND daybefore_due <= now() AND start_time > now()"
  );
  out.due = rows.length;
  if (!rows.length) return out;
  for (const r of rows) {
    try {
      const parts = _coworkApptTimeParts(r.start_time instanceof Date ? r.start_time.toISOString() : String(r.start_time));
      // Quiet hours: only text between 08:00 and 20:00 ET; otherwise leave for next run.
      if (parts.etHour < 8 || parts.etHour >= 20) { out.skipped.push(r.prospect_id + ":quiet_hours"); continue; }
      // Don't remind a cancelled appointment — re-verify against Calendly first.
      const appt = await _coworkFindCalendlyAppointment(r.email);
      if (!appt) {
        await pool.query("UPDATE appointment_reminders SET daybefore_sent = TRUE WHERE prospect_id = $1", [r.prospect_id]);
        out.skipped.push(r.prospect_id + ":no_active_appointment");
        continue;
      }
      if (dryRun) { out.skipped.push(r.prospect_id + ":dry_run"); continue; }
      const pr = await bonzoGetProspectById(r.prospect_id);
      const first = (pr && pr.ok && pr.json && pr.json.first_name) || "";
      const sms = await bonzoFetch("/prospects/" + r.prospect_id + "/sms", {
        method: "POST",
        body: JSON.stringify({ message: TURTUR_APPT_DAYBEFORE_SMS(first, parts.dayWord, parts.timeStr), send_as: "owner" }),
      });
      if (!sms || !sms.ok) { out.skipped.push(r.prospect_id + ":sms_failed:" + (sms && sms.status)); continue; }
      await pool.query("UPDATE appointment_reminders SET daybefore_sent = TRUE WHERE prospect_id = $1", [r.prospect_id]);
      out.fired += 1;
    } catch (e) {
      out.skipped.push(r.prospect_id + ":err:" + (e && e.message || e));
    }
  }
  return out;
}

// Reconcile sweep — catches bookings made from email links or after the timed
// checks. Default dry-run; GHA cron calls with ?dry_run=false.
app.post("/appointments/reconcile/:code", express.json({ limit: "256kb" }), async (req, res) => {
  if (req.params.code !== process.env.LEAD_INBOUND_CODE) return res.status(401).json({ ok: false, error: "Unauthorized" });
  try {
    const dryRun = req.query.dry_run !== "false";
    const hours = Math.min(parseInt(req.query.hours, 10) || 48, 168);
    const maxLookups = Math.min(parseInt(req.query.limit, 10) || 25, 50);
    const cutoff = Date.now() - hours * 3600 * 1000;
    const candidates = [];
    for (let page = 1; page <= 3; page++) {
      const r = await bonzoFetch("/prospects?per_page=100&page=" + page, { method: "GET" });
      const data = (r && r.json && r.json.data) || [];
      if (!data.length) break;
      let allOlder = true;
      for (const p of data) {
        const t = p.created_at ? new Date(p.created_at).getTime() : 0;
        if (t >= cutoff) allOlder = false; else continue;
        if (!p.email) continue;
        const tagsL = getTagNames(p.tags || []).map(s => String(s).toLowerCase());
        if (tagsL.indexOf("appointment_set") !== -1) continue;
        const drips = (p.campaigns || []).map(c => (typeof c === "object" ? c.id : c)).filter(id => TURTUR_ROUTING_DRIP_IDS.indexOf(id) !== -1);
        if (!drips.length) continue;
        candidates.push(p);
      }
      if (allOlder) break;
    }
    const results = [];
    for (const p of candidates.slice(0, maxLookups)) {
      try {
        const appt = await _coworkFindCalendlyAppointment(p.email);
        if (!appt) { results.push({ id: p.id, email: p.email, appt: false }); continue; }
        const suppression = await _coworkSuppressDripsForAppointment(p, appt, { dryRun: dryRun });
        results.push({ id: p.id, email: p.email, appt: appt.start_time, suppression: suppression });
      } catch (e) {
        results.push({ id: p.id, email: p.email, error: e && e.message || String(e) });
      }
    }
    let reminders = null;
    try { reminders = await _coworkFireDueReminders(dryRun); } catch (e) { reminders = { error: e && e.message || String(e) }; }
    res.json({ ok: true, dry_run: dryRun, window_hours: hours, candidates: candidates.length, checked: Math.min(candidates.length, maxLookups), results: results, reminders: reminders });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message || String(e) });
  }
});
// === END COWORK 2026-06-11 APPOINTMENT SUPPRESSION ===


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

async function _googleCustomerMatchUpload(cache) {
  if (!cache || !cache.records || cache.records.length === 0) return null;
  const dt = process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
  const cid = process.env.GOOGLE_ADS_CUSTOMER_ID;
  const mcc = process.env.GOOGLE_ADS_MCC_ID;
  const listId = process.env.GOOGLE_ADS_PAST_CLIENT_ALL_LIST_ID;
  if (!dt || !cid || !mcc || !listId) return { error: 'missing google ads env vars' };
  let token;
  try { token = await _coworkGetAdsToken(); } catch (e) { return { error: 'token: ' + e.message }; }
  if (!token) return { error: 'no token' };
  const cleanCid = String(cid).replace(/-/g, '');
  const cleanMcc = String(mcc).replace(/-/g, '');
  const apiBase = 'https://googleads.googleapis.com/v20/customers/' + cleanCid;
  const headers = {
    'Authorization': 'Bearer ' + token,
    'developer-token': dt,
    'login-customer-id': cleanMcc,
    'Content-Type': 'application/json'
  };
  const createBody = {
    job: {
      type: 'CUSTOMER_MATCH_USER_LIST',
      customerMatchUserListMetadata: {
        userList: 'customers/' + cleanCid + '/userLists/' + listId
      }
    }
  };
  const createResp = await fetch(apiBase + '/offlineUserDataJobs:create', {
    method: 'POST', headers, body: JSON.stringify(createBody)
  });
  const createJson = await createResp.json();
  const resourceName = createJson.resourceName;
  if (!resourceName) return { create_status: createResp.status, error: createJson };
  const operations = [];
  for (const rec of cache.records) {
    const ids = [];
    if (rec.email) ids.push({ hashedEmail: _coworkSha256Hex(rec.email) });
    if (rec.phone) {
      const digits = String(rec.phone).replace(/\D/g, '');
      if (digits) ids.push({ hashedPhoneNumber: _coworkSha256Hex('+1' + digits) });
    }
    if (ids.length > 0) operations.push({ create: { userIdentifiers: ids } });
  }
  const BATCH = 1000;
  let totalAdded = 0;
  let lastError = null;
  for (let i = 0; i < operations.length; i += BATCH) {
    const batch = operations.slice(i, i + BATCH);
    const addResp = await fetch('https://googleads.googleapis.com/v20/' + resourceName + ':addOperations', {
      method: 'POST', headers, body: JSON.stringify({ operations: batch, enablePartialFailure: true })
    });
    if (addResp.ok) {
      totalAdded += batch.length;
    } else {
      lastError = { status: addResp.status, body: (await addResp.text()).slice(0, 800) };
      break;
    }
  }
  if (lastError) return { resource: resourceName, operations_added: totalAdded, error: lastError };
  const runResp = await fetch('https://googleads.googleapis.com/v20/' + resourceName + ':run', {
    method: 'POST', headers, body: '{}'
  });
  return { resource: resourceName, operations_added: totalAdded, list_id: listId, run_status: runResp.status };
}

async function _coworkHandleAdsUpload(req, res) {
  try {
    const b = req.body || {};
    const gclid = b.gclid || b.GCLID;
    const gbraid = b.gbraid || "";
    const wbraid = b.wbraid || "";
    if (!gclid && !gbraid && !wbraid) return res.status(400).json({ ok: false, error: "gclid, gbraid, or wbraid required" });
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
    const orderId = b.order_id || (gclid || gbraid || wbraid) + "-" + Date.now();
    const _pcConvId = process.env.GOOGLE_ADS_FUNDED_LOAN_PAST_CLIENT_CONV_ID;
    const _convId = b.conversion_action_id ||
      ((b.past_client === true || b.past_client === "true" || b.past_client === 1) && _pcConvId
        ? _pcConvId
        : process.env.GOOGLE_ADS_FUNDED_LOAN_CONV_ID);
    const convResource = "customers/" + process.env.GOOGLE_ADS_CUSTOMER_ID +
      "/conversionActions/" + _convId;
    const access = await _coworkGetAdsToken();
    const url = "https://googleads.googleapis.com/v20/customers/" +
      process.env.GOOGLE_ADS_CUSTOMER_ID + ":uploadClickConversions";
    const _conv = {
      conversionAction: convResource,
      conversionDateTime: ct,
      conversionValue: value,
      currencyCode: currency,
      orderId: orderId
    };
    // Exactly one click id per conversion. NOTE: gbraid/wbraid require the conversion
    // action to use MANY_PER_CLICK counting (QA conv 7607422039 switched 2026-06-04).
    if (gclid) _conv.gclid = gclid;
    else if (gbraid) _conv.gbraid = gbraid;
    else _conv.wbraid = wbraid;
    const payload = {
      conversions: [_conv],
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

    // === Mirror to Meta CAPI ===
    let metaCapi = null;
    try {
      const META_TOKEN = process.env.META_ACCESS_TOKEN;
      const META_PIXEL = process.env.META_PIXEL_ID || "1879445049445130";
      if (META_TOKEN && META_PIXEL) {
        // Cowork 2026-05-11: allow callers to override the Meta event_name (ARIVE flows use "Lead"/"Purchase")
        const evtName = b.meta_event_name
          ? String(b.meta_event_name)
          : ((b.past_client === true || b.past_client === "true" || b.past_client === 1) ? "FundedLoanPastClient" : "FundedLoan");
        const user_data = {};
        if (b.email) user_data.em = [_coworkSha256Hex(b.email)];
        if (b.phone) user_data.ph = [_coworkSha256Hex(String(b.phone).replace(/\D/g,""))];
        if (b.fbp) user_data.fbp = b.fbp;
        if (b.fbc) user_data.fbc = b.fbc;
        const evtData = [{
          event_name: evtName,
          event_time: Math.floor(Date.now()/1000),
          action_source: "system_generated",
          event_source_url: "https://turturhomeloans.com/funded",
          user_data: user_data,
          custom_data: { currency: currency, value: value, order_id: orderId, past_client: !!b.past_client, gclid: gclid }
        }];
        const formBody = new URLSearchParams({ data: JSON.stringify(evtData), access_token: META_TOKEN });
        const mr = await fetch("https://graph.facebook.com/v23.0/" + META_PIXEL + "/events", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: formBody.toString(),
        });
        metaCapi = { status: mr.status, body: (await mr.text()).slice(0, 300) };
        console.log("[META CAPI] " + evtName + " status=" + mr.status);
      }
    } catch (mexc) { metaCapi = { error: mexc.message }; console.error("[META CAPI]", mexc.message); }

    // === COWORK 2026-05-14: Mirror to GA4 via Measurement Protocol ===
    // Default to "purchase" (funded loan). ARIVE_APPLICATION callers override with "close_convert_lead".
    // Set ga4_event_name=null in the request body to skip GA4 push entirely.
    let ga4 = null;
    try {
      const ga4Name = (typeof b.ga4_event_name !== "undefined") ? b.ga4_event_name : "purchase";
      if (ga4Name) {
        const clientId = (b.email && String(b.email).trim()) || orderId;
        ga4 = await postGa4Event(clientId, ga4Name, {
          value: value,
          currency: currency,
          transaction_id: orderId,
          gclid: gclid || ""
        });
      } else {
        ga4 = { skipped: true, reason: "ga4_event_name=null" };
      }
    } catch (ga4exc) {
      ga4 = { error: ga4exc.message };
      console.error("[GA4-MP] handler err:", ga4exc.message);
    }

    return res.status(r.ok ? 200 : 502).json({
      ok: r.ok,
      http: r.status,
      conversion_action_id: _convId,
      sent: { gclid, value, currency, conversion_time: ct, order_id: orderId },
      google: parsed,
      meta_capi: metaCapi,
      ga4: ga4
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
// === PAST-CLIENT MATCHING (with Postgres durable backup) ===
const _PCM_DISK = "/tmp/past_clients.json";
let _pcmCache = null;
let _pgPool = null;

async function _pgGetPool() {
  if (_pgPool) return _pgPool;
  if (!process.env.DATABASE_URL) return null;
  const pgmod = await import("pg");
  const Pool = pgmod.Pool || (pgmod.default && pgmod.default.Pool);
  // SSL: always enable for non-local DBs (Render, Neon, Supabase, etc. all require it).
  const _dbUrl = process.env.DATABASE_URL;
  const _isLocal = /(@|\/)(localhost|127\.0\.0\.1)/.test(_dbUrl || "");
  _pgPool = new Pool({
    connectionString: _dbUrl,
    ssl: _isLocal ? false : { rejectUnauthorized: false },
    max: 5,
  });
  await _pgPool.query(`CREATE TABLE IF NOT EXISTS past_clients (
    email_hash TEXT,
    phone_hash TEXT,
    record JSONB NOT NULL
  )`);
  await _pgPool.query("CREATE INDEX IF NOT EXISTS past_clients_email_hash_idx ON past_clients(email_hash) WHERE email_hash IS NOT NULL");
  await _pgPool.query("CREATE INDEX IF NOT EXISTS past_clients_phone_hash_idx ON past_clients(phone_hash) WHERE phone_hash IS NOT NULL");
  // === COWORK 2026-06-11: appointment day-before reminder schedule ===
  await _pgPool.query(`CREATE TABLE IF NOT EXISTS appointment_reminders (
    prospect_id TEXT PRIMARY KEY,
    email TEXT,
    start_time TIMESTAMPTZ NOT NULL,
    daybefore_due TIMESTAMPTZ NOT NULL,
    daybefore_sent BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  // === COWORK 2026-06-03: google_contacts cache (bonzo_id -> People API resourceName) ===
  await _pgPool.query(`CREATE TABLE IF NOT EXISTS google_contacts (
    bonzo_id TEXT PRIMARY KEY,
    resource_name TEXT NOT NULL,
    email TEXT,
    phone_last10 TEXT,
    etag TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await _pgPool.query("CREATE INDEX IF NOT EXISTS google_contacts_phone_idx ON google_contacts(phone_last10) WHERE phone_last10 IS NOT NULL");
  await _pgPool.query("CREATE INDEX IF NOT EXISTS google_contacts_email_idx ON google_contacts(email) WHERE email IS NOT NULL");
  // === COWORK 2026-07-14: lead_events — durable raw log of every /lead/inbound payload ===
  // Partials used to post straight to Bonzo's webhook; unmapped fields were lost forever.
  // Every inbound payload (full + partial) now lands here so nothing is ever unrecoverable.
  await _pgPool.query(`CREATE TABLE IF NOT EXISTS lead_events (
    id BIGSERIAL PRIMARY KEY,
    lead_id TEXT,
    email TEXT,
    kind TEXT NOT NULL,
    lead_source TEXT,
    payload JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await _pgPool.query("CREATE INDEX IF NOT EXISTS lead_events_email_idx ON lead_events(email) WHERE email IS NOT NULL");
  await _pgPool.query("CREATE INDEX IF NOT EXISTS lead_events_lead_id_idx ON lead_events(lead_id) WHERE lead_id IS NOT NULL");
  return _pgPool;
}

function _coworkSha256Hex(s) {
  return _coworkCreateHash("sha256").update(String(s||"").toLowerCase().trim()).digest("hex");
}

function _coworkPCMLoad() {
  if (_pcmCache) return _pcmCache;
  try {
    if (fs.existsSync(_PCM_DISK)) {
      _pcmCache = JSON.parse(fs.readFileSync(_PCM_DISK, "utf8"));
      return _pcmCache;
    }
  } catch (e) { console.error("PCM load:", e.message); }
  _pcmCache = { records: [], by_email_hash: {}, by_phone_hash: {}, generated: null };
  return _pcmCache;
}

function _coworkPCMSave() {
  try { fs.writeFileSync(_PCM_DISK, JSON.stringify(_pcmCache)); }
  catch (e) { console.error("PCM save:", e.message); }
  _pgPersistFromCache().catch(e => console.error("PCM pg persist:", e.message));
}

async function _pgPersistFromCache() {
  const pool = await _pgGetPool();
  if (!pool || !_pcmCache || !_pcmCache.records) return;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("TRUNCATE TABLE past_clients");
    const insertText = "INSERT INTO past_clients(email_hash, phone_hash, record) VALUES ($1,$2,$3)";
    const ehLookup = {};
    const phLookup = {};
    for (const h in _pcmCache.by_email_hash) ehLookup[_pcmCache.by_email_hash[h]] = h;
    for (const h in _pcmCache.by_phone_hash) phLookup[_pcmCache.by_phone_hash[h]] = h;
    for (let i = 0; i < _pcmCache.records.length; i++) {
      await client.query(insertText, [ehLookup[i] || null, phLookup[i] || null, _pcmCache.records[i]]);
    }
    await client.query("COMMIT");
    console.log("PCM: persisted", _pcmCache.records.length, "records to Postgres");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

async function _pgHydrateIfEmpty() {
  if (_pcmCache && _pcmCache.records && _pcmCache.records.length > 0) return;
  const pool = await _pgGetPool();
  if (!pool) return;
  const { rows } = await pool.query("SELECT email_hash, phone_hash, record FROM past_clients");
  if (rows.length === 0) return;
  const cache = { records: [], by_email_hash: {}, by_phone_hash: {}, generated: new Date().toISOString() };
  rows.forEach((r, idx) => {
    cache.records.push(r.record);
    if (r.email_hash) cache.by_email_hash[r.email_hash] = idx;
    if (r.phone_hash) cache.by_phone_hash[r.phone_hash] = idx;
  });
  _pcmCache = cache;
  try { fs.writeFileSync(_PCM_DISK, JSON.stringify(_pcmCache)); } catch (e) {}
  console.log("PCM: hydrated", rows.length, "records from Postgres");
}

_pgHydrateIfEmpty().catch(e => console.error("PCM hydrate failed:", e.message));

function _coworkPCMatch(email, phone) {
  const c = _coworkPCMLoad();
  const eh = email ? _coworkSha256Hex(email) : null;
  const ph = phone ? _coworkSha256Hex(String(phone).replace(/\D/g,"")) : null;
  if (eh && Object.prototype.hasOwnProperty.call(c.by_email_hash, eh)) return c.records[c.by_email_hash[eh]];
  if (ph && Object.prototype.hasOwnProperty.call(c.by_phone_hash, ph)) return c.records[c.by_phone_hash[ph]];
  return null;
}
// === END PAST-CLIENT MATCHING ===


app.post("/customer-match/upload/:code", express.json({limit: "50mb"}), async function(req, res) {
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

    // === Push hashed list to Meta Custom Audiences in parallel ===
    let metaResults = { all: null, refi: null };
    try {
      const META_TOKEN = process.env.META_ACCESS_TOKEN;
      const META_ALL = process.env.META_AUDIENCE_PAST_CLIENT_ALL_ID;
      const META_REFI = process.env.META_AUDIENCE_REFI_ELIGIBLE_ID;
      if (META_TOKEN && META_ALL) {
        // Build hashed user payloads
        const allPayload = { schema: ["EMAIL", "PHONE"], data: [] };
        const refiPayload = { schema: ["EMAIL", "PHONE"], data: [] };
        for (const r of cache.records) {
          // Lowercase trimmed email + digits-only phone, then SHA-256
          // Build hashed values directly from already-hashed eh/ph (those are sha256 of lowercased+trimmed)
          if (!r.eh && !r.ph) continue;
          const row = [r.eh || "", r.ph || ""];
          allPayload.data.push(row);
          if (r.savings && r.savings.monthly_savings > 0) {
            refiPayload.data.push(row);
          }
        }
        async function metaUpload(audId, payload) {
          if (!audId || payload.data.length === 0) return null;
          const body = new URLSearchParams({
            payload: JSON.stringify(payload),
            access_token: META_TOKEN,
          });
          const r = await fetch("https://graph.facebook.com/v23.0/" + audId + "/users", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: body.toString(),
          });
          const t = await r.text();
          return { status: r.status, body: t.slice(0, 400), count: payload.data.length };
        }
        try { metaResults.all = await metaUpload(META_ALL, allPayload); } catch (e) { metaResults.all = { error: e.message }; }
        if (META_REFI) {
          try { metaResults.refi = await metaUpload(META_REFI, refiPayload); } catch (e) { metaResults.refi = { error: e.message }; }
        }
        console.log("[META audience] all=" + JSON.stringify(metaResults.all) + " refi=" + JSON.stringify(metaResults.refi));
      }
    } catch (e) { console.error("[META audience] push error:", e.message); }

    const googleResults = await _googleCustomerMatchUpload(cache).catch(e => ({ error: String(e && e.message || e) }));

    return res.status(200).json({
      ok: true,
      records_stored: cache.records.length,
      with_email: Object.keys(cache.by_email_hash).length,
      with_phone: Object.keys(cache.by_phone_hash).length,
      with_savings: cache.records.filter(rr=>rr.savings).length,
      meta_audience: metaResults,
      google_customer_match: googleResults
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
console.log("[PCM] wrapper init typeof_extract=" + typeof _coworkExtractAttribution + " typeof_match=" + typeof _coworkPCMatch);

// Wrap _coworkExtractAttribution to also enrich with past-client data
if (typeof _coworkExtractAttribution === "function" && typeof _coworkPCMatch === "function") {
  const _origExtract = _coworkExtractAttribution;
  _coworkExtractAttribution = function(body) {
    const flat = _origExtract(body);
    console.log("[PCM] wrapper called email=" + (flat.email||"").slice(0,8) + " phone=" + String(flat.phone||"").slice(0,6));
    try {
      const email = (flat.email || "").toLowerCase().trim();
      const phone = String(flat.phone || flat.phone_number || "").replace(/\D/g, "");
      const match = _coworkPCMatch(email, phone);
      if (!match) console.log("[PCM] no match for email=" + email.slice(0,10));
      if (match) {
        // Tag this submission as a past-client re-engagement.
        // We also overwrite form_name because Bonzo webhooks map "Lead source ← form_name"
        // — without this override, the form's original name (e.g. "Purchase Options Form")
        // would land in mortgage.lead_source and the Got Lead "Lead type Past Client?"
        // condition would not match.
        flat.lead_source = "Past Client - Re-engaged";
        flat.form_name = "Past Client - Re-engaged";
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




// === COWORK: Auto-decide lead fate ===
const TURTUR_NEW_LEAD_STAGE_ID = 420154;
const TURTUR_NURTURE_STAGE_ID = 411990;
const TURTUR_BAD_LEAD_STAGE_ID = 411900;
const TURTUR_PURCHASE_INSTANT_RESPONSE_ID = 212081;
const TURTUR_BAD_CAMPAIGN_ID = 210023;
const TURTUR_TEXT_NURTURE_CAMPAIGN_ID = 226237;
const TURTUR_EMAIL_NURTURE_CAMPAIGN_ID = 226242;
const TURTUR_EMAILTEXT_NURTURE_CAMPAIGN_ID = 226238;

function _decideLeadFate(prospect) {
  const tagNames = (prospect.tags || []).map(t => String(typeof t === "string" ? t : (t.name||"")).toLowerCase());
  const hasBadEmail = tagNames.includes("bad_email");
  const hasBadPhone = tagNames.includes("bad_phone");
  if (prospect.do_not_call || (Array.isArray(prospect.opt_outs) && prospect.opt_outs.length > 0)) {
    return { decision: "skip_opted_out", reason: "do_not_call or opt_out present" };
  }
  // COWORK 2026-06-11: a booked appointment is not a stale lead — leave them alone.
  if (tagNames.includes("appointment_set")) {
    return { decision: "skip_appointment_set", reason: "active appointment booked" };
  }
  if (hasBadEmail && hasBadPhone) return { decision: "bad_lead", target_campaign_id: TURTUR_BAD_CAMPAIGN_ID, target_stage_id: TURTUR_BAD_LEAD_STAGE_ID };
  if (hasBadEmail)                return { decision: "text_nurture", target_campaign_id: TURTUR_TEXT_NURTURE_CAMPAIGN_ID, target_stage_id: TURTUR_NURTURE_STAGE_ID };
  if (hasBadPhone)                return { decision: "email_nurture", target_campaign_id: TURTUR_EMAIL_NURTURE_CAMPAIGN_ID, target_stage_id: TURTUR_NURTURE_STAGE_ID };
  return { decision: "general_nurture", target_campaign_id: TURTUR_EMAILTEXT_NURTURE_CAMPAIGN_ID, target_stage_id: TURTUR_NURTURE_STAGE_ID };
}

async function _executeLeadDecision(prospect, decision) {
  // COWORK 2026-06-11: rewritten with real Bonzo v3 routes (the old PUT/DELETE/start
  // routes never existed — they 404'd silently because bonzoFetch doesn't throw).
  const actions = [];
  try {
    const r = await bonzoFetch("/prospects/" + prospect.id + "/pipeline-stage/" + decision.target_stage_id, { method: "POST" });
    actions.push(r && r.ok ? "moved_stage" : "stage_failed:" + (r && r.status));
  } catch (e) { actions.push("stage_err:" + e.message); }
  try {
    // "Move to campaign" REPLACES the current campaign (detaches Purchase Instant Response).
    const r = await bonzoFetch("/prospects/" + prospect.id + "/campaign/" + decision.target_campaign_id, { method: "POST" });
    actions.push(r && r.ok ? "moved_to_target_campaign" : "campaign_failed:" + (r && r.status));
  } catch (e) { actions.push("enroll_err:" + e.message); }
  return actions;
}

async function _autoDecideLeadFate(opts) {
  opts = opts || {};
  const dryRun = opts.dryRun !== false;
  const minAgeHours = opts.minAgeHours || 24;
  const limit = opts.limit || 50;
  const listResp = await bonzoFetch("/prospects?pipeline_stage_id=" + TURTUR_NEW_LEAD_STAGE_ID + "&per_page=" + limit, { method: "GET" });
  const prospects = (listResp && listResp.json && listResp.json.data) || [];
  const cutoff = Date.now() - minAgeHours * 60 * 60 * 1000;
  const eligible = prospects.filter(p => p.created_at && new Date(p.created_at).getTime() < cutoff);
  const results = [];
  for (const p of eligible) {
    const decision = _decideLeadFate(p);
    const summary = {
      id: p.id,
      name: p.full_name || ((p.first_name||"") + " " + (p.last_name||"")).trim(),
      tags: (p.tags || []).map(t => typeof t === "string" ? t : t.name),
      decision: decision.decision,
      target_campaign_id: decision.target_campaign_id,
      target_stage_id: decision.target_stage_id
    };
    if (!dryRun && decision.target_campaign_id) {
      summary.actions = await _executeLeadDecision(p, decision);
    }
    results.push(summary);
  }
  console.log("[auto-decide] dry_run=" + dryRun + " reviewed=" + eligible.length + "/" + prospects.length);
  return { dry_run: dryRun, total_in_stage: prospects.length, eligible_count: eligible.length, results: results };
}

app.post("/auto-decide/:code", express.json({ limit: "1mb" }), async function(req, res) {
  if (req.params.code !== process.env.LEAD_INBOUND_CODE) return res.status(401).json({ ok: false, error: "Unauthorized" });
  try {
    const dryRun = req.query.dry_run !== "false";
    const minAgeHours = parseInt(req.query.min_age_hours, 10) || 24;
    const limit = parseInt(req.query.limit, 10) || 50;
    const out = await _autoDecideLeadFate({ dryRun: dryRun, minAgeHours: minAgeHours, limit: limit });
    res.json(Object.assign({ ok: true }, out));
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e && e.message || e), stack: String(e && e.stack || "").slice(0, 1500) });
  }
});


// =========================
// GOOGLE OAUTH CALLBACK
// Exchanges authorization code from Render's own server so the refresh token
// is bound to Render's IP. Visit /oauth2/callback after authorizing.
// =========================
app.get("/oauth2/callback", async (req, res) => {
  const code = req.query.code;
  if (!code) return res.status(400).send("Missing code parameter");
  try {
    const params = new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: "https://bonzo-sync.onrender.com/oauth2/callback",
      grant_type: "authorization_code",
    });
    const r = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });
    const j = await r.json();
    if (!r.ok) return res.status(400).json({ error: j.error, description: j.error_description });
    res.json({
      ok: true,
      refresh_token: j.refresh_token,
      access_token: j.access_token ? j.access_token.substring(0, 30) + "..." : null,
      scope: j.scope,
      note: "Save refresh_token to Render env var GOOGLE_REFRESH_TOKEN then redeploy"
    });
  } catch (e) {
    res.status(500).json({ error: String(e.message) });
  }
});



// === COWORK 2026-05-11: Arive (LOS) integration ===
// Arive is the loan-origination system at https://api.arive.com.
// Outbound calls auth via POST /api/auth/login → JWT bearer token (~1hr lifetime).
// Inbound webhooks from Arive verified via X-API-KEY header.
//
// Required env vars (set ARIVE_APP_ID + ARIVE_APP_SECRET_HASH once partner creds arrive):
//   ARIVE_API_KEY           inbound-webhook verification key (32-char from Settings → API Integrations)
//   ARIVE_API_BASE          defaults to https://api.arive.com
//   ARIVE_CLIENT_ID         40-char Client ID
//   ARIVE_SECRET            64-char Secret Key
//   ARIVE_APP_ID            PROVIDED BY ARIVE PARTNER PROGRAM
//   ARIVE_APP_SECRET_HASH   PROVIDED BY ARIVE PARTNER PROGRAM
//
// Endpoints we expose:
//   POST /arive/webhook/:code   (Arive → us — receives event notifications)
//   POST /arive/subscribe/:code (ops helper — subscribes a webhook on Arive)
//   GET  /arive/hooks/:code     (ops helper — lists active hooks)

let _ariveToken = { value: null, expiresAt: 0 };

async function _ariveGetToken() {
  if (_ariveToken.value && Date.now() < _ariveToken.expiresAt) return _ariveToken.value;
  const base = process.env.ARIVE_API_BASE || "https://api.arive.com";
  const need = ["ARIVE_CLIENT_ID","ARIVE_SECRET","ARIVE_API_KEY","ARIVE_APP_ID","ARIVE_APP_SECRET_HASH"];
  const missing = need.filter(k => !process.env[k]);
  if (missing.length) throw new Error("Arive auth missing env: " + missing.join(","));
  const body = {
    clientId:      process.env.ARIVE_CLIENT_ID,
    secret:        process.env.ARIVE_SECRET,
    apiKey:        process.env.ARIVE_API_KEY,
    appId:         process.env.ARIVE_APP_ID,
    appSecretHash: process.env.ARIVE_APP_SECRET_HASH,
  };
  const r = await fetch(base + "/api/auth/login", {
    method: "POST",
    headers: { "Content-Type":"application/json", "Accept":"application/json", "X-API-KEY": body.apiKey, "User-Agent":"Mozilla/5.0 bonzo-sync arive" },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error("Arive login " + r.status + ": " + JSON.stringify(j));
  _ariveToken.value = j.AccessToken;
  _ariveToken.expiresAt = Date.now() + (Number(j.ExpiresIn || 3600) - 60) * 1000;
  console.log("[arive] token refreshed, expires in", j.ExpiresIn, "s");
  return _ariveToken.value;
}

async function _ariveFetch(method, path, payload) {
  const base = process.env.ARIVE_API_BASE || "https://api.arive.com";
  async function _do(token) {
    return fetch(base + path, {
      method,
      headers: {
        "Authorization": "Bearer " + token,
        "Content-Type": "application/json",
        "Accept": "application/json",
        "X-API-KEY": process.env.ARIVE_API_KEY,
        "User-Agent": "Mozilla/5.0 bonzo-sync arive",
      },
      body: payload ? JSON.stringify(payload) : undefined,
    });
  }
  let r = await _do(await _ariveGetToken());
  if (r.status === 401) {
    _ariveToken = { value: null, expiresAt: 0 };
    r = await _do(await _ariveGetToken());
  }
  let body = null;
  try { body = await r.json(); } catch { try { body = await r.text(); } catch {} }
  return { status: r.status, ok: r.ok, body };
}

// Inbound: Arive posts events here when loans/leads change.
// Path-based code + X-API-KEY header — both must match.
app.post("/arive/webhook/:code", async (req, res) => {
  if (req.params.code !== process.env.LEAD_INBOUND_CODE) return res.status(401).send("Unauthorized (path)");
  // Path code (LEAD_INBOUND_CODE) is primary auth. X-API-KEY header is optional defense-in-depth:
  //   - If a key was sent AND we have ARIVE_API_KEY configured, the values must match.
  //   - If no key was sent, that's fine (Zapier doesn't send custom headers by default).
  const sentKey = req.header("x-api-key") || req.header("X-API-KEY");
  if (sentKey && process.env.ARIVE_API_KEY && sentKey !== process.env.ARIVE_API_KEY) {
    console.warn("[arive/webhook] X-API-KEY mismatch — got", sentKey.slice(0,6)+"…");
    return res.status(401).send("Unauthorized (api key)");
  }
  const body = req.body || {};
  // Spec doesn't pin exact payload field names — accept multiple casings
  const event  = String(body.Event || body.event || body.EventType || "").toUpperCase();
  const loanId = body.LoanId || body.loanId || body.LoanID || null;
  const leadId = body.LeadId || body.leadId || body.LeadID || null;
  console.log("[arive/webhook] event=" + event + " loanId=" + loanId + " leadId=" + leadId);

  // ACK fast; process async
  res.status(200).json({ ok: true, queued: event });
  setImmediate(async () => {
    try {
      switch (event) {
        case "LEAD_CREATED":
        case "LEAD_UPDATED":
          await _ariveOnLead(event, leadId, body); break;
        case "LOAN_APP_SUBMITTED":
          await _ariveOnLoanAppSubmitted(loanId); break;   // PRIMARY bid signal
        case "LOAN_CREATED":
          await _ariveOnLoanCreated(loanId); break;
        case "LOAN_STAGE_CHANGED":
          await _ariveOnLoanStageChanged(loanId); break;
        case "LOAN_DATE_CHANGED":
          await _ariveOnLoanDateChanged(loanId); break;
        default:
          console.log("[arive/webhook] unhandled event:", event);
      }
    } catch (e) {
      console.error("[arive/webhook] handler error for", event + ":", e && e.stack || e);
    }
  });
});

// Lead handler — tolerant of both shapes:
//   (a) Arive-direct webhook: {Event, LeadId} → we call back to /api/leads/{id} for borrower data
//   (b) Zapier-bridge: full borrower fields already in payload (first_name, email, phone, ...)
async function _ariveOnLead(event, leadId, rawBody) {
  // Try payload-inline first (Zapier shape)
  let b = null;
  if (rawBody && typeof rawBody === "object") {
    const flat = rawBody;
    const inlineEmail = flat.email || flat.Email || flat.borrower_email || flat["Borrower Email"];
    const inlinePhone = flat.phone || flat.Phone || flat.mobile_phone || flat["Mobile Phone"];
    if (inlineEmail || inlinePhone) {
      b = {
        FirstName: flat.first_name || flat.FirstName || flat["First Name"] || "",
        LastName:  flat.last_name  || flat.LastName  || flat["Last Name"]  || "",
        Email:     inlineEmail || "",
        Phone:     inlinePhone || "",
      };
      console.log("[arive/lead] using inline payload data (Zapier-bridge mode), email=" + (inlineEmail || "(none)"));
    }
  }
  // Fall back to Arive API fetch if we have a leadId but no inline data
  if (!b && leadId) {
    const r = await _ariveFetch("GET", "/api/leads/" + leadId);
    if (!r.ok) { console.error("[arive/lead] fetch fail", r.status, r.body); return; }
    const lead = r.body || {};
    b = (lead.Borrowers && lead.Borrowers[0]) || lead.Borrower || lead.borrower || {};
  }
  if (!b) { console.warn("[arive/lead] no payload data and no leadId to fetch"); return; }
  const email = b.Email || b.email;
  const phone = b.MobilePhone || b.Phone || b.phone;
  if (!email && !phone) { console.warn("[arive/lead] no contact info on lead", leadId); return; }
  // Reuse the same Bonzo-upsert path used by /lead/inbound
  const fakeReq = {
    body: {
      form_name: "ARIVE Lead",
      fields: {
        first_name:  { value: b.FirstName || b.firstName || "" },
        last_name:   { value: b.LastName  || b.lastName  || "" },
        email:       { value: email || "" },
        phone:       { value: phone || "" },
        lead_source: { value: "ARIVE Lead" },
      },
    },
  };
  const fakeRes = { status: () => fakeRes, json: () => fakeRes, send: () => fakeRes };
  await _coworkHandleInbound(fakeReq, fakeRes);
  console.log("[arive/lead] upserted lead", leadId, "into Bonzo");
}

async function _ariveOnLoanAppSubmitted(loanId) {
  // 1003 / application submitted — the PRIMARY conversion signal for Google Ads bidding.
  // TODO once we have GCLID-by-email lookup: upload offline conv 'qualified_application' + Meta CAPI Lead.
  if (!loanId) return;
  const r = await _ariveFetch("GET", "/api/loans/" + loanId);
  if (!r.ok) { console.error("[arive/loan-app] fetch fail", r.status, r.body); return; }
  const loan = r.body || {};
  const b = (loan.Borrowers && loan.Borrowers[0]) || {};
  console.log("[arive/loan-app] LOAN_APP_SUBMITTED loanId=" + loanId + " borrower email=" + (b.Email || "?") + " — fan-out to Google Ads/Meta CAPI pending Postgres gclid lookup");
}

async function _ariveOnLoanCreated(loanId) { console.log("[arive/loan-created] loanId=" + loanId + " — no-op"); }
async function _ariveOnLoanStageChanged(loanId) { console.log("[arive/loan-stage] loanId=" + loanId + " — map stage to Bonzo lifecycle pending"); }
async function _ariveOnLoanDateChanged(loanId) { console.log("[arive/loan-date] loanId=" + loanId + " — check funded date → Google Ads revenue conv pending"); }

// Ops helpers — subscribe / list webhook hooks via JSON POST.
app.post("/arive/subscribe/:code", express.json(), async (req, res) => {
  if (req.params.code !== process.env.LEAD_INBOUND_CODE) return res.status(401).send("Unauthorized");
  const event = (req.body || {}).event;
  if (!event) return res.status(400).json({ ok: false, error: "missing 'event' field" });
  const webhookUrl = "https://bonzo-sync.onrender.com/arive/webhook/" + process.env.LEAD_INBOUND_CODE;
  try {
    const r = await _ariveFetch("POST", "/api/hooks/subscribe", { WebhookUrl: webhookUrl, Event: event });
    return res.status(r.status).json(r.body || {});
  } catch (e) { return res.status(500).json({ ok: false, error: String(e.message || e) }); }
});

app.get("/arive/hooks/:code", async (req, res) => {
  if (req.params.code !== process.env.LEAD_INBOUND_CODE) return res.status(401).send("Unauthorized");
  try {
    const r = await _ariveFetch("GET", "/api/hooks");
    return res.status(r.status).json(r.body || {});
  } catch (e) { return res.status(500).json({ ok: false, error: String(e.message || e) }); }
});
// === END COWORK ARIVE PATCH ===


// === COWORK 2026-06-03: Spam-call prospect cleanup ===
// Deletes Bonzo prospects whose name is just a phone number (incoming
// spam calls/texts that left no real name). Also removes the matching
// Google Contact if one exists.
//
// Defense:
//   - Auth: code must equal LEAD_INBOUND_CODE
//   - dry_run default = true (must explicitly pass ?dry_run=false to delete)
//   - Hard cap: never delete more than SPAM_CLEANUP_HARD_CAP per run
//   - Logs every candidate before delete; returns full report
app.post("/spam-cleanup/:code", express.json({ limit: "1mb" }), async function(req, res) {
  if (req.params.code !== process.env.LEAD_INBOUND_CODE) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }
  try {
    const dryRun = req.query.dry_run !== "false";
    const HARD_CAP = Math.min(Number(process.env.SPAM_CLEANUP_HARD_CAP || 50), 200);
    const requestLimit = Math.min(Number(req.query.limit) || 50, HARD_CAP);

    // Pull all prospects, paginated
    const candidates = [];
    let page = 1;
    let lastPage = 1;
    do {
      const r = await bonzoFetch("/prospects?per_page=100&page=" + page, { method: "GET" });
      if (!r || !r.ok || !r.json) {
        return res.status(502).json({ ok: false, error: "bonzo_list_failed", page: page, status: r && r.status });
      }
      const data = r.json.data || [];
      const meta = r.json.meta || {};
      lastPage = meta.last_page || 1;
      for (const p of data) {
        if (nameLooksLikePhone(p.first_name, p.last_name)) {
          candidates.push({
            id: p.id,
            full_name: (p.full_name || "").trim(),
            source: p.source || null,
            status: p.status || null,
            created_at: p.created_at || null,
            email: p.email || null,
            phone: p.phone || null,
          });
        }
      }
      page++;
    } while (page <= lastPage);

    // Apply hard cap
    const toDelete = candidates.slice(0, requestLimit);
    const skipped = candidates.length - toDelete.length;

    console.log("[spam-cleanup] candidates=" + candidates.length +
                " will_act=" + toDelete.length + " hard_cap_skipped=" + skipped +
                " dry_run=" + dryRun);

    const results = [];
    let deletedBonzo = 0, deletedGoogle = 0, errors = 0;

    if (!dryRun) {
      for (const c of toDelete) {
        const r = { id: c.id, name: c.full_name, bonzo_delete: null, google_delete: null };
        // Bonzo DELETE
        try {
          const del = await bonzoFetch("/prospects/" + c.id, { method: "DELETE" });
          r.bonzo_delete = { ok: del && del.ok, status: del && del.status };
          if (del && del.ok) deletedBonzo++;
          else errors++;
        } catch (e) {
          r.bonzo_delete = { ok: false, error: e && e.message };
          errors++;
        }
        // Google delete (best-effort)
        try {
          const gd = await deleteGoogleContactsForBonzoProspect(c.id, c.email, c.phone);
          r.google_delete = gd;
          if (gd && gd.deleted) deletedGoogle += gd.deleted;
        } catch (e) {
          r.google_delete = { ok: false, error: e && e.message };
        }
        results.push(r);
      }
    }

    return res.json({
      ok: true,
      dry_run: dryRun,
      total_scanned_pages: lastPage,
      candidate_count: candidates.length,
      acted_on: toDelete.length,
      hard_cap: HARD_CAP,
      hard_cap_skipped: skipped,
      deleted_bonzo: deletedBonzo,
      deleted_google: deletedGoogle,
      errors: errors,
      candidates: dryRun ? candidates : undefined,
      results: dryRun ? undefined : results,
    });
  } catch (err) {
    console.error("[spam-cleanup] err:", err && err.message);
    return res.status(500).json({ ok: false, error: err && err.message });
  }
});


app.listen(process.env.PORT || 3000, () => {
  console.log("Server running");
});
