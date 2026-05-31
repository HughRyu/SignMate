#!/usr/bin/env node

import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

const checks = [
  {
    name: "syntax",
    cmd: "npm",
    args: ["run", "check"],
  },
  {
    name: "audit",
    cmd: "npm",
    args: ["audit", "--omit=dev", "--audit-level=moderate"],
    env: { npm_config_registry: process.env.SIGNMATE_AUDIT_REGISTRY || "https://registry.npmjs.org" },
  },
  {
    name: "diff whitespace",
    cmd: "git",
    args: ["diff", "--check"],
  },
];

function run({ name, cmd, args, env = {} }) {
  console.log(`\n==> ${name}: ${cmd} ${args.join(" ")}`);
  const result = spawnSync(cmd, args, {
    stdio: "inherit",
    shell: false,
    env: { ...process.env, ...env },
  });
  if (result.status !== 0) {
    console.error(`\n[release:check] ${name} failed with exit code ${result.status}`);
    process.exit(result.status || 1);
  }
}

for (const check of checks) run(check);

console.log("\n==> git status --short");
const status = spawnSync("git", ["status", "--short"], { encoding: "utf8" });
if (status.status !== 0) {
  process.stderr.write(status.stderr || "");
  process.exit(status.status || 1);
}
const lines = status.stdout.split(/\r?\n/).filter(Boolean);
if (lines.length) {
  console.log(lines.join("\n"));
  console.log("\n[release:check] Working tree has changes. This is OK only if they are intentional release files and will be committed before tagging.");
} else {
  console.log("clean");
}

const forbiddenPaths = [
  ".env",
  "config/secrets.yaml",
  "config/sites.yaml",
  "config/notify.yaml",
  "config/branding.json",
];
const tracked = spawnSync("git", ["ls-files", ...forbiddenPaths], { encoding: "utf8" });
if (tracked.status !== 0) {
  process.stderr.write(tracked.stderr || "");
  process.exit(tracked.status || 1);
}
const trackedForbidden = tracked.stdout.split(/\r?\n/).filter(Boolean);
if (trackedForbidden.length) {
  console.error("\n[release:check] Forbidden runtime/sensitive files are tracked:");
  for (const file of trackedForbidden) console.error(`- ${file}`);
  process.exit(1);
}

const presentForbidden = forbiddenPaths.filter(file => existsSync(file));
if (presentForbidden.length) {
  console.log("\n[release:check] Runtime/sensitive files exist locally and must remain untracked:");
  for (const file of presentForbidden) console.log(`- ${file}`);
}

console.log("\n[release:check] OK");
