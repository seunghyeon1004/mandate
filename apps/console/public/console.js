// Issuer console page. Talks only to the local console server (same origin).
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const EXPLORER = "https://ccdexplorer.io/testnet";
const tx = (h) => `<a class="ext hash" href="${EXPLORER}/transaction/${esc(h)}" rel="noopener">${esc(String(h).slice(0, 10))}…</a>`;
const acc = (a) => `<a class="ext hash" href="${EXPLORER}/account/${esc(a)}" rel="noopener">${esc(a.slice(0, 8))}…${esc(a.slice(-4))}</a>`;
const ccd = (m) => `${(Number(m) / 1e6).toLocaleString("en-GB", { maximumFractionDigits: 6 })} CCD`;
const date = (u) => new Date(u * 1000).toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "UTC" }) + " UTC";
const ICON = {
  pass: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8.5l3 3 7-7" fill="none" stroke="currentColor" stroke-width="2"/></svg>',
  fail: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" stroke-width="2"/></svg>',
  skip: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 8h8" fill="none" stroke="currentColor" stroke-width="2"/></svg>',
};
const ACTION = { signup: "sign up", post_comment: "post comments", buy_report: "buy reports", delete_account: "delete accounts" };
const STATUS = {
  active: `<span class="status status--pass">${ICON.pass}Active</span>`,
  revoked: `<span class="status status--fail">${ICON.fail}Revoked</span>`,
  expired: `<span class="status status--skip">${ICON.skip}Expired</span>`,
  missing: `<span class="status status--fail">${ICON.fail}Not on chain</span>`,
};
async function api(path, init) {
  const r = await fetch(path, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(body.error ?? `HTTP ${r.status}`), { body, status: r.status });
  return body;
}

async function loadAgent() {
  try {
    const a = await api("/api/agent");
    if (!a.registered) {
      $("agent-facts").innerHTML = `<div class="empty"><p>No agent registered yet. Register it once from the command line: <code>npm run mandate -- register</code>. That binds the agent's key to your account (CIS-8) and mints its Agent Registry NFT.</p></div>`;
      $("agent-badge").textContent = "";
      return;
    }
    $("agent-badge").innerHTML = a.badgeCheck.valid
      ? `<span class="status status--pass">${ICON.pass}Verified by Concordium badge valid</span>`
      : `<span class="status status--fail">${ICON.fail}Badge not valid: ${esc(JSON.stringify(a.badgeCheck.issues).slice(0, 80))}</span>`;
    $("agent-facts").innerHTML = `
      <dt>Agent</dt><dd>token ${esc(a.tokenId)} in the Agent Registry, ${esc(a.record?.status ?? "unknown")}${a.card ? `, <a class="ext" href="${esc(a.card)}" rel="noopener">agent card</a>` : ""}</dd>
      <dt>Owner</dt><dd>${acc(a.owner)} (you)</dd>
      <dt>Signing key</dt><dd><span class="hash">${esc(a.agentKey.slice(0, 16))}…</span> ${a.keyBinding?.owner === a.owner ? "bound to you through CIS-8" : "not bound"}</dd>
      <dt>Pays from</dt><dd>${acc(a.agentWallet)} (its registered agent wallet)</dd>`;
  } catch (e) {
    $("agent-facts").innerHTML = `<div class="empty"><p class="callout callout--error">Could not read the agent: ${esc(e.message)}</p><button class="key" type="button" id="agent-retry">Try again</button></div>`;
    $("agent-retry").addEventListener("click", loadAgent);
  }
}

async function loadMandates() {
  const tb = $("mandates").querySelector("tbody");
  try {
    const d = await api("/api/mandates");
    if (!d.mandates.length) {
      tb.innerHTML = `<tr><td colspan="5"><div class="empty"><p>No mandates yet. Give your agent one above; it appears here with its status on chain.</p></div></td></tr>`;
      return;
    }
    tb.innerHTML = d.mandates.map((m) => {
      const caps = m.scope.maxPerAction ? `; up to ${ccd(m.scope.maxPerAction.amount)} each${m.scope.maxTotal ? `, ${ccd(m.scope.maxTotal.amount)} total` : ""}` : "";
      const actions = m.status === "active"
        ? `<div class="confirm" data-id="${esc(m.id)}"><button class="key key--danger" type="button" data-act="ask">Revoke</button></div>`
        : m.revoked ? `revoked in ${tx(m.revoked.tx)}` : "";
      return `<tr class="mrow" data-state="${m.status === "active" ? "pass" : "skip"}">
        <td class="m-id"><span class="hash">${esc(m.id.slice(0, 8))}…</span>${m.txs ? `<span class="small m-anchor">anchor ${tx(m.txs.anchor)}</span>` : ""}</td>
        <td class="m-scope">${m.scope.actions.map((a) => esc(ACTION[a] ?? a)).join(", ")} on ${m.scope.domains.map(esc).join(", ")}${caps}</td>
        <td class="m-until"><span class="m-label">Until </span>${date(m.expiry)}</td>
        <td class="m-status">${STATUS[m.status] ?? esc(m.status)}</td>
        <td class="actions-cell">${actions}</td></tr>`;
    }).join("");
  } catch (e) {
    tb.innerHTML = `<tr><td colspan="5"><p class="callout callout--error">Could not read mandate status from the chain: ${esc(e.message)}</p></td></tr>`;
  }
}

async function loadLog() {
  const tb = $("log").querySelector("tbody");
  try {
    const d = await api("/api/log");
    tb.innerHTML = d.rows.length ? d.rows.map((r) => `<tr><td>${esc(r.group)}</td><td class="what">${esc(r.what)}</td><td>${tx(r.tx)}</td></tr>`).join("") : `<tr><td colspan="3"><div class="empty"><p>Nothing on chain yet.</p></div></td></tr>`;
  } catch (e) {
    tb.innerHTML = `<tr><td colspan="3"><p class="callout callout--error">${esc(e.message)}</p></td></tr>`;
  }
}

// Revoke: an inline, typed confirmation (destructive, cannot be undone).
$("mandates").addEventListener("click", async (ev) => {
  const btn = ev.target.closest("button[data-act]");
  if (!btn) return;
  const box = btn.closest(".confirm");
  const id = box.dataset.id;
  if (btn.dataset.act === "ask") {
    box.innerHTML = `<label class="visually-hidden" for="c-${esc(id)}">Type the first 8 characters of the mandate id to confirm</label>
      <input class="input" id="c-${esc(id)}" placeholder="Type ${esc(id.slice(0, 8))}" autocomplete="off">
      <button class="key key--danger" type="button" data-act="do">Revoke now</button><button class="key" type="button" data-act="cancel">Keep</button>`;
    box.querySelector("input").focus();
  } else if (btn.dataset.act === "cancel") {
    box.innerHTML = `<button class="key key--danger" type="button" data-act="ask">Revoke</button>`;
    box.querySelector("button").focus();
  } else if (btn.dataset.act === "do") {
    const input = box.querySelector("input");
    if (input.value.trim() !== id.slice(0, 8)) { input.setAttribute("aria-invalid", "true"); input.focus(); return; }
    btn.setAttribute("aria-busy", "true"); btn.disabled = true; btn.textContent = "Revoking";
    try {
      const r = await api(`/api/mandates/${id}/revoke`, { method: "POST", body: JSON.stringify({ confirm: id }) });
      box.innerHTML = `<span class="status status--fail">${ICON.fail}Revoked</span> in ${tx(r.tx)}`;
      $("mandates-note").textContent = "Revoked. Websites reject the agent within their cache bound (10 s on the demo site).";
      setTimeout(() => { loadMandates(); loadLog(); }, 1500);
    } catch (e) {
      box.innerHTML = `<p class="err small" role="alert">${esc(e.message)}</p><button class="key key--danger" type="button" data-act="ask">Try again</button>`;
    }
  }
});

function setSteps(job) {
  const done = new Map(job?.steps.map((s) => [s.step, s]) ?? []);
  let activeSet = false;
  for (const li of $("steps").querySelectorAll("li")) {
    const s = done.get(li.dataset.step);
    li.querySelector(".tx")?.remove();
    if (s) { li.dataset.state = "done"; if (s.tx) li.insertAdjacentHTML("beforeend", `<span class="tx">${tx(s.tx)}</span>`); }
    else if (job && !job.done && !activeSet) { li.dataset.state = "active"; activeSet = true; }
    else delete li.dataset.state;
  }
}

$("issue").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const f = ev.target;
  for (const el of f.querySelectorAll(".err")) el.hidden = true;
  for (const el of f.querySelectorAll("[aria-invalid]")) el.removeAttribute("aria-invalid");
  $("issue-error").hidden = true;
  const body = {
    actions: [...f.querySelectorAll('input[name="actions"]:checked')].map((i) => i.value),
    domains: f.domains.value, ttl: f.ttl.value, maxPerAction: f.maxPerAction.value, maxTotal: f.maxTotal.value,
  };
  const btn = $("issue-btn");
  btn.disabled = true; btn.setAttribute("aria-busy", "true"); btn.textContent = "Issuing";
  try {
    const { job } = await api("/api/mandates", { method: "POST", body: JSON.stringify(body) });
    setSteps({ steps: [], done: false });
    for (;;) {
      await new Promise((r) => setTimeout(r, 1500));
      const j = await api(`/api/jobs/${job}`);
      setSteps(j);
      if (j.done) {
        if (j.error) throw new Error(j.error);
        break;
      }
    }
    await Promise.all([loadMandates(), loadLog()]);
  } catch (e) {
    const errs = e.body?.errors;
    if (errs) {
      let first = null;
      for (const [k, msg] of Object.entries(errs)) {
        const el = $(`e-${k}`); if (el) { el.textContent = msg; el.hidden = false; }
        const input = k === "actions" ? f.querySelector('input[name="actions"]') : f.querySelector(`[name="${k}"]`);
        input?.setAttribute("aria-invalid", "true"); first ??= input;
      }
      first?.focus();
    } else { $("issue-error").textContent = e.message; $("issue-error").hidden = false; }
  } finally {
    btn.disabled = false; btn.removeAttribute("aria-busy"); btn.textContent = "Prove age and issue";
  }
});

loadAgent();
loadMandates();
loadLog();
