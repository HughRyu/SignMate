// ============================================================
// v2ex — V2EX Daily Missions Driver
//
// Flow:
// 1. Inject cookies maintained from Web UI
// 2. Open /mission/daily with Playwright
// 3. If already redeemed, treat as success
// 4. Otherwise find /mission/daily/redeem?once=... and open it
// ============================================================

import BaseDriver from "./base.js";
import logger from "../utils/logger.js";

function normalizeCookieHeader(value = "") {
  return String(value || "")
    .trim()
    .split(/[\r\n]+/)
    .map(part => part.trim().replace(/;+$/, ""))
    .filter(Boolean)
    .join("; ");
}

function cookieFromLineFormat(value = "") {
  return String(value || "")
    .trim()
    .split(/[\r\n]+/)
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => line.replace(/;+$/, ""))
    .join("; ");
}

function parseCookieHeader(header, domain = ".v2ex.com") {
  return normalizeCookieHeader(header)
    .split(";")
    .map(part => part.trim())
    .filter(Boolean)
    .map(part => {
      const eq = part.indexOf("=");
      if (eq < 0) return null;
      const name = part.slice(0, eq).trim();
      let value = part.slice(eq + 1).trim();
      value = value.replace(/^"|"$/g, "");
      if (!name) return null;
      return { name, value, domain, path: "/", secure: true, httpOnly: false, sameSite: "Lax" };
    })
    .filter(Boolean);
}

function formatSignTime(date = new Date()) {
  return date.toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai",
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function includesLogin(body = "") {
  return /Sign Out|Settings|Notes|Planet/i.test(body);
}

function alreadyRedeemed(body = "") {
  return /already redeemed|已领取|每日登录奖励已领取|Daily login reward already redeemed/i.test(body);
}

function extractCoinStats(text = "") {
  const normalized = String(text || "").replace(/\s+/g, " ");
  const pick = (...patterns) => {
    for (const pattern of patterns) {
      const match = normalized.match(pattern);
      const num = match ? Number.parseInt(match[1], 10) : NaN;
      if (Number.isFinite(num)) return num;
    }
    return null;
  };
  return {
    rewardCopper: pick(/(?:获得|奖励|received|reward)\s*(\d+)\s*(?:铜币|bronze)/i, /(\d+)\s*(?:铜币|bronze)\s*(?:奖励|reward)/i),
    totalGold: pick(/金币[:：]?\s*(\d+)/, /(\d+)\s*(?:金币|gold)/i),
    totalSilver: pick(/银币[:：]?\s*(\d+)/, /(\d+)\s*(?:银币|silver)/i),
    totalCopper: pick(/铜币[:：]?\s*(\d+)/, /(\d+)\s*(?:铜币|bronze)/i),
  };
}


function todayV2EXDate() {
  return new Date().toLocaleDateString("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).replace(/\//g, "");
}

async function readBalanceStats(page, origin, timeout = 60_000) {
  try {
    await page.goto(`${origin}/balance`, { waitUntil: "domcontentloaded", timeout });
    await page.waitForTimeout(1200);
    return await page.evaluate((today) => {
      const toInt = value => {
        const cleaned = String(value ?? "").trim().replace(/[^0-9.\-]/g, "");
        if (!cleaned) return null;
        const n = Number.parseFloat(cleaned);
        return Number.isFinite(n) ? Math.trunc(n) : null;
      };
      const stats = {};
      const balance = document.querySelector(".balance_area");
      if (balance) {
        const html = balance.innerHTML;
        const g = html.match(/(\d+)\s*<img[^>]+alt=["']G["']/i);
        const s = html.match(/(\d+)\s*<img[^>]+alt=["']S["']/i);
        const b = html.match(/(\d+)\s*<img[^>]+alt=["']B["']/i);
        const nums = balance.innerText.match(/\d+/g) || [];
        stats.totalGold = toInt(g?.[1] ?? nums[0]);
        stats.totalSilver = toInt(s?.[1] ?? nums[1]);
        stats.totalCopper = toInt(b?.[1] ?? nums[2]);
      }
      const rows = Array.from(document.querySelectorAll("table.data tr"));
      const loginRow = rows.map(row => row.innerText.replace(/\s+/g, " ").trim())
        .find(text => text.includes(today) && /每日登录奖励/.test(text));
      const reward = loginRow?.match(/每日登录奖励\s+([0-9]+(?:\.0)?)/)?.[1]
        || loginRow?.match(/每日登录奖励\s*(\d+)\s*铜币/)?.[1]
        || loginRow?.match(/奖励\s*(\d+)\s*铜币/)?.[1];
      stats.rewardCopper = toInt(reward);
      return stats;
    }, todayV2EXDate());
  } catch (err) {
    logger.warn(`[V2EX] 读取账户余额失败: ${err.message}`);
    return {};
  }
}

function mergeCoinStats(...items) {
  return Object.assign({}, ...items.filter(Boolean).map(item => Object.fromEntries(Object.entries(item).filter(([, value]) => Number.isFinite(value)))));
}

function coinMessage(stats = {}) {
  const parts = [];
  if (Number.isFinite(stats.rewardCopper)) parts.push(`奖励 ${stats.rewardCopper} 个铜币`);
  const totals = [];
  if (Number.isFinite(stats.totalGold)) totals.push(`金币 ${stats.totalGold}`);
  if (Number.isFinite(stats.totalSilver)) totals.push(`银币 ${stats.totalSilver}`);
  if (Number.isFinite(stats.totalCopper)) totals.push(`铜币 ${stats.totalCopper}`);
  if (totals.length) parts.push(totals.join(" / "));
  return parts.join("；");
}

export default class V2EXDriver extends BaseDriver {
  getCookie() {
    const secrets = this.secrets?.v2ex || {};
    const cookie = normalizeCookieHeader(secrets.cookie || cookieFromLineFormat(secrets.session_only || ""));
    if (!cookie || cookie.includes("<YOUR_")) return "";
    if (/[^\x00-\xff]/.test(cookie)) {
      throw new Error("Cookie 含非法字符，请重新从浏览器复制原始 Cookie");
    }
    return cookie;
  }

  async signIn() {
    const { chromium } = await import("playwright-core");
    const {
      base_url = "https://www.v2ex.com",
      timeout = 60_000,
      proxy_url,
      chromium_executable_path = process.env.CHROMIUM_PATH || process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || "/ms-playwright/chromium-1200/chrome-linux64/chrome",
    } = this.siteConfig;

    const cookie = this.getCookie();
    if (!cookie) return { success: false, message: "⚠️ Cookie 未配置，请点击「维护 Cookie」填写" };

    const origin = (base_url || "https://www.v2ex.com").replace(/\/$/, "");
    const proxy = proxy_url ? { server: proxy_url } : undefined;
    const signTime = formatSignTime();

    logger.info(`[V2EX] 步骤 1/5：启动 Playwright 浏览器${proxy_url ? `，代理: ${proxy_url}` : ""}`);
    const browser = await chromium.launch({
      executablePath: chromium_executable_path,
      headless: true,
      proxy,
      args: ["--disable-blink-features=AutomationControlled", "--no-sandbox"],
      timeout,
    });

    try {
      const context = await browser.newContext({
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
        locale: "zh-CN",
        timezoneId: "Asia/Shanghai",
        viewport: { width: 1440, height: 1000 },
        extraHTTPHeaders: { "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8" },
      });

      logger.info("[V2EX] 步骤 2/5：注入 Cookie，准备浏览器上下文");
      await context.addCookies(parseCookieHeader(cookie));
      const page = await context.newPage();

      const dailyUrl = `${origin}/mission/daily`;
      logger.info(`[V2EX] 步骤 3/5：打开每日任务页面 → ${dailyUrl}`);
      const daily = await page.goto(dailyUrl, { waitUntil: "domcontentloaded", timeout });
      await page.waitForTimeout(this.siteConfig.playwright_wait_ms || 2500);

      const title = await page.title().catch(() => "");
      const bodyText = await page.locator("body").innerText({ timeout: 5000 }).catch(() => "");
      const preview = bodyText.replace(/\s+/g, " ").slice(0, 220);
      logger.info(`[V2EX] 步骤 4/5：页面状态 ${daily?.status() || "unknown"} | ${title} | ${preview}`);

      if (!includesLogin(bodyText)) {
        return {
          success: false,
          message: "V2EX 登录态无效或 Cookie 不完整，请重新维护 Cookie",
          details: { signTime, pageTitle: title },
          steps: [
            { label: "启动 Playwright 浏览器", ok: true },
            { label: "注入 Cookie 并准备浏览器上下文", ok: true },
            { label: "打开 V2EX 每日任务页面", ok: false, status: daily?.status() || null, detail: "未识别到登录状态" },
          ],
        };
      }

      if (alreadyRedeemed(bodyText)) {
        const coinStats = mergeCoinStats(extractCoinStats(bodyText), await readBalanceStats(page, origin, timeout));
        const extra = coinMessage(coinStats);
        const message = `今天已完成签到${extra ? `；${extra}` : ""}；签到时间：${signTime}`;
        return {
          success: true,
          message,
          details: { signTime, alreadySigned: true, ...coinStats, pageTitle: title },
          steps: [
            { label: "启动 Playwright 浏览器", ok: true },
            { label: "注入 Cookie 并准备浏览器上下文", ok: true },
            { label: "打开 V2EX 每日任务页面", ok: true, status: daily?.status() || null },
            { label: "读取签到状态", ok: true, detail: `页面显示 Daily login reward already redeemed${extra ? `；${extra}` : ""}` },
          ],
        };
      }

      logger.info("[V2EX] 步骤 5/5：查找并访问领取奖励链接");
      const redeemHref = await page.$$eval("a", links => {
        const hit = links.find(a => /mission\/daily\/redeem/i.test(a.href) || /领取|redeem/i.test(a.textContent || ""));
        return hit?.href || "";
      });

      if (!redeemHref) {
        return {
          success: false,
          message: "未找到 V2EX 每日奖励领取链接，可能页面结构变化或已无可领取奖励",
          details: { signTime, pageTitle: title },
          steps: [
            { label: "启动 Playwright 浏览器", ok: true },
            { label: "注入 Cookie 并准备浏览器上下文", ok: true },
            { label: "打开 V2EX 每日任务页面", ok: true, status: daily?.status() || null },
            { label: "查找领取链接", ok: false, detail: preview },
          ],
        };
      }

      const redeem = await page.goto(redeemHref, { waitUntil: "domcontentloaded", timeout });
      await page.waitForTimeout(2000);
      const finalText = await page.locator("body").innerText({ timeout: 5000 }).catch(() => "");
      const finalPreview = finalText.replace(/\s+/g, " ").slice(0, 220);
      const coinStats = mergeCoinStats(extractCoinStats(bodyText), extractCoinStats(finalText), await readBalanceStats(page, origin, timeout));
      const extra = coinMessage(coinStats);
      const ok = redeem?.status() && redeem.status() < 400;
      const message = ok ? `签到成功${extra ? `；${extra}` : ""}；签到时间：${signTime}` : `签到失败 HTTP ${redeem?.status() || "unknown"}`;

      return {
        success: Boolean(ok),
        message,
        raw: finalPreview,
        details: { signTime, ...coinStats, pageTitle: await page.title().catch(() => title) },
        steps: [
          { label: "启动 Playwright 浏览器", ok: true },
          { label: "注入 Cookie 并准备浏览器上下文", ok: true },
          { label: "打开 V2EX 每日任务页面", ok: true, status: daily?.status() || null },
          { label: "找到领取奖励链接", ok: true, detail: redeemHref },
          { label: "访问领取链接", ok: Boolean(ok), status: redeem?.status() || null, detail: `${finalPreview}${extra ? `；${extra}` : ""}` },
        ],
      };
    } finally {
      await browser.close().catch(() => {});
    }
  }

  formatResult(result) {
    const icon = result.success ? "✅" : "❌";
    return `${icon} V2EX 签到\n📝 ${result.message}`;
  }
}
