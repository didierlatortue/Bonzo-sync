import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json({ limit: "1mb" }));

// ------------------ HELPERS ------------------

function normalizePhone(p) {
  if (!p) return "";

  let s = String(p).trim();
  const hasPlus = s.startsWith("+");
  s = s.replace(/[^\d]/g, "");
  return hasPlus ? `+${s}` : s;
}

// Phone FIRST, then email
function bestQueryKey(prospect) {
  const phone = normalizePhone(prospect?.phone);
  if (phone) return { type: "phone", value: phone };

  const email = (prospect?.email || "").trim().toLowerCase();
  if (email) return { type: "email", value: email };

  return null;
}

function ensurePeopleResourceName(resourceName) {
  if (!resourceName) return resourceName;
  return resourceName.startsWith("people/") ? resourceName : `people/${resourceName}`;
}

// Safely read responses that might be HTML (not JSON)
async function readJsonOrText(r) {
  const text = await r.text();
  try {
    return { ok: r.ok, status: r.status, json: JSON.parse(text), text: null };
  } catch {
    return { ok: r.ok, status: r.status, json: null, text };
  }
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
    throw new Error("Failed to refresh Google token");
  }

  return out.json.access_token;
}

// ------------------ SEARCH CONTACT ------------------

async function searchGoogleContact(query, accessToken) {
  const url =
    "https://people.googleapis.com/v1/people:searchContacts" +
    `?query=${encodeURIComponent(query)}` +
    "&readMask=names,emailAddresses,phoneNumbers,biographies" +
    "&pageSize=10";

  const r = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  const out = await readJsonOrText(r);

  if (!out.ok) {
    console.error("searchContacts failed:", out.status, out.json || out.text);
    throw new Error("Failed to search contacts");
  }

  return out.json?.results?.[0]?.person || null;
}

// ------------------ UPSERT CONTACT ------------------

async function upsertGoogleContact(prospect) {
  const key = bestQueryKey(prospect);
  if (!key) return;

  const accessToken = await getGoogleAccessToken();

  const body = {
    names: [
      {
        givenName: prospect?.first_name || "",
        familyName: prospect?.last_name || "",
      },
    ],
    emailAddresses: prospect?.email
      ? [{ value: prospect.email.trim().toLowerCase() }]
      : [],
    phoneNumbers: prospect?.phone
      ? [{ value: normalizePhone(prospect.phone) }]
      : [],
    biographies: [
      {
        value: `Source: Bonzo | ID: ${prospect?.id || ""}`,
      },
    ],
  };

  const existing = await searchGoogleContact(key.value, accessToken);

  // ---------- UPDATE ----------
  if (existing?.resourceName && existing?.etag) {
    const rn = ensurePeopleResourceName(existing.resourceName);

    const updateUrl =
      `https://people.googleapis.com/v1/${rn}` +
      "?updatePersonFields=names,emailAddresses,phoneNumbers,biographies";

    const r = await fetch(updateUrl, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "If-Match": existing.etag,
      },
      body: JSON.stringify(body),
    });

    const out = await readJsonOrText(r);

    if (!out.ok) {
      console.error("updateContact failed:", out.status, out.json || out.text);
      throw new Error("Failed to update contact");
    }

    console.log("Updated contact:", out.json.resourceName);
    return;
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

  console.log("Created contact:", out.json.resourceName);
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

// ------------------ START SERVER ------------------

app.listen(process.env.PORT || 3000, () => {
  console.log("Server running");
});
