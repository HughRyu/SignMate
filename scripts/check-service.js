// Explicit integration check for a disposable container, never production.
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync } from "node:fs";
if (process.env.SIGNMATE_ISOLATED_TEST !== "true") throw new Error("Run only in a disposable test container");
process.env.WEB_PORT = "0";
process.env.SIGNMATE_AUTH_DISABLED = "true";
mkdirSync("config", { recursive: true });
writeFileSync("config/sites.yaml", "sites:\n  fixture:\n    driver: fixture\n    note: Integration Fixture\n    enabled: true\n    proxy: off\n    base_url: https://fixture.invalid\n");
writeFileSync("config/secrets.yaml", "fixture:\n  cookie: fixture=local\n");
const { runtimeState } = await import("../src/utils/runtime-state.js");
const { credentialGeneration } = await import("../src/utils/session-verification.js");
runtimeState.update("verification", "fixture", { generation: credentialGeneration({ cookie: "fixture=local" }), status: "verified" });
runtimeState.update("runs", "fixture", { consecutiveFailures: 3 });
runtimeState.update("notifications", "latest", { ok: false });
const { startServer } = await import("../src/server.js");
writeFileSync("config/sites.yaml", "sites:\n  fixture:\n    driver: fixture\n    note: Integration Fixture\n    enabled: true\n    proxy: off\n    base_url: https://fixture.invalid\n  linux-sb:\n    enabled: true\n  sb-sb:\n    enabled: true\n");
writeFileSync("config/secrets.yaml", "fixture:\n  cookie: fixture=local\nlinux-sb:\n  cookie: fixture=local\nsb-sb:\n  cookie: fixture=local\n");
const store = await import("../src/store.js");
for (const [key, details] of [
  ["linux-sb", { username: "LinuxFixture", totalPoints: 900, totalCoins: 0 }],
  ["sb-sb", { username: "ForumFixture", levelTitle: "Lv.1 初来乍到", totalCoins: 1056, totalExp: 28, joinDays: 52, postCount: 0, bankBalance: 0, gameCoins: 0 }],
]) await store.addEntry(key, { siteKey: key, kind: "visit", success: true, message: "保活成功", details });
const server = await startServer();
const base = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  const health = await fetch(`${base}/api/health`).then(response => response.json());
  assert.equal(health.ok, true);
  assert.equal(health.browserOk, true);
  const sites = await fetch(`${base}/api/sites`).then(response => response.json());
  assert.equal(sites.data[0].verification.status, "verified");
  assert.equal(sites.notificationHealth.ok, false);
  const { chromium } = await import("playwright-core");
  const { resolveChromiumExecutablePath } = await import("../src/utils/browser.js");
  browser = await chromium.launch({ executablePath: await resolveChromiumExecutablePath(chromium), headless: true, args: ["--no-sandbox"] });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(base);
  await page.locator("#card-fixture").waitFor();
  const card = await page.locator("#card-fixture").innerText();
  assert.match(card, /已验证/);
  assert.match(card, /连续失败 3 次/);
  assert.match(await page.locator("#sitesSummary").innerText(), /通知发送失败/);
  for (const width of [1366, 1024, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const key of ["linux-sb", "sb-sb"]) {
      const card = page.locator(`#card-${key}`);
      const metrics = await card.locator(".aggregate-metrics").innerText();
      assert.match(metrics, key === "linux-sb" ? /LinuxFixture/ : /ForumFixture/);
      assert.match(metrics, key === "linux-sb" ? /烧饼 0/ : /注册天数 52/);
      assert.equal(await card.evaluate(el => {
        const box = el.getBoundingClientRect();
        return [...el.querySelectorAll(".aggregate-metrics,.metric-chip,.site-card-schedule,.site-card-actions")].some(item => {
          const r = item.getBoundingClientRect();
          return r.bottom > box.bottom || r.right > box.right || r.left < box.left || item.scrollWidth > item.clientWidth + 1;
        });
      }), false, `${key} overflow at ${width}`);
    }
  }
  assert.deepEqual(errors, []);
  console.log("[check:service] health, API and browser UI passed");
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
