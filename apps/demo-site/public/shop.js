// Live feed of agent requests for the demo relying party. Polls /api/activity every 2 s.
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const EXPLORER = "https://ccdexplorer.io/testnet";
const tx = (h, label) => `<a class="ext hash" href="${EXPLORER}/transaction/${esc(h)}" rel="noopener">${esc(label ?? h.slice(0, 10) + "…")}</a>`;
const ICON = {
  pass: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8.5l3 3 7-7" fill="none" stroke="currentColor" stroke-width="2"/></svg>',
  fail: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" stroke-width="2"/></svg>',
  skip: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 8h8" fill="none" stroke="currentColor" stroke-width="2"/></svg>',
};
const status = (ok) => ok === true ? `<span class="status status--pass">${ICON.pass}Pass</span>` : ok === false ? `<span class="status status--fail">${ICON.fail}Fail</span>` : `<span class="status status--skip">${ICON.skip}Not run</span>`;
const LABEL = {
  headers: "Mandate headers present", mandate_format: "Well-formed mandate", network: "Concordium testnet registry", request_signature: "Signed by the agent's bound key",
  freshness: "Fresh (within 60 s)", replay: "Not a replay", validity_window: "Inside its validity window", scope_action: "Action in scope", scope_domain: "This site in scope",
  spend_cap: "Within spend caps", human_signature: "Signed by the issuer's account keys", on_chain_anchor: "Anchored on chain, not revoked",
  agent_registry: "Agent NFT active and owned by the issuer", key_binding: "Agent key bound to the issuer (CIS-8)", adult_proof: "Issuer proved age 18+ (zero knowledge)",
};
const SOURCE = { local: "This site", grpc: "Testnet node", mcp: "Agent Registry MCP", cache: "Cache (≤ 10 s)", indexer: "Indexer" };
const ACTION = { signup: "signed up", post_comment: "posted a comment", buy_report: "bought a report", delete_account: "tried to delete an account" };
const REASON = {
  revoked: "Rejected: mandate revoked", expired: "Rejected: mandate expired", action_out_of_scope: "Rejected: action not in the mandate", domain_out_of_scope: "Rejected: site not in the mandate",
  over_cap_per_action: "Rejected: price above the per-action cap", over_cap_total: "Rejected: total spend cap reached", payment_not_allowed: "Rejected: no paid actions allowed",
  replay: "Rejected: replayed request", stale_request: "Rejected: request too old", bad_request_signature: "Rejected: wrong agent key", missing_headers: "Rejected: no mandate",
  bad_human_signature: "Rejected: mandate not signed by its issuer", not_anchored: "Rejected: mandate not on chain", anchor_mismatch: "Rejected: mandate altered",
  agent_revoked: "Rejected: agent revoked in the registry", key_not_bound: "Rejected: agent key not bound", adult_proof_invalid: "Rejected: age proof did not verify", chain_unavailable: "Could not reach the chain",
};
const time = (iso) => new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const ccd = (m) => `${(Number(m) / 1e6).toLocaleString("en-GB", { maximumFractionDigits: 6 })} CCD`;
const seen = new Set();
let last = "";
const open = new Set();

function entry(a) {
  const ok = a.result.ok;
  const who = a.tokenId ? `Agent ${esc(a.tokenId)}` : "An agent";
  const title = ok ? `${who} ${ACTION[a.action] ?? esc(a.action)}${a.price ? ` for ${ccd(a.price)}` : ""}` : `${who}: ${esc(a.action)}${a.price ? ` (${ccd(a.price)})` : ""}`;
  const verdict = ok ? `<span class="status status--pass">${ICON.pass}Accepted, no puzzle</span>` : `<span class="status status--fail">${ICON.fail}${esc(REASON[a.result.code] ?? "Rejected")}</span>`;
  const bits = [];
  if (!ok && a.result.reason) bits.push(esc(a.result.reason));
  if (a.receipt) bits.push(`receipt ${tx(a.receipt.tx)} ${a.receipt.status === "finalized" ? "finalized" : a.receipt.status === "failed" ? "failed" : "submitted, waiting for finality"}`);
  if (a.payment) bits.push(`paid ${ccd(a.payment.amount)} in ${tx(a.payment.tx)}`);
  if (a.mandateId) bits.push(`mandate <span class="hash">${esc(a.mandateId.slice(0, 8))}…</span>`);
  // A rejection leads with the check that failed; the ones that passed follow; checks that never ran collapse into one quiet line.
  const numbered = a.result.checks.map((c, i) => ({ ...c, n: i + 1 }));
  const failed = numbered.filter((c) => c.ok === false);
  const passed = numbered.filter((c) => c.ok === true);
  const notRun = numbered.filter((c) => c.ok === null);
  const tr = (c) => `<tr data-state="${c.ok === false ? "fail" : "pass"}"><td class="n">${c.n}</td><td class="what">${esc(LABEL[c.name] ?? c.name)}</td><td class="res">${status(c.ok)}</td><td class="src">${esc(SOURCE[c.source] ?? c.source ?? "")}</td><td class="detail">${c.ok === false ? esc(c.reason ?? "") : ""}</td></tr>`;
  const rows = [...failed, ...passed].map(tr).join("") + (notRun.length ? `<tr data-state="skip"><td class="n"></td><td class="what" colspan="4">${notRun.length} later check${notRun.length === 1 ? "" : "s"} not run: the site stops at the first failure</td></tr>` : "");
  const isNew = !seen.has(a.id);
  seen.add(a.id);
  return `<li><div class="entry${isNew ? " entry--new" : ""}" data-id="${a.id}">
    <span class="entry__time">${time(a.at)}</span>
    <span class="entry__title">${title}</span>
    <span class="entry__verdict">${verdict}</span>
    <span class="entry__sub">${bits.join("; ")}</span>
    <details data-id="${a.id}"${open.has(a.id) ? " open" : ""}><summary>${ok ? `All ${a.result.checks.length} checks passed` : `Why it was rejected (${failed.length ? "check " + failed[0].n : "details"})`}</summary>
      <div class="scroll-x"><table class="ledger"><thead><tr><th scope="col">#</th><th scope="col">Check</th><th scope="col">Result</th><th scope="col">Answered by</th><th scope="col">Why</th></tr></thead><tbody>${rows}</tbody></table></div>
    </details></div></li>`;
}

async function poll() {
  try {
    const r = await fetch("/api/activity", { cache: "no-store" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const d = await r.json();
    const sig = JSON.stringify(d.entries);
    if (sig === last) return; // unchanged: keep the DOM (and keyboard focus) as it is
    last = sig;
    const feed = $("feed");
    const focusedId = document.activeElement?.closest?.("[data-id]")?.dataset.id;
    feed.setAttribute("aria-busy", "false");
    $("feed-status").textContent = d.entries.length ? `${d.entries.length} request${d.entries.length === 1 ? "" : "s"}, live` : "Live";
    if (!d.entries.length) {
      feed.innerHTML = `<li><div class="empty"><p>No agent requests yet. An agent with a mandate for this site shows up here the moment it signs up or buys a report.</p><p class="small muted">Try it: <code>node apps/agent/src/cli.ts signup</code></p></div></li>`;
    } else {
      feed.innerHTML = d.entries.map(entry).join("");
      if (focusedId) feed.querySelector(`details[data-id="${focusedId}"] summary`)?.focus();
    }
  } catch (e) {
    $("feed-status").textContent = "Offline";
    $("feed").setAttribute("aria-busy", "false");
    $("feed").innerHTML = `<li><div class="empty"><p class="callout callout--error">The site's server did not answer (${esc(e.message)}). The feed retries every few seconds.</p></div></li>`;
  }
}

document.addEventListener("toggle", (ev) => {
  const d = ev.target;
  if (d instanceof HTMLDetailsElement && d.dataset.id) { const id = Number(d.dataset.id); d.open ? open.add(id) : open.delete(id); }
}, true);

$("signup").addEventListener("submit", (ev) => {
  ev.preventDefault();
  const msg = $("signup-msg");
  const email = $("email");
  if (!email.checkValidity()) { email.setAttribute("aria-invalid", "true"); msg.className = "callout callout--error"; msg.textContent = "Enter an email address."; msg.hidden = false; email.focus(); return; }
  email.removeAttribute("aria-invalid");
  msg.className = "callout";
  msg.textContent = "Human sign-up is not wired in this demo. The point is the other path: agents with a mandate, shown on the right.";
  msg.hidden = false;
});

poll();
setInterval(poll, 2000);
