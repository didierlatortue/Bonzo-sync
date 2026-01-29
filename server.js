import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json({ limit: "1mb" }));

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

  const data = await r.json();

  if (!r.ok) {
    console.error("Google token error:", data);
    throw new Error("Failed to refresh token");
  }

  return data.access_token;
}

// ------------------ CREATE CONTACT ------------------

async function createGoogleContact(prospect) {
  // Only create a contact if phone exists
  const phone = (prospect?.phone || "").trim();
  if (!phone) return;

  const token = await getGoogleAccessToken();

  const body = {
    names: [
      {
        givenName: prospect.first_name || "",
        familyName: prospect.last_name || "",
      },
    ],

    organizations: [
      {
        name: "Home Loans",     // <-- Company line
        type: "work",
        primary: true,
      },
    ],

    emailAddresses: prospect.email ? [{ value: prospect.email }] : [],

    phoneNumbers: [{ value: phone }],

    biographies: [
      {
        value: `Source: Bonzo | ID: ${prospect.id}`,
      },
    ],
  };

  const r = await fetch("https://people.googleapis.com/v1/people:createContact", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const data = await r.json();

  if (!r.ok) {
    console.error("People API error:", data);
    throw new Error("Failed to create contact");
  }

  return data;
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

    if (
      ["prospects.created", "prospects.updated"].includes(event)
    ) {
      const result = await createGoogleContact(prospect);

      if (result) {
        console.log("Google contact created:", result.resourceName);
      }
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
