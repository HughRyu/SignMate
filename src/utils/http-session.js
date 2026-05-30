// ============================================================
// http-session — Cookie-based HTTP session helpers
//
// Experimental API/protocol foundation. Keeps requests close to a
// browser session without launching Playwright: shared Cookie header,
// Chromium-like headers, optional proxy, timeout, and safe text/json
// parsing. Do not log Cookie values.
// ============================================================

import { ProxyAgent } from "undici";
import { normalizeProxyUrl } from "./proxy.js";

const DEFAULT_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";

export function normalizeCookieHeader(value = "") {
  return String(value || "")
    .trim()
    .split(/[\r\n]+/)
    .map(part => part.trim().replace(/;+$/g, ""))
    .filter(Boolean)
    .join("; ");
}

export function getCookieForSite(secrets = {}, siteConfig = {}) {
  const key = siteConfig.key || siteConfig.driver || "website";
  const siteSecrets = secrets?.[key] || secrets?.[siteConfig.driver] || {};
  const cookie = normalizeCookieHeader(siteSecrets.cookie || "");
  if (!cookie || cookie.includes("<YOUR_")) return "";
  if (/[^\x00-\xff]/.test(cookie)) throw new Error("Cookie 含非法字符，请重新从浏览器复制原始 Cookie");
  return cookie;
}

export function createHttpSession({ baseUrl, cookie = "", proxyUrl = "", timeout = 30_000, userAgent = DEFAULT_UA } = {}) {
  if (!baseUrl) throw new Error("baseUrl is required");
  const origin = new URL(baseUrl).origin;
  const normalizedCookie = normalizeCookieHeader(cookie);
  const proxy = normalizeProxyUrl(proxyUrl || "");
  const dispatcher = proxy ? new ProxyAgent(proxy) : undefined;

  const buildUrl = path => new URL(path || "/", origin).toString();
  const request = async (path, options = {}) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Number(options.timeout || timeout));
    try {
      const headers = {
        "user-agent": userAgent,
        "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.8,*/*;q=0.7",
        "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
        "cache-control": "no-cache",
        "pragma": "no-cache",
        ...(normalizedCookie ? { cookie: normalizedCookie } : {}),
        ...(options.headers || {}),
      };
      const url = /^https?:\/\//i.test(String(path || "")) ? String(path) : buildUrl(path);
      return await fetch(url, {
        method: options.method || "GET",
        headers,
        body: options.body,
        redirect: options.redirect || "follow",
        dispatcher,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  };

  const get = (path, options = {}) => request(path, { ...options, method: "GET" });
  const postForm = (path, form = {}, options = {}) => {
    const body = form instanceof URLSearchParams ? form : new URLSearchParams(form);
    return request(path, {
      ...options,
      method: "POST",
      body: body.toString(),
      headers: {
        "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
        "x-requested-with": "XMLHttpRequest",
        "referer": buildUrl(options.referer || "/"),
        ...(options.headers || {}),
      },
    });
  };

  return { origin, cookie: normalizedCookie, proxyUrl: proxy, get, postForm, request, buildUrl };
}

export async function readText(response) {
  try {
    const buffer = await response.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    const head = new TextDecoder("utf-8", { fatal: false }).decode(bytes.slice(0, Math.min(bytes.length, 4096)));
    const contentType = response.headers?.get?.("content-type") || "";
    const charset = contentType.match(/charset=([^;\s]+)/i)?.[1]
      || head.match(/<meta[^>]+charset=["']?([^"'\s/>]+)/i)?.[1]
      || head.match(/<meta[^>]+content=["'][^"']*charset=([^"'\s;]+)/i)?.[1]
      || "utf-8";
    const normalized = /^(gbk|gb2312|gb18030)$/i.test(charset) ? "gb18030" : charset;
    return new TextDecoder(normalized, { fatal: false }).decode(bytes);
  } catch {
    return "";
  }
}

export async function readJson(response) {
  const text = await readText(response);
  try { return { json: JSON.parse(text), text }; } catch { return { json: null, text }; }
}

export function htmlToText(html = "") {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>|<\/div>|<\/li>|<\/tr>|<\/td>|<\/th>|<\/h[1-6]>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;?/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, " ")
    .trim();
}

export function pageTitleFromHtml(html = "") {
  return String(html || "").match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/\s+/g, " ").trim() || "";
}
