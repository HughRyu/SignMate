#!/usr/bin/env node

import { registerDriver, loadConfig, runSingle } from "../src/runner.js";
import NodeSeekDriver from "../src/drivers/nodeseek.js";
import TemplateDriver from "../src/drivers/template.js";
import V2EXDriver from "../src/drivers/v2ex.js";
import NaixiDriver from "../src/drivers/naixi.js";
import RightDriver from "../src/drivers/right.js";
import WebsiteDriver from "../src/drivers/website.js";
import Pojie52Driver from "../src/drivers/pojie52.js";
import NodeLocDriver from "../src/drivers/nodeloc.js";
import PcevaDriver from "../src/drivers/pceva.js";
import ChiphellDriver from "../src/drivers/chiphell.js";
import NexusPhpDriver from "../src/drivers/nexusphp.js";
import QianmojuDriver from "../src/drivers/qianmoju.js";
import KafanDriver from "../src/drivers/kafan.js";
import FengDriver from "../src/drivers/feng.js";
import TiebaDriver from "../src/drivers/tieba.js";

registerDriver("nodeseek", NodeSeekDriver);
registerDriver("template", TemplateDriver);
registerDriver("v2ex", V2EXDriver);
registerDriver("naixi", NaixiDriver);
registerDriver("right", RightDriver);
registerDriver("website", WebsiteDriver);
registerDriver("visit", WebsiteDriver);
registerDriver("pojie52", Pojie52Driver);
registerDriver("nodeloc", NodeLocDriver);
registerDriver("pceva", PcevaDriver);
registerDriver("chiphell", ChiphellDriver);
registerDriver("nexusphp", NexusPhpDriver);
registerDriver("qianmoju", QianmojuDriver);
registerDriver("kafan", KafanDriver);
registerDriver("feng", FengDriver);
registerDriver("tieba", TiebaDriver);

function usage() {
  console.log(`Usage:
  npm run smoke:sites -- [options] <site-key...>

Options:
  --list             List configured sites and exit
  --json             Emit JSON summary only
  --continue-on-fail Continue after a failed site

Examples:
  npm run smoke:sites -- --list
  npm run smoke:sites -- v2ex pterclub-net ourbits-club
  npm run smoke:sites -- --continue-on-fail v2ex pojie52 nodeseek

Safety:
  This script never prints Cookie values or secrets, but it does execute the selected site drivers.
  Run only for explicitly selected sites, preferably after they are already signed/keepalive-safe.
`);
}

function parseArgs(argv) {
  const options = { json: false, list: false, continueOnFail: false, keys: [] };
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--list") options.list = true;
    else if (arg === "--continue-on-fail") options.continueOnFail = true;
    else if (arg.startsWith("-")) throw new Error(`Unknown option: ${arg}`);
    else options.keys.push(arg);
  }
  return options;
}

function compactResult(site, result, startedAt, endedAt) {
  const details = result.details || {};
  return {
    key: site.key,
    name: site.note || site.key || site.driver,
    driver: site.driver,
    kind: result.kind || site.kind || (site.driver === "website" || site.driver === "visit" ? "visit" : "signin"),
    success: Boolean(result.success),
    message: result.message || "",
    checkinAction: details.checkinAction || null,
    httpUsed: Boolean(details.httpUsed || details.browserContextApi === false && details.checkinAction?.startsWith?.("api_")),
    browserUsed: Boolean(details.browserUsed || details.browserLight || details.browserContextApi),
    proxyModeUsed: details.proxyModeUsed || null,
    proxyUsed: details.proxyUsed ?? null,
    stepCount: Array.isArray(result.steps) ? result.steps.length : 0,
    startedAt,
    endedAt,
  };
}

function printHuman(item) {
  const status = item.success ? "✅" : "❌";
  const mode = [
    item.checkinAction ? `action=${item.checkinAction}` : "",
    item.httpUsed ? "http" : "",
    item.browserUsed ? "browser" : "",
    item.proxyModeUsed ? `proxy=${item.proxyModeUsed}` : "",
  ].filter(Boolean).join(" · ");
  console.log(`${status} ${item.key} (${item.name}) [${item.kind}]${mode ? ` — ${mode}` : ""}`);
  if (item.message) console.log(`   ${item.message}`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) { usage(); return; }

  const { sites, secrets } = loadConfig();
  const enabledSites = sites.filter(site => site.enabled !== false);

  if (options.list) {
    for (const site of sites) {
      const enabled = site.enabled === false ? "disabled" : "enabled";
      const kind = site.kind || (site.driver === "website" || site.driver === "visit" ? "visit" : "signin");
      console.log(`${site.key}\t${enabled}\t${kind}\t${site.driver}\t${site.note || ""}`);
    }
    return;
  }

  if (!options.keys.length) {
    usage();
    throw new Error("Please pass at least one site key. Refusing to smoke-test all sites implicitly.");
  }

  const byKey = new Map(enabledSites.map(site => [String(site.key), site]));
  const missing = options.keys.filter(key => !byKey.has(String(key)));
  if (missing.length) throw new Error(`Unknown or disabled site key(s): ${missing.join(", ")}`);

  const results = [];
  for (const key of options.keys) {
    const site = byKey.get(String(key));
    const startedAt = new Date().toISOString();
    try {
      const result = await runSingle(site, secrets);
      const item = compactResult(site, result, startedAt, new Date().toISOString());
      results.push(item);
      if (!options.json) printHuman(item);
      if (!item.success && !options.continueOnFail) break;
    } catch (err) {
      const item = {
        key: site.key,
        name: site.note || site.key || site.driver,
        driver: site.driver,
        kind: site.kind || "signin",
        success: false,
        message: err.message,
        checkinAction: null,
        httpUsed: false,
        browserUsed: false,
        proxyModeUsed: null,
        proxyUsed: null,
        stepCount: 0,
        startedAt,
        endedAt: new Date().toISOString(),
      };
      results.push(item);
      if (!options.json) printHuman(item);
      if (!options.continueOnFail) break;
    }
  }

  const summary = {
    total: results.length,
    success: results.filter(item => item.success).length,
    failed: results.filter(item => !item.success).length,
    results,
  };
  if (options.json) console.log(JSON.stringify(summary, null, 2));
  if (summary.failed) process.exitCode = 1;
}

main().catch(err => {
  console.error(`[smoke:sites] ${err.message}`);
  process.exit(1);
});
