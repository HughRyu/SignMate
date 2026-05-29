#!/usr/bin/env node
// ============================================================
// nodeseek — NodeSeek 论坛签到 Driver
//
// 默认使用 Playwright/Chromium 浏览器模式：
// 1. 注入 Web UI 维护的 Cookie
// 2. 打开 /board 让 Cloudflare/站点建立真实浏览器上下文
// 3. 在页面上下文里 POST /api/attendance?random=true
//
// 这样比 Node fetch 更接近真实浏览器，避免 Cloudflare challenge。
// ============================================================

import BaseDriver from "./base.js";
import { postJSON } from "../utils/http.js";
import logger from "../utils/logger.js";

function normalizeCookieHeader(value = "") {
  return String(value || "")
    .trim()
    .split(/[\r\n]+/)
    .map(part => part.trim().replace(/;+$/, ""))
    .filter(Boolean)
    .join("; ");
}

function parseCookieHeader(header, domain = ".nodeseek.com") {
  return normalizeCookieHeader(header)
    .split(";")
    .map(part => part.trim())
    .filter(Boolean)
    .map(part => {
      const eq = part.indexOf("=");
      if (eq < 0) return null;
      const name = part.slice(0, eq).trim();
      const value = part.slice(eq + 1).trim();
      if (!name) return null;
      return {
        name,
        value,
        domain,
        path: "/",
        httpOnly: false,
        secure: true,
        sameSite: "Lax",
      };
    })
    .filter(Boolean);
}

function isAlreadySigned(message = "") {
  return /已完成签到|请勿重复|已经签到|今日签到/.test(message);
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


function finiteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function nodeSeekLevelStats(totalChickenLegs) {
  const coin = Number(totalChickenLegs);
  if (!Number.isFinite(coin) || coin < 0) return {};
  let level = 0;
  for (let n = 6; n >= 0; n--) {
    if (coin >= 100 * Math.pow(n, 2)) { level = n; break; }
  }
  const currentFloor = 100 * Math.pow(level, 2);
  const nextLevel = level < 6 ? level + 1 : null;
  const nextNeed = nextLevel ? 100 * Math.pow(nextLevel, 2) : null;
  const levelProgress = nextNeed ? Math.round(((coin - currentFloor) / (nextNeed - currentFloor)) * 100) : 100;
  return { nodeSeekLevel: level, nodeSeekLevelProgress: Math.max(0, Math.min(100, levelProgress)), nodeSeekNextLevelChickenLegs: nextNeed };
}

async function readNodeSeekStats(page) {
  return page.evaluate(async () => {
    const user = globalThis.__config__?.user || globalThis.meCard?.user || null;
    let board = null;
    try {
      board = await fetch('/api/attendance/board?page=1', { credentials: 'include' }).then(r => r.json());
    } catch {}
    return {
      totalChickenLegs: user?.coin ?? null,
      rewardChickenLegs: board?.record?.gain ?? null,
      attendanceRank: board?.order ?? null,
      attendanceTotalParticipants: board?.total ?? null,
    };
  }).catch(() => ({}));
}

function extractChickenLegs(text = "") {
  const value = String(text || "");
  const patterns = [
    /签到获得鸡腿\s*(\d+)\s*个/,
    /获得鸡腿\s*(\d+)\s*个/,
    /获得\s*(\d+)\s*个?鸡腿/,
    /鸡腿\s*[+＋]\s*(\d+)/,
  ];
  for (const pattern of patterns) {
    const match = value.match(pattern);
    if (match) return Number(match[1]);
  }
  return null;
}

function buildSuccessMessage(baseMessage, details = {}) {
  const lines = [];
  if (Number.isFinite(details.rewardChickenLegs)) {
    lines.push(`此次签到获得 ${details.rewardChickenLegs} 个鸡腿`);
  } else {
    lines.push(baseMessage || "签到成功");
  }
  if (Number.isFinite(details.totalChickenLegs)) lines.push(`总鸡腿 ${details.totalChickenLegs}`);
  if (Number.isFinite(details.nodeSeekLevel)) {
    lines.push(`等级 Lv${details.nodeSeekLevel}${Number.isFinite(details.nodeSeekLevelProgress) ? ` (${details.nodeSeekLevelProgress}%)` : ""}`);
  }
  if (baseMessage && !lines.includes(baseMessage) && !Number.isFinite(details.rewardChickenLegs)) {
    lines.push(baseMessage);
  }
  // 奖励已解析时，不再把 “今天已完成签到，请勿重复操作” 放进卡片文案。
  lines.push(`签到时间：${details.signTime || formatSignTime()}`);
  return lines.join("；");
}

export default class NodeSeekDriver extends BaseDriver {
  async signIn() {
    const mode = this.siteConfig.signin_mode || this.siteConfig.mode || "playwright";
    if (mode === "fetch") return this.signInWithFetch();

    try {
      return await this.signInWithPlaywright();
    } catch (err) {
      logger.warn(`[NodeSeek] Playwright 签到失败: ${err.message}`);
      if (this.siteConfig.playwright_fallback_fetch === true) {
        return this.signInWithFetch();
      }
      return { success: false, message: `Playwright 签到失败: ${err.message}` };
    }
  }

  getCookie() {
    const secrets = this.secrets?.nodeseek || {};
    let cookie = secrets.cookie;
    if (!cookie && secrets.session_only) {
      cookie = `session=${secrets.session_only};`;
    }
    cookie = normalizeCookieHeader(cookie);

    if (!cookie || cookie.includes("<YOUR_") || cookie === "session=;") {
      return "";
    }
    if (/[^\x00-\xff]/.test(cookie)) {
      throw new Error("Cookie 含非法字符（例如中文省略号 …），请重新粘贴浏览器里的原始 Cookie");
    }
    return cookie;
  }

  async signInWithPlaywright() {
    const { chromium } = await import("playwright-core");
    const {
      base_url = "https://www.nodeseek.com",
      timeout = 60_000,
      proxy_url,
      chromium_executable_path = process.env.CHROMIUM_PATH || process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || "/ms-playwright/chromium-1200/chrome-linux64/chrome",
    } = this.siteConfig;

    const cookie = this.getCookie();
    if (!cookie) {
      return { success: false, message: "⚠️ Cookie 未配置，请点击「维护 Cookie」填写" };
    }

    const origin = base_url.replace(/\/$/, "");
    const proxy = proxy_url ? { server: proxy_url } : undefined;
    logger.info(`[NodeSeek] 步骤 1/5：启动 Playwright 浏览器${proxy_url ? `，代理: ${proxy_url}` : ""}`);

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

      logger.info(`[NodeSeek] 步骤 2/5：注入 Cookie，准备浏览器上下文`);
      await context.addCookies(parseCookieHeader(cookie));
      const page = await context.newPage();
      const boardUrl = `${origin}/board`;
      logger.info(`[NodeSeek] 步骤 3/5：打开 NodeSeek 页面 → ${boardUrl}`);
      const board = await page.goto(boardUrl, { waitUntil: "domcontentloaded", timeout });
      await page.waitForTimeout(this.siteConfig.playwright_wait_ms || 5000);

      const title = await page.title().catch(() => "");
      const bodyText = await page.locator("body").innerText({ timeout: 5000 }).catch(() => "");
      const bodyPreview = bodyText.replace(/\s+/g, " ").slice(0, 160);
      logger.info(`[NodeSeek] 步骤 4/5：页面状态 ${board?.status() || "unknown"} | ${title} | ${bodyPreview}`);

      if (/Just a moment|Checking your browser|请稍候|验证/.test(title + bodyText)) {
        return { success: false, message: "Cloudflare 验证未通过，请确认代理出口和浏览器 Cookie/cf_clearance" };
      }

      logger.info(`[NodeSeek] 步骤 5/5：在浏览器页面内提交签到请求`);
      const result = await page.evaluate(async () => {
        const res = await fetch("/api/attendance?random=true", {
          method: "POST",
          credentials: "include",
          headers: {
            "Content-Type": "application/json",
            "Accept": "application/json, text/plain, */*",
          },
          body: "{}",
        });
        const text = await res.text();
        let data = null;
        try { data = JSON.parse(text); } catch {}
        return {
          status: res.status,
          contentType: res.headers.get("content-type"),
          text: text.slice(0, 1000),
          data,
        };
      });

      logger.info(`[NodeSeek] 签到接口 HTTP ${result.status} | ${result.text.replace(/\s+/g, " ").slice(0, 300)}`);
      const apiMessage = result.data?.message || result.data?.error || result.text || `HTTP ${result.status}`;
      const signTime = formatSignTime();
      const pageStats = await readNodeSeekStats(page);
      const rewardChickenLegs = finiteNumber(pageStats.rewardChickenLegs) ?? extractChickenLegs(bodyText) ?? extractChickenLegs(apiMessage);
      const totalChickenLegs = finiteNumber(pageStats.totalChickenLegs);
      const levelStats = nodeSeekLevelStats(totalChickenLegs);
      const attendanceRank = finiteNumber(pageStats.attendanceRank);
      const attendanceTotalParticipants = finiteNumber(pageStats.attendanceTotalParticipants);
      const alreadySigned = isAlreadySigned(apiMessage);
      const success = result.status >= 200 && result.status < 300 && (result.data?.success !== false);

      if (success || alreadySigned) {
        const message = buildSuccessMessage(apiMessage, { rewardChickenLegs, totalChickenLegs, ...levelStats, alreadySigned, signTime });
        return {
          success: true,
          message,
          raw: result.data || result.text,
          details: {
            signTime,
            rewardChickenLegs,
            totalChickenLegs,
            ...levelStats,
            attendanceRank,
            attendanceTotalParticipants,
            alreadySigned,
            pageTitle: title,
          },
          steps: [
            { label: "启动 Playwright 浏览器", ok: true },
            { label: "注入 Cookie 并准备浏览器上下文", ok: true },
            { label: "打开 NodeSeek 页面并通过 Cloudflare/站点校验", ok: true, status: board?.status() || null },
            { label: "读取页面签到信息", ok: true, detail: Number.isFinite(rewardChickenLegs) ? `页面显示获得 ${rewardChickenLegs} 个鸡腿${Number.isFinite(totalChickenLegs) ? `，当前总鸡腿 ${totalChickenLegs}` : ""}` : bodyPreview },
            { label: "提交签到 API", ok: true, status: result.status, detail: apiMessage },
          ],
        };
      }
      if (/Just a moment|cf-mitigated|challenge-platform|cloudflare/i.test(result.text)) {
        return { success: false, message: "HTTP 403 — Cloudflare 验证拦截；请确认代理出口与 Cookie/cf_clearance" };
      }
      return { success: false, message: apiMessage, raw: result.data || result.text };
    } finally {
      await browser.close().catch(() => {});
    }
  }

  async signInWithFetch() {
    const { base_url = "https://www.nodeseek.com", impersonate = "chrome142", timeout } = this.siteConfig;
    const cookie = this.getCookie();
    if (!cookie) {
      return { success: false, message: "⚠️ Cookie 未配置，请点击「维护 Cookie」填写" };
    }

    const url = `${base_url.replace(/\/$/, "")}/api/attendance?random=true`;
    logger.info(`[NodeSeek] Fetch 模式签到 → ${url}`);

    const response = await postJSON(url, {
      body: {},
      headers: {
        "Cookie": cookie,
        "Origin": base_url.replace(/\/$/, ""),
        "Referer": `${base_url.replace(/\/$/, "")}/board`,
      },
      impersonate,
      timeout,
      retries: this.siteConfig.retry || 2,
      retryDelay: this.siteConfig.retry_delay_ms || 10000,
      proxyUrl: this.siteConfig.proxy_url,
    });

    const text = await response.text();
    const preview = text.replace(/\s+/g, " ").slice(0, 300);
    logger.info(`[NodeSeek] HTTP ${response.status} | ${preview}`);

    let data;
    try { data = JSON.parse(text); } catch { data = null; }
    const message = data?.message || data?.error || `HTTP ${response.status}`;

    const signTime = formatSignTime();
    const rewardChickenLegs = extractChickenLegs(text);
    if (response.status === 200) {
      return { success: true, message: buildSuccessMessage(data?.message || "签到请求已发送", { rewardChickenLegs, signTime }), raw: data || text.slice(0, 500), details: { signTime, rewardChickenLegs } };
    }
    if (isAlreadySigned(message)) {
      return { success: true, message: buildSuccessMessage(message, { rewardChickenLegs, alreadySigned: true, signTime }), raw: data || text.slice(0, 500), details: { signTime, rewardChickenLegs, alreadySigned: true } };
    }
    if (response.status === 401 || response.status === 403) {
      const isCfChallenge = /Just a moment|challenge-platform|cf-browser-verification|cloudflare/i.test(text);
      return {
        success: false,
        message: isCfChallenge
          ? `HTTP ${response.status} — Cloudflare 验证拦截；请改用 Playwright 模式`
          : `HTTP ${response.status} — 登录态被拒绝，请确认 Cookie 是否完整/同出口`,
      };
    }
    return { success: false, message, raw: text.slice(0, 500) };
  }

  formatResult(result) {
    const icon = result.success ? "✅" : "❌";
    return `${icon} NodeSeek 签到\n📝 ${result.message}`;
  }
}
