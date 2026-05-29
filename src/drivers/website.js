// ============================================================
// website — Generic Cookie Probe Driver
//
// For sites that do not need a dedicated sign-in action.
// It verifies that the configured Cookie can open base_url and
// optionally checks for a login keyword.
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

function parseCookieHeader(header, domain) {
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

function cookieDomainFromUrl(url) {
  const hostname = new URL(url).hostname;
  return hostname.startsWith("www.") ? `.${hostname.slice(4)}` : `.${hostname}`;
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

export default class WebsiteDriver extends BaseDriver {
  getCookie() {
    const key = this.siteConfig.key || this.siteConfig.driver || "website";
    const secrets = this.secrets?.[key] || this.secrets?.[this.siteConfig.driver] || {};
    const cookie = normalizeCookieHeader(secrets.cookie || "");
    if (!cookie || cookie.includes("<YOUR_")) return "";
    if (/[^\x00-\xff]/.test(cookie)) throw new Error("Cookie 含非法字符，请重新从浏览器复制原始 Cookie");
    return cookie;
  }

  async signIn() {
    const { chromium } = await import("playwright-core");
    const {
      base_url,
      timeout = 60_000,
      proxy_url,
      login_keyword,
      chromium_executable_path = process.env.CHROMIUM_PATH || process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || "/ms-playwright/chromium-1200/chrome-linux64/chrome",
    } = this.siteConfig;
    if (!base_url) return { success: false, message: "基础 URL 未配置" };

    const signTime = formatSignTime();
    const cookie = this.getCookie();
    const url = base_url.replace(/\/$/, "");
    const proxy = proxy_url ? { server: proxy_url } : undefined;

    logger.info(`[网站探活] 步骤 1/4：启动 Playwright 浏览器${proxy_url ? `，代理: ${proxy_url}` : ""}`);
    const browser = await chromium.launch({ executablePath: chromium_executable_path, headless: true, proxy, args: ["--no-sandbox"], timeout });
    try {
      const context = await browser.newContext({
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
        locale: "zh-CN",
        timezoneId: "Asia/Shanghai",
        viewport: { width: 1440, height: 1000 },
      });
      if (cookie) {
        logger.info("[网站探活] 步骤 2/4：注入 Cookie");
        await context.addCookies(parseCookieHeader(cookie, cookieDomainFromUrl(url)));
      } else {
        logger.info("[网站探活] 步骤 2/4：未配置 Cookie，直接打开页面");
      }
      const page = await context.newPage();
      logger.info(`[网站探活] 步骤 3/4：打开站点 → ${url}`);
      const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout });
      await page.waitForTimeout(this.siteConfig.playwright_wait_ms || 1500);
      const title = await page.title().catch(() => "");
      const bodyText = await page.locator("body").innerText({ timeout: 5000 }).catch(() => "");
      const preview = bodyText.replace(/\s+/g, " ").slice(0, 220);
      const status = response?.status() || 0;
      const keywordOk = login_keyword ? bodyText.includes(login_keyword) : true;
      const ok = status >= 200 && status < 400;
      logger.info(`[网站探活] 步骤 4/4：页面状态 ${status} | ${title}`);
      return {
        success: ok,
        message: ok ? `访问完成，页面可正常打开${login_keyword && !keywordOk ? "（关键字未匹配，仅作提示）" : ""}；检查时间：${signTime}` : `访问失败：HTTP ${status}`,
        details: { signTime, pageTitle: title, status, keywordFound: keywordOk },
        steps: [
          { label: "启动 Playwright 浏览器", ok: true },
          { label: cookie ? "注入 Cookie" : "未配置 Cookie，直接打开页面", ok: true },
          { label: "打开站点", ok: status >= 200 && status < 400, status, detail: url },
          { label: login_keyword ? "关键字提示检查" : "读取页面标题", ok: true, detail: login_keyword ? `${keywordOk ? "已找到" : "未找到"}：${login_keyword}` : title || preview },
        ],
      };
    } finally {
      await browser.close().catch(() => {});
    }
  }

  formatResult(result) {
    const icon = result.success ? "✅" : "❌";
    return `${icon} ${this.name}\n📝 ${result.message}`;
  }
}
