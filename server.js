import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json({ limit: "1mb" }));

/**
 * ENV REQUIRED:
 *  - BONZO_CODE
 *  - BONZO_API_KEY
 *  - BONZO_AUTH_MODE  (bearer | raw | xapikey)  <-- IMPORTANT
 *  - (optional) BONZO_BASE_URL default https://app.getbonzo.com/api
 *
 *  - GOOGLE_CLIENT_ID
 *  - GOOGLE_CLIENT_SECRET
 *  - GOOGLE_REFRESH_TOKEN
 *
 *  - MS_TENANT_ID
 *  - MS_CLIENT_ID
 *  - MS_CLIENT_SECRET
 *  - OUTLOOK_MAILBOX   (example: didier@turturhomeloans.com)
 *
 *  - SCAN_SECRET  (required for /scan-bounces)
 */

// ------------------ HELPERS ------------------

function digitsOnly(p) {
  return String(p || "").replace(/\D/g, "");
}

function normalizeEmail(e) {
  const s = String(e || "").trim().toLowerCase();
  return s || "";
}

function normalizePhoneForStore(p) {
  if (!p) return "";
  const raw = String(p).trim();
  const hasPlus = raw.startsWith("+");
  const d = digitsOnly(raw);
  if (!d) return "";
  return hasPlus ? `+${d}` : d;
}

function last10Digits(d) {
  const s = String(d || "");
  if (s.length <= 10) return s;
  return s.slice(-10);
}

function ensurePeopleResourceName(resourceName) {
  if (!resourceName) return resourceName;
  return resourceName.startsWith("people/") ? resourceName : `people/${resourceName}`;
}

async function readJsonOrText(r) {
  const text = await r.text();
  try {
    return { ok: r.ok, status: r.status, json: JSON.parse(text), text: null };
  } catch {
    return { ok: r.ok, status: r.status, json: null, text };
  }
}

function nameLooksLikePhone(first, last) {
  const full = `${first || ""} ${last || ""}`.trim();
  if (!full) return true;
  const cleaned = full.replace(/[\s\-\(\)]/g, "");
  const digitCount = (cleaned.match(/\d/g) || []).length;
  if (cleaned.length > 0 && digitCount / cleaned.length > 0.7) return true;
  if (/^\d+$/.test(cleaned)) return true;
  return false;
}

// ------------------ GOOGLE AUTH ------------------

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
  if (!out.ok) {
    console.error("Google token error:", out.status, out.json || out.text);
    throw new Error("Failed to refresh token");
  }

  return out.json.access_token;
}

// ------------------ PEOPLE API: SEARCH + GET ------------------

async function searchGoogleContacts(query, accessToken) {
  const url =
    "https://people.googleapis.com/v1/people:searchContacts" +
    `?query=${encodeURIComponent(query)}` +
    "&readMask=names,emailAddresses,phoneNumbers,biographies,metadata" +
    "&pageSize=10";

  const r = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  const out = await readJsonOrText(r);

  if (!out.ok) {
    console.error("searchContacts failed:", out.status, out.json || out.text);
    throw new Error("Failed to search contacts");
  }

  const results = out.json?.results || [];
  return results.map((x) => x.person).filter(Boolean);
}

async function getPerson(resourceName, accessToken) {
  const rn = ensurePeopleResourceName(resourceName);

  const url =
    `https://people.googleapis.com/v1/${rn}` +
    "?personFields=names,emailAddresses,phoneNumbers,biographies,organizations";

  const r = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  const out = await readJsonOrText(r);

  if (!out.ok) {
    console.error("getPerson failed:", out.status, out.json || out.text);
    throw new Error("Failed to read person");
  }

  return out.json;
}

// ------------------ MATCHING LOGIC ------------------

function personHasEmail(person, email) {
  if (!email) return false;
  const emails = person?.emailAddresses || [];
  return emails.some((e) => normalizeEmail(e?.value) === email);
}

function personHasPhone(person, phoneDigits) {
  if (!phoneDigits) return false;

  const targetDigits = digitsOnly(phoneDigits);
  const targetLast10 = last10Digits(targetDigits);

  const phones = person?.phoneNumbers || [];
  for (const p of phones) {
    const pd = digitsOnly(p?.value || "");
    if (!pd) continue;

    if (pd === targetDigits) return true;
    if (last10Digits(pd) === targetLast10 && targetLast10.length === 10) return true;
  }
  return false;
}

async function findExistingContact(prospect, accessToken) {
  const email = normalizeEmail(prospect?.email);
  const phoneStored = normalizePhoneForStore(prospect?.phone);
  const phoneDigits = digitsOnly(phoneStored);
  const phoneLast10 = last10Digits(phoneDigits);

  const queries = [];

  if (phoneDigits) {
    queries.push(phoneStored);
    queries.push(phoneDigits);
    if (phoneLast10 && phoneLast10.length === 10) queries.push(phoneLast10);
  }

  if (email) queries.push(email);

  const uniqQueries = [...new Set(queries)].filter(Boolean);

  for (const q of uniqQueries) {
    const people = await searchGoogleContacts(q, accessToken);
    if (!people.length) continue;

    const byPhone = phoneDigits ? people.find((p) => personHasPhone(p, phoneDigits)) : null;
    if (byPhone?.resourceName) return byPhone;

    const byEmail = email ? people.find((p) => personHasEmail(p, email)) : null;
    if (byEmail?.resourceName) return byEmail;

    if (people.length === 1 && people[0]?.resourceName) return people[0];
  }

  return null;
}

// ------------------ UPSERT GOOGLE CONTACT ------------------

async function upsertGoogleContact(prospect) {
  if (nameLooksLikePhone(prospect?.first_name, prospect?.last_name)) {
    console.log("Skipping number-as-name contact", {
      first: prospect?.first_name,
      last: prospect?.last_name,
      phone: prospect?.phone,
      id: prospect?.id,
    });
    return;
  }

  const phoneStored = normalizePhoneForStore(prospect?.phone);
  const phoneDigits = digitsOnly(phoneStored);
  if (!phoneDigits) return;

  const email = normalizeEmail(prospect?.email);
  const accessToken = await getGoogleAccessToken();

  const body = {
    names: [{ givenName: prospect?.first_name || "", familyName: prospect?.last_name || "" }],
    emailAddresses: email ? [{ value: email }] : [],
    phoneNumbers: [{ value: phoneStored || phoneDigits }],
    biographies: [{ value: `Source: Bonzo | ID: ${prospect?.id || ""}` }],
    organizations: [{ name: "Home Loans", title: "Lead" }],
  };

  const found = await findExistingContact(prospect, accessToken);

  // UPDATE
  if (found?.resourceName) {
    const person = await getPerson(found.resourceName, accessToken);
    const rn = ensurePeopleResourceName(person.resourceName);

    const updateUrl =
      `https://people.googleapis.com/v1/${rn}:updateContact` +
      "?updatePersonFields=names,emailAddresses,phoneNumbers,biographies,organizations";

    for (let attempt = 1; attempt <= 2; attempt++) {
      const etag = attempt === 1 ? person.etag : (await getPerson(rn, accessToken)).etag;

      const r = await fetch(updateUrl, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
          ...(etag ? { "If-Match": etag } : {}),
        },
        body: JSON.stringify({ ...body, etag }),
      });

      const out = await readJsonOrText(r);

      if (out.ok) {
        console.log("Updated Google contact:", out.json.resourceName);
        return out.json;
      }

      if (out.status === 412 && attempt === 1) continue;

      console.error("updateContact failed:", out.status, out.json || out.text);
      throw new Error("Failed to update contact");
    }
  }

  // CREATE
  const r = await fetch("https://people.googleapis.com/v1/people:createContact", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const out = await readJsonOrText(r);

  if (!out.ok) {
    console.error("createContact failed:", out.status, out.json || out.text);
    throw new Error("Failed to create contact");
  }

  console.log("Created Google contact:", out.json.resourceName);
  return out.json;
}

// ------------------ BONZO API HELPERS ------------------

function bonzoBase() {
  // IMPORTANT: default to app.getbonzo.com (matches your webhook URLs)
  return process.env.BONZO_BASE_URL || "https://app.getbonzo.com/api";
}

function bonzoHeaders() {
  const mode = String(process.env.BONZO_AUTH_MODE || "raw").toLowerCase();
  const key = process.env.BONZO_API_KEY || "";

  // Always ask for JSON so we don't get HTML back
  const base = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };

  // Modes:
  //  - bearer: Authorization: Bearer <token>
  //  - raw:    Authorization: <token>   (NO "Bearer")
  //  - xapikey: X-API-KEY: <token>
  if (mode === "bearer") return { ...base, Authorization: `Bearer ${key}` };
  if (mode === "xapikey") return { ...base, "X-API-KEY": key };
  return { ...base, Authorization: key }; // raw (your “no Bearer” case)
}

async function bonzoFetch(path, opts = {}) {
  const url = `${bonzoBase()}${path}`;
  const r = await fetch(url, {
    ...opts,
    headers: {
      ...bonzoHeaders(),
      ...(opts.headers || {}),
    },
  });
  return await readJsonOrText(r);
}

async function bonzoGetProspectById(id) {
  return await bonzoFetch(`/prospects/${id}`, { method: "GET" });
}

async function bonzoPutProspectFull(id, prospectObj) {
  return await bonzoFetch(`/prospects/${id}`, {
    method: "PUT",
    body: JSON.stringify(prospectObj),
  });
}

// Best-effort search (leave this; it will start working once auth mode is right)
async function bonzoFindProspectsByEmail(email) {
  const e = normalizeEmail(email);
  if (!e) return [];

  const candidates = [
    `/prospects?query=${encodeURIComponent(e)}`,
    `/prospects?search=${encodeURIComponent(e)}`,
    `/prospects/search?query=${encodeURIComponent(e)}`,
  ];

  for (const path of candidates) {
    const out = await bonzoFetch(path, { method: "GET" });

    if (!out.ok) {
      console.log("Bonzo search failed:", path, out.status, out.json || out.text);
      continue;
    }

    const data = out.json;
    const list =
      data?.prospects ||
      data?.data ||
      data?.results ||
      (Array.isArray(data) ? data : null) ||
      [];

    if (Array.isArray(list)) return list;
  }

  return [];
}

// ------------------ MICROSOFT GRAPH AUTH ------------------

async function getMsGraphToken() {
  const tenant = process.env.MS_TENANT_ID;
  const clientId = process.env.MS_CLIENT_ID;
  const clientSecret = process.env.MS_CLIENT_SECRET;

  if (!tenant || !clientId || !clientSecret) {
    throw new Error("Missing MS_TENANT_ID / MS_CLIENT_ID / MS_CLIENT_SECRET");
  }

  const tokenUrl = `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`;
  const params = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "client_credentials",
    scope: "https://graph.microsoft.com/.default",
  });

  const r = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  const out = await readJsonOrText(r);
  if (!out.ok) {
    console.error("MS token error:", out.status, out.json || out.text);
    throw new Error("Failed to get Microsoft Graph token");
  }

  return out.json.access_token;
}

async function graphGet(path, token) {
  const url = `https://graph.microsoft.com/v1.0${path}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const out = await readJsonOrText(r);
  if (!out.ok) {
    console.error("Graph GET failed:", url, out.status, out.json || out.text);
    throw new Error(`Graph GET failed ${out.status}`);
  }
  return out.json;
}

// ------------------ BOUNCE DETECTION ------------------

function extractEmailFromText(text) {
  const t = String(text || "");
  const m = t.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi);
  if (!m || !m.length) return "";
  return normalizeEmail(m[0]);
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

// In-memory de-dupe for scanned messages (prevents repeat deletes)
const seenMessageIds = new Map(); // id -> timestamp
function markSeen(id) {
  if (!id) return;
  seenMessageIds.set(id, Date.now());
}
function isSeen(id) {
  if (!id) return false;
  return seenMessageIds.has(id);
}
// Clean old entries every 10 minutes (keep ~1 hour)
setInterval(() => {
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const [id, ts] of seenMessageIds.entries()) {
    if (ts < cutoff) seenMessageIds.delete(id);
  }
}, 10 * 60 * 1000);

// ------------------ WEBHOOKS ------------------

app.post("/bonzo/events", async (req, res) => {
  try {
    const code = req.header("x-bonzo-code");
    if (code !== process.env.BONZO_CODE) return res.status(401).send("Unauthorized");

    const { event, prospect } = req.body;
    console.log("Bonzo event:", event);

    if (["prospects.created", "prospects.updated"].includes(event)) {
      await upsertGoogleContact(prospect);
    }

    res.status(200).json({ ok: true });
  } catch (err) {
    console.error("Webhook error:", err);
    res.status(500).send("Server error");
  }
});

// Cleanup webhook: bad phone / bad email (Bonzo event hook)
app.post("/bonzo/event-hook", async (req, res) => {
  try {
    const code = req.header("x-bonzo-code");
    if (code !== process.env.BONZO_CODE) return res.status(401).send("Unauthorized");

    const { event, additional, prospect } = req.body;

    if (event !== "messages.outgoing.updated") {
      return res.status(200).json({ ok: true, ignored: true });
    }

    const message = additional?.message;
    if (!message) return res.status(200).json({ ok: true, ignored: true, reason: "no_message" });

    const status = String(message.status || "").toLowerCase();
    const type = String(message.type || "").toLowerCase();
    const prospectId = message?.prospect?.id || prospect?.id || message?.prospect_id;

    console.log("Message update:", { status, type, prospectId, messageId: message.id });

    const BAD_STATUSES = new Set(["failed", "bounced", "undeliverable", "error"]);
    if (!prospectId) return res.status(200).json({ ok: true, skipped: true, reason: "no_prospect_id" });
    if (!BAD_STATUSES.has(status)) return res.status(200).json({ ok: true, skipped: true, reason: "status_not_bad" });
    if (type !== "sms" && type !== "email") return res.status(200).json({ ok: true, skipped: true, reason: "type_not_sms_or_email" });

    const getOut = await bonzoGetProspectById(prospectId);

    // If you ever see HTML here, auth/base URL is wrong
    if (!getOut.ok || !getOut.json) {
      console.log("Cleanup skipped: could not GET prospect", getOut.status, getOut.json || getOut.text);
      return res.status(200).json({ ok: true, skipped: true, reason: "get_failed" });
    }

    const current = getOut.json;

    if (type === "sms") {
      current.phone = null;
      current.tags = Array.from(new Set([...(current.tags || []), "bad_phone"]));
    } else {
      current.email = null;
      current.tags = Array.from(new Set([...(current.tags || []), "bad_email"]));
    }

    const putOut = await bonzoPutProspectFull(prospectId, current);
    console.log("Cleanup result:", putOut.status, putOut.json || putOut.text);

    return res.status(200).json({ ok: true, cleaned: putOut.ok, status: putOut.status });
  } catch (err) {
    console.error("Cleanup error:", err);
    return res.status(200).json({ ok: false, error: "exception" });
  }
});

// ------------------ OUTLOOK TEST + BOUNCE SCAN ------------------

app.get("/test-outlook", async (req, res) => {
  try {
    const mailbox = process.env.OUTLOOK_MAILBOX;
    if (!mailbox) return res.status(500).json({ ok: false, error: "Missing OUTLOOK_MAILBOX env var" });

    const token = await getMsGraphToken();

    const data = await graphGet(
      `/users/${encodeURIComponent(mailbox)}/mailFolders/Inbox/messages?$top=5&$select=id,subject,receivedDateTime,from,bodyPreview`,
      token
    );

    const messages = (data?.value || []).map((m) => ({
      id: m.id,
      subject: m.subject,
      receivedDateTime: m.receivedDateTime,
      from: m.from?.emailAddress?.address || "",
      preview: (m.bodyPreview || "").slice(0, 140),
    }));

    return res.json({ ok: true, mailbox, count: messages.length, messages });
  } catch (e) {
    console.error("test-outlook error:", e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.post("/scan-bounces", async (req, res) => {
  const secret = req.header("x-scan-secret");
  if (!process.env.SCAN_SECRET) return res.status(500).send("Missing SCAN_SECRET on server");
  if (secret !== process.env.SCAN_SECRET) return res.status(401).send("Unauthorized");

  try {
    const mailbox = process.env.OUTLOOK_MAILBOX;
    if (!mailbox) return res.status(500).json({ ok: false, error: "Missing OUTLOOK_MAILBOX env var" });

    const top = Math.min(Math.max(Number(req.body?.top || 25), 1), 100);
    const token = await getMsGraphToken();

    const data = await graphGet(
      `/users/${encodeURIComponent(mailbox)}/mailFolders/Inbox/messages?$top=${top}&$select=id,subject,receivedDateTime,from,bodyPreview`,
      token
    );

    const items = data?.value || [];
    const bounces = [];

    for (const m of items) {
      if (isSeen(m.id)) continue;
      markSeen(m.id);

      if (!isBounceSubject(m.subject)) continue;

      const email = extractEmailFromText(m.bodyPreview) || extractEmailFromText(m.subject);

      if (!email) {
        bounces.push({ id: m.id, subject: m.subject, extractedEmail: "", action: "no_email_found" });
        continue;
      }

      const prospects = await bonzoFindProspectsByEmail(email);

      if (!prospects.length) {
        bounces.push({ id: m.id, subject: m.subject, extractedEmail: email, action: "no_bonzo_match_found" });
        continue;
      }

      let cleanedCount = 0;
      for (const p of prospects) {
        const pid = p?.id || p?.prospectId || p?.prospect_id;
        if (!pid) continue;

        const getOut = await bonzoGetProspectById(pid);
        if (!getOut.ok || !getOut.json) continue;

        const current = getOut.json;
        current.email = null;
        current.tags = Array.from(new Set([...(current.tags || []), "bad_email"]));

        const putOut = await bonzoPutProspectFull(pid, current);
        if (putOut.ok) cleanedCount++;
      }

      bounces.push({
        id: m.id,
        subject: m.subject,
        extractedEmail: email,
        action: "clean_attempted",
        bonzoMatches: prospects.length,
        cleanedCount,
      });
    }

    return res.json({ ok: true, scanned: items.length, bouncesFound: bounces.length, bounces });
  } catch (e) {
    console.error("scan-bounces error:", e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// ------------------ START SERVER ------------------

app.get("/", (req, res) => res.status(200).send("ok"));

app.listen(process.env.PORT || 3000, () => {
  console.log("Server running");
});
