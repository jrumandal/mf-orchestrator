#!/usr/bin/env node
/**
 * Fan-out release trigger: dispatch each repo's CI workflow in topological
 * order (dependencies first), WAITING for each run to complete before
 * triggering the next. This enforces the publish ordering
 * (shared -> MFs -> shell -> backend -> mobile).
 *
 * Usage:
 *   GITHUB_TOKEN=*** OWNER=jrumandal node scripts/trigger-release.mjs <major|minor|patch>
 *
 * - Dispatches `ci.yml` on `main` for each repo (in order).
 * - Polls the run until it completes (success or failure).
 * - Aborts the fan-out if any repo's CI fails (no point publishing dependents).
 *
 * NOTE: Requires a token with `workflow` scope (to dispatch) + `actions:read`
 * (to poll). On a free GitHub account, the PUBLISH jobs in each repo will 403
 * (GitHub Packages unavailable), but the CI jobs themselves run.
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const bump = process.argv[2] || "patch";
const owner = process.env.OWNER || "jrumandal";
const token = process.env.GITHUB_TOKEN;
const ref = process.env.REF || "main";
const workflow = process.env.WORKFLOW || "ci.yml";
const pollMs = 15000;
const timeoutMs = 30 * 60 * 1000;

if (!token) {
  console.error("GITHUB_TOKEN is required");
  process.exit(1);
}

const registry = JSON.parse(readFileSync(join(__dirname, "..", "repos.json"), "utf8"));
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

const api = (path, opts = {}) =>
  fetch(`https://api.github.com${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${token}`,
      "User-Agent": "mf-orchestrator",
      Accept: "application/vnd.github+json",
      ...(opts.headers || {}),
    },
  });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function dispatch(repo) {
  const res = await api(`/repos/${owner}/${repo}/actions/workflows/${workflow}/dispatches`, {
    method: "POST",
    body: JSON.stringify({ ref }),
  });
  if (res.status !== 204) {
    const text = await res.text();
    throw new Error(`Dispatch ${repo} failed (${res.status}): ${text}`);
  }
}

async function waitForRun(repo) {
  const start = Date.now();
  // find the most recent run for this workflow
  let runId = null;
  for (let i = 0; i < 20 && !runId; i++) {
    const res = await api(`/repos/${owner}/${repo}/actions/runs?per_page=1&created=>=${new Date(Date.now() - 120000).toISOString()}`);
    const data = await res.json();
    const run = data.workflow_runs?.[0];
    if (run) runId = run.id;
    if (!runId) await sleep(pollMs);
  }
  if (!runId) throw new Error(`Could not find a run for ${repo}`);
  while (Date.now() - start < timeoutMs) {
    const res = await api(`/repos/${owner}/${repo}/actions/runs/${runId}`);
    const run = await res.json();
    if (run.status === "completed") {
      return run.conclusion;
    }
    await sleep(pollMs);
  }
  throw new Error(`Timed out waiting for ${repo} run ${runId}`);
}

console.log(`\n=== Fan-out release (${bump}) owner=${owner} ref=${ref} ===\n`);
for (let i = 0; i < order.length; i++) {
  const repo = order[i];
  const publish = byName.get(repo).publish ? " [publish]" : "";
  process.stdout.write(`  ${i + 1}/${order.length} ${repo}${publish} ... `);
  try {
    await dispatch(repo);
    const conclusion = await waitForRun(repo);
    console.log(conclusion === "success" ? "SUCCESS" : `FAILED (${conclusion})`);
    if (conclusion !== "success") {
      console.error(`\nAborting fan-out: ${repo} CI failed. Dependents not triggered.`);
      process.exit(1);
    }
  } catch (e) {
    console.log(`ERROR: ${e.message}`);
    console.error(`\nAborting fan-out at ${repo}: ${e.message}`);
    process.exit(1);
  }
}
console.log(`\n=== Fan-out complete: all ${order.length} repos green ===`);
