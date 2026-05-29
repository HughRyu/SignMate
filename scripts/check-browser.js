import { chromium } from "playwright-core";
import { existsSync } from "node:fs";
import { resolveChromiumExecutablePath } from "../src/utils/browser.js";

if (String(process.env.SIGNMATE_SKIP_BROWSER_CHECK || "").toLowerCase() === "true") {
  console.log("[check:browser] skipped by SIGNMATE_SKIP_BROWSER_CHECK=true");
  process.exit(0);
}

const executablePath = await resolveChromiumExecutablePath(chromium);
if (!executablePath || !existsSync(executablePath)) {
  throw new Error(`Chromium executable not found: ${executablePath || "<empty>"}`);
}

const browser = await chromium.launch({
  executablePath,
  headless: true,
  args: ["--no-sandbox"],
});
await browser.close();
console.log(`[check:browser] Chromium OK: ${executablePath}`);
