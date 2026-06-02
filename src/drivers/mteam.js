// ============================================================
// mteam — M-Team API token driver
//
// M-Team 新站点登录态不依赖传统 Cookie；后台“存取令牌”通过
// x-api-key 请求头访问 API。当前实现验证令牌、采集账号/做种/魔力
// 数据，并作为 PT 保活/状态采集处理；若后续确认官方签到接口，
// 可在本 driver 中追加精确签到动作，避免误报。
// ============================================================

import BaseDriver from "./base.js";
import logger from "../utils/logger.js";
import { ProxyAgent } from "undici";
import { normalizeProxyUrl } from "../utils/proxy.js";

const DEFAULT_API_BASE = "https://api.m-team.cc/api";
const DEFAULT_UA = "SignMate/1.0 (+https://github.com/openclaw/openclaw)";

function pickSiteSecrets(secrets = {}, siteConfig = {}) {
  const key = siteConfig.key || siteConfig.driver || "mteam";
  return secrets?.[key] || secrets?.[siteConfig.driver] || {};
}

function getApiToken(secrets = {}, siteConfig = {}) {
  const siteSecrets = pickSiteSecrets(secrets, siteConfig);
  return String(
    siteSecrets.api_key
    || siteSecrets.apiKey
    || siteSecrets.access_token
    || siteSecrets.accessToken
    || siteSecrets.token
    || ""
  ).trim();
}

function maskToken(token = "") {
  const value = String(token || "");
  if (!value) return "未配置";
  if (value.length <= 10) return "已配置";
  return `${value.slice(0, 4)}…${value.slice(-4)}（长度 ${value.length}）`;
}

function formatBytes(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n) || n < 0) return "-";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(i === 0 ? 0 : 2)} ${units[i]}`;
}

function formatNumber(value) {
  const n = Number(String(value ?? "").replace(/,/g, ""));
  return Number.isFinite(n) ? n.toLocaleString("zh-CN") : "-";
}

function unwrapData(payload) {
  if (!payload || typeof payload !== "object") return null;
  if (payload.code === "0" || payload.code === 0) return payload.data || {};
  return null;
}

function failMessage(payload, fallback = "请求失败") {
  if (!payload || typeof payload !== "object") return fallback;
  return payload.message || payload.msg || fallback;
}

async function readJsonSafe(response) {
  const text = await response.text().catch(() => "");
  try { return { json: JSON.parse(text), text }; }
  catch { return { json: null, text }; }
}

export default class MTeamDriver extends BaseDriver {
  getApiToken() {
    return getApiToken(this.secrets, this.siteConfig);
  }

  apiBase() {
    return String(this.siteConfig.api_base_url || DEFAULT_API_BASE).replace(/\/+$/, "");
  }

  async postApi(path, body = {}) {
    const token = this.getApiToken();
    const timeout = Number(this.siteConfig.timeout || 30_000);
    const proxy = normalizeProxyUrl(this.siteConfig.proxy_url || "");
    const dispatcher = proxy ? new ProxyAgent(proxy) : undefined;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch(`${this.apiBase()}${path}`, {
        method: "POST",
        headers: {
          "user-agent": DEFAULT_UA,
          "accept": "application/json, text/plain, */*",
          "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
          "content-type": "application/json",
          "x-api-key": token,
        },
        body: JSON.stringify(body || {}),
        dispatcher,
        signal: controller.signal,
      });
      return { response, ...(await readJsonSafe(response)) };
    } finally {
      clearTimeout(timer);
    }
  }

  async signIn() {
    const token = this.getApiToken();
    const steps = [];
    if (!token) {
      return {
        success: false,
        message: "存取令牌未配置，请在 secrets.yaml 中为 M-Team 配置 api_key/accessToken",
        details: { tokenConfigured: false, kind: "visit" },
        steps: [{ label: "检查存取令牌", ok: false, detail: "未配置" }],
      };
    }

    logger.info(`[M-Team] 步骤 1/3：检查存取令牌（${maskToken(token)}）`);
    steps.push({ label: "检查存取令牌", ok: true, detail: `已配置，长度 ${token.length}` });

    logger.info("[M-Team] 步骤 2/3：读取会员资料");
    const profileResult = await this.postApi("/member/profile", {});
    const profilePayload = profileResult.json;
    const profile = unwrapData(profilePayload);
    if (!profile) {
      const message = failMessage(profilePayload, `会员资料接口异常：HTTP ${profileResult.response?.status || 0}`);
      return {
        success: false,
        message,
        details: { tokenConfigured: true, tokenLength: token.length, apiStatus: profileResult.response?.status || 0, kind: "visit" },
        steps: [...steps, { label: "读取会员资料", ok: false, status: profileResult.response?.status || 0, detail: message }],
      };
    }
    steps.push({ label: "读取会员资料", ok: true, detail: profile.username || profile.id || "成功" });

    logger.info("[M-Team] 步骤 3/3：读取做种/下载状态");
    const peerResult = await this.postApi("/tracker/myPeerStatus", {}).catch(err => ({ error: err }));
    const peer = peerResult.error ? null : unwrapData(peerResult.json);
    steps.push({ label: "读取做种/下载状态", ok: !peerResult.error && !!peer, detail: peerResult.error ? peerResult.error.message : `做种 ${peer?.seeder ?? "-"} / 下载 ${peer?.leecher ?? "-"}` });

    const status = profile.memberStatus || {};
    const counts = profile.memberCount || {};
    const username = profile.username || profile.name || "-";
    const uploaded = counts.uploaded ?? status.uploaded;
    const downloaded = counts.downloaded ?? status.downloaded;
    const bonus = counts.bonus ?? status.bonus;
    const ratio = Number(downloaded || 0) > 0 ? (Number(uploaded || 0) / Number(downloaded || 1)).toFixed(3) : "∞";
    const seeder = peer?.seeder ?? profile.peerCount?.seeder ?? "-";
    const leecher = peer?.leecher ?? profile.peerCount?.leecher ?? "-";

    const message = `保活完成，API 令牌有效；用户 ${username}；魔力 ${formatNumber(bonus)}；上传 ${formatBytes(uploaded)} / 下载 ${formatBytes(downloaded)}；分享率 ${ratio}；做种 ${seeder} / 下载中 ${leecher}`;
    return {
      success: true,
      message,
      details: {
        kind: "visit",
        checkinAction: "api_token_keepalive",
        tokenConfigured: true,
        tokenLength: token.length,
        username,
        userId: profile.id || null,
        bonus,
        uploaded,
        downloaded,
        ratio,
        seeder,
        leecher,
        allowDownload: profile.allowDownload,
        status: profile.status,
        enabled: profile.enabled,
      },
      steps,
    };
  }

  formatResult(result) {
    const icon = result.success ? "✅" : "❌";
    return `${icon} ${this.name}: ${result.message}`;
  }
}
