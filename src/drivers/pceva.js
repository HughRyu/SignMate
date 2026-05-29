// ============================================================
// pceva — PCEVA DSU daily sign driver
//
// Sign page: /plugin.php?id=dsu_paulsign:sign
// Submit   : /plugin.php?id=dsu_paulsign:sign&operation=qiandao&infloat=1
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

function parseCookieHeader(header, domain = ".pceva.com.cn") {
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
  return /RyuHwang|退出|设置|提醒|积分|我的/.test(text) && !/立即登录|用户登录|登录/.test(text.slice(0, 500));
}

function numberFrom(text = "", regex) {
  const hit = String(text || "").replace(/\s+/g, " ").match(regex);
  const num = hit ? Number.parseInt(hit[1], 10) : NaN;
  return Number.isFinite(num) ? num : null;
}

function parseStats(text = "") {
  const normalized = String(text || "").replace(/\s+/g, " ");
  return {
    totalDays: numberFrom(normalized, /累计已签到[:：]\s*(\d+)\s*天/),
    monthDays: numberFrom(normalized, /本月已累计签到[:：]\s*(\d+)\s*天/),
    rewardPoints: numberFrom(normalized, /上次获得的奖励为[:：]\s*绝对值\s*(\d+)/) ?? numberFrom(normalized, /奖励[^0-9]*(\d+)/),
    totalRewardPoints: numberFrom(normalized, /总奖励为[:：]\s*绝对值\s*(\d+)/),
    totalPoints: numberFrom(normalized, /绝对值[:：]\s*(\d+)/) ?? null,
    level: normalized.match(/您目前的等级[:：]\s*(\[[^\]]+\][^,，\s]+)/)?.[1] || null,
    nextLevelDays: numberFrom(normalized, /再签到\s*(\d+)\s*天/),
  };
}

function messageFromStats(prefix, stats = {}, signTime) {
  const parts = [prefix];
  if (Number.isFinite(stats.rewardPoints)) parts.push(`奖励 ${stats.rewardPoints} 绝对值`);
  if (Number.isFinite(stats.totalRewardPoints)) parts.push(`总奖励 ${stats.totalRewardPoints}`);
  if (Number.isFinite(stats.totalPoints)) parts.push(`总积分 ${stats.totalPoints}`);
  if (Number.isFinite(stats.totalDays)) parts.push(`总签到 ${stats.totalDays} 天`);
  if (stats.level) parts.push(`等级 ${stats.level}`);
  parts.push(`签到时间：${signTime}`);
  return parts.join("；");
}

export default class PcevaDriver extends BaseDriver {
  getCookie() {
    const secrets = this.secrets?.pceva || {};
    const cookie = normalizeCookieHeader(secrets.cookie || "");
    if (!cookie || cookie.includes("<YOUR_")) return "";
    if (/[^\x00-\xff]/.test(cookie)) throw new Error("Cookie 含非法字符，请重新从浏览器复制原始 Cookie");
    return cookie;
  }

  async signIn() {
    const { chromium } = await import("playwright-core");
    const {
      base_url = "https://www.pceva.com.cn",
      timeout = 60_000,
      proxy_url,
      chromium_executable_path = process.env.CHROMIUM_PATH || process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || "/ms-playwright/chromium-1200/chrome-linux64/chrome",
    } = this.siteConfig;

    const cookie = this.getCookie();
    if (!cookie) return { success: false, message: "⚠️ Cookie 未配置，请点击「维护 Cookie」填写" };

    const origin = String(base_url || "https://www.pceva.com.cn").replace(/\/+$/, "");
    const signPageUrl = `${origin}/plugin.php?id=dsu_paulsign:sign`;
    const signTime = formatSignTime();
    const proxy = proxy_url ? { server: proxy_url } : undefined;

    logger.info(`[PCEVA] 步骤 1/5：启动 Playwright 浏览器${proxy_url ? `，代理: ${proxy_url}` : ""}`);
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

      logger.info("[PCEVA] 步骤 2/5：注入 Cookie，准备浏览器上下文");
      await context.addCookies(parseCookieHeader(cookie));
      const page = await context.newPage();

      logger.info(`[PCEVA] 步骤 3/5：打开签到页面 → ${signPageUrl}`);
      let response = await page.goto(signPageUrl, { waitUntil: "domcontentloaded", timeout });
      await page.waitForTimeout(this.siteConfig.playwright_wait_ms || 2500);
      let title = await page.title().catch(() => "");
      let bodyText = await page.locator("body").innerText({ timeout: 5000 }).catch(() => "");
      logger.info(`[PCEVA] 步骤 4/5：页面状态 ${response?.status() || "unknown"} | ${title} | ${bodyText.replace(/\s+/g, " ").slice(0, 260)}`);

      if (!isLoggedIn(bodyText)) {
        return {
          success: false,
          message: "PCEVA 登录态无效或 Cookie 不完整，请重新维护 Cookie",
          details: { signTime, pageTitle: title },
          steps: [
            { label: "启动 Playwright 浏览器", ok: true },
            { label: "注入 Cookie 并准备浏览器上下文", ok: true },
            { label: "打开 PCEVA 签到页面", ok: false, status: response?.status() || null, detail: "未识别到登录状态" },
          ],
        };
      }

      let stats = parseStats(bodyText);
      if (/今天已签到|今日已签到|【今天已签到】|已签到/.test(bodyText) && !/【今天未签到】/.test(bodyText)) {
        const creditUrl = `${origin}/home.php?mod=spacecp&ac=credit`;
        await page.goto(creditUrl, { waitUntil: "domcontentloaded", timeout }).catch(() => null);
        await page.waitForTimeout(800);
        const creditText = await page.locator("body").innerText({ timeout: 5000 }).catch(() => "");
        const creditStats = parseStats(creditText);
        if (Number.isFinite(creditStats.totalPoints)) stats.totalPoints = creditStats.totalPoints;
        return {
          success: true,
          message: messageFromStats("今天已完成签到", stats, signTime),
          details: { signTime, rewardPoints: stats.rewardPoints, totalPoints: stats.totalPoints, totalDays: stats.totalDays, pcevaLevel: stats.level, pcevaNextLevelDays: stats.nextLevelDays, pageTitle: title },
          steps: [
            { label: "启动 Playwright 浏览器", ok: true },
            { label: "注入 Cookie 并准备浏览器上下文", ok: true },
            { label: "打开 PCEVA 签到页面", ok: true, status: response?.status() || null },
            { label: "读取签到状态", ok: true, detail: `页面显示今天已签到${Number.isFinite(stats.totalDays) ? `，总 ${stats.totalDays} 天` : ""}` },
          ],
        };
      }

      logger.info("[PCEVA] 步骤 5/5：提交 DSU 签到表单");
      const submit = await page.evaluate(async () => {
        const form = document.querySelector('form[action*="dsu_paulsign"][action*="qiandao"]');
        if (!form) return { ok: false, error: "未找到签到表单" };
        const action = new URL(form.getAttribute("action"), location.href).toString();
        const formData = new FormData(form);
        if (!formData.get("qdxq")) formData.set("qdxq", "kx");
        if (!formData.get("todaysay")) formData.set("todaysay", "自动签到");
        const body = new URLSearchParams();
        for (const [k, v] of formData.entries()) body.set(k, v);
        const res = await fetch(action, {
          method: "POST",
          credentials: "include",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
            "X-Requested-With": "XMLHttpRequest",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          },
          body: body.toString(),
        });
        const text = await res.text();
        return { ok: res.ok, status: res.status, text: text.slice(0, 1600), action };
      });

      response = await page.goto(signPageUrl, { waitUntil: "domcontentloaded", timeout }).catch(() => response);
      await page.waitForTimeout(1500);
      title = await page.title().catch(() => title);
      bodyText = await page.locator("body").innerText({ timeout: 5000 }).catch(() => bodyText);
      stats = parseStats(`${submit.text || ""} ${bodyText}`);
      const creditUrl = `${origin}/home.php?mod=spacecp&ac=credit`;
      await page.goto(creditUrl, { waitUntil: "domcontentloaded", timeout }).catch(() => null);
      await page.waitForTimeout(800);
      const creditText = await page.locator("body").innerText({ timeout: 5000 }).catch(() => "");
      const creditStats = parseStats(creditText);
      if (Number.isFinite(creditStats.totalPoints)) stats.totalPoints = creditStats.totalPoints;
      const combined = `${submit.text || ""} ${bodyText}`;
      const success = submit.ok && /签到成功|已签到|今天已签到|今日已签到|签到完毕|恭喜/.test(combined) && !/未找到签到表单/.test(combined);

      return {
        success,
        message: success ? messageFromStats("签到成功", stats, signTime) : `签到失败：${submit.error || combined.replace(/\s+/g, " ").slice(0, 160)}`,
        raw: submit,
        details: { signTime, rewardPoints: stats.rewardPoints, totalPoints: stats.totalPoints, totalDays: stats.totalDays, pcevaLevel: stats.level, pcevaNextLevelDays: stats.nextLevelDays, pageTitle: title },
        steps: [
          { label: "启动 Playwright 浏览器", ok: true },
          { label: "注入 Cookie 并准备浏览器上下文", ok: true },
          { label: "打开 PCEVA 签到页面", ok: true, status: response?.status() || null },
          { label: "读取签到表单", ok: true, detail: Number.isFinite(stats.totalDays) ? `当前总签到 ${stats.totalDays} 天` : "已读取" },
          { label: "提交 DSU 签到表单", ok: success, status: submit.status || null, detail: success ? `${Number.isFinite(stats.rewardPoints) ? `奖励 ${stats.rewardPoints} 绝对值；` : ""}${Number.isFinite(stats.totalDays) ? `总 ${stats.totalDays} 天` : "签到成功"}` : (submit.error || "签到失败") },
        ],
      };
    } finally {
      await browser.close().catch(() => {});
    }
  }

  formatResult(result) {
    const icon = result.success ? "✅" : "❌";
    return `${icon} PCEVA 签到\n📝 ${result.message}`;
  }
}
