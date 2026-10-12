import BaseDriver from "./base.js";
import { request } from "../utils/http.js";
import { parseForumAccount, parseLinuxWallet } from "../utils/forum-account.js";

// Require positive account evidence: a public HTTP 200 page is not keepalive.
export function classifyForumPage(html, baseUrl) {
  const title = String(html).match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "";
  if (/just a moment|attention required|安全验证|人机验证|captcha/i.test(title)
      || /id=["'](?:challenge-form|cf-challenge)["']|window\._cf_chl_opt\b|\/cdn-cgi\/challenge-platform\/(?:h\/[bg]\/)?orchestrate\//i.test(html)) {
    return "challenge";
  }
  const markup = String(html).replace(/<!--[\s\S]*?-->|<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
  let logout = false;
  let login = false;
  const paths = new Set();
  for (const match of markup.matchAll(/<(?:a|form)\b[^>]*\b(?:href|action)\s*=\s*["']([^"']+)["']/gi)) {
    try {
      const url = new URL(match[1], baseUrl);
      if (url.origin !== new URL(baseUrl).origin) continue;
      paths.add(url.pathname.replace(/\/$/, ""));
      if (/\/(?:logout|signout|user_logout)\/?$/i.test(url.pathname)) logout = true;
      if (/\/(?:login|signin)\/?$/i.test(url.pathname)) login = true;
    } catch { /* Ignore malformed links. */ }
  }
  // LINUX SB renders its account menu without a logout link on the homepage.
  // Require both its logged-in filter identity and account-only navigation.
  const linuxIdentity = /<[^>]+\bdata-home-keyword-filter-user-id\s*=\s*["']([1-9]\d*)["'][^>]*>/i.test(markup);
  const linuxAccount = new URL(baseUrl).hostname === "linux.sb" && linuxIdentity
    && paths.has("/profile") && paths.has("/direct_messages");
  return (logout || linuxAccount) && !login ? "authenticated" : login ? "logged_out" : "unknown";
}

export default class ForumVisitDriver extends BaseDriver {
  async fetchPage(url, cookie) {
    return request(url, {
      method: "GET", redirect: "manual", proxyUrl: this.siteConfig.proxy_url,
      headers: { Cookie: cookie, Accept: "text/html", "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36" },
    }, this.siteConfig.timeout || 30000);
  }

  async signIn() {
    const cookie = String(this.secrets?.[this.siteConfig.key]?.cookie || "").trim();
    if (!cookie || cookie.includes("<YOUR_")) return { success: false, message: "保活需要登录 Cookie，请先维护 Cookie" };
    if (/[\r\n]|[^\x00-\xff]/.test(cookie)) return { success: false, message: "Cookie 格式异常，请重新维护 Cookie" };
    const base = new URL(this.siteConfig.base_url);
    if (base.protocol !== "https:") return { success: false, message: "保活站点必须使用 HTTPS" };
    let url = base.href;
    for (let hop = 0; hop < 4; hop++) {
      const response = await this.fetchPage(url, cookie);
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        await response.body?.cancel();
        if (!location) return { success: false, message: "保活页面重定向异常" };
        const next = new URL(location, url);
        if (next.origin !== base.origin || /\/(?:login|signin)\/?$/i.test(next.pathname)) {
          return { success: false, message: "保活需要重新登录，请更新 Cookie" };
        }
        url = next.href;
        continue;
      }
      const html = await response.text();
      const state = classifyForumPage(html, base.href);
      if (state === "challenge") return { success: false, message: "站点要求安全验证，请在相同代理出口人工完成验证后重试" };
      if (!response.ok) return { success: false, message: `保活访问失败：HTTP ${response.status}` };
      if (state !== "authenticated") return { success: false, message: state === "logged_out" ? "Cookie 未登录或已失效，请更新 Cookie" : "无法确认登录态，未报告保活成功" };
      const account = parseForumAccount(html, base.href);
      const details = { status: response.status, authenticated: true, ...account.details };
      if (account.walletUrl && this.siteConfig.verify_only !== true) {
        try {
          const wallet = await this.fetchPage(account.walletUrl, cookie);
          // Never follow a wallet redirect or reuse a challenge/login page as a balance.
          if (wallet.ok) {
            const walletHtml = await wallet.text();
            const walletState = classifyForumPage(walletHtml, base.href);
            const walletAccount = parseForumAccount(walletHtml, base.href);
            // Wallet pages omit the homepage filter ID; require the same sidebar account.
            const sameAccount = account.profileUrl && walletAccount.profileUrl === account.profileUrl
              && walletAccount.details.username === account.details.username;
            if (walletState === "authenticated" || (walletState === "unknown" && sameAccount)) {
              const balance = parseLinuxWallet(walletHtml);
              if (balance !== null) details.totalCoins = balance;
            }
          } else await wallet.body?.cancel();
        } catch { /* Optional metrics must not turn a confirmed visit into failure. */ }
      }
      return { success: true, message: "已登录访问完成，保活成功", details };
    }
    return { success: false, message: "保活页面重定向次数过多" };
  }
}
