#!/usr/bin/env node
/**
 * Orchestrate a cross-repo release:
 *   1. Compute the topological release order (dependencies first).
 *   2. For each repo, bump its version (major|minor|patch).
 *   3. Emit the publish fan-out plan (which repos publish to npm).
 *
 * Usage:
 *   node scripts/orchestrate.mjs <major|minor|patch> [--root <workspaceRoot>] [--dry-run]
 *
 * - <workspaceRoot> defaults to the parent of this repo (i.e. /mnt/d/workspace),
 *   where each repo lives as a sibling directory.
 * - --dry-run prints the plan without writing any package.json.
 *
 * NOTE: This driver performs the LOCAL version bumps + plan. The actual
 * `npm publish` happens in each repo's own CI (publish job) — the orchestrator
 * coordinates ORDER and VERSION, not the publish itself.
 */
import { readFileSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const [bump, ...rest] = process.argv.slice(2);
if (!bump || !["major", "minor", "patch"].includes(bump)) {
  console.error("Usage: orchestrate.mjs <major|minor|patch> [--root <workspaceRoot>] [--dry-run]");
  process.exit(1);
}
const rootIdx = rest.indexOf("--root");
const root = rootIdx !== -1 ? resolve(rest[rootIdx + 1]) : resolve(__dirname, "..", "..");
const dryRun = rest.includes("--dry-run");

const registry = JSON.parse(readFileSync(join(__dirname, "..", "repos.json"), "utf8"));

// --- 1. topological order (reuse topo-sort logic inline) ---
const nodes = registry.registry;
const byName = new Map(nodes.map((n) => [n.name, n]));
const inDegree = new Map(nodes.map((n) => [n.name, 0]));
const adj = new Map(nodes.map((n) => [n.name, []]));
for (const n of nodes) {
  for (const dep of n.dependsOn) {
    adj.get(dep).push(n.name);
    inDegree.set(n.name, inDegree.get(n.name) + 1);
  }
}
const queue = nodes.filter((n) => inDegree.get(n.name) === 0).map((n) => n.name);
const order = [];
while (queue.length) {
  const name = queue.shift();
  order.push(name);
  for (const next of adj.get(name)) {
    inDegree.set(next, inDegree.get(next) - 1);
    if (inDegree.get(next) === 0) queue.push(next);
  }
}

console.log(`\n=== Orchestrate ${bump} release (root: ${root}${dryRun ? ", DRY-RUN" : ""}) ===\n`);

// --- 2. bump each repo in order ---
const bumpScript = join(__dirname, "bump-version.mjs");
const results = [];
for (const name of order) {
  const repoDir = join(root, name);
  const pkgPath = join(repoDir, "package.json");
  if (!existsSync(pkgPath)) {
    console.log(`  SKIP  ${name} (no package.json at ${repoDir})`);
    results.push({ name, status: "skipped" });
    continue;
  }
  const args = [bumpScript, repoDir, bump];
  if (dryRun) args.push("--dry-run");
  const r = spawnSync(process.execPath, args, { encoding: "utf8" });
  const line = (r.stdout || "").trim().split("\n")[0];
  const ok = r.status === 0;
  console.log(`  ${ok ? "OK  " : "FAIL"}  ${name}: ${line}`);
  results.push({ name, status: ok ? "bumped" : "failed" });
}

// --- 3. publish fan-out plan ---
const publishers = order.filter((n) => byName.get(n).publish);
console.log(`\n=== Publish fan-out (npm) ===`);
if (publishers.length === 0) {
  console.log("  (no publishable repos)");
} else {
  publishers.forEach((n, i) => console.log(`  ${i + 1}. ${n}  ->  npm publish (in ${n} CI)`));
}
console.log(`\n=== Summary ===`);
console.log(`  repos: ${results.length}, bumped: ${results.filter((r) => r.status === "bumped").length}, skipped: ${results.filter((r) => r.status === "skipped").length}, failed: ${results.filter((r) => r.status === "failed").length}`);
console.log(`  publishable: ${publishers.length} (${publishers.join(", ")})`);
