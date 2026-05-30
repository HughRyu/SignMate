// ============================================================
// right — 恩山无线论坛 Daily Sign Driver
//
// Sign page: /forum/erling_qd-sign_in.html
// AJAX API : /forum/plugin.php?id=erling_qd:action&action=sign
// payload  : formhash=<FORMHASH>
// ============================================================

import BaseDriver from "./base.js";
import logger from "../utils/logger.js";
import { resolveChromiumExecutablePath } from "../utils/browser.js";
import { wantsHttpMode, allowsHttpFallback, runDiscuzHttp } from "../utils/discuz-http.js";

function normalizeCookieHeader(value = "") {
  return String(value || "")
    .trim()
    .split(/[\r\n]+/)
    .map(part => part.trim().replace(/;+$/, ""))
    .filter(Boolean)
    .join("; ");
}

function parseCookieHeader(header, domain = ".right.com.cn") {
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
  return /HughRyu|退出|我的|设置|消息|提醒|积分/.test(text) && !/立即登录|用户登录/.test(text.slice(0, 600));
}

function alreadySigned(text = "") {
  return /已签到|今日已签|今天已签|已完成签到|连续签到|签到记录|明天再来/.test(text);
}

function extractReward(text = "") {
  const normalized = String(text || "").replace(/\s+/g, " ");
  const patterns = [
    /(?:奖励|获得|得到)\s*(\d+)\s*(积分|金币|经验|威望)/,
    /(\d+)\s*(积分|金币|经验|威望)/,
  ];
  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (match) return `${match[1]} ${match[2]}`;
  }
  return "";
}

function normalizeSignStats(stats = {}) {
  const out = { ...stats };
  // 恩山 erling_qd 插件签到 AJAX 后页面常保留默认占位值（连续 0 / 总 2），
  // 但签到前已签到页能读到真实值。遇到占位值时，不覆盖历史里的可信值。
  if (out.streakDays === 0 && out.totalDays === 2 && !out.alreadySigned) {
    out.streakDays = null;
    out.totalDays = null;
  }
  return out;
}

async function readSignStats(page, fallbackText = "") {
  const parsed = await page.evaluate(() => {
    const numberFrom = (selector) => {
      const text = document.querySelector(selector)?.textContent || document.querySelector(selector)?.getAttribute("value") || "";
      const num = Number.parseInt(String(text).replace(/[^0-9-]/g, ""), 10);
      return Number.isFinite(num) ? num : null;
    };
    const text = document.body.innerText.replace(/\s+/g, " ");
    const matchNumber = (regex) => {
      const hit = text.match(regex);
      const num = hit ? Number.parseInt(hit[1], 10) : NaN;
      return Number.isFinite(num) ? num : null;
    };
    const already = /已签到|今日已签|今天已签|已完成签到|明天再来/.test(text);
    return {
      alreadySigned: already,
      rewardPoints: numberFrom(".erqd-current-point") ?? matchNumber(/今日积分[:：]\s*(\d+)/),
      streakDays: numberFrom(".erqd-continuous-days") ?? matchNumber(/连续签到[:：]\s*(\d+)\s*天/),
      totalDays: numberFrom(".erqd-total-days") ?? matchNumber(/总签到天数[:：]\s*(\d+)\s*天/),
      totalPoints: matchNumber(/积分[:：]\s*(\d+)/),
    };
  }).catch(() => {
    const text = String(fallbackText || "").replace(/\s+/g, " ");
    const pick = (regex) => {
      const hit = text.match(regex);
      const num = hit ? Number.parseInt(hit[1], 10) : NaN;
      return Number.isFinite(num) ? num : null;
    };
    return {
      alreadySigned: /已签到|今日已签|今天已签|已完成签到|明天再来/.test(text),
      rewardPoints: pick(/今日积分[:：]\s*(\d+)/),
      streakDays: pick(/连续签到[:：]\s*(\d+)\s*天/),
      totalDays: pick(/总签到天数[:：]\s*(\d+)\s*天/),
      totalPoints: pick(/积分[:：]\s*(\d+)/),
    };
  });
  return normalizeSignStats(parsed);
}

function appendStatsMessage(message, stats = {}) {
  const parts = [message];
  if (Number.isFinite(stats.rewardPoints)) parts.push(`今日积分 ${stats.rewardPoints}`);
  if (Number.isFinite(stats.streakDays)) parts.push(`连续签到 ${stats.streakDays} 天`);
  if (Number.isFinite(stats.totalDays)) parts.push(`总签到 ${stats.totalDays} 天`);
  return parts.join("；");
}

export default class RightDriver extends BaseDriver {
  getCookie() {
    const secrets = this.secrets?.right || {};
    const cookie = normalizeCookieHeader(secrets.cookie || "");
    if (!cookie || cookie.includes("<YOUR_")) return "";
    if (/[^\x00-\xff]/.test(cookie)) {
      throw new Error("Cookie 含非法字符，请重新从浏览器复制原始 Cookie");
    }
    return cookie;
  }

  async signIn() {
    if (wantsHttpMode(this.siteConfig)) {
      const httpResult = await runDiscuzHttp(this.siteConfig, this.secrets, "right");
      if (httpResult.success || !allowsHttpFallback(this.siteConfig)) return httpResult;
      logger.warn(`[${this.siteConfig.note || "right"}] HTTP/API-first 失败，回退 Playwright：${httpResult.message}`);
    }
    const { chromium } = await import("playwright-core");
    const {
      base_url = "https://www.right.com.cn/forum",
      timeout = 60_000,
      proxy_url,
      chromium_executable_path = await resolveChromiumExecutablePath(chromium),
    } = this.siteConfig;

    const cookie = this.getCookie();
    if (!cookie) return { success: false, message: "⚠️ Cookie 未配置，请点击「维护 Cookie」填写" };

    const origin = (base_url || "https://www.right.com.cn/forum").replace(/\/$/, "");
    const proxy = proxy_url ? { server: proxy_url } : undefined;
    const signTime = formatSignTime();

    logger.info(`[恩山无线论坛] 步骤 1/5：启动 Playwright 浏览器${proxy_url ? `，代理: ${proxy_url}` : ""}`);
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

      logger.info("[恩山无线论坛] 步骤 2/5：注入 Cookie，准备浏览器上下文");
      await context.addCookies(parseCookieHeader(cookie));
      const page = await context.newPage();

      const signPageUrl = `${origin}/erling_qd-sign_in.html`;
      logger.info(`[恩山无线论坛] 步骤 3/5：打开签到页面 → ${signPageUrl}`);
      const signPage = await page.goto(signPageUrl, { waitUntil: "domcontentloaded", timeout });
      await page.waitForTimeout(this.siteConfig.playwright_wait_ms || 2500);

      const title = await page.title().catch(() => "");
      const bodyText = await page.locator("body").innerText({ timeout: 5000 }).catch(() => "");
      const preview = bodyText.replace(/\s+/g, " ").slice(0, 260);
      logger.info(`[恩山无线论坛] 步骤 4/5：页面状态 ${signPage?.status() || "unknown"} | ${title} | ${preview}`);

      if (!isLoggedIn(bodyText)) {
        return {
          success: false,
          message: "恩山无线论坛登录态无效或 Cookie 不完整，请重新维护 Cookie",
          details: { signTime, pageTitle: title },
          steps: [
            { label: "启动 Playwright 浏览器", ok: true },
            { label: "注入 Cookie 并准备浏览器上下文", ok: true },
            { label: "打开恩山签到页面", ok: false, status: signPage?.status() || null, detail: "未识别到登录状态" },
          ],
        };
      }

      if (alreadySigned(bodyText) && !/signin-btn|签到中|立即签到/.test(bodyText)) {
        const stats = await readSignStats(page, bodyText);
        const reward = extractReward(bodyText) || (Number.isFinite(stats.rewardPoints) ? `${stats.rewardPoints} 积分` : "");
        return {
          success: true,
          message: `${appendStatsMessage(`今天已完成签到${reward ? `，奖励 ${reward}` : ""}`, stats)}；签到时间：${signTime}`,
          details: { signTime, alreadySigned: true, reward, rewardPoints: stats.rewardPoints, streakDays: stats.streakDays, totalDays: stats.totalDays, totalPoints: stats.totalPoints, pageTitle: title },
          steps: [
            { label: "启动 Playwright 浏览器", ok: true },
            { label: "注入 Cookie 并准备浏览器上下文", ok: true },
            { label: "打开恩山签到页面", ok: true, status: signPage?.status() || null },
            { label: "读取签到状态", ok: true, detail: `页面显示今天已签到${reward ? `，奖励 ${reward}` : ""}${Number.isFinite(stats.streakDays) ? `，连续 ${stats.streakDays} 天` : ""}${Number.isFinite(stats.totalDays) ? `，总 ${stats.totalDays} 天` : ""}` },
          ],
        };
      }

      logger.info("[恩山无线论坛] 步骤 5/5：提交签到 AJAX 请求");
      const result = await page.evaluate(async () => {
        const scriptText = Array.from(document.querySelectorAll("script")).map(s => s.innerText || "").join("\n");
        const formhash = window.FORMHASH || scriptText.match(/FORMHASH\s*=\s*['\"]([^'\"]+)/)?.[1] || document.querySelector('input[name="formhash"]')?.value || "";
        const params = new URLSearchParams();
        params.set("formhash", formhash);
        const res = await fetch("plugin.php?id=erling_qd:action&action=sign", {
          method: "POST",
          credentials: "include",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
            "X-Requested-With": "XMLHttpRequest",
            "Accept": "application/json, text/javascript, */*; q=0.01",
          },
          body: params.toString(),
        });
        const text = await res.text();
        let data = null;
        try { data = JSON.parse(text); } catch {}
        return { status: res.status, text: text.slice(0, 1200), data, formhash };
      });

      const responseMessage = result.data?.message || result.data?.msg || result.text || `HTTP ${result.status}`;
      const stats = await readSignStats(page, `${bodyText} ${responseMessage}`);
      const reward = extractReward(responseMessage) || extractReward(bodyText) || (Number.isFinite(stats.rewardPoints) ? `${stats.rewardPoints} 积分` : "");
      const success = result.status >= 200 && result.status < 300 && (result.data?.success === true || /成功|已签到|今日已签|今天已签/.test(responseMessage));
      return {
        success,
        message: success
          ? `${appendStatsMessage(`${/已签到|今日已签|今天已签/.test(responseMessage) ? "今天已完成签到" : "签到成功"}${reward ? `，奖励 ${reward}` : ""}`, stats)}；签到时间：${signTime}`
          : `签到失败：${responseMessage}`,
        raw: result.data || result.text,
        details: { signTime, reward, rewardPoints: stats.rewardPoints, streakDays: stats.streakDays, totalDays: stats.totalDays, totalPoints: stats.totalPoints, pageTitle: title },
        steps: [
          { label: "启动 Playwright 浏览器", ok: true },
          { label: "注入 Cookie 并准备浏览器上下文", ok: true },
          { label: "打开恩山签到页面", ok: true, status: signPage?.status() || null },
          { label: "读取 formhash", ok: Boolean(result.formhash), detail: result.formhash ? "已获取" : "未获取到 formhash" },
          { label: "提交签到 AJAX 请求", ok: success, status: result.status, detail: success ? `${responseMessage}${reward ? `；奖励 ${reward}` : ""}${Number.isFinite(stats.streakDays) ? `；连续 ${stats.streakDays} 天` : ""}${Number.isFinite(stats.totalDays) ? `；总 ${stats.totalDays} 天` : ""}` : responseMessage },
        ],
      };
    } finally {
      await browser.close().catch(() => {});
    }
  }

  formatResult(result) {
    const icon = result.success ? "✅" : "❌";
    return `${icon} 恩山无线论坛签到\n📝 ${result.message}`;
  }
}
