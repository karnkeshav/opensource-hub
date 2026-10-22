(function () {
  "use strict";

  // Clickjacking guard (GitHub Pages can't send X-Frame-Options / frame-ancestors headers).
  if (window.top !== window.self) { try { window.top.location = window.self.location; } catch (e) { document.documentElement.hidden = true; } }

  var cfg = window.HUB_CONFIG || {};
  var repo = /^[\w.-]+\/[\w.-]+$/.test(cfg.githubRepo || "") ? cfg.githubRepo : "";
  var endpoint = /^https:\/\/formspree\.io\/f\/[\w-]+$/.test(cfg.formEndpoint || "") ? cfg.formEndpoint : "";
  var FB = "https://www.gstatic.com/firebasejs/10.12.2/";

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text; // textContent only: data is never parsed as HTML
    return n;
  }
  function fmt(n) { return typeof n === "number" ? n.toLocaleString() : "–"; }

  // ---- Firebase (loaded only when configured) ----
  var fbPromise = null;
  function firebase() {
    if (!cfg.firebase) return Promise.reject(new Error("firebase not configured"));
    if (!fbPromise) {
      fbPromise = Promise.all([import(FB + "firebase-app.js"), import(FB + "firebase-auth.js"), import(FB + "firebase-firestore.js")])
        .then(function (m) {
          var app = m[0].initializeApp(cfg.firebase);
          return { auth: m[1], fs: m[2], a: m[1].getAuth(app), db: m[2].getFirestore(app) };
        });
    }
    return fbPromise;
  }

  var user = null;

  // ---- Sign in with Google (optional) ----
  var slot = document.getElementById("auth-slot");
  function renderAuth() {
    slot.textContent = "";
    if (!cfg.firebase || !cfg.signIn) return;
    if (user) {
      var who = el("span", "who", user.displayName || user.email || "Signed in");
      var out = el("button", "btn-text", "Sign out");
      out.type = "button";
      out.addEventListener("click", function () { firebase().then(function (f) { return f.auth.signOut(f.a); }); });
      slot.appendChild(who); slot.appendChild(out);
    } else {
      var inn = el("button", "btn-text", "Sign in with Google");
      inn.type = "button";
      inn.addEventListener("click", function () {
        firebase().then(function (f) { return f.auth.signInWithPopup(f.a, new f.auth.GoogleAuthProvider()); })
          .catch(function () { /* popup closed or blocked: nothing to do */ });
      });
      slot.appendChild(inn);
    }
  }
  if (cfg.firebase && cfg.signIn) {
    renderAuth();
    firebase().then(function (f) {
      f.auth.onAuthStateChanged(f.a, function (u) { user = u; renderAuth(); });
    }).catch(function () {});
  }

  // ---- Download counts from GitHub Releases (sum of asset download_count by file name) ----
  function loadCounts() {
    if (!repo) return Promise.resolve(null);
    try {
      var cached = JSON.parse(sessionStorage.getItem("hub-counts") || "null");
      if (cached && Date.now() - cached.t < 10 * 60 * 1000) return Promise.resolve(cached.v);
    } catch (e) {}
    return fetch("https://api.github.com/repos/" + repo + "/releases?per_page=100", { headers: { Accept: "application/vnd.github+json" } })
      .then(function (r) { if (!r.ok) throw new Error("api " + r.status); return r.json(); })
      .then(function (releases) {
        var by = {};
        releases.forEach(function (rel) {
          (rel.assets || []).forEach(function (a) { by[a.name] = (by[a.name] || 0) + (a.download_count || 0); });
        });
        try { sessionStorage.setItem("hub-counts", JSON.stringify({ t: Date.now(), v: by })); } catch (e) {}
        return by;
      })
      .catch(function () { return null; });
  }

  // Signed-in download clicks are logged (client-side: a direct release link is not counted here).
  function logDownload(appId) {
    if (!cfg.firebase || !user) return;
    firebase().then(function (f) {
      return f.fs.addDoc(f.fs.collection(f.db, "downloads"), { uid: user.uid, app: String(appId).slice(0, 80), createdAt: f.fs.serverTimestamp() });
    }).catch(function () {});
  }

  // ---- Render apps ----
  function renderApps(apps, counts) {
    var grid = document.getElementById("app-grid");
    grid.textContent = "";
    var total = 0, any = false;
    apps.forEach(function (a) {
      var card = el("article", "card app");
      var head = el("div", "app-head");
      head.appendChild(el("div", "app-icon", a.icon || "⬢"));
      var t = el("div", "app-titles");
      t.appendChild(el("h3", "app-name", a.name));
      t.appendChild(el("p", "app-tagline", a.tagline));
      head.appendChild(t);
      card.appendChild(head);

      var tags = el("div", "tags");
      if (a.size) tags.appendChild(el("span", "tag-chip size-badge", a.size));
      (a.tags || []).forEach(function (x) { tags.appendChild(el("span", "tag-chip", x)); });
      card.appendChild(tags);

      var meta = el("div", "meta");
      meta.appendChild(el("span", "meta-item", a.platform || "–"));
      var c = counts && typeof counts[a.asset] === "number" ? counts[a.asset] : null;
      if (c != null) { total += c; any = true; }
      meta.appendChild(el("span", "meta-item", fmt(c) + " downloads"));
      card.appendChild(meta);

      var actions = el("div", "app-actions");
      var dl;
      if (repo && a.asset && a.released) {
        dl = el("a", "btn btn-primary", "Download");
        dl.href = "https://github.com/" + repo + "/releases/latest/download/" + encodeURIComponent(a.asset);
        dl.rel = "noopener";
        dl.addEventListener("click", function () { logDownload(a.id || a.name); });
      } else {
        dl = el("button", "btn btn-primary", "Coming soon");
        dl.type = "button"; dl.disabled = true; dl.setAttribute("aria-disabled", "true");
      }
      actions.appendChild(dl);
      if (a.runOnline && /^https:\/\//.test(a.runOnline)) {
        var run = el("a", "btn btn-ghost", "Run online");
        run.href = a.runOnline; run.rel = "noopener";
        actions.appendChild(run);
      }
      if (a.source && /^https:\/\/github\.com\//.test(a.source)) {
        var src = el("a", "btn btn-ghost", "Source");
        src.href = a.source; src.rel = "noopener"; src.target = "_blank";
        actions.appendChild(src);
      }
      card.appendChild(actions);
      if (a.sha256 && /^[a-f0-9]{64}$/i.test(a.sha256)) {
        var sha = el("div", "sha");
        sha.appendChild(el("code", null, "SHA-256: " + a.sha256));
        card.appendChild(sha);
      }
      grid.appendChild(card);
    });
    document.getElementById("stat-apps").textContent = String(apps.length);
    document.getElementById("stat-downloads").textContent = any ? fmt(total) : "–";
  }

  fetch("apps.json", { cache: "no-cache" })
    .then(function (r) { return r.json(); })
    .then(function (apps) { return loadCounts().then(function (counts) { renderApps(apps, counts); }); })
    .catch(function () {
      var g = document.getElementById("app-grid");
      g.textContent = "";
      g.appendChild(el("p", "muted", "Could not load the app list. Please try again later."));
    });

  // ---- Footer ----
  document.getElementById("year").textContent = String(new Date().getFullYear());
  if (repo) document.getElementById("repo-link").href = "https://github.com/" + repo;

  // ---- Request form ----
  var form = document.getElementById("request-form");
  var status = document.getElementById("f-status");
  var btn = document.getElementById("f-submit");
  var details = document.getElementById("f-details");
  var counter = document.getElementById("f-count");
  details.addEventListener("input", function () { counter.textContent = String(details.value.length); });

  function say(msg, ok) { status.textContent = msg; status.className = "form-status " + (ok ? "is-success" : "is-error"); }
  function lastSent() { try { return Number(localStorage.getItem("hub-last-req") || 0); } catch (e) { return 0; } }
  function markSent() { try { localStorage.setItem("hub-last-req", String(Date.now())); } catch (e) {} }

  function sendEmail(data) {
    return fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ _subject: "App request: " + data.app.slice(0, 70), app: data.app, details: data.details, name: data.name, email: data.email })
    }).then(function (r) { if (!r.ok) throw new Error("form " + r.status); });
  }

  function saveFirestore(data) {
    return firebase().then(function (f) {
      var doc = { app: data.app, details: data.details, name: data.name, email: data.email, createdAt: f.fs.serverTimestamp(), status: "new" };
      if (user) doc.uid = user.uid;
      return f.fs.addDoc(f.fs.collection(f.db, "requests"), doc);
    });
  }

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    if (document.getElementById("f-web").value) return; // honeypot: bots fill this in
    var data = {
      app: document.getElementById("f-app").value.trim(),
      details: details.value.trim(),
      name: document.getElementById("f-name").value.trim(),
      email: document.getElementById("f-email").value.trim()
    };
    if (user) { data.name = data.name || user.displayName || ""; data.email = data.email || user.email || ""; }
    if (data.app.length < 3) return say("Please describe the app you need (at least 3 characters).", false);
    if (data.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) return say("That email address doesn’t look right.", false);
    if (Date.now() - lastSent() < 60 * 1000) return say("Please wait a minute before sending another request.", false);

    var jobs = [];
    if (endpoint) jobs.push(sendEmail(data));
    if (cfg.firebase) jobs.push(saveFirestore(data));

    btn.disabled = true; say("Sending…", true);

    if (jobs.length) {
      // Success if at least one channel accepted the request.
      Promise.all(jobs.map(function (j) { return j.then(function () { return true; }, function () { return false; }); }))
        .then(function (res) {
          if (res.indexOf(true) !== -1) { markSent(); form.reset(); counter.textContent = "0"; say("Thanks! Your request was received.", true); }
          else say("Sorry, something went wrong. Please try again later.", false);
        }).then(function () { btn.disabled = false; });
      return;
    }

    if (repo) {
      var body = "**What should it do?**\n" + data.app + "\n\n**Details**\n" + (data.details || "_none_");
      var url = "https://github.com/" + repo + "/issues/new?labels=app-request&title=" +
        encodeURIComponent("App request: " + data.app.slice(0, 70)) + "&body=" + encodeURIComponent(body);
      markSent();
      window.open(url, "_blank", "noopener");
      say("Opening a pre-filled GitHub request. Submit it there to finish. (Your name and email are not included.)", true);
    } else {
      say("Requests aren’t switched on yet.", false);
    }
    btn.disabled = false;
  });
})();
