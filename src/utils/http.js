// ============================================================
// http — HTTP 请求工具
// 基于 Node.js 内置 fetch，封装通用超时/重试/日志
// ============================================================

import logger from "./logger.js";
import { ProxyAgent } from "undici";
import { normalizeProxyUrl } from "./proxy.js";

const DEFAULT_TIMEOUT = 30_000;
const DEFAULT_RETRY_DELAY = 5_000;

/**
 * 发送 HTTP 请求（带超时和重试）
 *
 * @param {string} url         请求 URL
 * @param {object} options     fetch 选项
 * @param {number} [timeout]   超时（毫秒）
 * @param {number} [retries]   重试次数
 * @param {number} [retryDelay] 重试间隔
 * @returns {Promise<Response>}
 */
export async function request(url, options = {}, timeout = DEFAULT_TIMEOUT, retries = 0, retryDelay = DEFAULT_RETRY_DELAY) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const proxyUrl = normalizeProxyUrl(options.proxyUrl || process.env.SIGNMATE_PROXY_URL || "");
    const fetchOptions = { ...options };
    delete fetchOptions.proxyUrl;
    if (proxyUrl) {
      fetchOptions.dispatcher = new ProxyAgent(proxyUrl);
    }

    const response = await fetch(url, {
      ...fetchOptions,
      signal: controller.signal,
    });
    return response;
  } catch (err) {
    const message = formatFetchError(err);
    if (retries > 0) {
      logger.warn(`[HTTP] 请求失败 (${message}), 剩余重试 ${retries} 次, 等待 ${retryDelay}ms`);
      await sleep(retryDelay);
      return request(url, options, timeout, retries - 1, retryDelay);
    }
    throw new Error(message);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 快捷 POST JSON
 */
export async function postJSON(url, { body = {}, headers = {}, timeout, retries, retryDelay, impersonate, proxyUrl } = {}) {
  const reqHeaders = {
    "Content-Type": "application/json",
    "Accept": "application/json, text/plain, */*",
    ...getImpersonateHeaders(impersonate),
    ...headers,
  };

  const response = await request(
    url,
    {
      method: "POST",
      headers: reqHeaders,
      body: JSON.stringify(body),
      proxyUrl,
    },
    timeout,
    retries,
    retryDelay,
  );

  return response;
}

/**
 * 快捷 POST 表单
 */
export async function postForm(url, { body = new URLSearchParams(), headers = {}, timeout, retries, retryDelay, impersonate, proxyUrl } = {}) {
  const reqHeaders = {
    "Content-Type": "application/x-www-form-urlencoded",
    ...getImpersonateHeaders(impersonate),
    ...headers,
  };

  const response = await request(
    url,
    {
      method: "POST",
      headers: reqHeaders,
      body: body.toString(),
      proxyUrl,
    },
    timeout,
    retries,
    retryDelay,
  );

  return response;
}

/**
 * 快捷 GET 请求
 */
export async function get(url, { headers = {}, timeout, retries, retryDelay, proxyUrl } = {}) {
  const response = await request(
    url,
    { method: "GET", headers, proxyUrl },
    timeout,
    retries,
    retryDelay,
  );

  return response;
}

/**
 * 解析响应为 JSON（安全）
 */
export async function safeJson(res) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * 获取 TLS 指纹模拟对应的 User-Agent 头
 * 如需更深度的 TLS 指纹伪造，可集成 curl-impersonate 或 tls-client
 */
function getImpersonateHeaders(impersonate) {
  if (!impersonate || impersonate === "none") return {};

  const UA_MAP = {
    chrome142: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
    chrome131: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    safari18:  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Safari/605.1.15",
    firefox134: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:134.0) Gecko/20100101 Firefox/134.0",
  };

  const ua = UA_MAP[impersonate];
  if (ua) {
    return { "User-Agent": ua };
  }
  return {};
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}


function formatFetchError(err) {
  const cause = err?.cause;
  const errors = cause?.errors || err?.errors || [];
  const networkDetails = errors
    .map(e => [e.code, e.address, e.port].filter(Boolean).join(" "))
    .filter(Boolean)
    .join("; ");

  if (networkDetails) {
    return `${err.message}: ${networkDetails}`;
  }
  if (cause?.code || cause?.address) {
    return `${err.message}: ${[cause.code, cause.address, cause.port].filter(Boolean).join(" ")}`;
  }
  return err?.message || String(err);
}
