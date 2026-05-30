// ============================================================
// chiphell — Chiphell logged-in homepage visit driver
//
// 一日游保活：使用 Cookie 打开 Chiphell 首页，抓取用户名、积分、用户组。
// 三项都抓到才认为访问正确。
// ============================================================

import BaseDriver from "./base.js";
import logger from "../utils/logger.js";
import { resolveChromiumExecutablePath } from "../utils/browser.js";
import { wantsHttpMode, allowsHttpFallback, runSiteHttp } from "../utils/site-http.js";

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
      return { name, value, domain, path: "/", secure: false, httpOnly: false, sameSite: "Lax" };
    })
    .filter(Boolean);
}

function cookieDomainFromUrl(url) {
  const hostname = new URL(url).hostname;
  return hostname.startsWith("www.") ? `.${hostname.slice(4)}` : `.${hostname}`;
}

function formatTime(date = new Date()) {
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

export default class ChiphellDriver extends BaseDriver {
  getCookie() {
    const key = this.siteConfig.key || "chiphell-com";
    const secrets = this.secrets?.[key] || this.secrets?.chiphell || {};
    const cookie = normalizeCookieHeader(secrets.cookie || "");
    if (!cookie || cookie.includes("<YOUR_")) return "";
    if (/[^\x00-\xff]/.test(cookie)) throw new Error("Cookie 含非法字符，请重新从浏览器复制原始 Cookie");
    return cookie;
  }

  async signIn() {
    if (wantsHttpMode(this.siteConfig)) {
      const httpResult = await runSiteHttp(this.siteConfig, this.secrets, "chiphell");
      if (httpResult.success || !allowsHttpFallback(this.siteConfig)) return httpResult;
      logger.warn(`[${this.siteConfig.note || "chiphell"}] HTTP/API-first 失败，回退 Playwright：${httpResult.message}`);
    }
    const { chromium } = await import("playwright-core");
    const {
      base_url = "https://www.chiphell.com/forum.php",
      timeout = 30_000,
      proxy_url,
      chromium_executable_path = await resolveChromiumExecutablePath(chromium),
    } = this.siteConfig;

    const url = base_url.replace(/\/$/, "");
    const visitTime = formatTime();
    const cookie = this.getCookie();
    const proxy = proxy_url ? { server: proxy_url } : undefined;

    logger.info(`[Chiphell] 步骤 1/5：启动 Playwright 浏览器${proxy_url ? `，代理: ${proxy_url}` : ""}`);
    const browser = await chromium.launch({ executablePath: chromium_executable_path, headless: true, proxy, args: ["--no-sandbox"], timeout });
    try {
      const context = await browser.newContext({
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
        locale: "zh-CN",
        timezoneId: "Asia/Shanghai",
        viewport: { width: 1440, height: 1000 },
      });

      if (cookie) {
        logger.info("[Chiphell] 步骤 2/5：注入 Cookie");
        await context.addCookies(parseCookieHeader(cookie, cookieDomainFromUrl(url)));
      } else {
        logger.info("[Chiphell] 步骤 2/5：未配置 Cookie");
      }

      const page = await context.newPage();
      logger.info(`[Chiphell] 步骤 3/5：打开首页 → ${url}`);
      const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout });
      await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
      await page.waitForTimeout(this.siteConfig.playwright_wait_ms || 1500);

      const status = response?.status() || 0;
      const title = await page.title().catch(() => "");
      logger.info(`[Chiphell] 步骤 4/5：页面状态 ${status} | ${title}`);

      const profile = await page.evaluate(() => {
        const text = document.body?.innerText || "";
        const links = [...document.querySelectorAll("a")].map(a => a.innerText.trim()).filter(Boolean);
        let username = "";
        const myIndex = links.findIndex(x => x === "我的");
        if (myIndex > 0) username = links[myIndex - 1] || "";
        if (!username || /消息|帖子|收藏|好友/.test(username)) {
          username = text.match(/\n([^\n|]{2,40})\n\|我的/)?.[1]?.trim() || "";
        }
        const points = text.match(/积分\s*[:：]\s*([0-9]+)/)?.[1] || "";
        const userGroup = text.match(/用户组\s*[:：]\s*([^\n|]+)/)?.[1]?.trim() || "";
        const loggedIn = /\|退出|安全中心|提醒/.test(text) && !!username;
        return { username, points, userGroup, loggedIn };
      });

      const ok = status >= 200 && status < 400 && !!profile.username && !!profile.points && !!profile.userGroup;
      logger.info(`[Chiphell] 步骤 5/5：读取账号信息 ${profile.username || "-"} / 积分 ${profile.points || "-"} / 用户组 ${profile.userGroup || "-"}`);

      return {
        success: ok,
        message: ok
          ? `访问完成；用户名 ${profile.username}；积分 ${profile.points}${profile.todayPoints ? `；今日积分 +${profile.todayPoints}` : ""}；用户组 ${profile.userGroup}；访问时间：${visitTime}`
          : `访问失败：未能完整读取用户名、积分、用户组${status ? `（HTTP ${status}）` : ""}`,
        details: { ...profile, visitTime, pageTitle: title, status },
        steps: [
          { label: "启动 Playwright 浏览器", ok: true },
          { label: cookie ? "注入 Cookie" : "检查 Cookie 配置", ok: !!cookie, detail: cookie ? "已注入" : "未配置 Cookie" },
          { label: "打开 Chiphell 首页", ok: status >= 200 && status < 400, status, detail: url },
          { label: "确认登录态", ok: !!profile.loggedIn, detail: profile.loggedIn ? "页面包含用户菜单与退出入口" : "未识别到登录菜单" },
          { label: "读取账号信息", ok, detail: `用户名 ${profile.username || "-"}；积分 ${profile.points || "-"}${profile.todayPoints ? `；今日积分 +${profile.todayPoints}` : ""}；用户组 ${profile.userGroup || "-"}` },
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
