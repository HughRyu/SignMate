// ============================================================
// proxy — 代理配置读取、规范化与连通性检测
// ============================================================

import { request as undiciRequest, ProxyAgent } from "undici";

const DEFAULT_CONNECTIVITY_URL = "https://www.nodeseek.com/";

export function normalizeProxyUrl(value = "") {
  const text = String(value || "").trim();
  if (!text) return "";
  if (/^(https?|socks5h?|socks4):\/\//i.test(text)) return text;
  // 前台常见输入是 host:port，默认按 HTTP 代理处理。
  return `http://${text}`;
}

export function splitLines(value = "") {
  if (Array.isArray(value)) return value.map(v => String(v || "").trim()).filter(Boolean);
  return String(value || "").split(/[\r\n,]+/).map(v => v.trim()).filter(Boolean);
}

export function getGlobalProxy(sitesRaw = {}) {
  const proxy = sitesRaw.proxy || sitesRaw.global_proxy || {};
  const urls = splitLines(proxy.urls || proxy.url || proxy.http || proxy.https).map(normalizeProxyUrl).filter(Boolean);
  const testUrls = splitLines(proxy.test_urls || proxy.test_url || DEFAULT_CONNECTIVITY_URL);
  return {
    enabled: urls.length > 0,
    url: urls[0] || "",
    urls,
    autoFallback: proxy.auto_fallback !== false,
    testUrl: testUrls[0] || DEFAULT_CONNECTIVITY_URL,
    testUrls: testUrls.length ? testUrls : [DEFAULT_CONNECTIVITY_URL],
    health: proxy.health || null,
  };
}

export function setGlobalProxy(sitesRaw, settings = {}) {
  const current = sitesRaw.proxy || {};
  const urls = splitLines(settings.urls ?? settings.url ?? current.urls ?? current.url).map(normalizeProxyUrl).filter(Boolean);
  const testUrls = splitLines(settings.testUrls ?? settings.testUrl ?? current.test_urls ?? current.test_url ?? DEFAULT_CONNECTIVITY_URL);
  sitesRaw.proxy = {
    ...current,
    enabled: urls.length > 0,
    url: urls[0] || "",
    urls,
    auto_fallback: Object.prototype.hasOwnProperty.call(settings, "autoFallback") ? settings.autoFallback !== false : current.auto_fallback !== false,
    test_url: testUrls[0] || DEFAULT_CONNECTIVITY_URL,
    test_urls: testUrls.length ? testUrls : [DEFAULT_CONNECTIVITY_URL],
  };
  return sitesRaw;
}

export function siteProxyMode(site = {}) {
  const raw = site.proxy;
  if (raw === true) return "on";
  if (raw === false) return "off";
  if (raw === "on" || raw === "off" || raw === "auto") return raw;
  return "auto";
}

export function applySiteProxyMode(site, mode = "auto") {
  if (mode === "on" || mode === "off" || mode === "auto") {
    site.proxy = mode;
  }
  return site;
}


export async function testProxyPool(proxyUrls = [], testUrls = [DEFAULT_CONNECTIVITY_URL], timeoutMs = 10000) {
  const urls = splitLines(proxyUrls).map(normalizeProxyUrl).filter(Boolean);
  const targets = splitLines(testUrls).length ? splitLines(testUrls) : [DEFAULT_CONNECTIVITY_URL];
  // 多测试 URL 中至少一个通过即可认为该代理地址可用，避免目标站点差异导致整条代理被误判失效。
  const requiredPassCount = 1;
  const proxies = await Promise.all(urls.map(async (proxyUrl) => {
    const tests = await Promise.all(targets.map(async (testUrl) => ({ testUrl, ...(await testProxy(proxyUrl, testUrl, timeoutMs)) })));
    const passCount = tests.filter(t => t.ok).length;
    return { url: proxyUrl, ok: passCount >= requiredPassCount, passCount, requiredPassCount, tests };
  }));
  return {
    checkedAt: new Date().toISOString(),
    ok: proxies.some(p => p.ok),
    requiredPassCount,
    proxies,
    usableUrls: proxies.filter(p => p.ok).map(p => p.url),
  };
}

export function selectProxyUrl(proxy = {}, preferred = "") {
  const preferredUrl = normalizeProxyUrl(preferred);
  const healthUrls = proxy.health?.usableUrls || [];
  if (preferredUrl && (!healthUrls.length || healthUrls.includes(preferredUrl))) return preferredUrl;
  if (healthUrls.length) return healthUrls[0];
  return (proxy.urls && proxy.urls[0]) || proxy.url || "";
}

export async function testDirect(url = DEFAULT_CONNECTIVITY_URL, timeoutMs = 8000) {
  return timedRequest(url, { timeoutMs });
}

export async function testProxy(proxyUrl, url = DEFAULT_CONNECTIVITY_URL, timeoutMs = 10000) {
  const normalized = normalizeProxyUrl(proxyUrl);
  if (!normalized) throw new Error("代理地址为空");
  return timedRequest(url, { timeoutMs, dispatcher: new ProxyAgent(normalized) });
}

async function timedRequest(url, { timeoutMs, dispatcher } = {}) {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || 10000);
  const headers = { "User-Agent": "signmate-connectivity-check/1.0" };
  const once = async (method) => {
    const res = await undiciRequest(url, { method, dispatcher, signal: controller.signal, headers });
    // 消费/释放响应体，避免连接泄漏；GET 只用于探测主页是否能打开，不解析签到业务。
    await res.body?.dump?.();
    return res.statusCode;
  };
  try {
    let status = await once("HEAD");
    // 有些站点/CDN 禁 HEAD，但浏览器 GET 首页是正常的。用 GET 兜底更符合“能正常打开主页”。
    if ([403, 405, 501].includes(status)) status = await once("GET");
    return {
      ok: status >= 200 && status < 500,
      status,
      ms: Date.now() - started,
    };
  } catch (err) {
    return {
      ok: false,
      error: formatProxyError(err),
      ms: Date.now() - started,
    };
  } finally {
    clearTimeout(timer);
  }
}

export function formatProxyError(err) {
  const cause = err?.cause;
  const errors = cause?.errors || err?.errors || [];
  const networkDetails = errors
    .map(e => [e.code, e.address, e.port].filter(Boolean).join(" "))
    .filter(Boolean)
    .join("; ");

  if (networkDetails) return `${err.message}: ${networkDetails}`;
  if (cause?.code || cause?.address) {
    return `${err.message}: ${[cause.code, cause.address, cause.port].filter(Boolean).join(" ")}`;
  }
  return err?.message || String(err);
}


export function isProxyCacheFresh(checkedAt, maxAgeMs = 3 * 60 * 60 * 1000) {
  if (!checkedAt) return false;
  const ts = Date.parse(checkedAt);
  return Number.isFinite(ts) && Date.now() - ts < maxAgeMs;
}
