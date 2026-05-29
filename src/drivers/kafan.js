// ============================================================
// kafan — 卡饭论坛 dsu_amupper 签到 driver
//
// Plugin page: /plugin.php?id=dsu_amupper:pperlist
// Submit      : /plugin.php?id=dsu_amupper&ppersubmit=true&formhash=...
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

function parseCookieHeader(header, domain = ".bbs.kafan.cn") {
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

function compactText(text = "") {
  return String(text || "").replace(/\s+/g, " ").trim();
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

function isLoggedIn(text = "", html = "") {
  const source = compactText(`${text} ${html}`).slice(0, 3000);
  return /退出|设置|消息|提醒|积分[:：]|活力[:：]|个人空间/.test(source) && !/立即登录|用户登录|登录\s*注册/.test(source.slice(0, 1000));
}

function numberFrom(text = "", regex) {
  const hit = compactText(text).match(regex);
  const num = hit ? Number.parseInt(hit[1], 10) : NaN;
  return Number.isFinite(num) ? num : null;
}

function decodeDsuAmupperCookie(value = "") {
  if (!value) return "";
  try {
    return Buffer.from(decodeURIComponent(String(value)), "base64").toString("utf8");
  } catch {
    try { return Buffer.from(String(value), "base64").toString("utf8"); }
    catch { return ""; }
  }
}

function cookieValue(cookieHeader = "", name) {
  const parts = normalizeCookieHeader(cookieHeader).split(";").map(part => part.trim());
  for (const part of parts) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return "";
}

function todayStamp(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

function parseAmupperStats(text = "", cookieHeader = "") {
  const normalized = compactText(text);
  const dsuCookie = cookieValue(cookieHeader, "r6pb_69df_dsu_amupper");
  const decoded = decodeDsuAmupperCookie(dsuCookie);
  const decodedCompact = compactText(decoded);
  const ownAddupFromCookie = Number.parseInt(decoded.match(/!addup!\s*<[^>]*>\s*(\d+)\s*<\/[^>]+>\s*!times!/i)?.[1] || "", 10);
  const ownConsFromCookie = Number.parseInt(decoded.match(/!cons!\s*<[^>]*>\s*(\d+)\s*<\/[^>]+>\s*!times!/i)?.[1] || "", 10);
  return {
    username: normalized.match(/\|\s*([^|\s]+)\s*\|设置/)?.[1] || normalized.match(/^([^\s]+)\s+快捷导航\s+设置/)?.[1] || "",
    points: numberFrom(normalized, /积分[:：]\s*(\d+)/),
    experience: numberFrom(normalized, /经验[:：]\s*(\d+)/),
    vitality: numberFrom(normalized, /活力[:：]\s*(\d+)/),
    addup: numberFrom(normalized, /累计签到\s*(\d+)\s*次/) ?? (Number.isFinite(ownAddupFromCookie) ? ownAddupFromCookie : null),
    cons: numberFrom(normalized, /连续签到\s*(\d+)\s*次/) ?? (Number.isFinite(ownConsFromCookie) ? ownConsFromCookie : null),
    rewardAmount: numberFrom(normalized, /特奖励[:：]\s*[^\d\s]+\s*(\d+)/),
    rewardUnit: normalized.match(/特奖励[:：]\s*([^\d\s，。；;]+)\s*\d+/)?.[1] || "",
    nextRewardAmount: numberFrom(normalized, /明日签到将获得[^0-9]*(\d+)/),
    last: decodedCompact.match(/!last![:：]?\s*([0-9-]{10}\s+[0-9:]{8})/)?.[1] || "",
    rawDsuCookiePresent: Boolean(dsuCookie),
  };
}

function parseProfileStats(text = "") {
  const normalized = compactText(text);
  const group = normalized.match(/用户组\s+([^\s]+)\s+在线时间/)?.[1]
    || normalized.match(/我的主用户组\s*-\s*([^\s]+)\s+积分/)?.[1]
    || "";
  return {
    userGroup: group,
    points: numberFrom(normalized, /积分[:：]?\s*(\d+)/),
    experience: numberFrom(normalized, /经验[:：]?\s*(\d+)/),
    vitality: numberFrom(normalized, /活力[:：]?\s*(\d+)/),
  };
}

function mergeStats(...items) {
  const out = {};
  for (const item of items) {
    for (const [key, value] of Object.entries(item || {})) {
      if (value !== null && value !== undefined && value !== "") out[key] = value;
    }
  }
  return out;
}

function buildStatusMessage(stats = {}, signTime) {
  const parts = [];
  if (Number.isFinite(stats.rewardAmount) && stats.rewardUnit) parts.push(`签到${stats.rewardUnit} +${stats.rewardAmount}`);
  else if (Number.isFinite(stats.rewardAmount)) parts.push(`签到奖励 +${stats.rewardAmount}`);
  if (Number.isFinite(stats.cons)) parts.push(`连续签到 ${stats.cons} 次`);
  if (!parts.length) parts.push("今日已签到");
  if (signTime) parts.push(`签到时间：${signTime}`);
  return parts.join("；");
}

function buildDetailMessage(prefix, stats = {}, signTime) {
  const parts = [prefix];
  if (Number.isFinite(stats.rewardAmount) && stats.rewardUnit) parts.push(`签到${stats.rewardUnit} +${stats.rewardAmount}`);
  if (Number.isFinite(stats.nextRewardAmount)) parts.push(`明日奖励 ${stats.nextRewardAmount}`);
  if (Number.isFinite(stats.cons)) parts.push(`连续签到 ${stats.cons} 次`);
  if (Number.isFinite(stats.addup)) parts.push(`总签到 ${stats.addup} 次`);
  if (stats.userGroup) parts.push(`用户组 ${stats.userGroup}`);
  if (Number.isFinite(stats.experience)) parts.push(`总经验 ${stats.experience}`);
  if (Number.isFinite(stats.points)) parts.push(`积分 ${stats.points}`);
  if (Number.isFinite(stats.vitality)) parts.push(`活力 ${stats.vitality}`);
  if (stats.last) parts.push(`上次 ${stats.last}`);
  if (signTime) parts.push(`签到时间：${signTime}`);
  return parts.join("；");
}

export default class KafanDriver extends BaseDriver {
  getCookie() {
    const key = this.siteConfig.key || "kafan";
    const secrets = this.secrets?.[key] || this.secrets?.kafan || {};
    const cookie = normalizeCookieHeader(secrets.cookie || "");
    if (!cookie || cookie.includes("<YOUR_")) return "";
    if (/[^\x00-\xff]/.test(cookie)) throw new Error("Cookie 含非法字符，请重新从浏览器复制原始 Cookie");
    return cookie;
  }

  async signIn() {
    const { chromium } = await import("playwright-core");
    const {
      base_url = "https://bbs.kafan.cn",
      timeout = 60_000,
      proxy_url,
      playwright_wait_ms = 1800,
      chromium_executable_path = process.env.CHROMIUM_PATH || process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || "/ms-playwright/chromium-1200/chrome-linux64/chrome",
    } = this.siteConfig;

    const cookie = this.getCookie();
    if (!cookie) return { success: false, message: "⚠️ Cookie 未配置，请点击「维护 Cookie」填写" };

    const origin = String(base_url || "https://bbs.kafan.cn").replace(/\/+$/, "");
    const listUrl = `${origin}/plugin.php?id=dsu_amupper:pperlist`;
    const profileUrl = `${origin}/home.php?mod=space&do=profile`;
    const signTime = formatSignTime();
    const proxy = proxy_url ? { server: proxy_url } : undefined;

    logger.info(`[卡饭] 步骤 1/5：启动 Playwright 浏览器${proxy_url ? `，代理: ${proxy_url}` : ""}`);
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

      logger.info("[卡饭] 步骤 2/5：注入 Cookie，准备浏览器上下文");
      await context.addCookies(parseCookieHeader(cookie));
      const page = await context.newPage();
      page.setDefaultTimeout(Math.min(timeout, 15_000));

      logger.info(`[卡饭] 步骤 3/5：打开 dsu_amupper 页面 → ${listUrl}`);
      let response = await page.goto(listUrl, { waitUntil: "domcontentloaded", timeout });
      await page.waitForTimeout(playwright_wait_ms);
      let title = await page.title().catch(() => "");
      let bodyText = await page.locator("body").innerText({ timeout: 5000 }).catch(() => "");
      let html = await page.content().catch(() => "");
      logger.info(`[卡饭] 步骤 4/5：页面状态 ${response?.status() || "unknown"} | ${title} | ${compactText(bodyText).slice(0, 260)}`);

      if (!isLoggedIn(bodyText, html)) {
        return {
          success: false,
          message: "卡饭登录态无效或 Cookie 不完整，请重新维护 Cookie",
          details: { signTime, pageTitle: title },
          steps: [
            { label: "启动 Playwright 浏览器", ok: true },
            { label: "注入 Cookie 并准备浏览器上下文", ok: true },
            { label: "打开卡饭 dsu_amupper 页面", ok: false, status: response?.status() || null, detail: "未识别到登录状态" },
          ],
        };
      }

      let stats = parseAmupperStats(bodyText, cookie);
      const profileTextBefore = await page.goto(profileUrl, { waitUntil: "domcontentloaded", timeout: Math.min(timeout, 20000) })
        .then(() => page.locator("body").innerText({ timeout: 5000 }))
        .catch(() => "");
      stats = mergeStats(stats, parseProfileStats(profileTextBefore));
      await page.goto(listUrl, { waitUntil: "domcontentloaded", timeout: Math.min(timeout, 20000) }).catch(() => {});
      const alreadyByCookie = stats.last ? stats.last.slice(0, 10) === todayStamp() : false;
      const signHref = await page.locator("a#pper_a").first().getAttribute("href", { timeout: 3000 }).catch(() => "");
      const formhash = html.match(/formhash=([a-f0-9]+)/i)?.[1] || html.match(/name=["']formhash["'][^>]*value=["']([^"']+)/i)?.[1] || "";
      const submitUrl = signHref ? new URL(signHref, listUrl).toString() : (formhash ? `${origin}/plugin.php?id=dsu_amupper&ppersubmit=true&formhash=${encodeURIComponent(formhash)}` : "");

      if (alreadyByCookie && !signHref) {
        return {
          success: true,
          message: buildStatusMessage(stats, signTime),
          details: { signTime, username: stats.username, alreadySigned: true, clickedSignIn: false, checkinAction: "already_signed_before_run", addup: stats.addup, cons: stats.cons, totalDays: stats.addup, streakDays: stats.cons, rewardAmount: stats.rewardAmount, rewardUnit: stats.rewardUnit, nextRewardAmount: stats.nextRewardAmount, userGroup: stats.userGroup, points: stats.points, experience: stats.experience, totalExp: stats.experience, vitality: stats.vitality, last: stats.last, pageTitle: title },
          steps: [
            { label: "启动 Playwright 浏览器", ok: true },
            { label: "注入 Cookie 并准备浏览器上下文", ok: true },
            { label: "打开卡饭 dsu_amupper 页面", ok: true, status: response?.status() || null },
            { label: "读取签到状态", ok: true, detail: "Cookie/页面显示今天已签到" },
          ],
        };
      }

      if (!submitUrl) {
        const alreadyText = /已经|已签到|今日|今天/.test(compactText(bodyText).slice(0, 1500));
        return {
          success: alreadyByCookie || alreadyText,
          message: alreadyByCookie || alreadyText ? buildStatusMessage(stats, signTime) : "未找到卡饭 dsu_amupper 签到入口",
          details: { signTime, username: stats.username, alreadySigned: alreadyByCookie || alreadyText, clickedSignIn: false, checkinAction: alreadyByCookie || alreadyText ? "already_signed_uncertain" : "submit_url_missing", addup: stats.addup, cons: stats.cons, totalDays: stats.addup, streakDays: stats.cons, rewardAmount: stats.rewardAmount, rewardUnit: stats.rewardUnit, nextRewardAmount: stats.nextRewardAmount, userGroup: stats.userGroup, points: stats.points, experience: stats.experience, totalExp: stats.experience, vitality: stats.vitality, last: stats.last, pageTitle: title },
          steps: [
            { label: "启动 Playwright 浏览器", ok: true },
            { label: "注入 Cookie 并准备浏览器上下文", ok: true },
            { label: "打开卡饭 dsu_amupper 页面", ok: true, status: response?.status() || null },
            { label: "定位签到入口", ok: false, detail: "未找到 a#pper_a 或 formhash" },
          ],
        };
      }

      logger.info("[卡饭] 步骤 5/5：提交 dsu_amupper 签到请求");
      const beforeStats = stats;
      const submit = await page.goto(submitUrl, { waitUntil: "domcontentloaded", timeout: Math.min(timeout, 30000) })
        .then(async res => ({ ok: res?.ok() ?? false, status: res?.status() || null, text: await page.locator("body").innerText({ timeout: 5000 }).catch(() => "") }))
        .catch(err => ({ ok: false, status: null, error: err.message, text: "" }));
      await page.waitForTimeout(1200);

      response = await page.goto(listUrl, { waitUntil: "domcontentloaded", timeout: Math.min(timeout, 30000) }).catch(() => response);
      await page.waitForTimeout(playwright_wait_ms);
      title = await page.title().catch(() => title);
      bodyText = await page.locator("body").innerText({ timeout: 5000 }).catch(() => bodyText);
      const storage = await context.storageState().catch(() => ({ cookies: [] }));
      const updatedCookie = storage.cookies?.map(c => `${c.name}=${c.value}`).join("; ") || cookie;
      stats = parseAmupperStats(`${submit.text || ""} ${bodyText}`, updatedCookie);
      const profileTextAfter = await page.goto(profileUrl, { waitUntil: "domcontentloaded", timeout: Math.min(timeout, 20000) })
        .then(() => page.locator("body").innerText({ timeout: 5000 }))
        .catch(() => "");
      stats = mergeStats(stats, parseProfileStats(profileTextAfter));
      const combined = compactText(`${submit.text || ""} ${bodyText}`);
      const failureText = /请先登录|登录后|错误|失败|非法|已关闭/.test(combined.slice(0, 1000));
      const rewardSuccess = /累计签到\s*\d+\s*次|特奖励|明日签到将获得/.test(combined.slice(0, 1800));
      const already = /已经|今日|今天|已签到|不要太勤快|下次再来|已签到|已签过/.test(combined.slice(0, 1800)) || (stats.last ? stats.last.slice(0, 10) === todayStamp() : false);
      const beforeAddup = beforeStats.addup;
      const afterAddup = stats.addup;
      const delta = Number.isFinite(beforeAddup) && Number.isFinite(afterAddup) ? afterAddup - beforeAddup : null;
      const success = (submit.ok || submit.status === 200) && !failureText && (rewardSuccess || already || (delta !== null && delta >= 0));
      const finalSuccess = success || rewardSuccess || already || (delta !== null && delta > 0);

      return {
        success: finalSuccess,
        message: finalSuccess ? buildStatusMessage(stats, signTime) : `签到失败：${submit.error || combined.slice(0, 180)}`,
        raw: { status: submit.status, ok: submit.ok, text: submit.text?.slice(0, 1000) },
        details: { signTime, username: stats.username, alreadySigned: already && !rewardSuccess && !(delta !== null && delta > 0), clickedSignIn: true, checkinAction: finalSuccess ? (rewardSuccess || (delta !== null && delta > 0) ? "submitted" : "submitted_or_already") : "submit_failed", beforeAddup, afterAddup, addupDelta: delta, addup: stats.addup, cons: stats.cons, totalDays: stats.addup, streakDays: stats.cons, rewardAmount: stats.rewardAmount, rewardUnit: stats.rewardUnit, rewardExp: stats.rewardUnit === "经验" ? stats.rewardAmount : null, nextRewardAmount: stats.nextRewardAmount, userGroup: stats.userGroup, points: stats.points, experience: stats.experience, totalExp: stats.experience, vitality: stats.vitality, last: stats.last, pageTitle: title },
        steps: [
          { label: "启动 Playwright 浏览器", ok: true },
          { label: "注入 Cookie 并准备浏览器上下文", ok: true },
          { label: "打开卡饭 dsu_amupper 页面", ok: true, status: response?.status() || null },
          { label: "定位签到入口", ok: true, detail: formhash ? "已读取 formhash" : "使用页面链接" },
          { label: "提交 dsu_amupper 签到请求", ok: finalSuccess, status: submit.status || null, detail: finalSuccess ? buildDetailMessage(delta !== null && delta > 0 ? "签到成功" : "今日已签到", stats, signTime) : (submit.error || combined.slice(0, 160)) },
        ],
      };
    } finally {
      await browser.close().catch(() => {});
    }
  }

  formatResult(result) {
    const icon = result.success ? "✅" : "❌";
    return `${icon} 卡饭论坛\n📝 ${result.message}`;
  }
}
