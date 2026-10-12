// Explicit integration check for a disposable container, never production.
import assert from "node:assert/strict";
import { writeFileSync, readFileSync, mkdirSync } from "node:fs";
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
writeFileSync("config/sites.yaml", "sites:\n  fixture:\n    driver: fixture\n    note: Integration Fixture\n    enabled: true\n    proxy: off\n    base_url: https://fixture.invalid\n  linux-sb:\n    enabled: true\n  sb-sb:\n    enabled: true\n  audiences-me:\n    enabled: true\n");
writeFileSync("config/secrets.yaml", "fixture:\n  cookie: fixture=local\nlinux-sb:\n  cookie: fixture=local\nsb-sb:\n  cookie: fixture=local\naudiences-me:\n  cookie: fixture=local\n");
const store = await import("../src/store.js");
for (const [key, details] of [
  ["linux-sb", { username: "LinuxFixture", totalPoints: 900, totalCoins: 0 }],
  ["sb-sb", { username: "ForumFixture", levelTitle: "Lv.1 初来乍到", totalCoins: 1056, totalExp: 28, joinDays: 52, postCount: 0, bankBalance: 0, gameCoins: 0, featuredCount: 0, followingCount: 0, followersCount: 0 }],
  ["fixture", { username: "PrivateFixture", email: "private@example.invalid", totalPoints: 100, totalDays: 7, totalExp: 55, userGroup: "会员", customMetric: 99 }],
  ["audiences-me", { username: "PrivatePT", bonus: "1234.5", ratio: "2.5", upload: "1 TB", download: "400 GB", invite: 3 }],
]) await store.addEntry(key, { siteKey: key, kind: "visit", success: true, message: key === "fixture" ? "PrivateFixture private@example.invalid 保活成功" : "保活成功", details });
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
    for (const key of ["linux-sb", "sb-sb", "fixture", "audiences-me"]) {
      const card = page.locator(`#card-${key}`);
      const metrics = await card.locator(".aggregate-metrics").innerText();
      assert.doesNotMatch(await card.innerHTML(), /LinuxFixture|ForumFixture|PrivateFixture|PrivatePT|private@example/);
      if (key === "linux-sb") assert.match(metrics, /烧饼 0/);
      if (key === "sb-sb") assert.match(metrics, /注册天数 52/);
      assert.equal(await card.locator(".metric-chip").count(), key === "linux-sb" ? 2 : 4);
      await card.locator(".aggregate-metrics").click();
      await page.locator("#cardMetricPicker").waitFor();
      assert.equal(await page.locator('#cardMetricPicker input:checked').count(), key === "linux-sb" ? 2 : 4);
      assert.match(await page.locator("#processModal .process-details-panel").innerText(), new RegExp(({ "linux-sb": "LinuxFixture", "sb-sb": "ForumFixture", fixture: "PrivateFixture", "audiences-me": "PrivatePT" })[key]));
      assert.equal(await page.locator("#processModal .modal-card").evaluate(el => el.scrollWidth > el.clientWidth + 1), false);
      await page.locator("#processModalClose").click();
      assert.equal(await card.evaluate(el => {
        const box = el.getBoundingClientRect();
        return [...el.querySelectorAll(".aggregate-metrics,.metric-chip,.site-card-schedule,.site-card-actions")].some(item => {
          const r = item.getBoundingClientRect();
          return r.bottom > box.bottom || r.right > box.right || r.left < box.left || item.scrollWidth > item.clientWidth + 1;
        });
      }), false, `${key} overflow at ${width}`);
    }
  }
  // Old records have no steps, yet both pointer and keyboard must open the dialog.
  await page.locator("#card-sb-sb .aggregate-metrics").focus();
  await page.keyboard.press("Enter");
  const picker = page.locator("#cardMetricPicker");
  assert.equal(await picker.locator('input[value="username"]').isDisabled(), true);
  await picker.locator('input[value="levelTitle"]').uncheck();
  assert.equal(await picker.locator('button[type="submit"]').isDisabled(), false);
  await picker.locator('input[value="username"]').check();
  const saved = page.waitForResponse(r => r.url().endsWith('/sb-sb/card-metrics') && r.request().method() === 'POST');
  await picker.locator('button[type="submit"]').click();
  assert.equal((await saved).status(), 200);
  await page.getByText("已保存，卡片展示已更新", { exact: true }).waitFor();
  await page.locator("#processModalClose").click();
  await page.reload();
  await page.locator("#card-sb-sb").waitFor();
  assert.match(await page.locator("#card-sb-sb .aggregate-metrics").innerText(), /ForumFixture/);
  assert.doesNotMatch(await page.locator("#card-sb-sb .aggregate-metrics").innerText(), /初来乍到/);
  const another = await browser.newPage();
  await another.goto(base);
  await another.locator("#card-sb-sb").waitFor();
  assert.match(await another.locator("#card-sb-sb .aggregate-metrics").innerText(), /ForumFixture/);
  await another.close();
  await page.locator("#card-sb-sb .aggregate-metrics").click();
  assert.match(await page.locator("#processModal .process-details-panel").innerText(), /初来乍到/);
  assert.equal(await page.locator('#cardMetricPicker input[value="featuredCount"]').count(), 1);
  const before = readFileSync("config/sites.yaml", "utf8");
  for (const metrics of [["username", "username"], ["cookie"], ["username", "totalCoins", "totalExp", "postCount", "joinDays"], "username"]) {
    const response = await fetch(`${base}/api/sites/sb-sb/card-metrics`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ metrics }) });
    assert.equal(response.status, 400);
  }
  assert.equal(readFileSync("config/sites.yaml", "utf8"), before);
  await page.locator("#processModalClose").click();
  // A custom signin site and a PT site use the same persistent selection API.
  for (const [key, selected] of [["fixture", ["customMetric", "totalPoints"]], ["audiences-me", ["invite", "ratio"]], ["linux-sb", []]]) {
    const response = await fetch(`${base}/api/sites/${key}/card-metrics`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ metrics: selected }) });
    assert.equal(response.status, 200);
    const state = await fetch(`${base}/api/sites`).then(r => r.json());
    assert.deepEqual(state.data.find(site => site.key === key).cardMetrics, selected);
  }
  await page.reload();
  await page.locator("#card-fixture").waitFor();
  assert.match(await page.locator("#card-fixture .aggregate-metrics").innerText(), /customMetric 99/);
  assert.match(await page.locator("#card-audiences-me .aggregate-metrics").innerText(), /邀请 3/);
  assert.equal(await page.locator("#card-linux-sb .metric-chip").count(), 0);
  await page.locator("#card-linux-sb .aggregate-metrics").click();
  await page.locator("#cardMetricPicker").waitFor();
  assert.deepEqual(errors, []);
  console.log("[check:service] health, API and browser UI passed");
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
