#!/usr/bin/env node
/**
 * Bump the version in a repo's package.json (or a named package within it).
 * Usage:
 *   node scripts/bump-version.mjs <repoDir> <major|minor|patch> [--package <name>] [--dry-run]
 *
 * - <repoDir>      path to the repo (must contain package.json)
 * - <bump>         major | minor | patch
 * - --package      optional: only bump the named package (for multi-package repos)
 * - --dry-run      print the change without writing
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const [repoDir, bump, ...rest] = process.argv.slice(2);
if (!repoDir || !bump) {
  console.error("Usage: bump-version.mjs <repoDir> <major|minor|patch> [--package <name>] [--dry-run]");
  process.exit(1);
}
if (!["major", "minor", "patch"].includes(bump)) {
  console.error(`Invalid bump "${bump}" (use major|minor|patch)`);
  process.exit(1);
}
const dryRun = rest.includes("--dry-run");
const pkgIdx = rest.indexOf("--package");
const pkgName = pkgIdx !== -1 ? rest[pkgIdx + 1] : null;

const pkgPath = join(resolve(repoDir), "package.json");
if (!existsSync(pkgPath)) {
  // Tolerant: repo not present (e.g. CI only checks out the orchestrator).
  console.log(`bump: ${repoDir} — skipped (no package.json present)`);
  process.exit(0);
}
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));

function bumpVersion(v) {
  const [maj, min, pat] = v.split(".").map(Number);
  if (bump === "major") return `${maj + 1}.0.0`;
  if (bump === "minor") return `${maj}.${min + 1}.0`;
  return `${maj}.${min}.${pat + 1}`;
}

if (pkgName) {
  // multi-package repo: bump the named package's version field if present
  if (pkg.workspaces && Array.isArray(pkg.workspaces)) {
    console.log(`Multi-package repo; bumping root version (named package "${pkgName}" lives in a workspace dir).`);
  }
}

const oldVersion = pkg.version;
if (!oldVersion) {
  console.error(`No "version" field in ${pkgPath}`);
  process.exit(1);
}
const newVersion = bumpVersion(oldVersion);
console.log(`${pkg.name ?? pkgPath}: ${oldVersion} -> ${newVersion}${dryRun ? " (dry-run)" : ""}`);
if (!dryRun) {
  pkg.version = newVersion;
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
  console.log(`Wrote ${pkgPath}`);
}
