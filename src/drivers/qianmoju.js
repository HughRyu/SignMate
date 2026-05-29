// ============================================================
// qianmoju — 阡陌居 Discuz DSU 每日签到 driver
//
// Sign page: /plugin.php?id=dsu_paulsign:sign
// Submit   : /plugin.php?id=dsu_paulsign:sign&operation=qiandao&infloat=1
// ============================================================

import BaseDriver from "./base.js";
import logger from "../utils/logger.js";
import { resolveChromiumExecutablePath } from "../utils/browser.js";

function normalizeCookieHeader(value = "") {
  return String(value || "")
    .trim()
    .split(/[\r\n]+/)
    .map(part => part.trim().replace(/;+$/, ""))
    .filter(Boolean)
    .join("; ");
}

function parseCookieHeader(header, domain = ".1000qm.vip") {
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

function compactText(text = "") {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function normalizeLines(text = "") {
  return String(text || "")
    .replace(/\r/g, "\n")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

function isLoggedIn(text = "", title = "") {
  const head = compactText(text).slice(0, 1200);
  if (/登录/.test(title) || /立即登录|用户登录|登录\s*注册|密码|安全登录/.test(head)) return false;
  return /\|我的|设置|消息|提醒|退出|积分[:：]|用户组[:：]/.test(head);
}

function numberFrom(text = "", regex) {
  const hit = compactText(text).match(regex);
  const num = hit ? Number.parseInt(hit[1], 10) : NaN;
  return Number.isFinite(num) ? num : null;
}

function parseStats(text = "") {
  const lineText = normalizeLines(text);
  const normalized = compactText(lineText);
  const selfStart = lineText.search(/(?:readchichi|RyuHwang|Hugh)/i);
  const selfBlock = selfStart >= 0 ? lineText.slice(selfStart, selfStart + 900) : "";
  const source = compactText(selfBlock || normalized);
  const rewardMatch = source.match(/上次获得的奖励为[:：]\s*([^\s，,。.；;]+)\s*(\d+)/) || source.match(/(?:上次奖励|奖励)\s*[:：]?\s*([^\s，,。.；;\d]+)\s*(\d+)/);
  const username = source.match(/^\s*([A-Za-z0-9_\-一-龥]+)\s*[,，]\s*您/)?.[1]
    || normalized.match(/切换风格\s+([^\s|]+)\s*\|我的/)?.[1]
    || normalized.match(/([^\s|]+)\s*\|我的\s*\|设置/)?.[1]
    || "";
  return {
    username,
    totalDays: numberFrom(source, /(?:累计已签到|总天数|总签到|累计签到|已签到)[:：\s]*(\d+)\s*天?/),
    monthDays: numberFrom(source, /(?:本月已累计签到|月天数|本月签到)[:：\s]*(\d+)\s*天?/),
    rewardAmount: rewardMatch ? Number.parseInt(rewardMatch[2], 10) : null,
    rewardUnit: rewardMatch?.[1] || "",
    qianmojuPoints: numberFrom(normalized, /积分[:：]\s*(\d+)/),
    level: normalized.match(/用户组[:：]\s*([^\s|]+)/)?.[1] || source.match(/\[LV\.?\d+\][^\s]+/)?.[0] || null,
    selfRow: selfBlock,
  };
}

function buildMessage(prefix, stats = {}, signTime) {
  const parts = [prefix];
  if (Number.isFinite(stats.qianmojuPoints)) parts.push(`积分 ${stats.qianmojuPoints}`);
  if (stats.level) parts.push(`用户组 ${stats.level}`);
  if (Number.isFinite(stats.totalDays)) parts.push(`总签到 ${stats.totalDays} 天`);
  if (Number.isFinite(stats.monthDays)) parts.push(`本月 ${stats.monthDays} 天`);
  if (Number.isFinite(stats.rewardAmount) && stats.rewardUnit) parts.push(`上次奖励 ${stats.rewardAmount} ${stats.rewardUnit}`);
  parts.push(`签到时间：${signTime}`);
  return parts.join("；");
}

export default class QianmojuDriver extends BaseDriver {
  getCookie() {
    const key = this.siteConfig.key || "qianmoju";
    const secrets = this.secrets?.[key] || this.secrets?.qianmoju || {};
    const cookie = normalizeCookieHeader(secrets.cookie || "");
    if (!cookie || cookie.includes("<YOUR_")) return "";
    if (/[^\x00-\xff]/.test(cookie)) throw new Error("Cookie 含非法字符，请重新从浏览器复制原始 Cookie");
    return cookie;
  }

  async signIn() {
    const { chromium } = await import("playwright-core");
    const {
      base_url = "https://www.1000qm.vip",
      timeout = 60_000,
      proxy_url,
      playwright_wait_ms = 2500,
      chromium_executable_path = await resolveChromiumExecutablePath(chromium),
    } = this.siteConfig;

    const cookie = this.getCookie();
    if (!cookie) return { success: false, message: "⚠️ Cookie 未配置，请点击「维护 Cookie」填写" };

    const origin = String(base_url || "https://www.1000qm.vip").replace(/\/+$/, "");
    const signPageUrl = `${origin}/plugin.php?id=dsu_paulsign:sign`;
    const signTime = formatSignTime();
    const proxy = proxy_url ? { server: proxy_url } : undefined;

    logger.info(`[阡陌居] 步骤 1/5：启动 Playwright 浏览器${proxy_url ? `，代理: ${proxy_url}` : ""}`);
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

      logger.info("[阡陌居] 步骤 2/5：注入 Cookie，准备浏览器上下文");
      await context.addCookies(parseCookieHeader(cookie));
      const page = await context.newPage();
      page.setDefaultTimeout(Math.min(timeout, 15_000));

      logger.info(`[阡陌居] 步骤 3/5：打开签到页面 → ${signPageUrl}`);
      let response = await page.goto(signPageUrl, { waitUntil: "domcontentloaded", timeout });
      await page.waitForTimeout(playwright_wait_ms);
      let title = await page.title().catch(() => "");
      let bodyText = await page.locator("body").innerText({ timeout: 5000 }).catch(() => "");
      logger.info(`[阡陌居] 步骤 4/5：页面状态 ${response?.status() || "unknown"} | ${title} | ${compactText(bodyText).slice(0, 260)}`);

      if (!isLoggedIn(bodyText, title)) {
        return {
          success: false,
          message: "阡陌居登录态无效或 Cookie 不完整，请重新维护 Cookie",
          details: { signTime, pageTitle: title },
          steps: [
            { label: "启动 Playwright 浏览器", ok: true },
            { label: "注入 Cookie 并准备浏览器上下文", ok: true },
            { label: "打开阡陌居签到页面", ok: false, status: response?.status() || null, detail: "未识别到登录状态" },
          ],
        };
      }

      let stats = parseStats(bodyText);
      const selfAlreadySigned = /readchichi[^\n]{0,260}(?:今天已签到|已签到|签到成功)/i.test(bodyText);
      const alreadySigned = selfAlreadySigned || ((/(?:今天|今日|您今日)?已签到|今天已签到|今日已签到|签到成功|您已经签到/.test(bodyText))
        && !/今天签到了吗[？?]?请选择/.test(bodyText));
      if (alreadySigned) {
        return {
          success: true,
          message: buildMessage("今天已完成签到", stats, signTime),
          details: { signTime, username: stats.username, alreadySigned: true, clickedSignIn: false, checkinAction: "already_signed_before_run", qianmojuPoints: stats.qianmojuPoints, qianmojuRewardAmount: stats.rewardAmount, qianmojuRewardUnit: stats.rewardUnit, totalDays: stats.totalDays, monthDays: stats.monthDays, qianmojuLevel: stats.level, pageTitle: title },
          steps: [
            { label: "启动 Playwright 浏览器", ok: true },
            { label: "注入 Cookie 并准备浏览器上下文", ok: true },
            { label: "打开阡陌居签到页面", ok: true, status: response?.status() || null },
            { label: "读取签到状态", ok: true, detail: "页面显示今天已签到（运行前已是已签到状态）" },
          ],
        };
      }

      logger.info("[阡陌居] 步骤 5/5：提交 DSU 签到表单");
      const submit = await page.evaluate(async () => {
        const form = document.querySelector('form#qiandao, form[action*="dsu_paulsign"][action*="qiandao"]');
        if (!form) return { ok: false, error: "未找到签到表单" };
        const action = new URL(form.getAttribute("action"), location.href).toString();
        const formData = new FormData(form);
        formData.set("qdxq", formData.get("qdxq") || "kx");
        formData.set("qdmode", formData.get("qdmode") || "1");
        formData.set("todaysay", String(formData.get("todaysay") || "开心是一种选择，快乐融入日常，感受每一个美好的瞬间！").slice(0, 50));
        const body = new URLSearchParams();
        for (const [k, v] of formData.entries()) body.set(k, v);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 12000);
        let res;
        try {
          res = await fetch(action, {
          method: "POST",
          credentials: "include",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
            "X-Requested-With": "XMLHttpRequest",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          },
          body: body.toString(),
          signal: controller.signal,
        });
        } finally { clearTimeout(timer); }
        const text = await res.text();
        return { ok: res.ok, status: res.status, text: text.slice(0, 2000), action };
      });

      response = await page.goto(signPageUrl, { waitUntil: "commit", timeout: Math.min(timeout, 20000) }).catch(() => response);
      await page.waitForLoadState("domcontentloaded", { timeout: 8000 }).catch(() => {});
      await page.waitForTimeout(1200);
      title = await page.title().catch(() => title);
      bodyText = await page.locator("body").innerText({ timeout: 5000 }).catch(() => bodyText);
      stats = parseStats(`${submit.text || ""} ${bodyText}`);
      const combined = compactText(`${submit.text || ""} ${bodyText}`);
      const loginExpired = submit.error === "未找到签到表单" && (/登录/.test(title) || /立即登录|用户登录|请先登录|登录后/.test(combined.slice(0, 1000)));
      const success = !loginExpired && submit.ok && /签到成功|恭喜|今天已签到|今日已签到|已签到|签到完毕/.test(combined) && !/未找到签到表单|失败|错误|请先登录|登录后/.test(combined.slice(0, 800));

      return {
        success,
        message: success ? buildMessage("签到成功", stats, signTime) : (loginExpired ? "阡陌居登录态无效或 Cookie 不完整，请重新维护 Cookie" : `签到失败：${submit.error || combined.slice(0, 180)}`),
        raw: submit,
        details: { signTime, username: stats.username, alreadySigned: false, clickedSignIn: true, checkinAction: success ? "submitted" : "submit_failed", qianmojuPoints: stats.qianmojuPoints, qianmojuRewardAmount: stats.rewardAmount, qianmojuRewardUnit: stats.rewardUnit, totalDays: stats.totalDays, monthDays: stats.monthDays, qianmojuLevel: stats.level, pageTitle: title },
        steps: [
          { label: "启动 Playwright 浏览器", ok: true },
          { label: "注入 Cookie 并准备浏览器上下文", ok: true },
          { label: "打开阡陌居签到页面", ok: true, status: response?.status() || null },
          { label: "读取签到表单", ok: Boolean(!submit.error), detail: loginExpired ? "页面跳转到登录页，Cookie 可能已失效或不完整" : (submit.error || "已读取 DSU 签到表单") },
          { label: "提交 DSU 签到表单", ok: success, status: submit.status || null, detail: success ? buildMessage("签到成功", stats, signTime) : (loginExpired ? "未提交：需要重新维护 Cookie" : (submit.error || combined.slice(0, 160))) },
        ],
      };
    } finally {
      await browser.close().catch(() => {});
    }
  }

  formatResult(result) {
    const icon = result.success ? "✅" : "❌";
    return `${icon} 阡陌居签到\n📝 ${result.message}`;
  }
}
