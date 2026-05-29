// ============================================================
// naixi — 奶昔论坛 Daily Sign Driver
//
// Discuz k_misign plugin:
//   Sign page: /k_misign-sign.html or /plugin.php?id=k_misign:sign
//   Sign URL : /plugin.php?id=k_misign:sign&operation=qiandao&formhash=...&format=empty
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

function parseCookieHeader(header, domain = ".forum.naixi.net") {
  return normalizeCookieHeader(header)
    .split(";")
    .map(part => part.trim())
    .filter(Boolean)
    .map(part => {
      const eq = part.indexOf("=");
      if (eq < 0) return null;
      const name = part.slice(0, eq).trim();
      const value = part.slice(eq + 1).trim().replace(/^"|"$/g, "");
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

function isLoggedIn(text = "") {
  return /HughRyu|退出|个人资料|我的|积分|消息|提醒/.test(text) && !/登录|立即登录/.test(text.slice(0, 500));
}

function alreadySigned(text = "") {
  return /今天已签|已经签到|已签到|今日已签|您今天已经签到|您的签到排名|连续签到/.test(text);
}

function notSigned(text = "") {
  return /今天还没有签到|还没有签到|立即签到|点击签到/.test(text);
}

function extractReward(text = "") {
  const normalized = String(text || "").replace(/\s+/g, " ");
  const patterns = [
    /(?:奖励|获得|得到)\s*(\d+)\s*(经验|金币|积分|奶昔|威望)/,
    /(\d+)\s*(经验|金币|积分|奶昔|威望)/,
  ];
  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (match) return `${match[1]} ${match[2]}`;
  }
  return "";
}

function normalizeNumber(value) {
  const num = Number.parseInt(String(value ?? "").trim(), 10);
  return Number.isFinite(num) ? num : null;
}

async function readSignStats(page) {
  return page.evaluate(() => {
    const getValue = (selector) => document.querySelector(selector)?.getAttribute("value") || document.querySelector(selector)?.value || "";
    const toNumber = (value) => {
      const num = Number.parseInt(String(value || "").trim(), 10);
      return Number.isFinite(num) ? num : null;
    };
    return {
      rewardExp: toNumber(getValue("#lxreward")),
      streakDays: toNumber(getValue("#lxdays")),
      totalDays: toNumber(getValue("#lxtdays")),
    };
  }).catch(() => ({ rewardExp: null, streakDays: null, totalDays: null }));
}

function buildReward(stats = {}, fallbackText = "") {
  if (Number.isFinite(stats.rewardExp)) return `${stats.rewardExp} 经验`;
  return extractReward(fallbackText);
}

export default class NaixiDriver extends BaseDriver {
  getCookie() {
    const secrets = this.secrets?.naixi || {};
    const cookie = normalizeCookieHeader(secrets.cookie || "");
    if (!cookie || cookie.includes("<YOUR_")) return "";
    if (/[^\x00-\xff]/.test(cookie)) {
      throw new Error("Cookie 含非法字符，请重新从浏览器复制原始 Cookie");
    }
    return cookie;
  }

  async signIn() {
    const { chromium } = await import("playwright-core");
    const {
      base_url = "https://forum.naixi.net",
      timeout = 60_000,
      proxy_url,
      chromium_executable_path = process.env.CHROMIUM_PATH || process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || "/ms-playwright/chromium-1200/chrome-linux64/chrome",
    } = this.siteConfig;

    const cookie = this.getCookie();
    if (!cookie) return { success: false, message: "⚠️ Cookie 未配置，请点击「维护 Cookie」填写" };

    const origin = (base_url || "https://forum.naixi.net").replace(/\/$/, "");
    const proxy = proxy_url ? { server: proxy_url } : undefined;
    const signTime = formatSignTime();

    logger.info(`[奶昔论坛] 步骤 1/5：启动 Playwright 浏览器${proxy_url ? `，代理: ${proxy_url}` : ""}`);
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

      logger.info("[奶昔论坛] 步骤 2/5：注入 Cookie，准备浏览器上下文");
      await context.addCookies(parseCookieHeader(cookie));
      const page = await context.newPage();

      const signPageUrl = `${origin}/k_misign-sign.html`;
      logger.info(`[奶昔论坛] 步骤 3/5：打开签到页面 → ${signPageUrl}`);
      const signPage = await page.goto(signPageUrl, { waitUntil: "domcontentloaded", timeout });
      await page.waitForTimeout(this.siteConfig.playwright_wait_ms || 2500);

      const title = await page.title().catch(() => "");
      let bodyText = await page.locator("body").innerText({ timeout: 5000 }).catch(() => "");
      const preview = bodyText.replace(/\s+/g, " ").slice(0, 220);
      logger.info(`[奶昔论坛] 步骤 4/5：页面状态 ${signPage?.status() || "unknown"} | ${title} | ${preview}`);

      if (!isLoggedIn(bodyText)) {
        return {
          success: false,
          message: "奶昔论坛登录态无效或 Cookie 不完整，请重新维护 Cookie",
          details: { signTime, pageTitle: title },
          steps: [
            { label: "启动 Playwright 浏览器", ok: true },
            { label: "注入 Cookie 并准备浏览器上下文", ok: true },
            { label: "打开奶昔签到页面", ok: false, status: signPage?.status() || null, detail: "未识别到登录状态" },
          ],
        };
      }

      if (alreadySigned(bodyText)) {
        const stats = await readSignStats(page);
        const reward = buildReward(stats, bodyText);
        return {
          success: true,
          message: `今天已完成签到${reward ? `，奖励 ${reward}` : ""}${Number.isFinite(stats.streakDays) ? `；连续签到 ${stats.streakDays} 天` : ""}；签到时间：${signTime}`,
          details: { signTime, alreadySigned: true, reward, rewardExp: stats.rewardExp, streakDays: stats.streakDays, totalDays: stats.totalDays, pageTitle: title },
          steps: [
            { label: "启动 Playwright 浏览器", ok: true },
            { label: "注入 Cookie 并准备浏览器上下文", ok: true },
            { label: "打开奶昔签到页面", ok: true, status: signPage?.status() || null },
            { label: "读取签到状态", ok: true, detail: `页面显示今天已签到${reward ? `，奖励 ${reward}` : ""}${Number.isFinite(stats.streakDays) ? `，连续 ${stats.streakDays} 天` : ""}` },
          ],
        };
      }

      logger.info("[奶昔论坛] 步骤 5/5：查找并访问签到链接");
      const signHref = await page.$$eval("a", links => {
        const operationHit = links.find(a => /operation=qiandao/i.test(a.href));
        if (operationHit?.href) return operationHit.href;
        const textHit = links.find(a => /立即签到|点击签到/.test(a.textContent || ""));
        return textHit?.href || "";
      });

      if (!signHref) {
        return {
          success: false,
          message: "未找到奶昔论坛签到链接，可能页面结构变化或已经签到",
          details: { signTime, pageTitle: title },
          steps: [
            { label: "启动 Playwright 浏览器", ok: true },
            { label: "注入 Cookie 并准备浏览器上下文", ok: true },
            { label: "打开奶昔签到页面", ok: true, status: signPage?.status() || null },
            { label: "查找签到链接", ok: false, detail: preview },
          ],
        };
      }

      const signed = await page.goto(signHref, { waitUntil: "domcontentloaded", timeout });
      await page.waitForTimeout(2500);
      bodyText = await page.locator("body").innerText({ timeout: 5000 }).catch(() => "");
      const finalPreview = bodyText.replace(/\s+/g, " ").slice(0, 300);
      const successText = /签到成功|恭喜|获得奖励|已签到|今日已签|今天已签|您今天已经签到/.test(finalPreview);
      const stats = await readSignStats(page);
      const reward = /签到成功|恭喜|获得奖励|奖励|已签到|今日已签|今天已签/.test(finalPreview) ? buildReward(stats, bodyText) : "";
      const ok = Boolean(signed?.status() && signed.status() < 400 && successText) && !/失败|错误|请先登录|登录/.test(finalPreview);

      return {
        success: ok,
        message: ok ? `${alreadySigned(finalPreview) ? "今天已完成签到" : "签到成功"}${reward ? `，奖励 ${reward}` : ""}${Number.isFinite(stats.streakDays) ? `；连续签到 ${stats.streakDays} 天` : ""}；签到时间：${signTime}` : `签到失败：${finalPreview || `HTTP ${signed?.status() || "unknown"}`}`,
        raw: finalPreview,
        details: { signTime, reward, rewardExp: stats.rewardExp, streakDays: stats.streakDays, totalDays: stats.totalDays, pageTitle: await page.title().catch(() => title) },
        steps: [
          { label: "启动 Playwright 浏览器", ok: true },
          { label: "注入 Cookie 并准备浏览器上下文", ok: true },
          { label: "打开奶昔签到页面", ok: true, status: signPage?.status() || null, detail: notSigned(preview) ? "页面显示今天还没有签到" : preview },
          { label: "找到签到链接", ok: true, detail: signHref },
          { label: "访问签到链接", ok, status: signed?.status() || null, detail: ok ? `${finalPreview}${reward ? `；奖励 ${reward}` : ""}${Number.isFinite(stats.streakDays) ? `；连续 ${stats.streakDays} 天` : ""}` : finalPreview },
        ],
      };
    } finally {
      await browser.close().catch(() => {});
    }
  }

  formatResult(result) {
    const icon = result.success ? "✅" : "❌";
    return `${icon} 奶昔论坛签到\n📝 ${result.message}`;
  }
}
