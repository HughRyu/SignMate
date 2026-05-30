import { existsSync, readdirSync } from "fs";
import { join } from "path";

function discoverPlaywrightChromiumPath() {
  const root = "/ms-playwright";
  if (!existsSync(root)) return undefined;
  const candidates = [];
  for (const dir of readdirSync(root, { withFileTypes: true })) {
    if (!dir.isDirectory() || !dir.name.startsWith("chromium")) continue;
    const base = join(root, dir.name);
    candidates.push(
      join(base, "chrome-linux64", "chrome"),
      join(base, "chrome-linux", "chrome"),
      join(base, "chrome-linux", "headless_shell"),
    );
  }
  return candidates.find(path => existsSync(path));
}

export async function resolveChromiumExecutablePath(chromium) {
  const configured = process.env.CHROMIUM_PATH || process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  if (configured) return configured;
  const detected = typeof chromium?.executablePath === "function" ? chromium.executablePath() : "";
  if (detected) return detected;
  return discoverPlaywrightChromiumPath();
}

function truthy(value = "") {
  return ["1", "true", "yes", "on", "cloak"].includes(String(value || "").trim().toLowerCase());
}

export function browserEngine() {
  return String(process.env.SIGNMATE_BROWSER_ENGINE || "playwright").trim().toLowerCase();
}

export function shouldUseCloakBrowser(siteConfig = {}) {
  const siteEngine = String(siteConfig.browser_engine || siteConfig.browserEngine || "").trim().toLowerCase();
  if (siteEngine) return siteEngine === "cloak" || siteEngine === "cloakbrowser";
  return browserEngine() === "cloak" || truthy(process.env.SIGNMATE_CLOAK_ENABLED);
}

export function buildCloakLaunchOptions({ headless = true, proxy, args = [], timeout, siteConfig = {} } = {}) {
  const mergedArgs = [...(Array.isArray(args) ? args : [])];
  if (process.env.SIGNMATE_CLOAK_ARGS) mergedArgs.push(...process.env.SIGNMATE_CLOAK_ARGS.split(/\s+/).filter(Boolean));
  const options = {
    headless: String(process.env.SIGNMATE_CLOAK_HEADLESS || "").trim() === "false" ? false : headless,
    humanize: truthy(process.env.SIGNMATE_CLOAK_HUMANIZE ?? siteConfig.cloak_humanize),
    geoip: truthy(process.env.SIGNMATE_CLOAK_GEOIP ?? siteConfig.cloak_geoip),
    args: mergedArgs,
  };
  if (proxy) options.proxy = typeof proxy === "string" ? proxy : proxy.server || proxy;
  if (timeout) options.timeout = timeout;
  if (process.env.SIGNMATE_CLOAK_LOCALE || siteConfig.cloak_locale) options.locale = process.env.SIGNMATE_CLOAK_LOCALE || siteConfig.cloak_locale;
  if (process.env.SIGNMATE_CLOAK_TIMEZONE || siteConfig.cloak_timezone) options.timezone = process.env.SIGNMATE_CLOAK_TIMEZONE || siteConfig.cloak_timezone;
  return options;
}

export async function launchBrowser({ chromium, siteConfig = {}, launchOptions = {} } = {}) {
  if (shouldUseCloakBrowser(siteConfig)) {
    const cloak = await import("cloakbrowser");
    return cloak.launch(buildCloakLaunchOptions({ ...launchOptions, siteConfig }));
  }
  return chromium.launch(launchOptions);
}
