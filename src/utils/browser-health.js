import { chromium } from "playwright-core";
import { resolveChromiumExecutablePath } from "./browser.js";

export function createBrowserHealthCheck(launch, now = Date.now) {
  let cached, expires = 0, pending;
  return async () => {
    if (now() < expires) return cached;
    if (!pending) pending = (async () => {
      let browser;
      try { browser = await launch(); cached = true; }
      catch { cached = false; }
      finally {
        if (browser) await browser.close().catch(() => { cached = false; });
        expires = now() + (cached ? 5 * 60000 : 30000);
        pending = null;
      }
      return cached;
    })();
    return pending;
  };
}
export const checkBrowserHealth = createBrowserHealthCheck(async () => chromium.launch({
  executablePath: await resolveChromiumExecutablePath(chromium),
  headless: true, timeout: 2500, args: ["--no-sandbox"],
}));
