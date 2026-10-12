#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
function git(args) { try { return execFileSync("git", args, { encoding: "utf8" }).trim(); } catch { return null; } }
const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
console.log(JSON.stringify({ version: packageJson.version, commit: process.env.SIGNMATE_GIT_COMMIT || git(["rev-parse", "HEAD"]), tag: git(["describe", "--tags", "--exact-match"]), image: process.env.SIGNMATE_IMAGE || `ghcr.io/hughryu/signmate:${packageJson.version}`, generatedAt: new Date().toISOString(), runtimeFilesPresent: ["config/sites.yaml", "config/secrets.yaml", "data/history.json", "logs"].filter(existsSync) }, null, 2));
