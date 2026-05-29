import BaseDriver from "./base.js";
import logger from "../utils/logger.js";
import { request } from "../utils/http.js";
import CryptoJS from "crypto-js";

const API_BASE = "https://api.feng.com";
const WEB_BASE = "https://www.feng.com/forum/";
// Derived from feng.com frontend request-signature bundle. This is not a user secret.
const REQUEST_KEY = "2b7e151628aed2a6";

function safeDecode(value = "") {
  try { return decodeURIComponent(String(value || "")); } catch { return String(value || ""); }
}

function parseUserInfo(raw = "") {
  if (!raw) return null;
  const decoded = safeDecode(raw);
  try { return JSON.parse(decoded); } catch { return null; }
}

function cookieValue(rawCookie = "", name = "") {
  const target = String(name || "").trim();
  if (!target) return "";
  for (const part of String(rawCookie || "").split(/;|\r?\n/)) {
    const index = part.indexOf("=");
    if (index <= 0) continue;
    const key = part.slice(0, index).trim();
    if (key === target) return part.slice(index + 1).trim();
  }
  return "";
}

function asInt(value) {
  const n = Number.parseInt(String(value ?? "").replace(/[^0-9-]/g, ""), 10);
  return Number.isFinite(n) ? n : null;
}

function fengDetails(data = {}, account = {}, extra = {}) {
  const exp = asInt(data.currentExperience ?? data.experience ?? account.profile?.experience);
  const signInDays = asInt(data.signInCount);
  const joinDays = asInt(data.joinDays);
  const levelNo = asInt(data.level ?? account.profile?.level);
  const level = levelNo !== null ? `Lv${levelNo}` : (data.fengLevel || data.levelTitle || account.profile?.levelTitle || null);
  return {
    experience: exp,
    totalExp: exp,
    fengLevel: level,
    level,
    levelTitle: data.levelTitle || account.profile?.levelTitle || null,
    currentExperience: exp,
    creditsLower: asInt(data.creditsLower),
    creditsHigher: asInt(data.creditsHigher),
    fengCoins: asInt(data.weTicket ?? data.fengCoins),
    totalCoins: asInt(data.weTicket ?? data.fengCoins),
    joinDays,
    totalDays: joinDays ?? signInDays,
    signInDays,
    streakDays: signInDays,
    ...extra,
  };
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

function makeRequestId(path = "") {
  const normalizedPath = String(path || "").split("?")[0];
  const data = `url=${normalizedPath}$time=${Date.now()}000000`;
  const key = CryptoJS.enc.Utf8.parse(REQUEST_KEY);
  return CryptoJS.AES.encrypt(CryptoJS.enc.Utf8.parse(data), key, {
    iv: key,
    mode: CryptoJS.mode.CBC,
    padding: CryptoJS.pad.Pkcs7,
  }).toString();
}

function isApiOk(payload = {}) {
  const code = String(payload?.status?.code ?? "");
  const message = String(payload?.status?.message ?? "");
  return code === "0" || message === "请求成功" || message.toLowerCase() === "success";
}

export default class FengDriver extends BaseDriver {
  getAccount() {
    const key = this.siteConfig.key || "feng-com";
    const siteSecrets = this.secrets?.[key] || this.secrets?.feng || {};
    const rawCookie = siteSecrets.cookie || "";
    // 威锋登录态在浏览器里通常是 userInfo / userInfo-shared 两个 Cookie；
    // 面板手动粘贴完整 Cookie、CookieCloud 同步都只会写入 cookie 字段。
    // 因此 Driver 不能只读取拆出来的 userInfo 字段，否则新部署用户会提示未配置。
    const rawUserInfo = siteSecrets.userInfo || siteSecrets.userinfo || siteSecrets["userInfo"] || cookieValue(rawCookie, "userInfo") || "";
    const rawShared = siteSecrets.userInfoShared || siteSecrets["userInfo-shared"] || cookieValue(rawCookie, "userInfo-shared") || "";
    const parsed = parseUserInfo(rawUserInfo) || parseUserInfo(rawShared);
    const token = String(parsed?.accessToken || siteSecrets.accessToken || "").trim();
    if (!token || token.includes("<YOUR_")) return null;
    return { token, profile: parsed?.userInfo || {} };
  }

  async api(path, { method = "GET" } = {}) {
    const account = this.getAccount();
    if (!account) throw new Error("威锋 userInfo/accessToken 未配置");
    const headers = {
      "Accept": "application/json, text/plain, */*",
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
      "Origin": "https://www.feng.com",
      "Referer": WEB_BASE,
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
      "X-Access-Token": account.token,
      "X-Request-Id": makeRequestId(path),
    };
    const res = await request(`${API_BASE}${path}`, {
      method,
      headers,
      body: method === "GET" ? undefined : "",
      proxyUrl: this.siteConfig.proxy_url,
    }, this.siteConfig.timeout || 30000);
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch { /* keep raw text for error message */ }
    return { ok: res.ok, status: res.status, data, text };
  }

  async getUserHomeInfo(uid) {
    if (!uid) return null;
    const home = await this.api(`/v1/user/homePageInfo?uid=${encodeURIComponent(uid)}`);
    if (home.ok && isApiOk(home.data) && home.data?.data) return home.data.data;
    return null;
  }

  async signIn() {
    const account = this.getAccount();
    const signTime = formatTime();
    if (!account) {
      return { success: false, message: "威锋 userInfo/accessToken 未配置，请重新维护凭据" };
    }

    logger.info("[威锋] 步骤 1/3：读取用户经验/签到状态");
    const before = await this.api("/v1/user/experience");
    const beforeData = before.data?.data || {};
    const username = beforeData.userName || account.profile?.userName || "-";
    const beforeOk = before.ok && isApiOk(before.data);
    if (!beforeOk) {
      const msg = before.data?.status?.message || before.text || `HTTP ${before.status}`;
      return {
        success: false,
        message: `威锋登录态无效或接口访问失败：${msg}`,
        details: { signTime, username, status: before.status },
        steps: [{ label: "读取账号状态", ok: false, status: before.status, detail: msg }],
      };
    }

    const homeInfo = await this.getUserHomeInfo(beforeData.uid || account.profile?.userId).catch(() => null);
    const beforeMerged = { ...beforeData, ...(homeInfo?.userBaseInfo || {}), signInCount: homeInfo?.signInCount ?? beforeData.signInCount, weTicket: homeInfo?.weTicket, joinDays: homeInfo?.joinDays };
    const beforeExp = asInt(beforeMerged.currentExperience ?? beforeMerged.experience ?? account.profile?.experience);
    const beforeDays = asInt(beforeMerged.signInCount);
    if (beforeData.isSignedIn === true) {
      return {
        success: true,
        message: `连续签到 ${beforeDays ?? "-"} 天；经验 ${beforeExp ?? "-"}`,
        details: { signTime, ...fengDetails(beforeMerged, account, { alreadySigned: true, checkinAction: "already_signed" }) },
        steps: [
          { label: "读取账号状态", ok: true, detail: `经验 ${beforeExp ?? "-"}` },
          { label: "检查签到状态", ok: true, detail: "运行前已是已签到状态" },
        ],
      };
    }

    logger.info("[威锋] 步骤 2/3：调用签到接口");
    const signed = await this.api("/v1/attendance/userSignIn", { method: "POST" });
    const signOk = signed.ok && isApiOk(signed.data);
    const signMessage = signed.data?.status?.message || signed.text || `HTTP ${signed.status}`;

    logger.info("[威锋] 步骤 3/3：复查签到状态");
    const after = await this.api("/v1/user/experience");
    const afterData = after.data?.data || {};
    const afterHomeInfo = await this.getUserHomeInfo(afterData.uid || beforeMerged.uid || account.profile?.userId).catch(() => null);
    const afterMerged = { ...afterData, ...(afterHomeInfo?.userBaseInfo || {}), signInCount: afterHomeInfo?.signInCount ?? afterData.signInCount, weTicket: afterHomeInfo?.weTicket, joinDays: afterHomeInfo?.joinDays };
    const afterExp = asInt(afterMerged.currentExperience ?? afterMerged.experience);
    const afterDays = asInt(afterMerged.signInCount);
    const signedAfter = afterData.isSignedIn === true;
    const expGain = Number.isFinite(afterExp) && Number.isFinite(beforeExp) ? afterExp - beforeExp : null;
    const success = signOk || signedAfter;

    return {
      success,
      message: success
        ? `连续签到 ${afterDays ?? "-"} 天${Number.isFinite(expGain) ? `；经验 +${expGain}` : ""}`
        : `签到失败：${signMessage}`,
      details: {
        signTime,
        ...fengDetails(afterMerged, account, {
          experience: afterExp ?? beforeExp,
          totalExp: afterExp ?? beforeExp,
          beforeExperience: beforeExp,
          afterExperience: afterExp,
          rewardExp: Number.isFinite(expGain) && expGain > 0 ? expGain : null,
          totalDays: afterDays,
          streakDays: afterDays,
          beforeDays,
          afterDays,
          alreadySigned: signedAfter,
          checkinAction: success ? "signed" : "failed",
        }),
      },
      steps: [
        { label: "读取账号状态", ok: true, status: before.status, detail: `经验 ${beforeExp ?? "-"}` },
        { label: "调用签到接口", ok: signOk, status: signed.status, detail: signMessage },
        { label: "复查签到状态", ok: signedAfter, status: after.status, detail: `连续 ${afterDays ?? "-"} 天；经验 ${afterExp ?? "-"}` },
      ],
    };
  }

  formatResult(result) {
    const icon = result.success ? "✅" : "❌";
    return `${icon} ${this.name}\n📝 ${result.message}`;
  }
}
