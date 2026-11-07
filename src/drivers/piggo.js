import BaseDriver from "./base.js";
import { createHmac, randomBytes } from "node:crypto";
import { request } from "../utils/http.js";

export function piggoSignature(sign, path, ts, nonce) {
  return createHmac("sha256", sign).update(`GET\n${path.replace(/^\/+/, "").split("?")[0]}\n${ts}\n${nonce}`).digest("hex");
}
export function piggoAccount(data) {
  const user = data?.user;
  if (!user || !Number.isSafeInteger(Number(user.id)) || Number(user.id) < 1 || typeof user.username !== "string" || !user.username.trim()) return null;
  const details = { authenticated: true, username: user.username };
  for (const [source, dest] of Object.entries({ bonus: "bonus", uploaded: "upload", downloaded: "download", ratio: "ratio", class_name: "userGroup" })) {
    if (["string", "number"].includes(typeof user[source])) details[dest] = user[source];
  }
  return details;
}

// Piggo's new SPA is no longer NexusPHP. Only same-origin, read-only account
// requests are allowed; cookies must actually establish a server-side session.
export default class PiggoDriver extends BaseDriver {
  async fetchJson(path, headers) {
    const response = await request(new URL(path, "https://piggo.me"), { method: "GET", redirect: "manual", proxyUrl: this.siteConfig.proxy_url, headers }, this.siteConfig.timeout || 20000);
    let body;
    try { body = await response.json(); } catch { return { status: response.status, invalid: true }; }
    if (body && Object.hasOwn(body, "code") && Object.hasOwn(body, "data")) return { status: response.status, code: body.code, data: body.data };
    return { status: response.status, invalid: true };
  }
  async signIn() {
    const cookie = String(this.secrets[this.siteConfig.key]?.cookie || "").trim();
    if (!cookie) return { success: false, message: "Piggo Cookie 未配置" };
    if (new URL(this.siteConfig.base_url || "https://piggo.me").origin !== "https://piggo.me") return { success: false, message: "Piggo 保活仅支持原站 HTTPS" };
    const headers = { Cookie: cookie, Accept: "application/json", "X-Requested-With": "XMLHttpRequest", visitorId: randomBytes(16).toString("hex"), ts: String(Math.floor(Date.now() / 1000)), version: "1.0.0", webversion: "1" };
    try {
      const auth = await this.fetchJson("/v1/web/auth/sign", headers);
      if (auth.status === 401 || Number(auth.code) === 401) return this.cookieUnsupported();
      if (auth.status === 403) return { success: false, message: "Piggo 账户接口拒绝访问，需检查安全验证", details: { failureType: "challenge", verificationBlocked: true } };
      if (auth.status !== 200 || auth.code !== 0 || !/^[a-f0-9]{64}$/i.test(auth.data?.sign || "")) return { success: false, message: "Piggo 新版会话未确认，不报告保活成功", details: { failureType: "unconfirmed" } };
      headers.ts = String(Math.floor(Date.now() / 1000));
      headers["X-Spa-Nonce"] = randomBytes(16).toString("hex");
      headers["X-Spa-Hmac"] = piggoSignature(auth.data.sign, "/v1/web/me", headers.ts, headers["X-Spa-Nonce"]);
      const me = await this.fetchJson("/v1/web/me", headers);
      if (me.status === 401 || Number(me.code) === 401) return this.cookieUnsupported();
      if (me.status === 403) return { success: false, message: "Piggo 账户接口拒绝访问，需检查安全验证", details: { failureType: "challenge", verificationBlocked: true } };
      const details = me.status === 200 && me.code === 0 ? piggoAccount(me.data) : null;
      if (!details) return { success: false, message: "Piggo 账户身份未确认，不报告保活成功", details: { failureType: "unconfirmed" } };
      return { success: true, message: "Piggo 新版账户访问完成，保活成功", details, steps: [{ label: "验证新版会话", ok: true }, { label: "读取账户信息（只读）", ok: true }] };
    } catch { return { success: false, message: "Piggo 新版接口访问异常，请检查网络或代理", details: { failureType: "unconfirmed" } }; }
  }
  cookieUnsupported() {
    return { success: false, message: "Piggo 新版未接受当前 Cookie 登录态（401）；仅同步 Cookie 可能不足，未报告保活成功", details: { failureType: "auth_expired", cookieSessionRejected: true }, steps: [{ label: "验证新版 Cookie 会话", ok: false, status: 401, detail: "服务器拒绝 Cookie 会话，不把公开页面访问当作登录保活" }] };
  }
}
