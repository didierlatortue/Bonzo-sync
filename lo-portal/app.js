/* Turtur Home Loans — LO Portal front-end (served by bonzo-sync at /lo-portal/app.js) */
(function () {
  "use strict";
  var SCRIPT = document.currentScript || (function () { var s = document.querySelectorAll("script[src*='/lo-portal/app.js']"); return s[s.length - 1]; })();
  var API = (SCRIPT && SCRIPT.src ? new URL(SCRIPT.src).origin : "https://bonzo-sync.onrender.com") + "/lo-portal";
  var ROOT = document.getElementById("lo-portal");
  if (!ROOT) { ROOT = document.createElement("div"); ROOT.id = "lo-portal"; document.body.appendChild(ROOT); }
  ROOT.removeAttribute("style"); // drop the WordPress loading-placeholder styling
  var TOKEN_KEY = "thl_lo_token";
  var cfg = null, stripeJs = null, activeCheckout = null;

  // ---------- styles (matches turturhomeloans.com: Prata / Montserrat / Crimson Text, navy #0A375F, blue #3D8CC8) ----------
  (function () {
    if (document.querySelector("link[data-lo-fonts]")) return;
    var l = document.createElement("link"); l.rel = "stylesheet"; l.setAttribute("data-lo-fonts", "1");
    l.href = "https://fonts.googleapis.com/css2?family=Montserrat:wght@400;500;600;700&family=Prata&family=Crimson+Text:wght@400;600&display=swap";
    document.head.appendChild(l);
  })();
  var LOGO = "https://turturhomeloans.com/wp-content/uploads/2026/01/TurturHomeLoans-Logo-Horz-Main-e1778185862773-768x195.png";
  var css = "" +
    "html,body{margin:0;padding:0;background:#fff}" +
    "#lo-portal{--navy:#0A375F;--head:#13263A;--blue:#3D8CC8;--blue-d:#2f78ae;--light:#D1DFE9;--soft:#EEF4F9;--ink:#434A56;--muted:#6b7480;--line:#D1DFE9;--ok:#1f7a4d;--warn:#9a5a00;--bad:#b42318;" +
    "font-family:Montserrat,sans-serif!important;color:var(--ink)!important;background:#fff!important;min-height:100vh;display:flex;flex-direction:column;text-align:left;box-sizing:border-box;font-size:16px;line-height:1.55;padding:0!important}" +
    "#lo-portal *{box-sizing:border-box}" +
    "#lo-portal .lp-top{background:#fff;padding:18px 16px;text-align:center;border-bottom:1px solid var(--light)}" +
    "#lo-portal .lp-top img{display:block;margin:0 auto;width:260px;max-width:70vw;height:auto}" +
    "#lo-portal .lp-main{flex:1 0 auto;background:linear-gradient(180deg,#fff 0,var(--soft) 100%);padding:28px 0 48px}" +
    "#lo-portal .lp-wrap{max-width:880px;margin:0 auto;padding:0 16px}" +
    "#lo-portal .lp-card{background:#fff;border:2px solid var(--navy);border-radius:14px;padding:22px;margin:0 0 18px;box-shadow:0 6px 18px rgba(10,55,95,.08)}" +
    "#lo-portal h1,#lo-portal h2{font-family:Prata,serif;color:var(--head);font-weight:600;letter-spacing:-.2px}" +
    "#lo-portal h1{font-size:28px;line-height:1.2;margin:0 0 10px}#lo-portal h2{font-size:21px;margin:0 0 12px}" +
    "#lo-portal p{margin:0 0 12px}#lo-portal .lp-muted{color:var(--muted);font-size:14px}" +
    "#lo-portal label{display:block;font-size:14px;font-weight:600;color:var(--navy);margin:12px 0 4px}" +
    "#lo-portal input[type=text],#lo-portal input[type=email],#lo-portal input[type=tel],#lo-portal input[type=password]{width:100%;padding:11px 13px;border:1px solid #9fb3c6;border-radius:4px;font-family:Montserrat,sans-serif;font-size:16px;background:#fff;color:var(--head)}" +
    "#lo-portal input:focus{outline:2px solid var(--blue);outline-offset:1px;border-color:var(--blue)}" +
    "#lo-portal .lp-row{display:flex;gap:12px;flex-wrap:wrap}#lo-portal .lp-row>div{flex:1 1 220px}" +
    "#lo-portal button.lp-btn{background:var(--blue);color:#fff;border:2px solid var(--blue);border-radius:20px;padding:10px 22px;font-family:Montserrat,sans-serif;font-size:15px;font-weight:700;cursor:pointer;margin:14px 8px 0 0}" +
    "#lo-portal button.lp-btn:hover{background:var(--blue-d);border-color:var(--blue-d)}" +
    "#lo-portal button.lp-btn:disabled{opacity:.55;cursor:default}" +
    "#lo-portal button.lp-sec{background:#fff;color:var(--blue)}#lo-portal button.lp-sec:hover{background:var(--soft);color:var(--navy)}" +
    "#lo-portal button.lp-danger{background:#fff;color:var(--bad);border-color:var(--bad)}#lo-portal button.lp-danger:hover{background:#fdecea}" +
    "#lo-portal button.lp-link{background:none;border:0;color:var(--blue);text-decoration:underline;cursor:pointer;padding:0;font-family:Montserrat,sans-serif;font-size:14px;margin-top:12px}" +
    "#lo-portal .lp-err{background:#fdecea;color:var(--bad);border-radius:6px;padding:10px 12px;margin:12px 0 0;font-size:14px}" +
    "#lo-portal .lp-okmsg{background:#e8f5ee;color:var(--ok);border:1px solid #bfe3cf;border-radius:8px;padding:10px 12px;margin:0 0 18px;font-size:14px}" +
    "#lo-portal .lp-terms{white-space:pre-wrap;font-size:13px;border:1px solid var(--line);border-radius:6px;padding:12px;max-height:220px;overflow:auto;background:var(--soft);color:var(--head)}" +
    "#lo-portal .lp-check{display:flex;gap:10px;align-items:flex-start;font-weight:500;color:var(--ink);margin-top:12px}#lo-portal .lp-check input{margin-top:4px;width:18px;height:18px;flex:none;accent-color:var(--blue);appearance:auto;-webkit-appearance:checkbox;opacity:1;position:static}" +
    "#lo-portal table{width:100%;border-collapse:collapse;font-size:14px}#lo-portal th,#lo-portal td{text-align:left;padding:9px 6px;border-bottom:1px solid var(--line)}#lo-portal th{color:var(--navy);font-weight:600}" +
    "#lo-portal td a{color:var(--blue)}" +
    "#lo-portal .lp-scroll{overflow-x:auto}" +
    "#lo-portal .lp-badge{display:inline-block;border-radius:999px;padding:3px 12px;font-size:13px;font-weight:600}" +
    "#lo-portal .b-ok{background:#e8f5ee;color:var(--ok)}#lo-portal .b-warn{background:#fff4e0;color:var(--warn)}#lo-portal .b-bad{background:#fdecea;color:var(--bad)}" +
    "#lo-portal .lp-items div{display:flex;justify-content:space-between;gap:12px;padding:8px 0;border-bottom:1px dashed var(--line);color:var(--head)}" +
    "#lo-portal .lp-test{background:#fff4e0;color:var(--warn);text-align:center;font-size:13px;padding:8px;font-weight:600;border-radius:8px;margin:0 0 18px}" +
    "#lo-portal .lp-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:18px}#lo-portal .lp-grid .lp-card{margin:0}" +
    "#lo-portal .lp-grid{margin-bottom:18px}" +
    "#lo-portal .lp-big{font-family:Prata,serif;font-size:24px;color:var(--head)}" +
    "#lo-portal .lp-hello{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap}#lo-portal .lp-hello button{margin-top:0}" +
    "#lo-portal .lp-checkout{min-height:120px;margin-top:12px}" +
    "#lo-portal .lp-foot{background:var(--navy);color:#fff;padding:26px 16px}" +
    "#lo-portal .lp-foot-in{max-width:1100px;margin:0 auto;display:flex;align-items:center;justify-content:space-between;gap:12px 28px;flex-wrap:wrap}" +
    "#lo-portal .lp-foot-name{font-family:'Crimson Text',serif;font-size:32px;line-height:1.1;margin-right:18px}" +
    "#lo-portal .lp-foot-nmls{font-size:19px}" +
    "#lo-portal .lp-foot-left{display:flex;align-items:baseline;flex-wrap:wrap;gap:4px 0}" +
    "#lo-portal .lp-foot-ehl{font-size:16px}" +
    /* hard resets against the WordPress theme's global element styles */
    "#lo-portal h1,#lo-portal h2{font-family:Prata,serif!important;color:var(--head)!important;text-transform:none!important}" +
    "#lo-portal h1{font-size:30px!important;line-height:1.2!important;margin:0 0 10px!important}" +
    "#lo-portal h2{font-size:21px!important;line-height:1.3!important;margin:0 0 12px!important}" +
    "#lo-portal p,#lo-portal label,#lo-portal span,#lo-portal div,#lo-portal td,#lo-portal th,#lo-portal a,#lo-portal input,#lo-portal button{font-family:Montserrat,sans-serif}" +
    "#lo-portal label{font-family:Montserrat,sans-serif!important;font-size:14px!important;line-height:1.4!important}" +
    "#lo-portal input[type=text],#lo-portal input[type=email],#lo-portal input[type=tel],#lo-portal input[type=password]{margin:0!important;height:auto!important;box-shadow:none!important;line-height:1.4!important}" +
    "#lo-portal table,#lo-portal th,#lo-portal td{border:0!important;background:transparent!important}" +
    "#lo-portal th,#lo-portal td{border-bottom:1px solid var(--line)!important;padding:9px 8px!important;font-size:14px!important}" +
    "#lo-portal table{margin:0!important}" +
    "#lo-portal .lp-big{font-family:Prata,serif!important}#lo-portal .lp-foot-name{font-family:'Crimson Text',serif!important}" +
    "@media (max-width:640px){#lo-portal h1{font-size:25px!important}#lo-portal .lp-foot-in{flex-direction:column;align-items:flex-start}#lo-portal .lp-foot-name{font-size:28px}}";
  var st = document.createElement("style"); st.textContent = css; document.head.appendChild(st);

  // ---------- utils ----------
  function h(tag, attrs, kids) {
    var el = document.createElement(tag);
    if (attrs) for (var k in attrs) {
      if (k === "text") el.textContent = attrs[k];
      else if (k === "html") el.innerHTML = attrs[k];
      else if (k.indexOf("on") === 0) el.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] !== null && attrs[k] !== undefined && attrs[k] !== false) el.setAttribute(k, attrs[k]);
    }
    (kids || []).forEach(function (c) { if (c != null) el.appendChild(typeof c === "string" ? document.createTextNode(c) : c); });
    return el;
  }
  function money(cents, cur) { return (Number(cents || 0) / 100).toLocaleString("en-US", { style: "currency", currency: (cur || "usd").toUpperCase() }); }
  function dateStr(v) { if (!v) return "—"; var d = typeof v === "number" ? new Date(v * 1000) : new Date(v); return d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" }); }
  function getTok() { try { return localStorage.getItem(TOKEN_KEY); } catch (e) { return window.__thlTok || null; } }
  function setTok(t) { window.__thlTok = t; try { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); } catch (e) {} }
  function params() { return new URLSearchParams(location.search); }
  function cleanUrl(keys) { var u = new URL(location.href); keys.forEach(function (k) { u.searchParams.delete(k); }); history.replaceState(null, "", u.pathname + (u.search ? u.search : "") + u.hash); }
  function api(method, path, body) {
    var headers = { "Content-Type": "application/json" };
    var t = getTok(); if (t) headers.Authorization = "Bearer " + t;
    return fetch(API + path, { method: method, headers: headers, body: body ? JSON.stringify(body) : undefined, cache: "no-store" })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) {
        if (r.status === 401 && path !== "/login") { setTok(null); }
        if (!r.ok || j.ok === false) { var e = new Error(j.error || ("Request failed (" + r.status + ")")); e.status = r.status; throw e; }
        return j; }); });
  }
  function errBox(msg) { return h("div", { class: "lp-err", role: "alert", text: msg }); }
  function busy(btn, on, label) { btn.disabled = on; if (label) btn.textContent = on ? "Please wait…" : label; }

  function shell(content, opts) {
    opts = opts || {};
    ROOT.innerHTML = "";
    ROOT.appendChild(h("div", { class: "lp-top" }, [h("img", { src: LOGO, alt: "Turtur Home Loans", width: "260", height: "66" })]));
    var wrap = h("div", { class: "lp-wrap" });
    if (cfg && cfg.mode === "test") wrap.appendChild(h("div", { class: "lp-test", text: "TEST MODE — no real charges. Use card 4242 4242 4242 4242, any future date, any CVC." }));
    (Array.isArray(content) ? content : [content]).forEach(function (c) { if (c) wrap.appendChild(c); });
    ROOT.appendChild(h("div", { class: "lp-main" }, [wrap]));
    ROOT.appendChild(h("div", { class: "lp-foot" }, [h("div", { class: "lp-foot-in" }, [
      h("div", { class: "lp-foot-left" }, [h("span", { class: "lp-foot-name", text: "Turtur Home Loans" }), h("span", { class: "lp-foot-nmls", text: "NMLS #2836215" })]),
      h("div", { class: "lp-foot-ehl", text: "Equal Housing Lender" })
    ])]));
    window.scrollTo(0, 0);
  }
  function loading(msg) { shell(h("div", { class: "lp-card" }, [h("p", { text: msg || "Loading…" }), h("p", { class: "lp-muted", text: "The first load can take up to a minute while the server wakes up." })])); }

  function loadStripe() {
    if (stripeJs) return Promise.resolve(stripeJs);
    if (!cfg || !cfg.publishableKey) return Promise.reject(new Error("Payments are not configured yet."));
    return new Promise(function (res, rej) {
      function ready() { try { stripeJs = window.Stripe(cfg.publishableKey); res(stripeJs); } catch (e) { rej(e); } }
      if (window.Stripe) return ready();
      var s = document.createElement("script"); s.src = "https://js.stripe.com/v3/"; s.setAttribute("data-no-optimize", "1"); s.setAttribute("data-no-defer", "1");
      s.onload = ready; s.onerror = function () { rej(new Error("Could not load the secure payment form.")); };
      document.head.appendChild(s);
    });
  }
  function destroyCheckout() { if (activeCheckout) { try { activeCheckout.destroy(); } catch (e) {} activeCheckout = null; } }
  function mountCheckout(container, path) {
    destroyCheckout();
    container.innerHTML = ""; container.appendChild(h("p", { class: "lp-muted", text: "Loading secure payment form…" }));
    return loadStripe().then(function (stripe) {
      var fetchClientSecret = function () { return api("POST", path).then(function (j) { return j.clientSecret; }); };
      var p = stripe.initEmbeddedCheckout ? stripe.initEmbeddedCheckout({ fetchClientSecret: fetchClientSecret }) : stripe.createEmbeddedCheckoutPage({ fetchClientSecret: fetchClientSecret });
      return p.then(function (co) { activeCheckout = co; container.innerHTML = ""; co.mount(container); });
    }).catch(function (e) { container.innerHTML = ""; container.appendChild(errBox(e.message)); });
  }

  // ---------- views ----------
  function viewLogin(msg) {
    var err = h("div");
    var email = h("input", { type: "email", autocomplete: "username", id: "lp-email" });
    var pw = h("input", { type: "password", autocomplete: "current-password", id: "lp-pw" });
    var btn = h("button", { class: "lp-btn", type: "submit", text: "Log in" });
    var form = h("form", { onsubmit: function (e) {
      e.preventDefault(); err.innerHTML = ""; busy(btn, true, "Log in");
      api("POST", "/login", { email: email.value, password: pw.value }).then(function (j) { setTok(j.token); viewAccount(); })
        .catch(function (e2) { err.appendChild(errBox(e2.message)); busy(btn, false, "Log in"); });
    } }, [h("label", { for: "lp-email", text: "Email" }), email, h("label", { for: "lp-pw", text: "Password" }), pw, btn, err]);
    shell([msg ? h("div", { class: "lp-okmsg", text: msg }) : null, h("div", { class: "lp-card" }, [h("h1", { text: "Log in" }), form,
      h("button", { class: "lp-link", type: "button", onclick: viewForgot, text: "Forgot your password?" })])]);
  }

  function viewForgot() {
    var err = h("div"), done = h("div");
    var email = h("input", { type: "email", autocomplete: "username", id: "lp-femail" });
    var btn = h("button", { class: "lp-btn", type: "submit", text: "Send reset link" });
    var form = h("form", { onsubmit: function (e) {
      e.preventDefault(); err.innerHTML = ""; busy(btn, true, "Send reset link");
      api("POST", "/password/forgot", { email: email.value }).then(function (j) { done.innerHTML = ""; done.appendChild(h("div", { class: "lp-okmsg", text: j.message })); busy(btn, false, "Send reset link"); })
        .catch(function (e2) { err.appendChild(errBox(e2.message)); busy(btn, false, "Send reset link"); });
    } }, [h("label", { for: "lp-femail", text: "Email" }), email, btn, err]);
    shell(h("div", { class: "lp-card" }, [h("h1", { text: "Reset your password" }), done, form, h("button", { class: "lp-link", type: "button", onclick: function () { viewLogin(); }, text: "Back to log in" })]));
  }

  function viewReset(token) {
    var err = h("div");
    var pw = h("input", { type: "password", autocomplete: "new-password", id: "lp-npw" });
    var pw2 = h("input", { type: "password", autocomplete: "new-password", id: "lp-npw2" });
    var btn = h("button", { class: "lp-btn", type: "submit", text: "Save new password" });
    var form = h("form", { onsubmit: function (e) {
      e.preventDefault(); err.innerHTML = "";
      if (pw.value !== pw2.value) return err.appendChild(errBox("Passwords do not match."));
      busy(btn, true, "Save new password");
      api("POST", "/password/reset", { token: token, password: pw.value }).then(function (j) { setTok(j.token); cleanUrl(["reset"]); viewAccount("Your password was updated."); })
        .catch(function (e2) { err.appendChild(errBox(e2.message)); busy(btn, false, "Save new password"); });
    } }, [h("label", { for: "lp-npw", text: "New password (10+ characters)" }), pw, h("label", { for: "lp-npw2", text: "Confirm new password" }), pw2, btn, err]);
    shell(h("div", { class: "lp-card" }, [h("h1", { text: "Set a new password" }), form]));
  }

  function itemsList(items) {
    var total = 0, cur = "usd";
    var rows = items.map(function (it) {
      total += Number(it.amount || 0); cur = it.currency || cur;
      var label = it.name + (it.kind === "setup" ? " (one-time)" : "");
      var amt = money(it.amount, it.currency) + (it.interval ? " / " + (it.interval_count > 1 ? it.interval_count + " " + it.interval + "s" : it.interval) : "");
      return h("div", {}, [h("span", { text: label }), h("strong", { text: amt })]);
    });
    rows.push(h("div", { style: "border-bottom:0" }, [h("span", { text: "Due today" }), h("strong", { text: money(total, cur) })]));
    return h("div", { class: "lp-items" }, rows);
  }

  function viewRegister(inviteTok) {
    loading("Loading your registration…");
    api("GET", "/invite/" + encodeURIComponent(inviteTok)).then(function (inv) {
      var err = h("div");
      var f = {};
      function field(id, label, type, ac, val) { f[id] = h("input", { type: type, id: "lp-" + id, autocomplete: ac, value: val || null }); return h("div", {}, [h("label", { for: "lp-" + id, text: label }), f[id]]); }
      var agree = h("input", { type: "checkbox", id: "lp-agree" });
      var btn = h("button", { class: "lp-btn", type: "submit", text: "Create account & continue to payment" });
      var form = h("form", { onsubmit: function (e) {
        e.preventDefault(); err.innerHTML = "";
        if (f.password.value !== f.password2.value) return err.appendChild(errBox("Passwords do not match."));
        if (!agree.checked) return err.appendChild(errBox("Check the box to accept the platform terms."));
        busy(btn, true, "Create account & continue to payment");
        api("POST", "/register", {
          invite: inviteTok, first_name: f.first.value, last_name: f.last.value, email: f.email.value, phone: f.phone.value,
          password: f.password.value, agree: true, agreement_version: inv.agreement.version
        }).then(function (j) { setTok(j.token); cleanUrl(["invite"]); viewAccount(); })
          .catch(function (e2) { err.appendChild(errBox(e2.message)); busy(btn, false, "Create account & continue to payment"); });
      } }, [
        h("div", { class: "lp-row" }, [field("first", "First name", "text", "given-name"), field("last", "Last name", "text", "family-name")]),
        h("div", { class: "lp-row" }, [field("email", "Email", "email", "email", inv.email), field("phone", "Mobile phone", "tel", "tel")]),
        h("div", { class: "lp-row" }, [field("password", "Create a password (10+ characters)", "password", "new-password"), field("password2", "Confirm password", "password", "new-password")]),
        h("label", { text: "Platform terms" }), h("div", { class: "lp-terms", text: inv.agreement.text }),
        h("label", { class: "lp-check", for: "lp-agree" }, [agree, h("span", { text: "I have read and agree to the Turtur Home Loans Loan Officer Platform Terms above, including automatic monthly billing on the 1st of each month, 30 days' notice to cancel, and no refunds." })]),
        btn, err
      ]);
      if (inv.email) { f.email.readOnly = true; }
      shell([h("div", { class: "lp-card" }, [h("h1", { text: "Welcome to Turtur Home Loans" }), h("p", { text: "Create your loan officer account. After this step you'll enter your payment details on the next screen." }),
        h("h2", { text: "Your plan" }), itemsList(inv.items)]), h("div", { class: "lp-card" }, [h("h2", { text: "Your details" }), form])]);
    }).catch(function (e) {
      shell(h("div", { class: "lp-card" }, [h("h1", { text: "Registration link problem" }), errBox(e.message), h("button", { class: "lp-btn lp-sec", onclick: function () { cleanUrl(["invite"]); viewLogin(); }, text: "Go to log in" })]));
    });
  }

  function statusBadge(me) {
    if (me.plan.needs_payment) return h("span", { class: "lp-badge b-warn", text: "Payment needed" });
    if (me.plan.payment_pending) return h("span", { class: "lp-badge b-warn", text: "Payment processing" });
    var s = me.subscription;
    if (!s) return h("span", { class: "lp-badge b-ok", text: "Paid" });
    if (s.cancel_at && (s.status === "active" || s.status === "trialing")) return h("span", { class: "lp-badge b-warn", text: "Active — ends " + dateStr(s.cancel_at) });
    var map = { active: ["b-ok", "Active"], trialing: ["b-ok", "Active"], past_due: ["b-bad", "Past due"], unpaid: ["b-bad", "Unpaid"], canceled: ["b-bad", "Cancelled"], incomplete: ["b-warn", "Payment processing"], incomplete_expired: ["b-bad", "Payment expired"], paused: ["b-warn", "Paused"] };
    var m = map[s.status] || ["b-warn", s.status];
    return h("span", { class: "lp-badge " + m[0], text: m[1] });
  }

  function viewAccount(msg) {
    destroyCheckout();
    if (!getTok()) return viewLogin(msg);
    loading("Loading your account…");
    api("GET", "/me").then(function (me) {
      var parts = [];
      if (msg) parts.push(h("div", { class: "lp-okmsg", text: msg }));
      parts.push(h("div", { class: "lp-card" }, [h("div", { class: "lp-hello" }, [h("div", {}, [h("h1", { text: "Hi " + me.profile.first_name }), h("p", {}, [statusBadge(me)])]), h("button", { class: "lp-btn lp-sec", text: "Log out", onclick: logout })]),
        me.plan.payment_pending ? h("p", { class: "lp-muted", text: "Your first payment is processing. Bank (ACH) payments can take up to 4 business days to clear." }) : null]));

      if (me.plan.needs_payment) {
        var box = h("div", { class: "lp-checkout" });
        parts.push(h("div", { class: "lp-card" }, [h("h2", { text: "Complete your payment" }), itemsList(me.plan.items.filter(function (i) { return !(i.kind === "setup" && me.plan.setup_paid_at); })),
          h("p", { class: "lp-muted", style: "margin-top:12px", text: "Your card or bank details go directly to Stripe, our payment processor. Turtur Home Loans never sees your full card number." }), box]));
        shell(parts, { loggedIn: true });
        mountCheckout(box, "/checkout");
        return;
      }

      var s = me.subscription;
      var subCard = h("div", { class: "lp-card" }, [h("h2", { text: "Subscription" })]);
      var subItem = me.plan.items.filter(function (i) { return i.kind === "subscription"; })[0];
      if (subItem) subCard.appendChild(h("p", {}, [h("span", { class: "lp-big", text: money(subItem.amount, subItem.currency) }), h("span", { class: "lp-muted", text: " / " + subItem.interval + " — " + subItem.name })]));
      if (s && s.cancel_at) {
        subCard.appendChild(h("p", { text: "Cancellation notice received. Your subscription ends on " + dateStr(s.cancel_at) + "." }));
        var undo = h("button", { class: "lp-btn lp-sec", text: "Keep my subscription", onclick: function () {
          busy(undo, true, "Keep my subscription");
          api("POST", "/cancel/undo").then(function () { viewAccount("Your cancellation was withdrawn. Your subscription continues."); }).catch(function (e) { subCard.appendChild(errBox(e.message)); busy(undo, false, "Keep my subscription"); });
        } });
        subCard.appendChild(undo);
      } else if (me.upcoming) {
        subCard.appendChild(h("p", { text: "Next charge: " + money(me.upcoming.amount, me.upcoming.currency) + " on " + dateStr(me.upcoming.date) + "." }));
      }
      if (me.plan.setup_paid_at) subCard.appendChild(h("p", { class: "lp-muted", text: "Setup fee paid " + dateStr(me.plan.setup_paid_at) + "." }));

      var pmCard = h("div", { class: "lp-card" }, [h("h2", { text: "Payment method" })]);
      var pm = me.payment_method;
      pmCard.appendChild(h("p", { text: !pm ? "No payment method on file." : pm.type === "card" ? (pm.brand.charAt(0).toUpperCase() + pm.brand.slice(1)) + " ending in " + pm.last4 + " (expires " + pm.exp + ")" : pm.type === "bank" ? (pm.bank || "Bank account") + " ending in " + pm.last4 : pm.type }));
      if (s && (s.status === "past_due" || s.status === "unpaid")) pmCard.appendChild(errBox("Your last payment did not go through. Update your payment method below and we'll retry it right away."));
      var pmBox = h("div", { class: "lp-checkout", style: "display:none" });
      var pmBtn = h("button", { class: "lp-btn", text: "Update payment method", onclick: function () {
        pmBtn.style.display = "none"; pmCancel.style.display = ""; pmBox.style.display = "";
        mountCheckout(pmBox, "/payment-method/session");
      } });
      var pmCancel = h("button", { class: "lp-btn lp-sec", style: "display:none", text: "Close", onclick: function () {
        destroyCheckout(); pmBox.innerHTML = ""; pmBox.style.display = "none"; pmCancel.style.display = "none"; pmBtn.style.display = "";
      } });
      pmCard.appendChild(pmBtn); pmCard.appendChild(pmCancel); pmCard.appendChild(pmBox);

      parts.push(h("div", { class: "lp-grid" }, [subCard, pmCard]));

      var invCard = h("div", { class: "lp-card" }, [h("h2", { text: "Billing history" })]);
      if (!me.invoices.length) invCard.appendChild(h("p", { class: "lp-muted", text: "No invoices yet." }));
      else {
        var tb = h("tbody");
        me.invoices.forEach(function (i) {
          var link = i.url ? h("a", { href: i.url, target: "_blank", rel: "noopener", text: "View" }) : "";
          var pdf = i.pdf ? h("a", { href: i.pdf, target: "_blank", rel: "noopener", text: "PDF", style: "margin-left:10px" }) : "";
          tb.appendChild(h("tr", {}, [h("td", { text: dateStr(i.date) }), h("td", { text: i.number || "—" }), h("td", { text: money(i.status === "paid" ? i.amount_paid : i.amount_due, i.currency) }),
            h("td", { text: i.status === "paid" ? "Paid" : i.status === "open" ? "Due" : i.status === "void" ? "Void" : i.status === "uncollectible" ? "Unpaid" : i.status }), h("td", {}, [link, pdf])]));
        });
        invCard.appendChild(h("div", { class: "lp-scroll" }, [h("table", {}, [h("thead", {}, [h("tr", {}, [h("th", { text: "Date" }), h("th", { text: "Invoice" }), h("th", { text: "Amount" }), h("th", { text: "Status" }), h("th", { text: "" })])]), tb])]));
      }
      parts.push(invCard);

      var acct = h("div", { class: "lp-card" }, [h("h2", { text: "Account" }),
        h("p", { text: me.profile.first_name + " " + me.profile.last_name + " · " + me.profile.email + " · " + me.profile.phone }),
        h("p", { class: "lp-muted", text: "Terms accepted " + dateStr(me.agreement.accepted_at) + " (version " + me.agreement.version + ")." })]);
      var termsBox = h("div", { class: "lp-terms", style: "display:none", text: me.agreement.text });
      acct.appendChild(h("button", { class: "lp-link", type: "button", text: "View platform terms", onclick: function () { termsBox.style.display = termsBox.style.display === "none" ? "" : "none"; } }));
      acct.appendChild(termsBox);
      if (s && !s.cancel_at && ["active", "trialing", "past_due", "unpaid"].indexOf(s.status) !== -1) {
        var confirmBox = h("div", { style: "display:none;margin-top:12px" });
        var cBtn = h("button", { class: "lp-btn lp-danger", text: "Cancel subscription", onclick: function () { cBtn.style.display = "none"; confirmBox.style.display = ""; } });
        var yes = h("button", { class: "lp-btn lp-danger", text: "Yes, give 30-day cancellation notice", onclick: function () {
          busy(yes, true, "Yes, give 30-day cancellation notice");
          api("POST", "/cancel").then(function (j) { viewAccount("Cancellation notice received. Your subscription ends on " + dateStr(j.cancel_at) + "."); })
            .catch(function (e) { confirmBox.appendChild(errBox(e.message)); busy(yes, false, "Yes, give 30-day cancellation notice"); });
        } });
        var no = h("button", { class: "lp-btn lp-sec", text: "Never mind", onclick: function () { confirmBox.style.display = "none"; cBtn.style.display = ""; } });
        confirmBox.appendChild(h("p", { text: "Cancellation requires 30 days' notice. Your subscription will end at the close of the first billing period that ends at least 30 days from today, and that period is billed as normal. Fees are not refunded or prorated." }));
        confirmBox.appendChild(yes); confirmBox.appendChild(no);
        acct.appendChild(h("div", {}, [cBtn])); acct.appendChild(confirmBox);
      }
      parts.push(acct);
      shell(parts, { loggedIn: true });
    }).catch(function (e) {
      if (e.status === 401) return viewLogin("Please log in.");
      shell(h("div", { class: "lp-card" }, [errBox(e.message), h("button", { class: "lp-btn", onclick: function () { viewAccount(); }, text: "Try again" })]), { loggedIn: true });
    });
  }

  function logout() {
    destroyCheckout();
    api("POST", "/logout").catch(function () {}).then(function () { setTok(null); viewLogin("You are logged out."); });
  }

  // ---------- boot ----------
  function boot() {
    loading();
    fetch(API + "/config", { cache: "no-store" }).then(function (r) { return r.json(); }).then(function (j) {
      cfg = j;
      var p = params();
      if (p.get("invite")) return viewRegister(p.get("invite"));
      if (p.get("reset")) return viewReset(p.get("reset"));
      if (p.get("checkout")) {
        var sid = p.get("checkout"); cleanUrl(["checkout"]);
        if (!getTok()) return viewLogin("Payment submitted. Log in to see your account.");
        loading("Confirming your payment…");
        return api("POST", "/checkout/complete", { session_id: sid }).then(function (r) {
          viewAccount(r.needs_payment ? "Your payment is processing. Bank payments can take a few business days to clear." : "Payment received. Welcome aboard!");
        }).catch(function (e) { viewAccount(); });
      }
      if (p.get("pm")) {
        var pid = p.get("pm"); cleanUrl(["pm"]);
        if (!getTok()) return viewLogin();
        loading("Saving your payment method…");
        return api("POST", "/payment-method/complete", { session_id: pid }).then(function () { viewAccount("Your payment method was updated."); })
          .catch(function (e) { viewAccount(); });
      }
      return getTok() ? viewAccount() : viewLogin();
    }).catch(function () {
      shell(h("div", { class: "lp-card" }, [errBox("The portal could not reach the server. Refresh the page in a minute."), h("button", { class: "lp-btn", onclick: boot, text: "Try again" })]));
    });
  }
  boot();
})();
