// ============================================================
// tieba — 百度贴吧每日签到 driver
// ============================================================

import { createHash } from "node:crypto";
import iconv from "iconv-lite";
import BaseDriver from "./base.js";
import { get, postForm } from "../utils/http.js";
import logger from "../utils/logger.js";

const TBS_URL = "http://tieba.baidu.com/dc/common/tbs";
const LOGIN_INFO_URL = "https://zhidao.baidu.com/api/loginInfo";
const MY_LIKE_URL = "https://tieba.baidu.com/f/like/mylike?&pn=";
const SIGN_URL = "http://c.tieba.baidu.com/c/c/forum/sign";

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

async function readText(response) {
  const buffer = Buffer.from(await response.arrayBuffer());
  return iconv.decode(buffer, "gbk");
}

async function readJson(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function parseLastPage(html = "") {
  const match = String(html).match(/\/f\/like\/mylike\?&pn=(\d+)[^>]*>尾页/s);
  const page = Number.parseInt(match?.[1] || "1", 10);
  return Number.isFinite(page) && page > 0 ? page : 1;
}

function parseForumNames(html = "") {
  const names = [];
  const pattern = /<a[^>]+href="\/f\?kw=[^"]*"[^>]+title="([^"]+)"/g;
  for (const match of String(html).matchAll(pattern)) {
    const name = String(match[1] || "").trim();
    if (name) names.push(name);
  }
  return names;
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
    const response = await this.apiGet(TBS_URL, cookie);
    const data = await readJson(response);
    if (!response.ok) {
      return { ok: false, message: `登录验证失败：HTTP ${response.status}`, status: response.status, raw: data };
    }
    if (Number(data?.is_login || 0) === 0 || !data?.tbs) {
      return { ok: false, message: "登录失败，Cookie 可能已过期", status: response.status, raw: data };
    }

    let username = "";
    try {
      const userResponse = await this.apiGet(LOGIN_INFO_URL, cookie);
      const userData = await readJson(userResponse);
      username = userData?.userName || userData?.username || "";
    } catch {
      username = "";
    }

    return { ok: true, tbs: data.tbs, username, status: response.status, raw: data };
  }

  async getForumList(cookie) {
    const first = await this.apiGet(`${MY_LIKE_URL}1`, cookie);
    if (!first.ok) throw new Error(`获取贴吧列表失败：HTTP ${first.status}`);
    const firstHtml = await readText(first);
    const lastPage = parseLastPage(firstHtml);
    const names = parseForumNames(firstHtml);

    for (let page = 2; page <= lastPage; page++) {
      const response = await this.apiGet(`${MY_LIKE_URL}${page}`, cookie);
      if (!response.ok) {
        logger.warn(`[百度贴吧] 获取第 ${page} 页关注贴吧失败：HTTP ${response.status}`);
        continue;
      }
      names.push(...parseForumNames(await readText(response)));
    }

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
        details: { signTime, status: login.status },
        steps: [{ label: "验证登录态", ok: false, status: login.status, detail: login.message }],
      };
    }

    logger.info("[百度贴吧] 步骤 2/4：读取关注贴吧列表");
    const forums = await this.getForumList(cookie);
    if (forums.length === 0) {
      return {
        success: false,
        message: "未读取到关注贴吧列表，请确认账号状态或贴吧页面是否变更",
        details: { signTime, username: login.username, totalForums: 0 },
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
        successCount: stats.successCount,
        alreadySignedCount: stats.alreadySignedCount,
        shieldedCount: stats.shieldedCount,
        failedCount: stats.failedCount,
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
