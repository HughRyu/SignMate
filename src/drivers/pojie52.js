// ============================================================
// pojie52 — 吾爱破解 52pojie Discuz daily task driver
//
// Site: https://www.52pojie.cn/
// Strategy: open Discuz task page, apply/draw daily task when available.
// ============================================================

import BaseDriver from "./base.js";
import logger from "../utils/logger.js";
import { launchBrowser, resolveChromiumExecutablePath } from "../utils/browser.js";
import { wantsHttpMode, allowsHttpFallback, runDiscuzHttp } from "../utils/discuz-http.js";
import { createHttpSession, htmlToText, readText } from "../utils/http-session.js";

function normalizeCookieHeader(value = "") {
  return String(value || "")
    .trim()
    .split(/[\r\n;]+/)
    .map(part => part.trim().replace(/;+$/, ""))
    .filter(Boolean)
    .join("; ");
}

function cookieHeaderFromCookies(cookies = []) {
  return (cookies || [])
    .filter(c => c?.name && c?.value !== undefined)
    .map(c => `${c.name}=${c.value}`)
    .join("; ");
}

function parseCookieHeader(header, domain = ".52pojie.cn") {
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
  return /HughRyu|退出|积分|消息|提醒|快捷导航|我的/.test(text) && !/登录|立即登录/.test(text.slice(0, 500));
}

function parseCredit(text = "") {
  const normalized = String(text || "").replace(/\s+/g, " ");
  const patterns = [
    /吾爱币[:：]?\s*(-?\d+)/,
    /金币[:：]?\s*(-?\d+)/,
    /CB[:：]?\s*(-?\d+)/i,
  ];
  for (const pattern of patterns) {
    const hit = normalized.match(pattern);
    if (hit) {
      const num = Number.parseInt(hit[1], 10);
      if (Number.isFinite(num)) return num;
    }
  }
  return null;
}

function parseDiscuzPoints(text = "") {
  const normalized = String(text || "").replace(/\s+/g, " ");
  const patterns = [
    /积分[:：]\s*(-?\d+)/,
    /威望[:：]\s*(-?\d+)/,
    /贡献[:：]\s*(-?\d+)/,
  ];
  for (const pattern of patterns) {
    const hit = normalized.match(pattern);
    if (hit) {
      const num = Number.parseInt(hit[1], 10);
      if (Number.isFinite(num)) return num;
    }
  }
  return null;
}

function extractReward(text = "", beforeCredit = null, afterCredit = null) {
  if (Number.isFinite(beforeCredit) && Number.isFinite(afterCredit) && afterCredit !== beforeCredit) return Math.max(0, afterCredit - beforeCredit);
  const normalized = String(text || "").replace(/\s+/g, " ");
  const patterns = [
    /(?:奖励|获得|得到|增加)\s*(-?\d+)\s*(?:个)?(?:吾爱币|金币|积分|CB)/i,
    /(?:吾爱币|金币|积分|CB)\s*\+\s*(\d+)/i,
    /\+\s*(\d+)\s*(?:个)?(?:吾爱币|金币|积分|CB)/i,
  ];
  for (const pattern of patterns) {
    const hit = normalized.match(pattern);
    if (hit) {
      const num = Number.parseInt(hit[1], 10);
      if (Number.isFinite(num)) return num;
    }
  }
  return null;
}

function cleanTaskMessage(text = "") {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  if (/已完成|已申请|已经申请|明天|下次再来|今天/.test(normalized)) return "今天已完成签到";
  if (/成功|完成|领取|申请/.test(normalized)) return "签到成功";
  return normalized.slice(0, 120) || "签到完成";
}

async function readHttpTextWithCookie({ origin, cookie, siteConfig, path, headers = {} }) {
  const session = createHttpSession({
    baseUrl: origin,
    cookie,
    proxyUrl: siteConfig.proxy_url || "",
    timeout: siteConfig.timeout || 60_000,
  });
  const response = await session.get(path, { headers });
  const html = await readText(response);
  return { response, html, text: htmlToText(html) };
}

export default class Pojie52Driver extends BaseDriver {
  getCookie() {
    const secrets = this.secrets?.pojie52 || this.secrets?.["52pojie"] || {};
    const cookie = normalizeCookieHeader(secrets.cookie || "");
    if (!cookie || cookie.includes("<YOUR_")) return "";
    if (/[^\x00-\xff]/.test(cookie)) throw new Error("Cookie 含非法字符，请重新从浏览器复制原始 Cookie");
    return cookie;
  }

  async signIn() {
    if (wantsHttpMode(this.siteConfig)) {
      const httpResult = await runDiscuzHttp(this.siteConfig, this.secrets, "pojie52");
      if (httpResult.success || !allowsHttpFallback(this.siteConfig)) return httpResult;
      logger.warn(`[${this.siteConfig.note || "pojie52"}] HTTP/API-first 失败，回退 Playwright：${httpResult.message}`);
    }
    const { chromium } = await import("playwright-core");
    const {
      base_url = "https://www.52pojie.cn",
      timeout = 60_000,
      proxy_url,
      chromium_executable_path = await resolveChromiumExecutablePath(chromium),
    } = this.siteConfig;

    const cookie = this.getCookie();
    if (!cookie) return { success: false, message: "⚠️ Cookie 未配置，请点击「维护 Cookie」填写" };

    const origin = String(base_url || "https://www.52pojie.cn").replace(/\/+$/, "");
    const proxy = proxy_url ? { server: proxy_url } : undefined;
    const signTime = formatSignTime();

    logger.info(`[吾爱破解] 步骤 1/5：启动 Playwright/CloakBrowser 浏览器${proxy_url ? `，代理: ${proxy_url}` : ""}`);
    const browser = await launchBrowser({
      chromium,
      siteConfig: this.siteConfig,
      launchOptions: {
        executablePath: chromium_executable_path,
        headless: true,
        proxy,
        args: ["--disable-blink-features=AutomationControlled", "--no-sandbox"],
        timeout,
      },
    });

    try {
      const context = await browser.newContext({
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
        locale: "zh-CN",
        timezoneId: "Asia/Shanghai",
        viewport: { width: 1440, height: 1000 },
        extraHTTPHeaders: { "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8" },
      });

      logger.info("[吾爱破解] 步骤 2/5：注入 Cookie，准备浏览器上下文");
      await context.addCookies(parseCookieHeader(cookie));
      const page = await context.newPage();

      const taskUrl = `${origin}/home.php?mod=task`;
      logger.info(`[吾爱破解] 步骤 3/5：打开任务页面 → ${taskUrl}`);
      let response = await page.goto(taskUrl, { waitUntil: "domcontentloaded", timeout });
      await page.waitForTimeout(this.siteConfig.playwright_wait_ms || 2500);

      let title = await page.title().catch(() => "");
      let bodyText = await page.locator("body").innerText({ timeout: 5000 }).catch(() => "");
      const beforeCredit = parseCredit(bodyText);
      const beforePoints = parseDiscuzPoints(bodyText);
      logger.info(`[吾爱破解] 步骤 4/5：页面状态 ${response?.status() || "unknown"} | ${title} | ${bodyText.replace(/\s+/g, " ").slice(0, 260)}`);

      if (!isLoggedIn(bodyText)) {
        return {
          success: false,
          message: "吾爱破解登录态无效或 Cookie 不完整，请重新维护 Cookie",
          details: { signTime, pageTitle: title },
          steps: [
            { label: "启动 Playwright/CloakBrowser 浏览器", ok: true },
            { label: "注入 Cookie 并准备浏览器上下文", ok: true },
            { label: "打开吾爱破解任务页面", ok: false, status: response?.status() || null, detail: "未识别到登录状态" },
          ],
        };
      }

      logger.info("[吾爱破解] 步骤 5/5：浏览器通过验证后切换 HTTP 执行每日任务");
      const browserCookies = await context.cookies(origin);
      const verifiedCookie = cookieHeaderFromCookies(browserCookies);
      const httpSiteConfig = { ...this.siteConfig, http_cookie_override: verifiedCookie || cookie };
      const httpResult = await runDiscuzHttp(httpSiteConfig, this.secrets, "pojie52");
      if (httpResult.success) {
        httpResult.steps = [
          { label: "启动 Playwright/CloakBrowser 浏览器", ok: true },
          { label: "注入 Cookie 并通过 JS 验证", ok: true },
          ...(httpResult.steps || []),
        ];
        httpResult.details = { ...(httpResult.details || {}), browserLight: true, pageTitle: httpResult.details?.pageTitle || title };
        return httpResult;
      }
      logger.warn(`[吾爱破解] 浏览器轻量 HTTP 执行失败，回退页面内执行：${httpResult.message}`);

      const taskResult = await page.evaluate(async () => {
        const abs = (href) => new URL(href, location.href).toString();
        const links = Array.from(document.querySelectorAll("a[href]"));
        const candidates = links
          .map(a => ({ text: (a.innerText || a.textContent || "").trim(), href: a.getAttribute("href") || "" }))
          .filter(x => /home\.php\?mod=task/.test(x.href) && /(apply|draw|领取|申请|完成|每日|登录|打卡|签到)/i.test(`${x.href} ${x.text}`));
        const first = candidates.find(x => /do=(apply|draw)/.test(x.href)) || candidates[0];
        if (!first) return { found: false, text: document.body.innerText.slice(0, 1000), candidates };
        const res = await fetch(abs(first.href), { method: "GET", credentials: "include", headers: { "X-Requested-With": "XMLHttpRequest" } });
        const text = await res.text();
        return { found: true, status: res.status, url: abs(first.href), linkText: first.text, text: text.slice(0, 1600), candidates };
      });

      // 52pojie / Discuz daily task commonly uses id=2; try apply/draw fallback if no link is visible.
      if (!taskResult.found) {
        for (const path of ["/home.php?mod=task&do=apply&id=2", "/home.php?mod=task&do=draw&id=2"]) {
          response = await page.goto(`${origin}${path}`, { waitUntil: "domcontentloaded", timeout }).catch(() => null);
          await page.waitForTimeout(1200);
          bodyText = await page.locator("body").innerText({ timeout: 5000 }).catch(() => "");
          if (/成功|完成|领取|申请|已完成|已申请|积分|吾爱币|金币|CB|今天/.test(bodyText)) {
            taskResult.found = true;
            taskResult.status = response?.status() || null;
            taskResult.url = `${origin}${path}`;
            taskResult.linkText = path.includes("draw") ? "领取任务奖励" : "申请每日任务";
            taskResult.text = bodyText.slice(0, 1600);
            break;
          }
        }
      }

      const verify = await readHttpTextWithCookie({ origin, cookie: verifiedCookie || cookie, siteConfig: this.siteConfig, path: taskUrl }).catch(() => null);
      title = title || "任务 - 吾爱破解 - 52pojie.cn";
      bodyText = verify?.text || bodyText;
      const creditUrl = `${origin}/home.php?mod=spacecp&ac=credit`;
      const credit = await readHttpTextWithCookie({ origin, cookie: verifiedCookie || cookie, siteConfig: this.siteConfig, path: creditUrl }).catch(() => null);
      const creditText = credit?.text || "";
      const afterCredit = parseCredit(creditText || bodyText);
      const afterPoints = parseDiscuzPoints(creditText || bodyText);
      const combined = `${taskResult.text || ""} ${bodyText}`;
      let rewardPoints = extractReward(combined, beforePoints, afterPoints);
      const totalPoints = Number.isFinite(afterPoints) ? afterPoints : beforePoints;
      const totalCoins = Number.isFinite(afterCredit) ? afterCredit : beforeCredit;
      const configuredDailyReward = Number.parseInt(this.siteConfig.daily_reward_points ?? "", 10);
      if (!Number.isFinite(rewardPoints) && /已完成|已申请|已经申请|明天|下次再来|今天已/.test(combined) && Number.isFinite(configuredDailyReward)) {
        rewardPoints = configuredDailyReward;
      }
      const alreadyDone = /已完成|已申请|已经申请|明天|下次再来|今天已/.test(combined);
      const success = taskResult.found && ((taskResult.status >= 200 && taskResult.status < 400) || alreadyDone || /成功|完成|领取|申请/.test(combined));
      const daily = cleanTaskMessage(combined);
      const rewardText = Number.isFinite(rewardPoints) ? `，奖励 ${rewardPoints} 积分` : "";
      const totalText = `${Number.isFinite(totalPoints) ? `；总积分 ${totalPoints}` : ""}${Number.isFinite(totalCoins) ? `；吾爱币 ${totalCoins}` : ""}`;

      return {
        success,
        message: success ? `${daily}${rewardText}${totalText}；签到时间：${signTime}` : `签到失败：${cleanTaskMessage(combined || "未找到每日任务入口")}`,
        details: { signTime, rewardPoints, totalPoints, totalCoins, alreadySigned: alreadyDone, taskUrl: taskResult.url, pageTitle: title },
        raw: taskResult,
        steps: [
          { label: "启动 Playwright/CloakBrowser 浏览器", ok: true },
          { label: "注入 Cookie 并准备浏览器上下文", ok: true },
          { label: "打开吾爱破解任务页面", ok: true, status: response?.status() || null },
          { label: "读取登录状态与积分", ok: true, detail: Number.isFinite(totalPoints) ? `总积分 ${totalPoints}` : "已登录" },
          { label: "执行每日任务", ok: success, status: taskResult.status || null, detail: success ? `${daily}${rewardText}` : "未找到或未能完成每日任务" },
        ],
      };
    } finally {
      await browser.close().catch(() => {});
    }
  }

  formatResult(result) {
    const icon = result.success ? "✅" : "❌";
    return `${icon} 吾爱破解签到\n📝 ${result.message}`;
  }
}
