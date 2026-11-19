#!/usr/bin/env node
// Pre-push guard: scans every tracked or staged file for secrets. Prints file:line and the rule name only, never the matched text.
// 1) Exact needles taken from the real secret files in ../.secrets (seed phrases, private keys, any long value).
// 2) Generic patterns: BIP-39 runs of 12+ wordlist words, PEM private keys, Anthropic/OpenAI style API keys.
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { wordlist } from "@scure/bip39/wordlists/english.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const secretsDir = resolve(repo, "..", ".secrets");
const extraEnv = resolve(repo, "..", "..", ".secrets.env");

function collectNeedles() {
  const needles = new Set();
  const add = (v) => { if (typeof v === "string" && v.trim().length >= 16) needles.add(v.trim()); };
  const walk = (o) => { if (typeof o === "string") add(o); else if (o && typeof o === "object") Object.values(o).forEach(walk); };
  const files = [];
  const walkDir = (d) => { for (const f of readdirSync(d)) { const p = join(d, f); const st = statSync(p); if (st.isDirectory()) walkDir(p); else if (st.isFile()) files.push(p); } };
  if (existsSync(secretsDir)) walkDir(secretsDir);
  if (existsSync(extraEnv)) files.push(extraEnv);
  for (const p of files) {
    const text = readFileSync(p, "utf8");
    if (p.endsWith(".public.json")) continue; // public addresses only, by convention
    try { walk(JSON.parse(text)); } catch {
      for (const line of text.split("\n")) { const v = line.includes("=") ? line.slice(line.indexOf("=") + 1) : line; add(v.replace(/^["']|["']$/g, "")); }
    }
    const words = text.trim().split(/\s+/);
    if (words.length >= 12 && words.every((w) => wordlist.includes(w))) for (let i = 0; i + 4 <= words.length; i += 4) needles.add(words.slice(i, i + 4).join(" "));
  }
  return [...needles];
}

const tracked = execFileSync("git", ["-C", repo, "ls-files", "-z", "--cached"], { encoding: "utf8" }).split("\0").filter(Boolean);
const needles = collectNeedles();
const wordset = new Set(wordlist);
const rules = [
  ["pem-private-key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["anthropic-key", /sk-ant-[A-Za-z0-9_-]{20,}/],
  ["openai-key", /\bsk-[A-Za-z0-9]{32,}\b/],
];
let hits = 0;
for (const f of tracked) {
  if (f === "package-lock.json") continue;
  let text;
  try { text = readFileSync(join(repo, f), "utf8"); } catch { continue; }
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    for (const n of needles) if (line.includes(n)) { console.log(`${f}:${i + 1} matches a value from the secrets directory`); hits++; }
    for (const [name, re] of rules) if (re.test(line)) { console.log(`${f}:${i + 1} rule ${name}`); hits++; }
    const run = line.toLowerCase().split(/[^a-z]+/).filter(Boolean);
    let streak = 0;
    for (const w of run) { streak = wordset.has(w) ? streak + 1 : 0; if (streak >= 12) { console.log(`${f}:${i + 1} rule bip39-run`); hits++; break; }
    }
  });
}
console.log(`check-secrets: ${tracked.length} tracked files, ${needles.length} needles from secret files, ${hits} hit(s)`);
process.exit(hits ? 1 : 0);
