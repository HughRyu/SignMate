// ============================================================
// nodeloc — NodeLoc Discourse daily visit/check driver
//
// NodeLoc is Discourse-based. There is no public /checkin endpoint.
// This driver verifies the logged-in session, visits the homepage, and
// records Discourse gamification/visit metrics as sign-in result.
// ============================================================

import BaseDriver from "./base.js";
import logger from "../utils/logger.js";
import { ProxyAgent } from "undici";

function normalizeCookieHeader(value = "") {
  return String(value || "")
    .trim()
    .split(/[\r\n;]+/)
    .map(part => part.trim().replace(/;+$/, ""))
    .filter(Boolean)
    .join("; ");
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

function parseCookieHeader(header, domain = ".nodeloc.com") {
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

function pickUserName(current = {}) {
  return current?.username || current?.name || "";
}

async function fetchJson(url, cookie, proxyUrl, timeout = 30_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
        "Accept": "application/json, text/plain, */*",
        "Cookie": cookie,
      },
      dispatcher: proxyUrl ? new ProxyAgent(proxyUrl) : undefined,
      signal: controller.signal,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { ok: res.ok, status: res.status, json, text: text.slice(0, 1200) };
  } finally {
    clearTimeout(timer);
  }
}

function findDirectoryItem(directory = {}, userId, username) {
  const items = directory?.directory_items || [];
  return items.find(item => item.id === userId || item.user?.id === userId || item.user?.username === username) || null;
}

export default class NodeLocDriver extends BaseDriver {
  getCookie() {
    const secrets = this.secrets?.nodeloc || {};
    const cookie = normalizeCookieHeader(secrets.cookie || "");
    if (!cookie || cookie.includes("<YOUR_")) return "";
    if (/[^\x00-\xff]/.test(cookie)) throw new Error("Cookie 含非法字符，请重新从浏览器复制原始 Cookie");
    return cookie;
  }

  async signIn() {
    const { chromium } = await import("playwright-core");
    const {
      base_url = "https://www.nodeloc.com",
      timeout = 60_000,
      proxy_url,
      chromium_executable_path = process.env.CHROMIUM_PATH || process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || "/ms-playwright/chromium-1200/chrome-linux64/chrome",
    } = this.siteConfig;

    const cookie = this.getCookie();
    if (!cookie) return { success: false, message: "⚠️ Cookie 未配置，请点击「维护 Cookie」填写" };

    const origin = String(base_url || "https://www.nodeloc.com").replace(/\/+$/, "");
    const signTime = formatSignTime();
    const proxy = proxy_url ? { server: proxy_url } : undefined;

    logger.info(`[NodeLoc] 步骤 1/5：启动 Playwright 浏览器${proxy_url ? `，代理: ${proxy_url}` : ""}`);
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

      logger.info("[NodeLoc] 步骤 2/5：注入 Cookie，准备浏览器上下文");
      await context.addCookies(parseCookieHeader(cookie));
      await context.setExtraHTTPHeaders({ Cookie: cookie, "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8" });
      const page = await context.newPage();

      logger.info(`[NodeLoc] 步骤 3/5：打开首页 → ${origin}/`);
      const home = await page.goto(`${origin}/`, { waitUntil: "domcontentloaded", timeout });
      await page.waitForTimeout(this.siteConfig.playwright_wait_ms || 2000);
      const title = await page.title().catch(() => "");
      const bodyText = await page.locator("body").innerText({ timeout: 5000 }).catch(() => "");
      logger.info(`[NodeLoc] 步骤 4/5：页面状态 ${home?.status() || "unknown"} | ${title} | ${bodyText.replace(/\s+/g, " ").slice(0, 260)}`);

      logger.info("[NodeLoc] 步骤 5/5：读取当前用户与活跃数据");
      let currentRes = await fetchJson(`${origin}/session/current.json`, cookie, proxy_url, timeout);
      let current = currentRes.json?.current_user;
      let username = pickUserName(current);
      if (!current?.id || !username) {
        const browserCurrent = await page.evaluate(async () => {
          const paths = ["/session/current.json", "/current-user.json"];
          for (const path of paths) {
            try {
              const res = await fetch(path, { credentials: "include", headers: { Accept: "application/json" } });
              const text = await res.text();
              let json = null;
              try { json = JSON.parse(text); } catch {}
              if (json?.current_user) return { status: res.status, json, text: text.slice(0, 600) };
            } catch (err) {
              return { status: 0, error: err.message };
            }
          }
          return null;
        }).catch(err => ({ status: 0, error: err.message }));
        if (browserCurrent?.json?.current_user) {
          currentRes = browserCurrent;
          current = browserCurrent.json.current_user;
          username = pickUserName(current);
        }
      }
      if (!current?.id || !username) {
        return {
          success: false,
          message: `NodeLoc 登录态无效或 Cookie 不完整，请重新维护 Cookie（current_user HTTP ${currentRes.status || "unknown"}）`,
          details: { signTime, pageTitle: title },
          steps: [
            { label: "启动 Playwright 浏览器", ok: true },
            { label: "注入 Cookie 并准备浏览器上下文", ok: true },
            { label: "打开 NodeLoc 首页", ok: true, status: home?.status() || null },
            { label: "读取当前用户", ok: false, status: currentRes.status, detail: (currentRes.text || currentRes.error || "未获取到 current_user").replace(/\s+/g, " ").slice(0, 180) },
          ],
        };
      }

      const [userRes, directoryRes, dailyDirectoryRes] = await Promise.all([
        fetchJson(`${origin}/u/${encodeURIComponent(username)}.json`, cookie, proxy_url, timeout).catch(err => ({ ok: false, error: err.message })),
        fetchJson(`${origin}/directory_items.json?period=all&order=likes_received`, cookie, proxy_url, timeout).catch(err => ({ ok: false, error: err.message })),
        fetchJson(`${origin}/directory_items.json?period=daily&order=likes_received`, cookie, proxy_url, timeout).catch(err => ({ ok: false, error: err.message })),
      ]);
      const user = userRes.json?.user || {};
      const dirItem = findDirectoryItem(directoryRes.json, current.id, username);
      const dailyDirItem = findDirectoryItem(dailyDirectoryRes.json, current.id, username);
      const score = dirItem?.gamification_score ?? user?.gamification_score ?? current?.gamification_score ?? null;
      const rawTodayEnergy = dailyDirItem?.gamification_score ?? dailyDirItem?.daily_score ?? dailyDirItem?.score_today ?? dirItem?.daily_score ?? dirItem?.score_today ?? user?.daily_score ?? user?.score_today ?? current?.daily_score ?? current?.score_today ?? null;
      const todayEnergy = Number.isFinite(rawTodayEnergy) && rawTodayEnergy > 0 ? rawTodayEnergy : null;
      const daysVisited = dirItem?.days_visited ?? user?.days_visited ?? null;
      const postCount = dirItem?.post_count ?? user?.post_count ?? null;
      const likesReceived = dirItem?.likes_received ?? user?.likes_received ?? null;
      const trustLevel = current.trust_level ?? user.trust_level ?? null;

      const metricParts = [];
      if (Number.isFinite(todayEnergy)) metricParts.push(`今日能量 ${todayEnergy}`);
      if (Number.isFinite(score)) metricParts.push(`总能量 ${score}`);
      if (Number.isFinite(daysVisited)) metricParts.push(`访问 ${daysVisited} 天`);
      if (Number.isFinite(postCount)) metricParts.push(`帖子 ${postCount}`);
      const metricText = metricParts.length ? `；${metricParts.join("；")}` : "";

      return {
        success: true,
        message: `${metricParts.join("；") || "检查完成"}；签到时间：${signTime}`,
        details: {
          signTime,
          username,
          totalEnergy: Number.isFinite(score) ? score : null,
          rewardEnergy: Number.isFinite(todayEnergy) ? todayEnergy : null,
          totalDays: Number.isFinite(daysVisited) ? daysVisited : null,
          postCount: Number.isFinite(postCount) ? postCount : null,
          likesReceived: Number.isFinite(likesReceived) ? likesReceived : null,
          trustLevel: Number.isFinite(trustLevel) ? trustLevel : null,
          pageTitle: title,
        },
        raw: { current_user: current, directory: dirItem, dailyDirectory: dailyDirItem, user: { id: user.id, username: user.username, trust_level: user.trust_level } },
        steps: [
          { label: "启动 Playwright 浏览器", ok: true },
          { label: "注入 Cookie 并准备浏览器上下文", ok: true },
          { label: "打开 NodeLoc 首页", ok: true, status: home?.status() || null },
          { label: "读取当前用户", ok: true, status: currentRes.status, detail: username },
          { label: "读取活跃/能量数据", ok: true, status: dailyDirectoryRes.status || directoryRes.status || userRes.status || null, detail: metricParts.join("；") || "已完成访问" },
        ],
      };
    } finally {
      await browser.close().catch(() => {});
    }
  }

  formatResult(result) {
    const icon = result.success ? "✅" : "❌";
    return `${icon} NodeLoc 签到\n📝 ${result.message}`;
  }
}
