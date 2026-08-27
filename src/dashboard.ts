/**
 * The admin page, served inline by the Worker. No build step, no external
 * assets, no framework — it is one HTML string and a little vanilla JS.
 *
 * All values from MangaDex (series titles, chapter titles) are rendered with
 * textContent and DOM nodes rather than innerHTML, so a title containing markup
 * cannot become script.
 */

const STYLES = `
:root {
  --bg: #14141a; --panel: #1c1c25; --panel-2: #23232e; --line: #2f2f3c;
  --text: #e8e8ef; --muted: #9a9aad; --accent: #ff6740; --ok: #4ade80;
  --bad: #f87171; --warn: #fbbf24;
}
* { box-sizing: border-box; }
body {
  margin: 0; background: var(--bg); color: var(--text);
  font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
}
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
.wrap { max-width: 1000px; margin: 0 auto; padding: 32px 20px 64px; }
header { display: flex; align-items: baseline; gap: 12px; margin-bottom: 4px; }
h1 { font-size: 24px; margin: 0; letter-spacing: -0.01em; }
.sub { color: var(--muted); font-size: 13px; margin: 0 0 28px; }
h2 { font-size: 13px; text-transform: uppercase; letter-spacing: 0.08em;
     color: var(--muted); margin: 0 0 12px; font-weight: 600; }
section { margin-bottom: 32px; }
.panel { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; overflow: hidden; }
.row { display: flex; gap: 12px; align-items: center; padding: 12px 16px; border-top: 1px solid var(--line); }
.row:first-child { border-top: none; }
.row .grow { flex: 1; min-width: 0; }
.title { font-weight: 600; }
.meta { color: var(--muted); font-size: 13px; }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; }
.empty { padding: 20px 16px; color: var(--muted); }
button {
  background: var(--panel-2); color: var(--text); border: 1px solid var(--line);
  border-radius: 7px; padding: 8px 14px; font-size: 14px; cursor: pointer; font-family: inherit;
}
button:hover:not(:disabled) { border-color: var(--muted); }
button:disabled { opacity: 0.5; cursor: default; }
button.primary { background: var(--accent); border-color: var(--accent); color: #1a0d08; font-weight: 600; }
button.link { background: none; border: none; color: var(--muted); padding: 4px 8px; }
button.link:hover { color: var(--bad); }
input[type=text], input[type=password], input[type=email] {
  background: var(--bg); border: 1px solid var(--line); border-radius: 7px;
  padding: 9px 12px; color: var(--text); font: inherit; width: 100%;
}
input:focus { outline: 2px solid var(--accent); outline-offset: -1px; }
.pill { font-size: 11.5px; padding: 2px 8px; border-radius: 20px; border: 1px solid var(--line);
        color: var(--muted); white-space: nowrap; }
.pill.ok { color: var(--ok); border-color: #22482f; }
.pill.bad { color: var(--bad); border-color: #4a2626; }
.pill.warn { color: var(--warn); border-color: #4a3d1a; }
.bar { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin-bottom: 12px; }
pre { background: var(--bg); border: 1px solid var(--line); border-radius: 8px;
      padding: 14px; overflow-x: auto; margin: 0; font-size: 12.5px; }
.err { color: var(--bad); }
.login { max-width: 340px; margin: 18vh auto; padding: 0 20px; }
.login form { display: flex; flex-direction: column; gap: 12px; margin-top: 20px; }
details summary { cursor: pointer; color: var(--muted); font-size: 13px; padding: 8px 16px; }
`;

/** A heart, in the accent colour. Served at /favicon.svg. */
export const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
<path fill="#ff6740" d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/>
</svg>`;

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<title>${title}</title>
<style>${STYLES}</style>
</head><body>${body}</body></html>`;
}

export function renderLogin(error?: string): string {
  return page(
    "Nabu",
    `<div class="login">
      <h1>Nabu</h1>
      <p class="sub">MangaDex chapter notifier</p>
      ${error ? `<p class="err">${error}</p>` : ""}
      <form method="post" action="/login">
        <input type="password" name="password" placeholder="Admin token" autofocus
               autocomplete="current-password" required>
        <button class="primary" type="submit">Sign in</button>
      </form>
    </div>`,
  );
}

export function renderDashboard(): string {
  return page(
    "Nabu",
    `<div class="wrap">
  <header>
    <h1>Nabu</h1>
    <span id="status" class="pill">loading…</span>
    <span class="grow" style="flex:1"></span>
    <form method="post" action="/logout"><button class="link" type="submit">Sign out</button></form>
  </header>
  <p class="sub" id="config"></p>

  <section>
    <h2>Run now</h2>
    <div class="bar">
      <button class="primary" id="run">Run now</button>
      <span class="meta" id="run-note">Polls MangaDex and sends a digest if anything is new.</span>
    </div>
    <div id="run-result"></div>
  </section>

  <section>
    <h2>Recipients</h2>
    <div class="panel" id="recipients"></div>
    <div class="bar" style="margin-top:12px">
      <input type="email" id="new-recipient" placeholder="add@example.com"
             style="max-width:320px" autocomplete="off">
      <button id="add-recipient">Add</button>
      <button id="test-all">Send test to all</button>
      <span class="meta" id="recipients-note"></span>
    </div>
  </section>

  <section>
    <h2>Series</h2>
    <div class="bar">
      <button id="refresh-series">Sync followed series</button>
      <span class="meta">Pulls your follows from MangaDex so quiet series show up too.</span>
    </div>
    <div class="panel" id="series"></div>
  </section>

  <section>
    <h2>SMTP2GO region</h2>
    <div class="bar" id="regions"></div>
    <p class="meta">SMTP2GO issues API keys per region. A key from the wrong region is
      reported as "not found", not as a permission error. "Global" routes by whichever
      region is nearest the Worker, so pin the one your account lives in.</p>
  </section>

  <section>
    <h2>Credentials</h2>
    <div class="panel" id="diagnostics"></div>
    <p class="meta" style="margin-top:8px">Shape only — no secret value is ever read back or shown.</p>
  </section>

  <section>
    <h2>Runs</h2>
    <div class="panel" id="runs"></div>
  </section>
</div>
<script>${CLIENT_JS}</script>`,
  );
}

/**
 * Kept as a separate string so nothing in it is interpolated at build time —
 * this is the only place the page talks to the API.
 */
const CLIENT_JS = String.raw`
const $ = (id) => document.getElementById(id);
let state = { recipients: [] };

const el = (tag, opts = {}) => {
  const node = document.createElement(tag);
  if (opts.text !== undefined) node.textContent = opts.text;
  if (opts.cls) node.className = opts.cls;
  if (opts.href) node.href = opts.href;
  for (const child of opts.children || []) node.append(child);
  return node;
};

const ago = (iso) => {
  if (!iso) return "never";
  const secs = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 60) return "just now";
  const units = [["m", 60], ["h", 3600], ["d", 86400]];
  let out = Math.floor(secs / 60) + "m ago";
  for (const [suffix, size] of units) {
    if (secs >= size) out = Math.floor(secs / size) + suffix + " ago";
  }
  return out;
};

const emptyRow = (text) => el("div", { cls: "empty", text });

// A seeding run and a genuinely quiet run both end in "no email sent", but they
// mean very different things — say which.
function describeRun(ok, body) {
  if (!ok) return body.error ? "Failed: " + body.error : "Failed.";
  const s = body.summary;
  if (!s) return "Done.";
  if (s.mailed) return "Digest sent to " + (s.recipients || []).length + " recipient(s).";
  if (s.seeded) {
    return "First run: " + s.new + " chapter(s) marked as already seen, so the next " +
           "digest only contains genuinely new ones. No email by design.";
  }
  if (s.found === 0) return "Nothing published since the last run.";
  return "Ran — all " + s.found + " chapter(s) had already been sent.";
}

const testResults = {};

function renderRecipients() {
  const box = $("recipients");
  box.replaceChildren();
  if (!state.recipients.length) {
    box.append(emptyRow("No recipients — the digest has nowhere to go."));
    return;
  }
  for (const address of state.recipients) {
    const children = [el("span", { cls: "grow", text: address })];

    const result = testResults[address];
    if (result === "pending") {
      children.push(el("span", { cls: "pill", text: "sending…" }));
    } else if (result) {
      const pill = el("span", {
        cls: "pill " + (result.ok ? "ok" : "bad"),
        text: result.ok ? "delivered" : "failed",
      });
      // The provider's own words, on hover — usually names the exact problem.
      if (result.error) pill.title = result.error;
      children.push(pill);
    }

    const test = el("button", { cls: "link", text: "Test" });
    test.onclick = () => sendTest([address]);
    const remove = el("button", { cls: "link", text: "Remove" });
    remove.onclick = () => saveRecipients(state.recipients.filter((r) => r !== address));
    children.push(test, remove);

    box.append(el("div", { cls: "row", children }));
  }
}

async function sendTest(addresses) {
  for (const address of addresses) testResults[address] = "pending";
  renderRecipients();
  $("recipients-note").textContent = "Sending test email…";

  try {
    const res = await fetch("/api/test-email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ recipients: addresses }),
    });
    const body = await res.json();
    if (!res.ok && !body.results) {
      for (const address of addresses) delete testResults[address];
      $("recipients-note").textContent = body.error || "Failed to send.";
      renderRecipients();
      return;
    }
    for (const result of body.results) testResults[result.recipient] = result;
    const failed = body.results.filter((r) => !r.ok);
    $("recipients-note").textContent = failed.length
      ? failed.length + " failed — " + failed[0].error
      : "Test email sent. Check the inbox (and spam).";
  } catch (err) {
    for (const address of addresses) delete testResults[address];
    $("recipients-note").textContent = String(err);
  }
  renderRecipients();
}

async function saveRecipients(next) {
  if (!next.length) { $("recipients-note").textContent = "Keep at least one recipient."; return; }
  $("recipients-note").textContent = "Saving…";
  const res = await fetch("/api/recipients", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ recipients: next }),
  });
  const body = await res.json();
  if (!res.ok) { $("recipients-note").textContent = body.error || "Failed."; return; }
  state.recipients = body.recipients;
  $("recipients-note").textContent = "Saved.";
  renderRecipients();
}

function renderSeries(series) {
  const box = $("series");
  box.replaceChildren();
  if (!series.length) {
    box.append(emptyRow("Nothing yet. Series appear as chapters arrive, or hit Sync."));
    return;
  }
  for (const item of series) {
    const left = el("div", { cls: "grow", children: [el("div", { cls: "title", text: item.title })] });
    if (item.lastChapterLabel) {
      const link = el("a", { text: item.lastChapterLabel, href: item.lastChapterUrl || "#" });
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      left.append(el("div", { cls: "meta", children: [link] }));
    } else {
      left.append(el("div", { cls: "meta", text: "no chapters seen yet" }));
    }
    box.append(el("div", {
      cls: "row",
      children: [left, el("span", { cls: "meta", text: ago(item.lastChapterAt) })],
    }));
  }
}

function renderRegions(config) {
  const box = $("regions");
  box.replaceChildren();
  const labels = { global: "Global", us: "US", eu: "EU", au: "AU" };
  for (const region of config.smtp2goRegions || []) {
    const active = region === config.smtp2goRegion;
    const button = el("button", { text: labels[region] || region });
    if (active) button.className = "primary";
    button.disabled = active;
    button.onclick = async () => {
      box.querySelectorAll("button").forEach((b) => (b.disabled = true));
      await fetch("/api/smtp2go-region", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ region }),
      });
      await load();
    };
    box.append(button);
  }
}

function renderDiagnostics(secrets) {
  const box = $("diagnostics");
  box.replaceChildren();
  for (const d of secrets) {
    const pill = el("span", {
      cls: "pill " + (!d.present ? "bad" : d.looksRight ? "ok" : "warn"),
      text: !d.present ? "missing" : d.looksRight ? "ok" : "suspect",
    });
    const left = el("div", {
      cls: "grow",
      children: [
        el("div", { cls: "mono", text: d.name }),
        el("div", { cls: "meta", text: d.note + (d.present ? "  ·  " + d.length + " chars  ·  " + d.source : "") }),
      ],
    });
    box.append(el("div", { cls: "row", children: [left, pill] }));
  }
}

function renderRuns(runs) {
  const box = $("runs");
  box.replaceChildren();
  if (!runs.length) { box.append(emptyRow("No runs recorded yet.")); return; }

  for (const r of runs) {
    let pill;
    if (!r.ok) pill = el("span", { cls: "pill bad", text: "failed" });
    else if (r.seeded) pill = el("span", { cls: "pill warn", text: "seeded" });
    else if (r.mailed) pill = el("span", { cls: "pill ok", text: "mailed" });
    else pill = el("span", { cls: "pill", text: "no mail" });

    const detail = r.ok
      ? "found " + (r.found ?? 0) + " · new " + (r.new ?? 0) + " · " + (r.durationMs ?? 0) + "ms"
      : r.error;

    const left = el("div", {
      cls: "grow",
      children: [
        el("div", { text: new Date(r.at).toLocaleString() + "  ·  " + r.trigger }),
        el("div", { cls: r.ok ? "meta" : "meta err", text: detail || "" }),
      ],
    });

    const row = el("div", { cls: "row", children: [left, pill] });
    box.append(row);

    if (r.chapters && r.chapters.length) {
      const list = el("div", { cls: "row", children: [] });
      const inner = el("div", { cls: "grow" });
      for (const c of r.chapters) {
        const link = el("a", { text: c.series + " — " + c.label, href: c.url });
        link.target = "_blank"; link.rel = "noopener noreferrer";
        inner.append(el("div", { cls: "meta", children: [link] }));
      }
      const details = el("details");
      details.append(el("summary", { text: r.chapters.length + " chapter(s) in this digest" }), inner);
      list.replaceChildren(details);
      box.append(list);
    }
  }
}

async function load() {
  const res = await fetch("/api/state");
  if (res.status === 401) { location.reload(); return; }
  state = await res.json();
  fetch("/api/diagnostics")
    .then((r) => r.json())
    .then((d) => renderDiagnostics(d.secrets || []))
    .catch(() => {});
  renderRecipients();
  renderSeries(state.series || []);
  renderRuns(state.runs || []);

  const c = state.config || {};
  renderRegions(c);
  $("config").textContent =
    "via " + c.provider + (c.smtp2goRegion ? " (" + c.smtp2goRegion + ")" : "") +
    " · from " + c.sender + " · languages " + c.languages + " · last run " + ago(c.lastRun);
  const last = (state.runs || [])[0];
  const status = $("status");
  status.className = "pill" + (!last ? "" : last.ok ? " ok" : " bad");
  status.textContent = !last ? "no runs" : last.ok ? "healthy" : "last run failed";
  $("recipients-note").textContent = state.recipientsAreDefault
    ? "Using RECIPIENT_ADDRESS from wrangler.toml. Editing here overrides it."
    : "";
}

$("run").onclick = async () => {
  const button = $("run");
  button.disabled = true;
  $("run-note").textContent = "Running…";
  $("run-result").replaceChildren();
  try {
    const res = await fetch("/api/run", { method: "POST" });
    const body = await res.json();
    const pre = el("pre", { text: JSON.stringify(body.summary ?? body, null, 2) });
    if (!res.ok) pre.classList.add("err");
    $("run-result").append(pre);
    $("run-note").textContent = describeRun(res.ok, body);
    await load();
  } catch (err) {
    $("run-result").append(el("pre", { cls: "err", text: String(err) }));
    $("run-note").textContent = "Failed.";
  } finally {
    button.disabled = false;
  }
};

$("add-recipient").onclick = () => {
  const input = $("new-recipient");
  const value = input.value.trim();
  if (!value) return;
  if (state.recipients.includes(value)) { $("recipients-note").textContent = "Already listed."; return; }
  input.value = "";
  saveRecipients([...state.recipients, value]);
};
$("test-all").onclick = () => {
  if (state.recipients.length) sendTest([...state.recipients]);
};
$("new-recipient").addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); $("add-recipient").click(); }
});

$("refresh-series").onclick = async () => {
  const button = $("refresh-series");
  button.disabled = true;
  const original = button.textContent;
  button.textContent = "Syncing…";
  try {
    const res = await fetch("/api/series/refresh", { method: "POST" });
    const body = await res.json();
    button.textContent = res.ok ? "Synced " + body.followed : (body.error || "Failed");
    await load();
  } finally {
    setTimeout(() => { button.textContent = original; button.disabled = false; }, 2000);
  }
};

load();
`;
