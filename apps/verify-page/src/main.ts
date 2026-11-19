// Public verify page: runs verifyMandate() from @mandate/core against Concordium testnet in the visitor's browser.
import "../../../site/assets/mandate.css";
import { ConcordiumGRPCWebClient } from "@concordium/web-sdk";
import { ConcordiumChainView, McpClient, defaultRecordFetcher, loadRegistry, TESTNET, type AgentRecord, type KeyRecord } from "@mandate/chain";
import { CCD_TESTNET, mandateHash, validateMandate, verifyMandate, type Check, type CheckName, type ChainView, type Mandate, type SignedMandate, type Sourced, type VerifyResult } from "@mandate/core";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const EXPLORER = "https://ccdexplorer.io/testnet";
const txLink = (h: string, label = `${h.slice(0, 10)}…`) => `<a class="ext hash" href="${EXPLORER}/transaction/${h}" rel="noopener">${label}</a>`;
const accLink = (a: string) => `<a class="ext hash" href="${EXPLORER}/account/${a}" rel="noopener">${a.slice(0, 8)}…${a.slice(-4)}</a>`;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const fmtDate = (unix: number) => new Date(unix * 1000).toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "UTC" }) + " UTC";
const ccd = (micro: string) => `${(Number(micro) / 1e6).toLocaleString("en-GB", { maximumFractionDigits: 6 })} CCD`;

const ICON = {
  pass: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8.5l3 3 7-7" fill="none" stroke="currentColor" stroke-width="2"/></svg>',
  fail: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" stroke-width="2"/></svg>',
  skip: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 8h8" fill="none" stroke="currentColor" stroke-width="2"/></svg>',
};
const status = (ok: boolean | null, wait = false) =>
  wait ? '<span class="status status--wait"><span class="skeleton" style="width:4.5rem"></span><span class="visually-hidden">Checking</span></span>'
  : ok === true ? `<span class="status status--pass">${ICON.pass}Pass</span>`
  : ok === false ? `<span class="status status--fail">${ICON.fail}Fail</span>`
  : `<span class="status status--skip">${ICON.skip}Not run</span>`;
const SOURCE: Record<string, string> = { local: "This browser", grpc: "Testnet node (gRPC-web)", mcp: "Agent Registry MCP", cache: "Cache", indexer: "Registry indexer" };

const LABEL: Record<CheckName | "badge", string> = {
  headers: "Headers", mandate_format: "Well-formed mandate", network: "Concordium testnet registry", request_signature: "Request signature",
  freshness: "Fresh", replay: "Not a replay", validity_window: "Inside its validity window", scope_action: "Action in scope", scope_domain: "Domain in scope",
  spend_cap: "Within spend caps", human_signature: "Signed by the issuer's account keys", on_chain_anchor: "Anchored on chain, not revoked",
  agent_registry: "Agent NFT active, owned by the issuer, names this key", key_binding: "Agent key bound to the issuer (CIS-8)",
  adult_proof: "Issuer proved age 18+ for this mandate (zero knowledge)", badge: "Verified by Concordium badge (hosted check)",
};

/** Records what the chain answered so the page can show it as evidence. */
class RecordingView implements ChainView {
  seen: { anchor?: string | null; agent?: AgentRecord | null; key?: KeyRecord | null } = {};
  private readonly inner: ChainView;
  constructor(inner: ChainView) { this.inner = inner; }
  accountInfo(a: string) { return this.inner.accountInfo(a); }
  async mandateAnchor(t: string, k: string) { const r = await this.inner.mandateAnchor(t, k); this.seen.anchor = r.value; return r; }
  async agent(t: string) { const r = await this.inner.agent(t); this.seen.agent = r.value as AgentRecord | null; return r; }
  async keyOwner(k: { namespace: string; keyType: string; publicKeyHex: string }) { const r = await this.inner.keyOwner(k); this.seen.key = r.value; return r; }
  adultProof(m: Mandate): Promise<Sourced<{ ok: boolean; reason?: string }>> { return this.inner.adultProof(m); }
}

function evidence(name: CheckName | "badge", m: Mandate, seen: RecordingView["seen"], hash: string, badge?: BadgeResult): string {
  switch (name) {
    case "mandate_format": return `v${m.v}, id <span class="hash">${esc(m.id)}</span>, JCS SHA-256 <span class="hash">${hash.slice(0, 16)}…</span>`;
    case "network": return `<span class="hash">${esc(m.network)}</span>, CIS-8004 &lt;${esc(m.agent.contract.index)},${esc(m.agent.contract.subindex)}&gt;`;
    case "validity_window": return `${fmtDate(m.notBefore)} to ${fmtDate(m.expiry)}`;
    case "human_signature": return `issuer ${accLink(m.issuer)}, keys read from the account on chain`;
    case "on_chain_anchor": return seen.anchor === undefined ? "" : `<span class="hash">mandate:${esc(m.id.slice(0, 8))}…</span> = <span class="hash">${esc(String(seen.anchor).slice(0, 26))}${String(seen.anchor).length > 26 ? "…" : ""}</span>`;
    case "agent_registry": return seen.agent ? `token ${esc(m.agent.tokenId)}, owner ${accLink(seen.agent.owner)}, ${esc(seen.agent.status)}, key <span class="hash">${esc(seen.agent.externalKey?.publicKeyHex.slice(0, 10) ?? "none")}…</span>` : "";
    case "key_binding": return seen.key ? `<span class="hash">${esc(m.agentKey.namespace)}</span> ed25519 <span class="hash">${esc(m.agentKey.publicKeyHex.slice(0, 10))}…</span> bound to ${accLink(seen.key.owner)}, ${esc(seen.key.status)}` : "";
    case "adult_proof": return m.adultProof ? `request ${txLink(m.adultProof.vraTx)}, audit ${txLink(m.adultProof.vaaTx)}, <a class="ext" href="${esc(m.adultProof.recordUrl)}" rel="noopener">record</a>; no date of birth disclosed` : "no proof in mandate";
    case "badge": return badge ? (badge.error ? esc(badge.error) : `${Object.values(badge.checks ?? {}).filter((v) => v === true).length} registry checks passed, card hash pinned on chain; <a class="ext" href="${esc(badge.card ?? "#")}" rel="noopener">agent card</a>`) : "";
    default: return "";
  }
}

interface BadgeResult { ok: boolean; checks?: Record<string, unknown>; card?: string; error?: string }

function row(i: number, name: CheckName | "badge", c: { ok: boolean | null; source?: string; reason?: string } | null, detail: string): string {
  const wait = c === null;
  const state = wait ? "wait" : c.ok === false ? "fail" : c.ok === true ? "pass" : "skip";
  const why = c?.ok === false && c.reason ? `<strong>${esc(c.reason)}</strong>${detail ? "<br>" : ""}` : "";
  return `<tr data-state="${state}"><td class="n">${i}</td><td class="what">${LABEL[name]}</td><td class="res">${status(c?.ok ?? null, wait)}</td><td class="src">${wait ? '<span class="skeleton" style="width:8rem"></span>' : esc(SOURCE[c?.source ?? "local"] ?? String(c?.source))}</td><td class="detail">${why}${detail}</td></tr>`;
}

function renderFacts(sm: SignedMandate) {
  const m = sm.mandate, now = Date.now() / 1000;
  const left = Math.floor((m.expiry - now) / 86400);
  const scope = m.scope;
  const caps = scope.maxPerAction ? `${ccd(scope.maxPerAction.amount)} per action${scope.maxTotal ? `, ${ccd(scope.maxTotal.amount)} in total` : ""}` : "no paid actions";
  $("facts").innerHTML = `
    <dt>Issuer</dt><dd>${accLink(m.issuer)} (human, Concordium ID)</dd>
    <dt>Agent</dt><dd>token ${esc(m.agent.tokenId)} in the Agent Registry, paying from ${m.agentWallet ? accLink(m.agentWallet) : "no wallet"}</dd>
    <dt>May do</dt><dd>${scope.actions.map((a) => `<code>${esc(a)}</code>`).join(", ")} on ${scope.domains.map((d) => `<code>${esc(d)}</code>`).join(", ")}</dd>
    <dt>Spend caps</dt><dd>${caps}</dd>
    <dt>Valid until</dt><dd>${fmtDate(m.expiry)}${left >= 0 ? ` (${left} days from now)` : " (expired)"}</dd>`;
  const json = JSON.stringify(sm, null, 2);
  $("raw-pre").innerHTML = esc(json).replace(/^(\s*)(&quot;[^&]+&quot;):/gm, '$1<span class="k">$2</span>:');
  $("raw-hash").textContent = `sha256 ${mandateHash(m).slice(0, 16)}…`;
}

function setVerdict(kind: "pass" | "fail" | "wait", word: string, why: string) {
  $("verdict").className = `verdict verdict--${kind}`;
  $("verdict-word").innerHTML = `${kind === "pass" ? ICON.pass : kind === "fail" ? ICON.fail : ""}${esc(word)}`;
  $("verdict-why").textContent = why;
}

const WORD: Record<string, string> = { revoked: "Revoked", expired: "Expired", not_yet_valid: "Not yet valid", chain_unavailable: "Could not reach the chain" };

async function run(sm: SignedMandate) {
  $("result").setAttribute("aria-busy", "true");
  setVerdict("wait", "Checking", "Asking Concordium testnet. This takes a few seconds; the zero-knowledge proof is verified in your browser.");
  renderFacts(sm);
  const order: Array<CheckName | "badge"> = ["mandate_format", "network", "validity_window", "human_signature", "on_chain_anchor", "agent_registry", "key_binding", "adult_proof", "badge"];
  const tbody = $("ledger").querySelector("tbody")!;
  tbody.innerHTML = order.map((n, i) => row(i + 1, n, null, "")).join("");
  const t0 = performance.now();
  let result: VerifyResult;
  let view: RecordingView;
  const mcp = new McpClient(TESTNET.mcpUrl, "testnet", 6000);
  let badge: BadgeResult | undefined;
  try {
    const client = new ConcordiumGRPCWebClient(`https://${TESTNET.grpcHost}`, TESTNET.grpcPort, { timeout: 15000 });
    const registry = await loadRegistry(client);
    view = new RecordingView(new ConcordiumChainView({ client, registry, mcp, fetchRecord: defaultRecordFetcher() }));
    const badgeP = (async (): Promise<BadgeResult> => {
      try {
        const a = await mcp.agentOf(sm.mandate.agent.tokenId);
        if (!a) return { ok: false, error: "agent not found" };
        const b = await mcp.checkBadge(a.tokenAddress);
        return { ok: b.badge_valid && b.issues.length === 0, checks: b.checks, card: a.agentUri ?? undefined, ...(b.badge_valid ? {} : { error: `badge invalid: ${JSON.stringify(b.issues).slice(0, 160)}` }) };
      } catch (e) { return { ok: false, error: `badge check unavailable: ${(e as Error).message}` }; }
    })();
    result = await verifyMandate(sm, { network: CCD_TESTNET, registry: { index: String(TESTNET.cis8004.index), subindex: "0" } }, view);
    badge = await badgeP;
  } catch (e) {
    setVerdict("fail", "Could not reach the chain", `The testnet node did not answer (${(e as Error).message.slice(0, 120)}). Try again in a minute.`);
    tbody.innerHTML = order.map((n, i) => row(i + 1, n, { ok: null }, "")).join("");
    $("result").setAttribute("aria-busy", "false");
    return;
  }
  const hash = mandateHash(sm.mandate);
  const byName = new Map<string, Check>(result.checks.map((c) => [c.name, c]));
  tbody.innerHTML = order.map((n, i) => {
    if (n === "badge") return row(i + 1, n, { ok: badge!.ok, source: "mcp", ...(badge!.error ? { reason: badge!.error } : {}) }, evidence(n, sm.mandate, view.seen, hash, badge));
    const c = byName.get(n)!;
    return row(i + 1, n, c, evidence(n, sm.mandate, view.seen, hash));
  }).join("");
  $("elapsed").textContent = `${result.checks.filter((c) => c.ok).length + (badge?.ok ? 1 : 0)} of ${order.length} passed in ${((performance.now() - t0) / 1000).toFixed(1)} s, live from testnet.`;
  if (result.ok) setVerdict("pass", "Valid", "A website would accept this agent's signed requests within the scope above, instead of showing a CAPTCHA.");
  else if (result.code === "revoked") {
    const at = /^revoked\|at:(\d+)$/.exec(String(view.seen.anchor ?? ""))?.[1];
    setVerdict("fail", "Revoked", `The issuer revoked this mandate on chain${at ? ` on ${fmtDate(Number(at))}` : ""}. Websites now reject the agent's requests; the demo site notices within its 10-second cache bound.`);
  } else setVerdict("fail", WORD[result.code!] ?? "Rejected", result.reason ?? "");
  $("result").setAttribute("aria-busy", "false");
}

async function load(param: string): Promise<SignedMandate> {
  const url = /^https:\/\//.test(param) ? param : new URL(`../mandates/${param}.json`, location.href).toString();
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error(`could not load ${param} (HTTP ${r.status})`);
  return (await r.json()) as SignedMandate;
}

function parseInput(text: string): SignedMandate | string {
  try {
    const v = JSON.parse(text) as SignedMandate;
    if (!v?.mandate || !v?.signature) return "Expected an object with \"mandate\" and \"signature\".";
    const why = validateMandate(v.mandate);
    return why ? `The mandate is not valid: ${why}.` : v;
  } catch {
    return "That is not JSON. Paste the signed mandate, or an https link to it.";
  }
}

async function main() {
  const params = new URLSearchParams(location.search);
  const m = params.get("m") ?? "demo-valid";
  for (const a of document.querySelectorAll<HTMLAnchorElement>("#picker .key")) a.setAttribute("aria-current", String(a.dataset.m === m || (m.startsWith("https://") && a.dataset.m === "paste")));
  const paste = $("paste");
  const form = $<HTMLFormElement>("paste-form");
  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const text = $<HTMLTextAreaElement>("paste-input").value.trim();
    const err = $("paste-error");
    err.hidden = true;
    $("paste-input").removeAttribute("aria-invalid");
    if (/^https:\/\//.test(text)) { location.search = `?m=${encodeURIComponent(text)}`; return; }
    const v = parseInput(text);
    if (typeof v === "string") { err.textContent = v; err.hidden = false; $("paste-input").setAttribute("aria-invalid", "true"); return; }
    await run(v);
  });
  if (m === "paste") {
    paste.hidden = false;
    setVerdict("wait", "Nothing to check yet", "Paste a signed mandate above, or pick one of the demo mandates.");
    $("facts").innerHTML = "";
    $("result").setAttribute("aria-busy", "false");
    return;
  }
  try {
    await run(await load(m));
  } catch (e) {
    setVerdict("fail", "Mandate not found", (e as Error).message);
    $("result").setAttribute("aria-busy", "false");
  }
}

void main();
