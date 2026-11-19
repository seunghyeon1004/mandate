import { ConcordiumGRPCWebClient } from "@concordium/web-sdk";
import { loadRegistry, ConcordiumChainView, McpClient, defaultRecordFetcher } from "@mandate/chain";
import { verifyMandate, CCD_TESTNET, type SignedMandate } from "@mandate/core";
const out = document.getElementById("out")!;
const t0 = performance.now();
try {
  const client = new ConcordiumGRPCWebClient("https://grpc.testnet.concordium.com", 20000);
  const registry = await loadRegistry(client);
  const view = new ConcordiumChainView({ client, registry, mcp: new McpClient("https://agent-registry-mcp.concordium.com"), fetchRecord: defaultRecordFetcher() });
  const sm = (await (await fetch(new URL("../mandates/demo-valid.json", location.href))).json()) as SignedMandate;
  const r = await verifyMandate(sm, { network: CCD_TESTNET, registry: { index: "12802", subindex: "0" } }, view);
  out.textContent = JSON.stringify({ ms: Math.round(performance.now() - t0), ok: r.ok, code: r.code, checks: r.checks }, null, 1);
} catch (e) { out.textContent = "ERR " + (e as Error).stack; }
