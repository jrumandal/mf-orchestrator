#!/usr/bin/env node
/**
 * Topological sort of the repo dependency graph → release order.
 * Reads repos.json, emits an ordered list (dependencies first).
 * Usage: node scripts/topo-sort.mjs [--json]
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const registry = JSON.parse(readFileSync(join(__dirname, "..", "repos.json"), "utf8"));

const nodes = registry.registry;
const byName = new Map(nodes.map((n) => [n.name, n]));

// Kahn's algorithm
const inDegree = new Map(nodes.map((n) => [n.name, 0]));
const adj = new Map(nodes.map((n) => [n.name, []]));
for (const n of nodes) {
  for (const dep of n.dependsOn) {
    if (!byName.has(dep)) throw new Error(`Unknown dependency "${dep}" (required by ${n.name})`);
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
if (order.length !== nodes.length) {
  const cycle = nodes.map((n) => n.name).filter((n) => !order.includes(n));
  throw new Error(`Dependency cycle detected among: ${cycle.join(", ")}`);
}

const result = order.map((name) => {
  const n = byName.get(name);
  return { name, type: n.type, publish: n.publish, dependsOn: n.dependsOn };
});

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log("Release order (dependencies first):");
  result.forEach((r, i) => {
    const tag = r.publish ? " [publish]" : "";
    console.log(`  ${i + 1}. ${r.name} (${r.type})${tag}`);
  });
}
