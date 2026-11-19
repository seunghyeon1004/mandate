#!/usr/bin/env node
// One-command local demo on Concordium TESTNET, with brand-new throwaway accounts on your machine.
//   node scripts/demo.mjs setup   two testnet identities (invented attributes, self-service testnet IdP), four accounts,
//                                 one faucet drop for three of them, agent registration and a first mandate (about 3 minutes)
//   node scripts/demo.mjs run     start the operator service, the demo site and the console, run the scripted agent,
//                                 keep the servers up until Ctrl-C
// Secrets go to ../.secrets (override with MANDATE_SECRETS_DIR); nothing is printed.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const secrets = process.env.MANDATE_SECRETS_DIR ?? resolve(repo, "..", ".secrets");
const stateDir = process.env.MANDATE_STATE_DIR ?? resolve(repo, "..", ".state");
const node = process.execPath;
const children = [];

function run(args, opts = {}) {
  return new Promise((ok, fail) => {
    const c = spawn(node, args, { cwd: repo, stdio: "inherit", ...opts });
    c.on("exit", (code) => (code === 0 ? ok() : fail(new Error(`${args.join(" ")} exited with ${code}`))));
  });
}
function background(name, args) {
  const c = spawn(node, args, { cwd: repo, stdio: ["ignore", "pipe", "pipe"] });
  c.stdout.on("data", (d) => process.stdout.write(`[${name}] ${d}`));
  c.stderr.on("data", (d) => process.stdout.write(`[${name}] ${d}`));
  children.push(c);
  return c;
}
async function waitFor(url, seconds = 60) {
  for (let i = 0; i < seconds; i++) {
    try { if ((await fetch(url, { signal: AbortSignal.timeout(1500) })).ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`${url} did not come up`);
}
const accounts = () => (existsSync(resolve(secrets, "accounts.public.json")) ? JSON.parse(readFileSync(resolve(secrets, "accounts.public.json"), "utf8")) : {});
process.on("SIGINT", () => { for (const c of children) c.kill(); process.exit(0); });

async function startOperator() {
  background("operator", ["apps/facilitator/src/main.ts"]);
  await waitFor("http://127.0.0.1:4022/health");
}

async function setup() {
  await run(["node_modules/typescript/bin/tsc", "-b"]);
  const a = accounts();
  if (!a.human) {
    console.log("Creating the human's testnet identity (invented attributes: Test Human, born 1990-01-01) ...");
    await run(["scripts/setup/identity-start.mjs", "human"]);
    await run(["scripts/setup/identity-form.mjs", "human", "Test", "Human", "19900101"]);
    await run(["scripts/setup/identity-finish.mjs", "human", "human:0", "agentWallet:1:faucet"]);
  }
  if (!accounts().sponsor) {
    console.log("Creating the operator's testnet identity (Test Operator) ...");
    await run(["scripts/setup/identity-start.mjs", "operator"]);
    await run(["scripts/setup/identity-form.mjs", "operator", "Test", "Operator", "19850101"]);
    await run(["scripts/setup/identity-finish.mjs", "operator", "sponsor:0:faucet", "site:1:faucet"]);
    console.log("Waiting 20 s for the faucet drops to land ...");
    await new Promise((r) => setTimeout(r, 20_000));
  }
  await startOperator();
  await run(["apps/console/src/cli.ts", "register"]);
  await run(["apps/console/src/cli.ts", "issue"]);
  for (const c of children) c.kill();
  console.log("\nSetup done. Next: node scripts/demo.mjs run");
}

async function demo() {
  if (!existsSync(resolve(stateDir, "mandates", "current.json"))) throw new Error("run `node scripts/demo.mjs setup` first");
  await run(["node_modules/typescript/bin/tsc", "-b"]);
  await startOperator();
  background("site", ["apps/demo-site/src/main.ts"]);
  background("console", ["apps/console/src/server.ts"]);
  await waitFor("http://127.0.0.1:4021/health");
  await waitFor("http://127.0.0.1:4020/");
  console.log("\nDemo site: http://localhost:4021   Console: http://127.0.0.1:4020\nRunning the scripted agent ...\n");
  for (const step of ["signup", "comment", "report", "bundle", "delete"]) await run(["apps/agent/src/cli.ts", step]).catch((e) => console.log(e.message));
  console.log("\nOpen the two pages above. Revoke the mandate in the console, then run `node apps/agent/src/cli.ts signup` again: the site rejects it. Ctrl-C stops the servers.");
}

const cmd = process.argv[2];
(cmd === "setup" ? setup() : cmd === "run" ? demo() : Promise.reject(new Error("usage: node scripts/demo.mjs setup|run"))).catch((e) => {
  console.error(e.message);
  for (const c of children) c.kill();
  process.exit(1);
});
