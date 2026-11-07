import BaseDriver from "./base.js";
import { chromium } from "playwright-core";
import { launchBrowser, resolveChromiumExecutablePath } from "../utils/browser.js";
import { classifyForumPage } from "./forum-visit.js";
import { parseForumAccount } from "../utils/forum-account.js";
import { parse } from "parse5";

const BASE = "https://sb.sb";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";
function* nodes(n) { yield n; for (const c of n.childNodes || []) yield* nodes(c); }
const attr = (n, k) => n.attrs?.find(a => a.name === k)?.value || "";
const text = n => [...nodes(n)].filter(n => n.nodeName === "#text").map(n => n.value).join("").replace(/\s+/g, " ").trim();
export function parseSbCheckin(html) {
  const ns = [...nodes(parse(html))];
  const panel = ns.find(n => attr(n, "class").split(/\s+/).includes("signin-hero-action"));
  const form = ns.find(n => n.tagName === "form" && attr(n, "action") === "/checkin/" && attr(n, "method").toLowerCase() === "post");
  const stats = {};
  for (const n of ns.filter(n => attr(n, "class").split(/\s+/).includes("signin-stat"))) {
    const children = [...nodes(n)];
    const label = text(children.find(c => attr(c, "class") === "signin-stat-label") || {});
    const value = text(children.find(c => attr(c, "class") === "signin-stat-value") || {}).replace(/,/g, "");
    const key = { "累计签到": "totalDays", "本月签到": "monthDays", "最长连续": "longestStreak" }[label];
    if (key && /^\d+$/.test(value)) stats[key] = Number(value);
  }
  const signed = !form && /今日已签到|今天已签到|今日已簽到|签到成功/.test(panel ? text(panel) : "");
  return { signed, ready: !!form, stats };
}

export default class SbSigninDriver extends BaseDriver {
  async openBrowser(proxy) {
    return launchBrowser({ chromium, siteConfig: this.siteConfig, launchOptions: { executablePath: await resolveChromiumExecutablePath(chromium), headless: true, proxy, args: ["--no-sandbox"] } });
  }
  async signIn() {
    const cookie = String(this.secrets[this.siteConfig.key]?.cookie || "").trim();
    if (!cookie) return { success: false, message: "烧饼论坛 Cookie 未配置" };
    if (new URL(this.siteConfig.base_url || BASE).origin !== BASE) return { success: false, message: "烧饼签到仅支持 sb.sb 原站" };
    let proxy;
    if (this.siteConfig.proxy_url) {
      const u = new URL(this.siteConfig.proxy_url);
      proxy = { server: u.origin, ...(u.username ? { username: decodeURIComponent(u.username), password: decodeURIComponent(u.password) } : {}) };
    }
    let browser, submitted = false;
    const steps = [];
    try {
      browser = await this.openBrowser(proxy);
      const context = await browser.newContext({ userAgent: UA });
      await context.addCookies(cookie.split(";").map(p => p.trim()).filter(p => p.includes("=")).map(p => {
        const i = p.indexOf("="); return { name: p.slice(0, i), value: p.slice(i + 1), url: BASE + "/" };
      }));
      const page = await context.newPage();
      page.setDefaultTimeout(10000);
      // Only the genuine checkin form may mutate state. Leave its optional public message empty.
      let posts = 0;
      await page.route(`${BASE}/checkin/**`, async route => {
        if (route.request().method() === "POST") {
          const body = new URLSearchParams(route.request().postData() || "");
          if (++posts > 1 || body.get("message")) return route.abort();
          submitted = true;
        }
        return route.fallback();
      });
      const response = await page.goto(BASE + "/checkin/", { waitUntil: "domcontentloaded", timeout: this.siteConfig.timeout || 30000 });
      let html = await page.content();
      const auth = classifyForumPage(html, BASE);
      if (auth === "challenge") return { success: false, message: "烧饼论坛需要安全验证", details: { failureType: "challenge", verificationBlocked: true } };
      if (!response?.ok()) return { success: false, message: `烧饼签到页访问失败：HTTP ${response?.status() || 0}` };
      if (auth !== "authenticated") return { success: false, message: auth === "logged_out" ? "烧饼论坛登录态已失效，请更新 Cookie" : "烧饼论坛登录态未确认", details: { failureType: auth === "logged_out" ? "auth_expired" : "unconfirmed" } };
      steps.push({ label: "验证登录状态", ok: true });
      const before = parseSbCheckin(html);
      if (this.siteConfig.verify_only === true) return { success: true, message: "烧饼论坛登录状态已确认（仅验证，未执行签到）", details: { authenticated: true, ...parseForumAccount(html, BASE).details, ...before.stats, clickedSignIn: false }, steps };
      if (before.signed) return { success: true, message: "烧饼论坛今日已签到", details: { ...parseForumAccount(html, BASE).details, ...before.stats, alreadySigned: true, clickedSignIn: false }, steps };
      if (!before.ready) return { success: false, message: "未识别到烧饼签到表单，不自动提交", steps };
      await page.locator('.signin-form input[name="message"]').fill("");
      await page.locator('.signin-form button[type="submit"]').click();
      if (await page.locator('cap-widget').count()) {
        const button = page.locator('[data-signin-cap]:not([hidden]) cap-widget').getByRole("button", { name: "点击验证你不是机器人", exact: true });
        await button.waitFor({ state: "visible", timeout: 10000 });
        await button.click();
      }
      // Cap's normal solve event submits the site's form itself; never send a second POST.
      const deadline = Date.now() + 45000;
      while (Date.now() < deadline) {
        await page.waitForTimeout(1000);
        if (await page.locator('cap-widget[data-state="error"]').count()) {
          steps.push({ label: "站点 Cap 验证未通过，未提交签到", ok: false });
          return { success: false, message: "烧饼签到 Cap 验证失败，请在相同出口人工验证后重试", details: { verificationBlocked: true, failureType: "challenge", clickedSignIn: submitted }, steps };
        }
        html = await page.content();
        const after = parseSbCheckin(html);
        if (after.signed && classifyForumPage(html, BASE) === "authenticated") {
          steps.push({ label: "完成签到并核对今日状态", ok: true });
          return { success: true, message: "烧饼论坛签到成功", details: { ...parseForumAccount(html, BASE).details, ...after.stats, clickedSignIn: submitted, alreadySigned: !submitted }, steps };
        }
      }
      return { success: false, message: submitted ? "签到已提交，但未确认结果；下次先核对今日状态" : "烧饼签到验证未完成，请在相同出口人工验证", details: { verificationBlocked: !submitted, failureType: !submitted ? "challenge" : "unconfirmed", clickedSignIn: submitted }, steps };
    } catch {
      return { success: false, message: submitted ? "签到提交后响应异常，未自动重复提交" : "烧饼签到页面加载异常，请稍后重试", details: { clickedSignIn: submitted, failureType: "unconfirmed" }, steps };
    } finally { await browser?.close().catch(() => {}); }
  }
}
