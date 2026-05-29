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
