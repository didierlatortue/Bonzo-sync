// =========================
// LO PORTAL (COWORK 2026-10-07)
// Hidden loan-officer portal: invite-only registration, email+password login,
// Stripe embedded Checkout (setup fee + monthly subscription), on-page card update,
// cancellation with 30-day notice, invoices.
//
// Mounted from server.js BEFORE the global express.json() so the Stripe webhook
// can verify its signature against the raw body.
//
// Env:
//   STRIPE_SECRET_KEY        sk_test_... / sk_live_...   (mode follows the key prefix)
//   STRIPE_PUBLISHABLE_KEY   pk_test_... / pk_live_...
//   STRIPE_WEBHOOK_SECRET    optional; otherwise read from lo_config (set by admin "connect webhook")
//   LO_ADMIN_CODE            gates /lo-portal/admin/*
//   LO_PORTAL_URL            the hidden WordPress page URL (invite links + Stripe return_url)
//   LO_NOTIFY_EMAIL          where owner notifications go (default OUTLOOK_MAILBOX)
//   OUTLOOK_MAILBOX          Graph sender mailbox (already used by bonzo-sync)
// =========================
import express from "express";
import crypto from "crypto";
import fetch from "node-fetch";

const STRIPE_API_VERSION = "2024-06-20";
const AGREEMENT_VERSION = "2026-10-07";
const SESSION_DAYS = 14;
const INVITE_DAYS_DEFAULT = 14;
const RESET_MINUTES = 60;
const NOTICE_DAYS = 30;
const ALLOWED_ORIGINS = ["https://turturhomeloans.com", "https://www.turturhomeloans.com"];
const WEBHOOK_EVENTS = [
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
  "checkout.session.async_payment_failed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.paid",
  "invoice.payment_failed",
];

export const LO_AGREEMENT_TEXT = [
  "TURTUR HOME LOANS — LOAN OFFICER PLATFORM TERMS",
  "",
  "1. Setup fee. The one-time setup fee shown on this page is charged when you register. It is non-refundable.",
  "2. Monthly platform fee. The monthly platform fee shown on this page is billed in advance on the 1st of each month and renews automatically until cancelled. At registration you pay one full monthly platform fee, which covers the period from your registration date through the last day of that calendar month (or through the last day of the following month if you register during the last two days of a month); regular billing starts on the 1st of the month after that period. There is no long-term commitment or minimum term.",
  "3. Authorization. You authorize Turtur Home Loans to charge the payment method you provide (card or bank account) for the setup fee and for each monthly platform fee until your subscription ends. You can replace your payment method at any time from your account page.",
  "4. Cancellation — 30 days' notice. You may cancel at any time from your account page or by written notice to Turtur Home Loans. Cancellation requires at least 30 days' notice: your subscription ends at the close of the first billing period that ends 30 or more days after the date of your notice, and that period is billed as normal.",
  "5. No refunds. Fees are not refundable and are not prorated, in whole or in part, including for partial months, unused time, or early cancellation. The only exception is a payment made in error — for example, a duplicate charge or a charge you did not authorize — which will be refunded once confirmed.",
  "6. Failed payments. If a payment fails, Stripe will retry it, and you can update your payment method from your account page. Access to the platform may be suspended while a balance is past due.",
  "7. Changes. Turtur Home Loans will give you at least 30 days' written notice before changing the monthly platform fee.",
].join("\n");

export function mountLoPortal(app, deps) {
  const getPool = deps.getPool;
  const getMsGraphToken = deps.getMsGraphToken;

  // ---------- helpers ----------
  const sha256 = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
  const randToken = (n) => crypto.randomBytes(n || 32).toString("base64url");
  const normEmail = (e) => String(e || "").trim().toLowerCase();
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const stripeMode = () => (String(process.env.STRIPE_SECRET_KEY || "").startsWith("sk_live_") || String(process.env.STRIPE_SECRET_KEY || "").startsWith("rk_live_") ? "live" : "test");
  const portalUrl = () => String(process.env.LO_PORTAL_URL || "https://turturhomeloans.com/").trim();
  const publicBase = () => String(process.env.PUBLIC_BASE_URL || "https://bonzo-sync.onrender.com").replace(/\/+$/, "");
  const log = (...a) => console.log("[LO]", ...a);

  function scryptAsync(pw, salt) {
    return new Promise((res, rej) => crypto.scrypt(pw, salt, 64, { N: 16384, r: 8, p: 1 }, (e, k) => (e ? rej(e) : res(k))));
  }
  async function hashPassword(pw) {
    const salt = crypto.randomBytes(16);
    const key = await scryptAsync(String(pw), salt);
    return "scrypt$" + salt.toString("base64") + "$" + key.toString("base64");
  }
  async function verifyPassword(pw, stored) {
    try {
      const parts = String(stored || "").split("$");
      if (parts[0] !== "scrypt" || parts.length !== 3) return false;
      const key = await scryptAsync(String(pw), Buffer.from(parts[1], "base64"));
      const want = Buffer.from(parts[2], "base64");
      return want.length === key.length && crypto.timingSafeEqual(want, key);
    } catch (_) {
      return false;
    }
  }
  function passwordProblem(pw) {
    pw = String(pw || "");
    if (pw.length < 10) return "Password must be at least 10 characters.";
    if (pw.length > 200) return "Password is too long.";
    return null;
  }

  // Simple per-IP limiter
  const hits = new Map();
  function limited(req, bucket, max, windowMs) {
    const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
    const k = bucket + "|" + ip;
    const now = Date.now();
    const arr = (hits.get(k) || []).filter((t) => now - t < windowMs);
    arr.push(now);
    hits.set(k, arr);
    return arr.length > max;
  }
  setInterval(() => {
    const now = Date.now();
    for (const [k, arr] of hits.entries()) if (!arr.some((t) => now - t < 3600000)) hits.delete(k);
  }, 600000).unref();

  // ---------- Stripe REST ----------
  function formEncode(obj, prefix, out) {
    out = out || [];
    if (obj === undefined || obj === null) return out;
    if (Array.isArray(obj)) {
      obj.forEach((v, i) => formEncode(v, prefix + "[" + i + "]", out));
    } else if (typeof obj === "object") {
      for (const k of Object.keys(obj)) formEncode(obj[k], prefix ? prefix + "[" + k + "]" : k, out);
    } else {
      out.push(encodeURIComponent(prefix) + "=" + encodeURIComponent(String(obj)));
    }
    return out;
  }
  async function stripe(method, path, params, idemKey) {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) throw Object.assign(new Error("Stripe is not configured"), { status: 503 });
    const qs = params ? formEncode(params).join("&") : "";
    const url = "https://api.stripe.com/v1" + path + (method === "GET" && qs ? "?" + qs : "");
    const headers = { Authorization: "Bearer " + key, "Stripe-Version": STRIPE_API_VERSION };
    if (method !== "GET") headers["Content-Type"] = "application/x-www-form-urlencoded";
    if (idemKey) headers["Idempotency-Key"] = idemKey;
    const r = await fetch(url, { method, headers, body: method !== "GET" && qs ? qs : undefined });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      const e = new Error((j.error && j.error.message) || "Stripe error " + r.status);
      e.status = r.status >= 500 ? 502 : 400;
      e.stripe = j.error;
      throw e;
    }
    return j;
  }

  // ---------- DB ----------
  let _ready = null;
  async function db() {
    const pool = await getPool();
    if (!pool) throw Object.assign(new Error("Database not configured"), { status: 503 });
    if (!_ready) {
      _ready = (async () => {
        await pool.query(`CREATE TABLE IF NOT EXISTS lo_config (
          k TEXT PRIMARY KEY, v TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
        await pool.query(`CREATE TABLE IF NOT EXISTS lo_users (
          id BIGSERIAL PRIMARY KEY,
          mode TEXT NOT NULL,
          email TEXT NOT NULL,
          password_hash TEXT NOT NULL,
          first_name TEXT, last_name TEXT, phone TEXT,
          setup_price_id TEXT, sub_price_id TEXT,
          stripe_customer_id TEXT,
          subscription_id TEXT,
          subscription_status TEXT,
          setup_paid_at TIMESTAMPTZ,
          current_period_end TIMESTAMPTZ,
          cancel_at TIMESTAMPTZ,
          cancel_requested_at TIMESTAMPTZ,
          agreement_version TEXT, agreement_accepted_at TIMESTAMPTZ, agreement_ip TEXT, agreement_ua TEXT,
          invite_token_hash TEXT,
          disabled BOOLEAN NOT NULL DEFAULT FALSE,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (mode, email))`);
        await pool.query("ALTER TABLE lo_users ADD COLUMN IF NOT EXISTS initial_paid_at TIMESTAMPTZ");
        await pool.query(`CREATE TABLE IF NOT EXISTS lo_invites (
          token_hash TEXT PRIMARY KEY,
          mode TEXT NOT NULL,
          token_hint TEXT,
          email TEXT,
          note TEXT,
          setup_price_id TEXT,
          sub_price_id TEXT,
          expires_at TIMESTAMPTZ NOT NULL,
          used_at TIMESTAMPTZ,
          revoked_at TIMESTAMPTZ,
          lo_user_id BIGINT,
          link TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
        await pool.query(`CREATE TABLE IF NOT EXISTS lo_sessions (
          token_hash TEXT PRIMARY KEY,
          lo_user_id BIGINT NOT NULL,
          expires_at TIMESTAMPTZ NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
        await pool.query(`CREATE TABLE IF NOT EXISTS lo_password_resets (
          token_hash TEXT PRIMARY KEY,
          lo_user_id BIGINT NOT NULL,
          expires_at TIMESTAMPTZ NOT NULL,
          used_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
        await pool.query(`CREATE TABLE IF NOT EXISTS lo_stripe_events (
          id TEXT PRIMARY KEY,
          type TEXT NOT NULL,
          livemode BOOLEAN,
          payload JSONB NOT NULL,
          processed_at TIMESTAMPTZ,
          error TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
      })().catch((e) => {
        _ready = null;
        throw e;
      });
    }
    await _ready;
    return pool;
  }
  async function getConfig(k) {
    const pool = await db();
    const { rows } = await pool.query("SELECT v FROM lo_config WHERE k=$1", [k]);
    return rows[0] ? rows[0].v : null;
  }
  async function setConfig(k, v) {
    const pool = await db();
    await pool.query("INSERT INTO lo_config(k,v) VALUES($1,$2) ON CONFLICT (k) DO UPDATE SET v=EXCLUDED.v, updated_at=now()", [k, v]);
  }

  // ---------- email ----------
  function mailConfigured() {
    return !!(process.env.OUTLOOK_MAILBOX && process.env.MS_TENANT_ID && process.env.MS_CLIENT_ID && process.env.MS_CLIENT_SECRET && getMsGraphToken);
  }
  async function sendMail(to, subject, html) {
    const mailbox = process.env.OUTLOOK_MAILBOX;
    if (!mailbox || !getMsGraphToken) throw new Error("mail not configured");
    const token = await getMsGraphToken();
    const r = await fetch("https://graph.microsoft.com/v1.0/users/" + encodeURIComponent(mailbox) + "/sendMail", {
      method: "POST",
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify({
        message: { subject, body: { contentType: "HTML", content: html }, toRecipients: [{ emailAddress: { address: to } }] },
        saveToSentItems: true,
      }),
    });
    if (!r.ok) throw new Error("sendMail " + r.status + " " + (await r.text()).slice(0, 300));
    return true;
  }
  function notifyOwner(subject, lines) {
    const to = process.env.LO_NOTIFY_EMAIL || process.env.OUTLOOK_MAILBOX;
    if (!to || !mailConfigured()) return;
    const html = "<div style='font-family:Arial,sans-serif;font-size:14px'>" + lines.map((l) => "<div>" + esc(l) + "</div>").join("") + "</div>";
    sendMail(to, "[LO Portal" + (stripeMode() === "test" ? " TEST" : "") + "] " + subject, html).catch((e) => log("notify failed:", e.message));
  }

  // ---------- prices ----------
  const _priceCache = new Map();
  async function getPrice(id) {
    if (!id) return null;
    const c = _priceCache.get(id);
    if (c && Date.now() - c.t < 300000) return c.p;
    const p = await stripe("GET", "/prices/" + encodeURIComponent(id), { expand: ["product"] });
    _priceCache.set(id, { t: Date.now(), p });
    return p;
  }
  function describePrice(p, kind) {
    if (!p) return null;
    return {
      kind,
      price_id: p.id,
      name: (p.product && p.product.name) || p.nickname || "Item",
      description: (p.product && p.product.description) || "",
      amount: p.unit_amount,
      currency: p.currency,
      interval: p.recurring ? p.recurring.interval : null,
      interval_count: p.recurring ? p.recurring.interval_count : null,
    };
  }
  async function validatePrices(setupId, subId) {
    if (!setupId && !subId) throw Object.assign(new Error("Pick at least one product."), { status: 400 });
    let setup = null, sub = null;
    if (setupId) {
      setup = await getPrice(setupId);
      if (!setup.active || setup.type !== "one_time") throw Object.assign(new Error("Setup fee price must be an active one-time price."), { status: 400 });
    }
    if (subId) {
      sub = await getPrice(subId);
      if (!sub.active || sub.type !== "recurring") throw Object.assign(new Error("Subscription price must be an active recurring price."), { status: 400 });
    }
    if (setup && sub && setup.currency !== sub.currency) throw Object.assign(new Error("Prices must use the same currency."), { status: 400 });
    return { setup, sub };
  }

  // ---------- sessions ----------
  async function createSession(userId) {
    const pool = await db();
    const tok = randToken(32);
    await pool.query("INSERT INTO lo_sessions(token_hash, lo_user_id, expires_at) VALUES($1,$2, now() + ($3 || ' days')::interval)", [sha256(tok), userId, String(SESSION_DAYS)]);
    return tok;
  }
  async function authUser(req) {
    const h = String(req.headers.authorization || "");
    const tok = h.startsWith("Bearer ") ? h.slice(7).trim() : "";
    if (!tok) return null;
    const pool = await db();
    const { rows } = await pool.query(
      "SELECT u.* FROM lo_sessions s JOIN lo_users u ON u.id=s.lo_user_id WHERE s.token_hash=$1 AND s.expires_at > now()",
      [sha256(tok)]
    );
    const u = rows[0];
    if (!u || u.disabled || u.mode !== stripeMode()) return null;
    return u;
  }
  function requireUser(handler) {
    return async (req, res) => {
      try {
        const u = await authUser(req);
        if (!u) return res.status(401).json({ ok: false, error: "Please log in again." });
        await handler(req, res, u);
      } catch (e) {
        log("error", req.path, e.message);
        res.status(e.status || 500).json({ ok: false, error: e.status && e.status < 500 ? e.message : "Something went wrong. Please try again." });
      }
    };
  }
  function wrap(handler) {
    return async (req, res) => {
      try {
        await handler(req, res);
      } catch (e) {
        log("error", req.path, e.message);
        res.status(e.status || 500).json({ ok: false, error: e.status && e.status < 500 ? e.message : "Something went wrong. Please try again." });
      }
    };
  }

  // ---------- Stripe -> local sync ----------
  function pickSubscription(list) {
    const subs = (list && list.data) || [];
    const order = ["active", "past_due", "trialing", "unpaid", "incomplete", "paused", "canceled", "incomplete_expired"];
    subs.sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status) || b.created - a.created);
    return subs[0] || null;
  }
  async function syncUser(user) {
    if (!user.stripe_customer_id) return user;
    const pool = await db();
    const subs = await stripe("GET", "/subscriptions", { customer: user.stripe_customer_id, status: "all", limit: 10 });
    const sub = pickSubscription(subs);
    let setupPaid = user.setup_paid_at;
    let initialPaid = user.initial_paid_at;
    if (!initialPaid || (!setupPaid && user.setup_price_id)) {
      const inv = await stripe("GET", "/invoices", { customer: user.stripe_customer_id, status: "paid", limit: 20, expand: ["data.lines"] });
      const paidList = (inv.data || []).filter((i) => i.amount_paid > 0).sort((a, b) => a.created - b.created);
      const paidAt = (i) => new Date((i.status_transitions && i.status_transitions.paid_at ? i.status_transitions.paid_at : i.created) * 1000);
      if (!initialPaid && paidList[0]) initialPaid = paidAt(paidList[0]);
      if (!setupPaid && user.setup_price_id) {
        for (const i of paidList) {
          const hit = ((i.lines && i.lines.data) || []).some((l) => l.price && l.price.id === user.setup_price_id);
          if (hit) { setupPaid = paidAt(i); break; }
        }
      }
      if ((!setupPaid || !initialPaid) && !user.sub_price_id) {
        const pis = await stripe("GET", "/payment_intents", { customer: user.stripe_customer_id, limit: 20 });
        const ok = (pis.data || []).find((p) => p.status === "succeeded" && p.metadata && p.metadata.lo_kind === "setup");
        if (ok) { setupPaid = setupPaid || new Date(ok.created * 1000); initialPaid = initialPaid || new Date(ok.created * 1000); }
      }
    }
    const { rows } = await pool.query(
      `UPDATE lo_users SET subscription_id=$2, subscription_status=$3, current_period_end=$4, cancel_at=$5, setup_paid_at=$6, initial_paid_at=$7, updated_at=now()
       WHERE id=$1 RETURNING *`,
      [
        user.id,
        sub ? sub.id : null,
        sub ? sub.status : null,
        sub && sub.current_period_end ? new Date(sub.current_period_end * 1000) : null,
        sub && sub.cancel_at ? new Date(sub.cancel_at * 1000) : sub && sub.cancel_at_period_end && sub.current_period_end ? new Date(sub.current_period_end * 1000) : null,
        setupPaid || null,
        initialPaid || null,
      ]
    );
    return rows[0] || user;
  }
  async function userByCustomer(customerId) {
    if (!customerId) return null;
    const pool = await db();
    const { rows } = await pool.query("SELECT * FROM lo_users WHERE stripe_customer_id=$1", [customerId]);
    return rows[0] || null;
  }
  // needs_payment: the LO has not completed checkout yet (show the payment form).
  // payment_pending: checkout done but the first payment has not cleared (e.g. ACH takes days).
  function needsPayment(u) {
    if (u.sub_price_id) return !u.subscription_id || u.subscription_status === "incomplete_expired";
    return !u.initial_paid_at && !u.setup_paid_at;
  }
  function paymentPending(u) {
    return !needsPayment(u) && !u.initial_paid_at && !u.setup_paid_at;
  }

  // ---------- CORS for /lo-portal (public routes) ----------
  app.use("/lo-portal", (req, res, next) => {
    if (req.path.startsWith("/admin") || req.path.startsWith("/stripe/webhook")) return next();
    const origin = req.headers.origin || "";
    if (ALLOWED_ORIGINS.includes(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
      res.setHeader("Access-Control-Max-Age", "600");
    }
    if (req.method === "OPTIONS") return res.status(204).end();
    res.setHeader("Cache-Control", "no-store");
    next();
  });

  const json = express.json({ limit: "64kb" });

  // ---------- public: config + front-end ----------
  app.get("/lo-portal/config", wrap(async (req, res) => {
    res.json({ ok: true, mode: stripeMode(), publishableKey: process.env.STRIPE_PUBLISHABLE_KEY || null, agreementVersion: AGREEMENT_VERSION });
  }));

  app.get("/lo-portal/app.js", (req, res) => {
    res.setHeader("Content-Type", "application/javascript; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.send(deps.appJs || "console.error('LO portal app not loaded')");
  });

  // ---------- public: invite ----------
  async function loadInvite(token) {
    const pool = await db();
    const { rows } = await pool.query("SELECT * FROM lo_invites WHERE token_hash=$1", [sha256(token)]);
    const inv = rows[0];
    if (!inv || inv.mode !== stripeMode()) throw Object.assign(new Error("This registration link is not valid."), { status: 404 });
    if (inv.revoked_at) throw Object.assign(new Error("This registration link has been cancelled. Ask Turtur Home Loans for a new one."), { status: 410 });
    if (inv.used_at) throw Object.assign(new Error("This registration link has already been used. Log in instead."), { status: 410, code: "used" });
    if (new Date(inv.expires_at) < new Date()) throw Object.assign(new Error("This registration link has expired. Ask Turtur Home Loans for a new one."), { status: 410 });
    return inv;
  }
  app.get("/lo-portal/invite/:token", wrap(async (req, res) => {
    if (limited(req, "invite", 60, 900000)) return res.status(429).json({ ok: false, error: "Too many attempts. Try again later." });
    const inv = await loadInvite(req.params.token);
    const { setup, sub } = await validatePrices(inv.setup_price_id, inv.sub_price_id);
    res.json({
      ok: true,
      email: inv.email || "",
      items: [describePrice(setup, "setup"), describePrice(sub, "subscription")].filter(Boolean),
      agreement: { version: AGREEMENT_VERSION, text: LO_AGREEMENT_TEXT },
      mode: stripeMode(),
    });
  }));

  // ---------- public: register ----------
  app.post("/lo-portal/register", json, wrap(async (req, res) => {
    if (limited(req, "register", 10, 900000)) return res.status(429).json({ ok: false, error: "Too many attempts. Try again later." });
    const b = req.body || {};
    const inv = await loadInvite(String(b.invite || ""));
    const email = normEmail(b.email);
    const first = String(b.first_name || "").trim().slice(0, 80);
    const last = String(b.last_name || "").trim().slice(0, 80);
    const phone = String(b.phone || "").replace(/[^\d+]/g, "").slice(0, 20);
    if (!first || !last) throw Object.assign(new Error("Enter your first and last name."), { status: 400 });
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw Object.assign(new Error("Enter a valid email address."), { status: 400 });
    if (phone.replace(/\D/g, "").length < 10) throw Object.assign(new Error("Enter a valid phone number."), { status: 400 });
    if (inv.email && normEmail(inv.email) !== email) throw Object.assign(new Error("Use the email address this link was sent to (" + inv.email + ")."), { status: 400 });
    const pwErr = passwordProblem(b.password);
    if (pwErr) throw Object.assign(new Error(pwErr), { status: 400 });
    if (b.agree !== true || String(b.agreement_version) !== AGREEMENT_VERSION) throw Object.assign(new Error("You must accept the platform terms."), { status: 400 });
    await validatePrices(inv.setup_price_id, inv.sub_price_id);

    const pool = await db();
    const exists = await pool.query("SELECT id FROM lo_users WHERE mode=$1 AND email=$2", [stripeMode(), email]);
    if (exists.rows[0]) throw Object.assign(new Error("An account with this email already exists. Log in instead."), { status: 409 });

    // claim invite atomically
    const claim = await pool.query("UPDATE lo_invites SET used_at=now() WHERE token_hash=$1 AND used_at IS NULL AND revoked_at IS NULL RETURNING token_hash", [inv.token_hash]);
    if (!claim.rows[0]) throw Object.assign(new Error("This registration link has already been used."), { status: 410 });

    try {
      const cust = await stripe("POST", "/customers", {
        email,
        name: first + " " + last,
        phone,
        metadata: { lo_portal: "1", source: "lo-portal" },
      }, "lo-cust-" + inv.token_hash.slice(0, 40));
      const ua = String(req.headers["user-agent"] || "").slice(0, 300);
      const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
      const { rows } = await pool.query(
        `INSERT INTO lo_users(mode,email,password_hash,first_name,last_name,phone,setup_price_id,sub_price_id,stripe_customer_id,
           agreement_version,agreement_accepted_at,agreement_ip,agreement_ua,invite_token_hash)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now(),$11,$12,$13) RETURNING *`,
        [stripeMode(), email, await hashPassword(b.password), first, last, phone, inv.setup_price_id, inv.sub_price_id, cust.id, AGREEMENT_VERSION, ip, ua, inv.token_hash]
      );
      const u = rows[0];
      await pool.query("UPDATE lo_invites SET lo_user_id=$2 WHERE token_hash=$1", [inv.token_hash, u.id]);
      await stripe("POST", "/customers/" + cust.id, { metadata: { lo_user_id: String(u.id) } });
      const token = await createSession(u.id);
      notifyOwner("New LO registered: " + first + " " + last, ["Name: " + first + " " + last, "Email: " + email, "Phone: " + phone, "Agreement accepted: v" + AGREEMENT_VERSION, "Next step for them: payment."]);
      res.json({ ok: true, token });
    } catch (e) {
      await pool.query("UPDATE lo_invites SET used_at=NULL, lo_user_id=NULL WHERE token_hash=$1", [inv.token_hash]).catch(() => {});
      throw e;
    }
  }));

  // ---------- public: login/logout ----------
  app.post("/lo-portal/login", json, wrap(async (req, res) => {
    if (limited(req, "login", 10, 900000)) return res.status(429).json({ ok: false, error: "Too many attempts. Wait 15 minutes and try again." });
    const email = normEmail(req.body && req.body.email);
    const pool = await db();
    const { rows } = await pool.query("SELECT * FROM lo_users WHERE mode=$1 AND email=$2", [stripeMode(), email]);
    const u = rows[0];
    const ok = u && !u.disabled && (await verifyPassword(req.body && req.body.password, u.password_hash));
    if (!ok) return res.status(401).json({ ok: false, error: "Email or password is incorrect." });
    res.json({ ok: true, token: await createSession(u.id) });
  }));
  app.post("/lo-portal/logout", wrap(async (req, res) => {
    const h = String(req.headers.authorization || "");
    if (h.startsWith("Bearer ")) {
      const pool = await db();
      await pool.query("DELETE FROM lo_sessions WHERE token_hash=$1", [sha256(h.slice(7).trim())]);
    }
    res.json({ ok: true });
  }));

  // ---------- public: password reset ----------
  async function createResetLink(userId) {
    const pool = await db();
    const tok = randToken(32);
    await pool.query("INSERT INTO lo_password_resets(token_hash, lo_user_id, expires_at) VALUES($1,$2, now() + ($3 || ' minutes')::interval)", [sha256(tok), userId, String(RESET_MINUTES)]);
    const u = new URL(portalUrl());
    u.searchParams.set("reset", tok);
    return u.toString();
  }
  app.post("/lo-portal/password/forgot", json, wrap(async (req, res) => {
    if (limited(req, "forgot", 5, 900000)) return res.status(429).json({ ok: false, error: "Too many attempts. Try again later." });
    const email = normEmail(req.body && req.body.email);
    const pool = await db();
    if (!mailConfigured()) {
      return res.json({ ok: true, message: "Password reset by email is not available yet. Contact Turtur Home Loans and we will send you a reset link." });
    }
    const { rows } = await pool.query("SELECT * FROM lo_users WHERE mode=$1 AND email=$2 AND NOT disabled", [stripeMode(), email]);
    if (rows[0]) {
      const link = await createResetLink(rows[0].id);
      sendMail(email, "Reset your Turtur Home Loans LO portal password",
        "<div style='font-family:Arial,sans-serif;font-size:14px'><p>Hi " + esc(rows[0].first_name) + ",</p>" +
        "<p>Use the link below to set a new password. It expires in " + RESET_MINUTES + " minutes.</p>" +
        "<p><a href='" + esc(link) + "'>Set a new password</a></p>" +
        "<p>If you did not ask for this, ignore this email.</p><p>Turtur Home Loans</p></div>"
      ).catch((e) => {
        log("reset mail failed:", e.message);
        notifyOwner("Password reset email FAILED for " + email, ["The LO asked for a password reset but the email could not be sent.", "Error: " + e.message, "Create a reset link for them from the admin page."]);
      });
    }
    res.json({ ok: true, message: "If that email has an account, a reset link is on its way." });
  }));
  app.post("/lo-portal/password/reset", json, wrap(async (req, res) => {
    if (limited(req, "reset", 10, 900000)) return res.status(429).json({ ok: false, error: "Too many attempts. Try again later." });
    const tok = String((req.body && req.body.token) || "");
    const pwErr = passwordProblem(req.body && req.body.password);
    if (pwErr) throw Object.assign(new Error(pwErr), { status: 400 });
    const pool = await db();
    const { rows } = await pool.query(
      "UPDATE lo_password_resets SET used_at=now() WHERE token_hash=$1 AND used_at IS NULL AND expires_at > now() RETURNING lo_user_id",
      [sha256(tok)]
    );
    if (!rows[0]) throw Object.assign(new Error("This reset link is invalid or expired. Request a new one."), { status: 400 });
    await pool.query("UPDATE lo_users SET password_hash=$2, updated_at=now() WHERE id=$1", [rows[0].lo_user_id, await hashPassword(req.body.password)]);
    await pool.query("DELETE FROM lo_sessions WHERE lo_user_id=$1", [rows[0].lo_user_id]);
    res.json({ ok: true, token: await createSession(rows[0].lo_user_id) });
  }));

  // ---------- account ----------
  async function paymentMethodSummary(customerId, sub) {
    let pmId = sub && sub.default_payment_method ? (typeof sub.default_payment_method === "string" ? sub.default_payment_method : sub.default_payment_method.id) : null;
    if (!pmId) {
      const c = await stripe("GET", "/customers/" + customerId, {});
      pmId = c.invoice_settings && c.invoice_settings.default_payment_method;
    }
    if (!pmId) return null;
    const pm = await stripe("GET", "/payment_methods/" + pmId, {});
    if (pm.type === "card" && pm.card) return { type: "card", brand: pm.card.brand, last4: pm.card.last4, exp: String(pm.card.exp_month).padStart(2, "0") + "/" + String(pm.card.exp_year).slice(-2) };
    if (pm.type === "us_bank_account" && pm.us_bank_account) return { type: "bank", bank: pm.us_bank_account.bank_name, last4: pm.us_bank_account.last4 };
    return { type: pm.type };
  }
  app.get("/lo-portal/me", requireUser(async (req, res, u) => {
    u = await syncUser(u);
    const [setup, subPrice] = await Promise.all([getPrice(u.setup_price_id).catch(() => null), getPrice(u.sub_price_id).catch(() => null)]);
    let sub = null, pm = null, invoices = [], upcoming = null;
    if (u.stripe_customer_id) {
      if (u.subscription_id) sub = await stripe("GET", "/subscriptions/" + u.subscription_id, {});
      pm = await paymentMethodSummary(u.stripe_customer_id, sub).catch(() => null);
      const inv = await stripe("GET", "/invoices", { customer: u.stripe_customer_id, limit: 24 });
      invoices = (inv.data || []).filter((i) => i.status !== "draft").map((i) => ({
        number: i.number, date: i.created, amount_due: i.amount_due, amount_paid: i.amount_paid, currency: i.currency,
        status: i.status, url: i.hosted_invoice_url, pdf: i.invoice_pdf,
      }));
      if (sub && ["active", "trialing", "past_due"].includes(sub.status) && !sub.cancel_at) {
        upcoming = { date: sub.current_period_end, amount: subPrice ? subPrice.unit_amount : null, currency: subPrice ? subPrice.currency : "usd" };
      }
    }
    res.json({
      ok: true,
      mode: stripeMode(),
      profile: { first_name: u.first_name, last_name: u.last_name, email: u.email, phone: u.phone, member_since: u.created_at },
      plan: {
        items: [describePrice(setup, "setup"), describePrice(subPrice, "subscription")].filter(Boolean),
        setup_paid_at: u.setup_paid_at,
        needs_payment: needsPayment(u),
        payment_pending: paymentPending(u),
      },
      subscription: sub ? {
        status: sub.status,
        current_period_end: sub.current_period_end,
        cancel_at: sub.cancel_at || (sub.cancel_at_period_end ? sub.current_period_end : null),
        cancel_requested_at: u.cancel_requested_at,
      } : null,
      upcoming,
      payment_method: pm,
      invoices,
      agreement: { version: u.agreement_version, accepted_at: u.agreement_accepted_at, text: LO_AGREEMENT_TEXT },
    });
  }));

  // ---------- checkout (initial payment) ----------
  app.post("/lo-portal/checkout", requireUser(async (req, res, u) => {
    u = await syncUser(u);
    if (!needsPayment(u)) return res.status(400).json({ ok: false, error: "Your account is already paid." });
    const { setup, sub } = await validatePrices(u.setup_price_id, u.sub_price_id);
    const ret = new URL(portalUrl());
    ret.searchParams.set("checkout", "{CHECKOUT_SESSION_ID}");
    const params = {
      ui_mode: "embedded",
      customer: u.stripe_customer_id,
      return_url: ret.toString().replace("%7BCHECKOUT_SESSION_ID%7D", "{CHECKOUT_SESSION_ID}"),
      client_reference_id: String(u.id),
      metadata: { lo_user_id: String(u.id), lo_kind: "initial" },
      customer_update: { name: "auto", address: "auto" },
      billing_address_collection: "auto",
    };
    const setupStillDue = setup && !u.setup_paid_at;
    if (sub) {
      // Owner rule (2026-10-07): renewals on the 1st of each month. At signup the LO pays the setup fee
      // plus ONE FULL monthly fee (covers signup -> end of month); the recurring price starts on the next 1st.
      // Implemented as a one-time "first month" line + trial_end on the next 1st (Checkout does not allow
      // proration_behavior=none together with one-time prices). trial_end must be >= 48h out, so within
      // the last ~2 days of a month the first month runs through the end of the following month.
      const anchor = firstBillingDate();
      params.mode = "subscription";
      params.line_items = [
        { price: sub.id, quantity: 1 },
        {
          quantity: 1,
          price_data: {
            currency: sub.currency,
            unit_amount: sub.unit_amount,
            product_data: { name: ((sub.product && sub.product.name) || "Platform Subscription") + " — first month (through " + monthEndLabel(anchor) + ")" },
          },
        },
      ];
      if (setupStillDue) params.line_items.push({ price: setup.id, quantity: 1 });
      params.submit_type = "subscribe";
      params.custom_text = { submit: { message: "Due today: " + (setupStillDue ? "the one-time setup fee plus " : "") + "your first full month (through " + monthEndLabel(anchor) + "). After that, $" + (sub.unit_amount / 100).toFixed(2) + " is billed on the 1st of each month." } };
      params.subscription_data = {
        metadata: { lo_user_id: String(u.id), first_month_through: monthEndLabel(anchor) },
        trial_end: anchor,
        trial_settings: { end_behavior: { missing_payment_method: "cancel" } },
      };
    } else {
      params.mode = "payment";
      params.line_items = [{ price: setup.id, quantity: 1 }];
      params.payment_intent_data = { setup_future_usage: "off_session", metadata: { lo_user_id: String(u.id), lo_kind: "setup" } };
      params.invoice_creation = { enabled: true, invoice_data: { metadata: { lo_user_id: String(u.id) } } };
    }
    const s = await stripe("POST", "/checkout/sessions", params);
    res.json({ ok: true, clientSecret: s.client_secret });
  }));

  async function finishCheckoutSession(sessionId, expectUserId) {
    const s = await stripe("GET", "/checkout/sessions/" + encodeURIComponent(sessionId), { expand: ["setup_intent", "subscription"] });
    const uid = s.metadata && s.metadata.lo_user_id;
    if (expectUserId && String(uid) !== String(expectUserId)) throw Object.assign(new Error("Session does not belong to this account."), { status: 403 });
    const pool = await db();
    const { rows } = await pool.query("SELECT * FROM lo_users WHERE id=$1", [uid]);
    let u = rows[0];
    if (!u) return { session: s, user: null };

    if (s.mode === "setup" && s.status === "complete" && s.setup_intent && s.setup_intent.payment_method) {
      const pmId = typeof s.setup_intent.payment_method === "string" ? s.setup_intent.payment_method : s.setup_intent.payment_method.id;
      await stripe("POST", "/customers/" + u.stripe_customer_id, { invoice_settings: { default_payment_method: pmId } });
      if (u.subscription_id) {
        await stripe("POST", "/subscriptions/" + u.subscription_id, { default_payment_method: pmId });
        // retry an open invoice if the account is behind
        const open = await stripe("GET", "/invoices", { customer: u.stripe_customer_id, status: "open", limit: 5 });
        for (const i of open.data || []) {
          await stripe("POST", "/invoices/" + i.id + "/pay", { payment_method: pmId }).catch((e) => log("retry pay failed", i.id, e.message));
        }
      }
    }
    if (s.mode === "subscription" && s.subscription) {
      const subId = typeof s.subscription === "string" ? s.subscription : s.subscription.id;
      const subObj = typeof s.subscription === "string" ? await stripe("GET", "/subscriptions/" + subId, {}) : s.subscription;
      if (subObj.default_payment_method) {
        await stripe("POST", "/customers/" + u.stripe_customer_id, { invoice_settings: { default_payment_method: typeof subObj.default_payment_method === "string" ? subObj.default_payment_method : subObj.default_payment_method.id } }).catch(() => {});
      }
    }
    if (s.mode === "payment" && s.payment_status === "paid" && s.metadata && s.metadata.lo_kind === "initial") {
      await pool.query("UPDATE lo_users SET setup_paid_at=COALESCE(setup_paid_at, now()) WHERE id=$1", [u.id]);
      if (s.payment_intent) {
        const pi = await stripe("GET", "/payment_intents/" + (typeof s.payment_intent === "string" ? s.payment_intent : s.payment_intent.id), {});
        if (pi.payment_method) await stripe("POST", "/customers/" + u.stripe_customer_id, { invoice_settings: { default_payment_method: pi.payment_method } }).catch(() => {});
      }
    }
    u = await syncUser((await pool.query("SELECT * FROM lo_users WHERE id=$1", [u.id])).rows[0]);
    return { session: s, user: u };
  }
  app.post("/lo-portal/checkout/complete", json, requireUser(async (req, res, u) => {
    const { session, user } = await finishCheckoutSession(String((req.body && req.body.session_id) || ""), u.id);
    res.json({ ok: true, status: session.status, payment_status: session.payment_status, needs_payment: user ? needsPayment(user) : true });
  }));

  // ---------- card / bank update (embedded setup-mode Checkout) ----------
  app.post("/lo-portal/payment-method/session", requireUser(async (req, res, u) => {
    if (!u.stripe_customer_id) throw Object.assign(new Error("No billing account yet."), { status: 400 });
    const ret = new URL(portalUrl());
    ret.searchParams.set("pm", "{CHECKOUT_SESSION_ID}");
    const s = await stripe("POST", "/checkout/sessions", {
      ui_mode: "embedded",
      mode: "setup",
      currency: "usd",
      customer: u.stripe_customer_id,
      return_url: ret.toString().replace("%7BCHECKOUT_SESSION_ID%7D", "{CHECKOUT_SESSION_ID}"),
      metadata: { lo_user_id: String(u.id), lo_kind: "update_payment_method" },
      setup_intent_data: { metadata: { lo_user_id: String(u.id) } },
    });
    res.json({ ok: true, clientSecret: s.client_secret });
  }));
  app.post("/lo-portal/payment-method/complete", json, requireUser(async (req, res, u) => {
    const { session } = await finishCheckoutSession(String((req.body && req.body.session_id) || ""), u.id);
    if (session.status !== "complete") return res.status(400).json({ ok: false, error: "The payment method was not saved. Try again." });
    notifyOwner("LO updated payment method: " + u.first_name + " " + u.last_name, ["Email: " + u.email]);
    res.json({ ok: true });
  }));

  // ---------- billing on the 1st ----------
  // 1st of next month (Eastern calendar), 14:00 UTC = 10:00 EDT / 09:00 EST.
  function nextFirstOfMonth(nowMs) {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "numeric" }).formatToParts(new Date(nowMs || Date.now()));
    const y = Number(parts.find((p) => p.type === "year").value);
    const m = Number(parts.find((p) => p.type === "month").value); // 1-12
    return Math.floor(Date.UTC(y, m, 1, 14, 0, 0) / 1000); // Date.UTC month is 0-based, so m = next month
  }
  function firstBillingDate(nowMs) {
    nowMs = nowMs || Date.now();
    let a = nextFirstOfMonth(nowMs);
    if (a * 1000 - nowMs < 50 * 3600 * 1000) a = nextFirstOfMonth(a * 1000 + 86400000); // need >= 48h for trial_end
    return a;
  }
  function monthEndLabel(anchorSec) {
    const d = new Date(anchorSec * 1000 - 86400000);
    return d.toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", year: "numeric" });
  }

  // ---------- cancellation (30 days' notice) ----------
  function addInterval(tsSec, interval, count) {
    const d = new Date(tsSec * 1000);
    if (interval === "year") d.setUTCFullYear(d.getUTCFullYear() + count);
    else if (interval === "week") d.setUTCDate(d.getUTCDate() + 7 * count);
    else if (interval === "day") d.setUTCDate(d.getUTCDate() + count);
    else d.setUTCMonth(d.getUTCMonth() + count);
    return Math.floor(d.getTime() / 1000);
  }
  function cancellationDate(sub, nowSec) {
    const price = sub.items && sub.items.data && sub.items.data[0] && sub.items.data[0].price;
    const interval = (price && price.recurring && price.recurring.interval) || "month";
    const count = (price && price.recurring && price.recurring.interval_count) || 1;
    let end = sub.current_period_end;
    const minEnd = nowSec + NOTICE_DAYS * 86400;
    let guard = 0;
    while (end < minEnd && guard++ < 24) end = addInterval(end, interval, count);
    return end;
  }
  app.post("/lo-portal/cancel", requireUser(async (req, res, u) => {
    if (!u.subscription_id) throw Object.assign(new Error("No active subscription."), { status: 400 });
    const sub = await stripe("GET", "/subscriptions/" + u.subscription_id, {});
    if (!["active", "trialing", "past_due", "unpaid"].includes(sub.status)) throw Object.assign(new Error("Subscription is not active."), { status: 400 });
    if (sub.cancel_at) return res.json({ ok: true, cancel_at: sub.cancel_at, already: true });
    const nowSec = Math.floor(Date.now() / 1000);
    const at = cancellationDate(sub, nowSec);
    await stripe("POST", "/subscriptions/" + u.subscription_id, { cancel_at: at, proration_behavior: "none", metadata: { cancel_requested_at: String(nowSec), cancel_source: "lo-portal" } });
    const pool = await db();
    await pool.query("UPDATE lo_users SET cancel_requested_at=now(), cancel_at=to_timestamp($2), updated_at=now() WHERE id=$1", [u.id, at]);
    const endStr = new Date(at * 1000).toLocaleDateString("en-US", { timeZone: "America/New_York", year: "numeric", month: "long", day: "numeric" });
    notifyOwner("LO cancellation notice: " + u.first_name + " " + u.last_name, ["Email: " + u.email, "Notice received: " + new Date().toLocaleString("en-US", { timeZone: "America/New_York" }) + " ET", "Subscription ends: " + endStr]);
    res.json({ ok: true, cancel_at: at });
  }));
  app.post("/lo-portal/cancel/undo", requireUser(async (req, res, u) => {
    if (!u.subscription_id) throw Object.assign(new Error("No subscription."), { status: 400 });
    const sub = await stripe("GET", "/subscriptions/" + u.subscription_id, {});
    if (!sub.cancel_at && !sub.cancel_at_period_end) return res.json({ ok: true });
    if (sub.cancel_at_period_end) await stripe("POST", "/subscriptions/" + u.subscription_id, { cancel_at_period_end: "false" });
    else await stripe("POST", "/subscriptions/" + u.subscription_id, { cancel_at: "" });
    const pool = await db();
    await pool.query("UPDATE lo_users SET cancel_requested_at=NULL, cancel_at=NULL, updated_at=now() WHERE id=$1", [u.id]);
    notifyOwner("LO withdrew cancellation: " + u.first_name + " " + u.last_name, ["Email: " + u.email]);
    res.json({ ok: true });
  }));

  // ---------- Stripe webhook ----------
  async function webhookSecret() {
    return process.env.STRIPE_WEBHOOK_SECRET || (await getConfig("webhook_secret_" + stripeMode()));
  }
  function verifyStripeSig(raw, header, secret) {
    const parts = String(header || "").split(",").reduce((a, kv) => {
      const i = kv.indexOf("=");
      if (i > 0) (a[kv.slice(0, i).trim()] = a[kv.slice(0, i).trim()] || []).push(kv.slice(i + 1).trim());
      return a;
    }, {});
    const t = parts.t && parts.t[0];
    const sigs = parts.v1 || [];
    if (!t || !sigs.length) return false;
    if (Math.abs(Date.now() / 1000 - Number(t)) > 600) return false;
    const expected = crypto.createHmac("sha256", secret).update(t + "." + raw.toString("utf8")).digest("hex");
    return sigs.some((s) => s.length === expected.length && crypto.timingSafeEqual(Buffer.from(s), Buffer.from(expected)));
  }
  app.post("/lo-portal/stripe/webhook", express.raw({ type: "*/*", limit: "1mb" }), async (req, res) => {
    let evt;
    try {
      const secret = await webhookSecret();
      if (!secret) return res.status(503).send("webhook not configured");
      if (!verifyStripeSig(req.body, req.headers["stripe-signature"], secret)) return res.status(400).send("bad signature");
      evt = JSON.parse(req.body.toString("utf8"));
    } catch (e) {
      log("webhook parse", e.message);
      return res.status(400).send("bad request");
    }
    const pool = await db();
    const ins = await pool.query("INSERT INTO lo_stripe_events(id,type,livemode,payload) VALUES($1,$2,$3,$4) ON CONFLICT (id) DO NOTHING RETURNING id", [evt.id, evt.type, !!evt.livemode, evt]);
    res.json({ received: true });
    if (!ins.rows[0]) return; // duplicate delivery
    try {
      const o = evt.data && evt.data.object;
      let u = null;
      if (evt.type.startsWith("checkout.session.")) {
        if (o.metadata && o.metadata.lo_user_id) {
          const r = await finishCheckoutSession(o.id, null);
          u = r.user;
          if (u && evt.type === "checkout.session.completed" && o.metadata.lo_kind === "initial") {
            notifyOwner("LO checkout completed: " + u.first_name + " " + u.last_name, ["Email: " + u.email, "Payment status: " + o.payment_status, "Amount: $" + ((o.amount_total || 0) / 100).toFixed(2)]);
          }
        }
      } else if (evt.type.startsWith("customer.subscription.") || evt.type.startsWith("invoice.")) {
        u = await userByCustomer(o.customer);
        if (u) u = await syncUser(u);
        if (u && evt.type === "invoice.payment_failed") {
          notifyOwner("LO payment FAILED: " + u.first_name + " " + u.last_name, ["Email: " + u.email, "Amount due: $" + ((o.amount_due || 0) / 100).toFixed(2), "Attempt: " + (o.attempt_count || 1)]);
          sendMail(u.email, "Payment failed — Turtur Home Loans LO platform",
            "<div style='font-family:Arial,sans-serif;font-size:14px'><p>Hi " + esc(u.first_name) + ",</p><p>Your payment of $" + ((o.amount_due || 0) / 100).toFixed(2) +
            " for the Turtur Home Loans LO platform did not go through. Log in to your LO portal to update your payment method.</p><p><a href='" + esc(portalUrl()) + "'>Open the LO portal</a></p><p>Turtur Home Loans</p></div>"
          ).catch((e) => log("fail mail", e.message));
        }
        if (u && evt.type === "customer.subscription.deleted") {
          notifyOwner("LO subscription ENDED: " + u.first_name + " " + u.last_name, ["Email: " + u.email]);
        }
      }
      await pool.query("UPDATE lo_stripe_events SET processed_at=now() WHERE id=$1", [evt.id]);
    } catch (e) {
      log("webhook process", evt.type, e.message);
      await pool.query("UPDATE lo_stripe_events SET error=$2 WHERE id=$1", [evt.id, String(e.message).slice(0, 500)]).catch(() => {});
    }
  });

  // =========================
  // ADMIN
  // =========================
  function adminOk(req) {
    const want = process.env.LO_ADMIN_CODE;
    const got = String(req.params.code || "");
    return !!want && want.length >= 16 && got.length === want.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want));
  }
  function adminWrap(handler) {
    return async (req, res) => {
      if (!adminOk(req)) return res.status(403).json({ ok: false, error: "bad code" });
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("X-Robots-Tag", "noindex, nofollow");
      try {
        await handler(req, res);
      } catch (e) {
        log("admin error", req.path, e.message);
        res.status(e.status || 500).json({ ok: false, error: e.message });
      }
    };
  }

  app.get("/lo-portal/admin/:code/data", adminWrap(async (req, res) => {
    const pool = await db();
    const prices = await stripe("GET", "/prices", { active: true, limit: 100, expand: ["data.product"] });
    const list = (prices.data || []).filter((p) => p.product && p.product.active !== false).map((p) => describePrice(p, p.type === "recurring" ? "subscription" : "setup"));
    const invites = (await pool.query("SELECT token_hint,email,note,setup_price_id,sub_price_id,expires_at,used_at,revoked_at,lo_user_id,link,created_at FROM lo_invites WHERE mode=$1 ORDER BY created_at DESC LIMIT 100", [stripeMode()])).rows;
    const users = (await pool.query("SELECT id,email,first_name,last_name,phone,setup_price_id,sub_price_id,subscription_status,setup_paid_at,current_period_end,cancel_at,cancel_requested_at,agreement_version,agreement_accepted_at,disabled,created_at FROM lo_users WHERE mode=$1 ORDER BY created_at DESC", [stripeMode()])).rows;
    const wh = await webhookSecret();
    res.json({ ok: true, mode: stripeMode(), portal_url: portalUrl(), webhook_connected: !!wh, publishable_key_set: !!process.env.STRIPE_PUBLISHABLE_KEY, email_configured: mailConfigured(), prices: list, invites, users });
  }));

  app.post("/lo-portal/admin/:code/invites", json, adminWrap(async (req, res) => {
    const b = req.body || {};
    const setupId = String(b.setup_price_id || "").trim() || null;
    const subId = String(b.sub_price_id || "").trim() || null;
    await validatePrices(setupId, subId);
    const email = b.email ? normEmail(b.email) : null;
    const days = Math.min(Math.max(parseInt(b.expires_days || INVITE_DAYS_DEFAULT, 10) || INVITE_DAYS_DEFAULT, 1), 60);
    const tok = randToken(24);
    const u = new URL(portalUrl());
    u.searchParams.set("invite", tok);
    const link = u.toString();
    const pool = await db();
    await pool.query(
      "INSERT INTO lo_invites(token_hash,mode,token_hint,email,note,setup_price_id,sub_price_id,expires_at,link) VALUES($1,$2,$3,$4,$5,$6,$7, now() + ($8 || ' days')::interval, $9)",
      [sha256(tok), stripeMode(), tok.slice(0, 6), email, String(b.note || "").slice(0, 200) || null, setupId, subId, String(days), link]
    );
    res.json({ ok: true, link, expires_days: days });
  }));

  app.post("/lo-portal/admin/:code/invites/:hint/revoke", adminWrap(async (req, res) => {
    const pool = await db();
    const r = await pool.query("UPDATE lo_invites SET revoked_at=now() WHERE mode=$1 AND token_hint=$2 AND used_at IS NULL AND revoked_at IS NULL RETURNING token_hint", [stripeMode(), req.params.hint]);
    res.json({ ok: true, revoked: r.rowCount });
  }));

  app.post("/lo-portal/admin/:code/users/:id/reset-link", adminWrap(async (req, res) => {
    const pool = await db();
    const { rows } = await pool.query("SELECT id FROM lo_users WHERE id=$1 AND mode=$2", [req.params.id, stripeMode()]);
    if (!rows[0]) return res.status(404).json({ ok: false, error: "not found" });
    res.json({ ok: true, link: await createResetLink(rows[0].id), expires_minutes: RESET_MINUTES });
  }));

  app.post("/lo-portal/admin/:code/users/:id/disable", json, adminWrap(async (req, res) => {
    const pool = await db();
    const disabled = !(req.body && req.body.enable === true);
    await pool.query("UPDATE lo_users SET disabled=$3, updated_at=now() WHERE id=$1 AND mode=$2", [req.params.id, stripeMode(), disabled]);
    if (disabled) await pool.query("DELETE FROM lo_sessions WHERE lo_user_id=$1", [req.params.id]);
    res.json({ ok: true, disabled });
  }));

  app.post("/lo-portal/admin/:code/users/:id/sync", adminWrap(async (req, res) => {
    const pool = await db();
    const { rows } = await pool.query("SELECT * FROM lo_users WHERE id=$1 AND mode=$2", [req.params.id, stripeMode()]);
    if (!rows[0]) return res.status(404).json({ ok: false, error: "not found" });
    const u = await syncUser(rows[0]);
    res.json({ ok: true, subscription_status: u.subscription_status, setup_paid_at: u.setup_paid_at, current_period_end: u.current_period_end, cancel_at: u.cancel_at });
  }));

  // Creates (or re-creates) the Stripe webhook endpoint for the current mode and stores its signing secret in lo_config.
  app.post("/lo-portal/admin/:code/connect-webhook", adminWrap(async (req, res) => {
    const url = publicBase() + "/lo-portal/stripe/webhook";
    const existing = await stripe("GET", "/webhook_endpoints", { limit: 100 });
    for (const w of existing.data || []) {
      if (w.url === url) await stripe("DELETE", "/webhook_endpoints/" + w.id);
    }
    const w = await stripe("POST", "/webhook_endpoints", {
      url,
      enabled_events: WEBHOOK_EVENTS,
      api_version: STRIPE_API_VERSION,
      description: "Turtur Home Loans LO portal (bonzo-sync)",
    });
    await setConfig("webhook_secret_" + stripeMode(), w.secret);
    res.json({ ok: true, mode: stripeMode(), endpoint_id: w.id, url, events: WEBHOOK_EVENTS });
  }));

  // Sends a test email to LO_NOTIFY_EMAIL to prove Graph Mail.Send works.
  app.post("/lo-portal/admin/:code/test-email", adminWrap(async (req, res) => {
    const to = process.env.LO_NOTIFY_EMAIL || process.env.OUTLOOK_MAILBOX;
    await sendMail(to, "[LO Portal] Test email", "<p>LO portal email sending works.</p>");
    res.json({ ok: true, to });
  }));

  // Recent webhook events (for verification)
  app.get("/lo-portal/admin/:code/events", adminWrap(async (req, res) => {
    const pool = await db();
    const { rows } = await pool.query("SELECT id,type,livemode,processed_at,error,created_at FROM lo_stripe_events ORDER BY created_at DESC LIMIT 50");
    res.json({ ok: true, events: rows });
  }));

  // Admin page (served by bonzo-sync; not on the public site)
  app.get("/lo-portal/admin/:code", (req, res) => {
    if (!adminOk(req)) return res.status(403).send("Forbidden");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Robots-Tag", "noindex, nofollow");
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(deps.adminHtml || "<p>admin page not loaded</p>");
  });

  log("LO portal mounted; mode=" + stripeMode() + "; stripe key " + (process.env.STRIPE_SECRET_KEY ? "set" : "MISSING"));
}
