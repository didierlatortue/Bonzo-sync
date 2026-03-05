import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json({ limit: "2mb" }));

/**
 * =========================
 * ENV VARS YOU NEED ON RENDER
 * =========================
 * BONZO_CODE               (your Event Hooks security code)
 * BONZO_API_KEY            (your Bonzo Personal API access token)
 * BONZO_BASE_URL           (optional; defaults to https://platform.getbonzo.com/api/v3)
 *
 * GOOGLE_CLIENT_ID
 * GOOGLE_CLIENT_SECRET
 * GOOGLE_REFRESH_TOKEN
 */

const BONZO_BASE_URL = process.env.BONZO_BASE_URL || "https://platform.getbonzo.com/api/v3";

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

// ------------------ BONZO API (Bearer Token) ------------------
// Bonzo expects Authorization: Bearer <token>   [oai_citation:2‡Postman](https://www.postman.com/getbonzo/bonzo-api/request/2y91snq/show-prospect)

function bonzoHeaders() {
  const token = process.env.BONZO_API_KEY;
  if (!token) throw new Error("Missing BONZO_API_KEY env var (Personal API access token).");
  return {
    Accept: "application/json",
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  };
}

async function bonzoGetProspect(prospectId) {
  const r = await fetch(`${BONZO_BASE_URL}/prospects/${prospectId}`, {
    method: "GET",
    headers: bonzoHeaders(),
  });
  const out = await readJsonOrText(r);
  return out;
}

async function bonzoPutProspect(prospectId, prospectData) {
  const r = await fetch(`${BONZO_BASE_URL}/prospects/${prospectId}`, {
    method: "PUT",
    headers: bonzoHeaders(),
    body: JSON.stringify(prospectData),
  });
  const out = await readJsonOrText(r);
  return out;
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

  const r = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

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

  const r = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  const out = await readJsonOrText(r);

  if (!out.ok) {
    console.error("getPerson failed:", out.status, out.json || out.text);
    throw new Error("Failed to read person");
  }

  return out.json;
}

// ------------------ MATCHING LOGIC (PREVENT DUPES) ------------------

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

// ------------------ UPSERT (NO DUPES) ------------------

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
    names: [
      {
        givenName: prospect?.first_name || "",
        familyName: prospect?.last_name || "",
      },
    ],
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
      const etag =
        attempt === 1 ? person.etag : (await getPerson(rn, accessToken)).etag;

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

      if (out.status === 412 && attempt === 1) {
        console.warn("ETag mismatch (412). Retrying with fresh etag...");
        continue;
      }

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

// ------------------ QUICK TEST ROUTES ------------------

app.get("/health", (req, res) => res.status(200).send("ok"));

/**
 * TEST BONZO TOKEN + BASE URL:
 * Visit: https://<your-render-url>/debug/bonzo/prospect/98725114
 * If auth is right you should see status 200 and the prospect payload.
 */
app.get("/debug/bonzo/prospect/:id", async (req, res) => {
  try {
    const out = await bonzoGetProspect(req.params.id);
    return res.status(200).json(out);
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// ------------------ BONZO EVENT HOOK (Google Contacts sync) ------------------

app.post("/bonzo/events", async (req, res) => {
  try {
    const code = req.header("x-bonzo-code");
    if (code !== process.env.BONZO_CODE) {
      return res.status(401).send("Unauthorized");
    }

    const { event, prospect } = req.body;
    console.log("Bonzo event:", event);

    if (["prospects.created", "prospects.updated"].includes(event)) {
      await upsertGoogleContact(prospect);
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("Webhook error:", err);
    return res.status(500).send("Server error");
  }
});

// ------------------ BONZO EVENT HOOK (Cleanup bad email/phone) ------------------

app.post("/bonzo/event-hook", async (req, res) => {
  try {
    const code = req.header("x-bonzo-code");
    if (code !== process.env.BONZO_CODE) {
      return res.status(401).send("Unauthorized");
    }

    const { event, additional, prospect } = req.body;

    if (event !== "messages.outgoing.updated") {
      return res.status(200).json({ ok: true, ignored: true });
    }

    const message = additional?.message;
    if (!message) {
      return res.status(200).json({ ok: true, ignored: true, reason: "no_message" });
    }

    const status = String(message.status || "").toLowerCase();
    const type = String(message.type || "").toLowerCase();

    const prospectId =
      message?.prospect?.id ||
      prospect?.id ||
      message?.prospect_id;

    console.log("Message update:", { status, type, prospectId, messageId: message.id });

    const BAD_STATUSES = new Set(["failed", "bounced", "undeliverable", "error"]);

    if (!prospectId) {
      return res.status(200).json({ ok: true, skipped: true, reason: "no_prospect_id" });
    }

    if (!BAD_STATUSES.has(status)) {
      return res.status(200).json({ ok: true, skipped: true, reason: "status_not_bad" });
    }

    if (type !== "sms" && type !== "email") {
      return res.status(200).json({ ok: true, skipped: true, reason: "type_not_sms_or_email" });
    }

    // 1) GET prospect (Bonzo returns { data: {...} })  [oai_citation:3‡Postman](https://www.postman.com/getbonzo/bonzo-api/request/2y91snq/show-prospect)
    const getOut = await bonzoGetProspect(prospectId);

    if (!getOut.ok) {
      console.log("Cleanup skipped: could not GET prospect", getOut.status, getOut.json || getOut.text);
      return res.status(200).json({ ok: true, skipped: true, reason: "get_failed", status: getOut.status });
    }

    const current = getOut.json?.data || getOut.json; // support either shape

    // 2) Modify
    const updated = { ...current };
    const tags = Array.isArray(updated.tags) ? updated.tags : [];
    const tagSet = new Set(tags);

    if (type === "sms") {
      updated.phone = null;
      tagSet.add("bad_phone");
    } else {
      updated.email = null;
      tagSet.add("bad_email");
    }

    updated.tags = Array.from(tagSet);

    // 3) PUT updated prospect
    const putOut = await bonzoPutProspect(prospectId, updated);

    console.log("Cleanup result:", putOut.status, putOut.json || putOut.text);

    return res.status(200).json({
      ok: true,
      cleaned: putOut.ok,
      putStatus: putOut.status,
    });
  } catch (err) {
    console.error("Cleanup error:", err);
    return res.status(200).json({ ok: false, error: "exception" });
  }
});

// ------------------ START SERVER ------------------

app.listen(process.env.PORT || 3000, () => {
  console.log("Server running");
  console.log("Using BONZO_BASE_URL:", BONZO_BASE_URL);
});
