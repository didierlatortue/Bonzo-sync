
import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json({ limit: "1mb" }));

// ------------------ HELPERS ------------------

function digitsOnly(p) {
  return String(p || "").replace(/\D/g, "");
}

function normalizeEmail(e) {
  const s = String(e || "").trim().toLowerCase();
  return s || "";
}

// Keep a consistent phone string to STORE (digits, optionally prefixed with +)
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
// Fix: this was missing in your current deploy
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
// adding helper for robocallers
function nameLooksLikePhone(first, last) {
  const full = `${first || ""} ${last || ""}`.trim();

  if (!full) return true;

  // Remove spaces, dashes, parentheses
  const cleaned = full.replace(/[\s\-\(\)]/g, "");

  // If it's mostly digits, it's probably a phone
  const digitCount = (cleaned.match(/\d/g) || []).length;

  // More than 70% digits = phone/spam
  if (digitCount / cleaned.length > 0.7) return true;

  // All digits
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
  // ❌ Skip if the "name" looks like a phone number (spam/unknown caller behavior)
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

// ---------- UPDATE ----------
if (found?.resourceName) {
  const person = await getPerson(found.resourceName, accessToken);
  const rn = ensurePeopleResourceName(person.resourceName);

  const updateUrl =
    `https://people.googleapis.com/v1/${rn}:updateContact` +
    "?updatePersonFields=names,emailAddresses,phoneNumbers,biographies,organizations";

  console.log("Updating resourceName:", rn);
  console.log("Update URL:", updateUrl);

  for (let attempt = 1; attempt <= 2; attempt++) {
    const etag =
      attempt === 1 ? person.etag : (await getPerson(rn, accessToken)).etag;

    const r = await fetch(updateUrl, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        // keep If-Match too (doesn't hurt), but the body etag is the key fix
        ...(etag ? { "If-Match": etag } : {}),
      },
      // ✅ IMPORTANT: include etag in body
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

  // ---------- CREATE ----------
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

// ------------------ WEBHOOK ------------------

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

    res.status(200).json({ ok: true });
  } catch (err) {
    console.error("Webhook error:", err);
    res.status(500).send("Server error");
  }
});

// ------------------- PUTs updated Clean up Webook in full  ---------------

app.post("/bonzo/event-hook", async (req, res) => {
  try {
    // 1) Verify this request is from Bonzo (same style as your /bonzo/events route)
    const code = req.header("x-bonzo-code");
    if (code !== process.env.BONZO_CODE) {
      return res.status(401).send("Unauthorized");
    }

    const { event, additional, prospect } = req.body;

    // Only process outgoing message status updates
    if (event !== "messages.outgoing.updated") {
      return res.status(200).json({ ok: true, ignored: true });
    }

    const message = additional?.message;
    if (!message) {
      return res.status(200).json({ ok: true, ignored: true, reason: "no_message" });
    }

    const status = String(message.status || "").toLowerCase(); // "sent", "error", etc.
    const type = String(message.type || "").toLowerCase();     // "sms" or "email"

    // IMPORTANT: pick the real prospect id (NOT the message id)
    const prospectId =
      message?.prospect?.id ||      // safest (nested object)
      prospect?.id ||               // sometimes top-level prospect is included
      message?.prospect_id;         // fallback (sometimes this is not the real prospect id)

    console.log("Message update:", { status, type, prospectId, messageId: message.id });

    // Treat "error" as a failure too (your logs show status = error for bad phone numbers)
    const BAD_STATUSES = new Set(["failed", "bounced", "undeliverable", "error"]);

    if (!prospectId) {
      console.log("Cleanup skipped: prospectId missing");
      return res.status(200).json({ ok: true, skipped: true, reason: "no_prospect_id" });
    }

    // Only clean on failure statuses
    if (!BAD_STATUSES.has(status)) {
      return res.status(200).json({ ok: true, skipped: true, reason: "status_not_bad" });
    }

    // Only clean sms/email
    if (type !== "sms" && type !== "email") {
      return res.status(200).json({ ok: true, skipped: true, reason: "type_not_sms_or_email" });
    }

    const baseUrl = process.env.BONZO_BASE_URL || "https://platform.getbonzo.com/api";

    // 2) GET the current prospect (needed because Bonzo supports PUT, not PATCH,
    // and PUT may require the full object)
    const getRes = await fetch(`${baseUrl}/prospects/${prospectId}`, {
      method: "GET",
      headers: {
        Authorization: process.env.BONZO_API_KEY,
        "Content-Type": "application/json",
    },
    });

    const currentText = await getRes.text();
    let current;
    try {
      current = JSON.parse(currentText);
    } catch {
      current = null;
    }

    if (!getRes.ok || !current) {
      console.log("Cleanup skipped: could not GET prospect", getRes.status, currentText?.slice(0, 300));
      return res.status(200).json({ ok: true, skipped: true, reason: "get_failed" });
    }

    // 3) Modify fields
    if (type === "sms") {
      current.phone = null;
      current.tags = Array.from(new Set([...(current.tags || []), "bad_phone"]));
    } else if (type === "email") {
      current.email = null;
      current.tags = Array.from(new Set([...(current.tags || []), "bad_email"]));
    }

    // 4) PUT the updated prospect back (Bonzo supports PUT)
    const putRes = await fetch(`${baseUrl}/prospects/${prospectId}`, {
      method: "PUT",
      headers: {
        Authorization: process.env.BONZO_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(current),
    });

    const putBody = await putRes.text();
    console.log("Cleanup result:", putRes.status, putBody?.slice(0, 300));

    // Return 200 so Bonzo doesn't keep retrying
    return res.status(200).json({ ok: true, cleaned: putRes.ok, status: putRes.status });

  } catch (err) {
    console.error("Cleanup error:", err);
    // Still return 200 so Bonzo won't retry forever while you're testing
    return res.status(200).json({ ok: false, error: "exception" });
  }
});

// ------------------ START SERVER ------------------

app.listen(process.env.PORT || 3000, () => {
  console.log("Server running");
});
