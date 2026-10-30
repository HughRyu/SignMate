// ============================================================
// tieba — 百度贴吧每日签到 driver
// ============================================================

import { createHash } from "node:crypto";
import BaseDriver from "./base.js";
import { get, postForm } from "../utils/http.js";
import logger from "../utils/logger.js";

const MOBILE_FORUMS_URL = "https://tieba.baidu.com/mo/q/newmoindex";
const SIGN_URL = "https://c.tieba.baidu.com/c/c/forum/sign";

function normalizeCookieHeader(value = "") {
  return String(value || "")
    .trim()
    .split(/[\r\n]+/)
    .flatMap(line => line.split(";"))
    .map(part => part.trim().replace(/;+$/, ""))
    .filter(Boolean)
    .join("; ");
}

function hasPlaceholder(value = "") {
  return !value || String(value).includes("<YOUR_");
}

function formatTime(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date).reduce((acc, part) => ({ ...acc, [part.type]: part.value }), {});
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

async function readJson(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function unique(values = []) {
  return [...new Set(values)];
}

function tiebaSignHash(name, tbs) {
  return createHash("md5")
    .update(`kw=${name}tbs=${tbs}tiebaclient!!!`, "utf8")
    .digest("hex");
}

function resultMessage(stats = {}) {
  return [
    `贴吧总数 ${stats.total ?? 0}`,
    `签到成功 ${stats.successCount ?? 0}`,
    `已经签到 ${stats.alreadySignedCount ?? 0}`,
    `被屏蔽 ${stats.shieldedCount ?? 0}`,
    `签到失败 ${stats.failedCount ?? 0}`,
    `签到时间：${stats.signTime || formatTime()}`,
  ].join("；");
}

export default class TiebaDriver extends BaseDriver {
  getCookie() {
    const key = this.siteConfig.key || "baidu-tieba";
    const secrets = this.secrets?.[key] || this.secrets?.tieba || {};
    const cookie = normalizeCookieHeader(secrets.cookie || "");
    if (hasPlaceholder(cookie)) return "";
    if (/[^\x00-\xff]/.test(cookie)) {
      throw new Error("Cookie 含非法字符，请重新从浏览器复制原始 Cookie");
    }
    return cookie;
  }

  commonHeaders(cookie) {
    return {
      "Accept": "application/json, text/plain, */*",
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      "Cookie": cookie,
      "Referer": "https://www.baidu.com/",
      "User-Agent": "Mozilla/5.0 (Linux; Android 12; Pixel 5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36",
    };
  }

  async apiGet(url, cookie) {
    return get(url, {
      headers: this.commonHeaders(cookie),
      timeout: this.siteConfig.timeout || 30000,
      retries: 0,
      proxyUrl: this.siteConfig.proxy_url,
    });
  }

  async validateLogin(cookie) {
    const response = await this.apiGet(MOBILE_FORUMS_URL, cookie);
    const data = await readJson(response);
    if (!response.ok) return { ok: false, message: `登录验证失败：HTTP ${response.status}`, status: response.status };
    if (data?.raw !== undefined) return { ok: false, failureType: "challenge", message: "贴吧要求人工确认登录或安全验证，请在相同出口处理", status: response.status };
    if (![0, "0"].includes(data?.no) || !(Number(data?.data?.uid) > 0) || !data?.data?.tbs) {
      const loggedOut = [false, 0, "0"].includes(data?.data?.is_login) || ([0, "0"].includes(data?.no) && [0, "0"].includes(data?.data?.uid));
      return { ok: false, failureType: loggedOut ? "auth_expired" : "unconfirmed", message: loggedOut ? "贴吧登录态已失效，请更新 Cookie" : "贴吧登录接口异常，暂未确认 Cookie 是否失效", status: response.status };
    }
    return { ok: true, tbs: data.data.tbs, status: response.status };
  }

  async getForumList(cookie) {
    // The legacy management page can return an empty shell for valid accounts.
    // The mobile index exposes the authenticated followed-forum list as JSON.
    const mobile = await this.apiGet(MOBILE_FORUMS_URL, cookie);
    if (!mobile.ok) throw new Error(`获取关注贴吧失败：HTTP ${mobile.status}`);
    const data = await readJson(mobile);
    if (data.raw !== undefined) throw new Error("贴吧列表接口返回非 JSON 页面，请在相同出口人工确认登录或安全验证");
    if (![0, "0"].includes(data.no) || !Array.isArray(data.data?.like_forum)) {
      throw new Error("贴吧关注列表接口异常，请确认登录状态后重试");
    }
    const names = data.data.like_forum.map(f => typeof f?.forum_name === "string" ? f.forum_name.trim() : "");
    if (names.some(name => !name)) throw new Error("贴吧关注列表字段异常，已停止签到");
    return unique(names);
  }

  async signForum(cookie, name, tbs) {
    const body = new URLSearchParams({
      kw: name,
      tbs,
      sign: tiebaSignHash(name, tbs),
    });
    const response = await postForm(SIGN_URL, {
      body,
      headers: this.commonHeaders(cookie),
      timeout: this.siteConfig.timeout || 30000,
      proxyUrl: this.siteConfig.proxy_url,
    });
    const data = await readJson(response);
    return { status: response.status, data, code: String(data?.error_code ?? "") };
  }

  async signForumWithRetry(cookie, name, tbs) {
    let lastResult = null;
    let lastError = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const result = await this.signForum(cookie, name, tbs);
        lastResult = result;
        if (["0", "160002", "340006"].includes(result.code)) return result;
      } catch (err) {
        lastError = err;
      }
      if (attempt === 0) await new Promise(resolve => setTimeout(resolve, 500));
    }
    if (lastResult) return lastResult;
    throw lastError || new Error("签到请求失败");
  }

  async signIn() {
    const signTime = formatTime();
    const cookie = this.getCookie();
    if (!cookie) {
      return { success: false, message: "Cookie 未配置，请点击「维护 Cookie」填写百度贴吧 Cookie" };
    }

    logger.info("[百度贴吧] 步骤 1/4：验证百度登录态并获取 tbs");
    const login = await this.validateLogin(cookie);
    if (!login.ok) {
      return {
        success: false,
        message: login.message,
        details: { signTime, status: login.status, failureType: login.failureType || "unconfirmed" },
        steps: [{ label: "验证登录态", ok: false, status: login.status, detail: login.message }],
      };
    }

    logger.info("[百度贴吧] 步骤 2/4：读取关注贴吧列表");
    const forums = await this.getForumList(cookie);
    if (forums.length === 0) {
      return {
        success: false,
        message: "未读取到关注贴吧列表，请确认账号状态或贴吧页面是否变更",
        details: { signTime, username: login.username, totalForums: 0, tiebaTotalForums: 0 },
        steps: [
          { label: "验证登录态", ok: true, status: login.status, detail: login.username || "已登录" },
          { label: "读取关注贴吧列表", ok: false, detail: "列表为空" },
        ],
      };
    }

    logger.info(`[百度贴吧] 步骤 3/4：开始签到 ${forums.length} 个贴吧`);
    const stats = {
      signTime,
      username: login.username,
      total: forums.length,
      successCount: 0,
      alreadySignedCount: 0,
      shieldedCount: 0,
      failedCount: 0,
    };
    const failedForums = [];
    for (const forum of forums) {
      try {
        const signed = await this.signForumWithRetry(cookie, forum, login.tbs);
        if (signed.code === "0") stats.successCount += 1;
        else if (signed.code === "160002") stats.alreadySignedCount += 1;
        else if (signed.code === "340006") stats.shieldedCount += 1;
        else {
          stats.failedCount += 1;
          failedForums.push(`${forum}:${signed.code || signed.status}`);
        }
      } catch (err) {
        stats.failedCount += 1;
        failedForums.push(`${forum}:${err.message}`);
      }
    }

    logger.info("[百度贴吧] 步骤 4/4：汇总签到结果");
    const completed = stats.successCount + stats.alreadySignedCount + stats.shieldedCount;
    const success = stats.total > 0 && completed === stats.total;
    return {
      success,
      message: resultMessage(stats),
      details: {
        signTime,
        username: stats.username,
        totalForums: stats.total,
        tiebaTotalForums: stats.total,
        successCount: stats.successCount,
        tiebaSuccessCount: stats.successCount,
        alreadySignedCount: stats.alreadySignedCount,
        tiebaAlreadySignedCount: stats.alreadySignedCount,
        shieldedCount: stats.shieldedCount,
        tiebaShieldedCount: stats.shieldedCount,
        failedCount: stats.failedCount,
        tiebaFailedCount: stats.failedCount,
        checkinAction: stats.successCount > 0 ? "signed" : (stats.alreadySignedCount > 0 ? "already_signed" : "failed"),
        failedForums: failedForums.slice(0, 10),
      },
      steps: [
        { label: "验证登录态", ok: true, status: login.status, detail: stats.username || "已登录" },
        { label: "读取关注贴吧列表", ok: true, detail: `${stats.total} 个贴吧` },
        { label: "提交贴吧签到", ok: success, detail: `成功 ${stats.successCount}，已签到 ${stats.alreadySignedCount}，屏蔽 ${stats.shieldedCount}，失败 ${stats.failedCount}` },
        { label: "汇总结果", ok: success, detail: failedForums.length ? failedForums.slice(0, 5).join("；") : "全部处理完成" },
      ],
    };
  }

  formatResult(result) {
    const icon = result.success ? "✅" : "❌";
    return `${icon} ${this.name}\n📝 ${result.message}`;
  }
}
