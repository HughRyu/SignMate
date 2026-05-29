// ============================================================
// server — Express 管理面板服务器
// 端口: 9999
// 提供: 仪表盘页面 + REST API
// ============================================================

import express from "express";
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import logger from "./utils/logger.js";
import { loadConfig, runSingle, runAll } from "./runner.js";
import { notifier } from "./notify.js";
import * as store from "./store.js";
import { applySiteProxyMode, getGlobalProxy, setGlobalProxy, siteProxyMode, testDirect, testProxy } from "./utils/proxy.js";

const PORT = parseInt(process.env.WEB_PORT || "9999", 10);
const WEB_DIR = join(import.meta.dirname, "web");
const CONFIG_DIR = join(import.meta.dirname, "..", "config");
const SECRETS_PATH = join(CONFIG_DIR, "secrets.yaml");
const SITES_PATH = join(CONFIG_DIR, "sites.yaml");


// ---- Cookie / secrets helpers ----

function readSitesRaw() {
  return parse(readFileSync(SITES_PATH, "utf-8")) || { sites: {} };
}

function writeSitesRaw(sitesRaw) {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(SITES_PATH, stringify(sitesRaw), "utf-8");
}

function normalizeSiteKey(value = "") {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function findSiteKey(sitesObj, siteName) {
  return sitesObj[siteName]
    ? siteName
    : Object.keys(sitesObj).find(k => sitesObj[k]?.driver === siteName);
}

function isPlaceholderSecret(value = "") {
  return !value || value.includes("<YOUR_") || value.includes("...") || value.includes("…") || value === "session=;";
}

function hasInvalidCookieChars(value = "") {
  return /[^\x00-\xff]/.test(value);
}

function normalizeSessionValue(value = "") {
  let text = String(value || "").trim();
  if (!text) return "";
  // 兼容用户在“仅 session 值”里粘贴 `session=xxxx` 或完整 Cookie。
  const match = text.match(/(?:^|;|\n|\r)\s*session=([^;\s]+)/i);
  if (match) return match[1].trim();
  return text.replace(/^session=/i, "").replace(/;.*$/, "").trim();
}

function normalizeCookieValue(value = "") {
  let text = String(value || "").trim();
  if (!text) return "";
  // 浏览器/插件复制出来有时是一行一个 key=value，这里统一转成 HTTP Cookie header 需要的分号格式。
  return text
    .split(/[\r\n]+/)
    .map(part => part.trim().replace(/;+$/, ""))
    .filter(Boolean)
    .join("; ");
}

function readSecrets() {
  if (!existsSync(SECRETS_PATH)) return {};
  return parse(readFileSync(SECRETS_PATH, "utf-8")) || {};
}

function writeSecrets(secrets) {
  mkdirSync(CONFIG_DIR, { recursive: true });
  const header = `# ============================================================\n# signmate — Web 管理面板维护的凭据配置\n# ⚠️ 敏感信息：不要提交到公开仓库\n# ============================================================\n\n`;
  writeFileSync(SECRETS_PATH, header + stringify(secrets), "utf-8");
}

function maskSecret(value = "") {
  if (!value) return "";
  if (value.length <= 16) return `${value.slice(0, 4)}****${value.slice(-4)}`;
  return `${value.slice(0, 10)}…${value.slice(-8)}`;
}

// ---- 日志内存缓存 ----
const logBuffer = [];
const MAX_LOG_LINES = 500;

/** 拦截 console.log 捕获日志到内存 */
function installLogCapture() {
  const originalLog = console.log.bind(console);
  console.log = (...args) => {
    const msg = args.map(a => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
    logBuffer.push({ time: new Date().toISOString(), msg });
    if (logBuffer.length > MAX_LOG_LINES) logBuffer.shift();
    originalLog(...args);
  };
}

// ---- 创建 App ----
export async function startServer() {
  installLogCapture();

  const app = express();

  // 解析 JSON body
  app.use(express.json());

  // 静态文件
  app.use(express.static(WEB_DIR));
  app.get("/", (_req, res) => res.sendFile(join(WEB_DIR, "index.html")));

  // ========================================
  // API: 站点列表 & 状态
  // ========================================
  app.get("/api/sites", async (_req, res) => {
    try {
      const { sites } = loadConfig();
      const statusMap = await store.getSitesStatus();

      const statusLookup = {};
      for (const s of statusMap) {
        statusLookup[s.site] = s;
      }

      const secrets = readSecrets();
      const result = sites.map(site => {
        const key = site.driver;
        const name = site.note || key;
        const status = statusLookup[name] || {};
        const siteSecrets = secrets[key] || {};
        const hasCookie = !isPlaceholderSecret(siteSecrets.cookie || siteSecrets.session_only || "");
        const cookieMessage = hasCookie ? "" : "⚠️ Cookie 未配置，请点击下方「维护 Cookie」";
        const staleConfigMessage = typeof status.lastMessage === "string" && (
          status.lastMessage.includes("Cookie 未配置") ||
          status.lastMessage.includes("ByteString") ||
          status.lastMessage.includes("8230") ||
          status.lastMessage.includes("invalid header value") ||
          status.lastMessage.includes("Headers.append")
        );
        return {
          key,
          name,
          note: site.note || "",
          enabled: site.enabled !== false,
          schedule: site.schedule || "",
          proxyMode: site.proxy_mode || siteProxyMode(site),
          proxyGlobalEnabled: site.proxy_global_enabled === true,
          hasCookie,
          lastSuccess: hasCookie && staleConfigMessage ? null : (hasCookie ? (status.lastSuccess ?? null) : false),
          lastMessage: cookieMessage || (staleConfigMessage ? "Cookie 已保存，可点击立即签到" : status.lastMessage || ""),
          lastTime: staleConfigMessage ? "" : (status.lastTime || ""),
          details: staleConfigMessage ? null : (status.details || null),
          steps: staleConfigMessage ? [] : (status.steps || []),
        };
      });

      res.json({ ok: true, data: result });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.post("/api/sites/:siteName/enabled", (req, res) => {
    try {
      const siteName = req.params.siteName;
      const enabled = req.body?.enabled !== false;
      const sitesRaw = readSitesRaw();
      const sitesObj = sitesRaw.sites || {};
      const key = findSiteKey(sitesObj, siteName);

      if (!key) {
        return res.status(404).json({ ok: false, error: `站点 "${siteName}" 不存在` });
      }

      sitesObj[key].enabled = enabled;
      sitesRaw.sites = sitesObj;
      writeSitesRaw(sitesRaw);
      res.json({ ok: true, data: { site: key, enabled } });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });


  app.post("/api/sites", (req, res) => {
    try {
      const body = req.body || {};
      const key = normalizeSiteKey(body.key || body.driver || body.name || body.note);
      if (!key) {
        return res.status(400).json({ ok: false, error: "站点标识不能为空，只能包含字母、数字、-、_" });
      }

      const sitesRaw = readSitesRaw();
      const sitesObj = sitesRaw.sites || {};
      if (sitesObj[key]) {
        return res.status(409).json({ ok: false, error: `站点 "${key}" 已存在` });
      }

      const driver = normalizeSiteKey(body.driver || key);
      if (!driver) {
        return res.status(400).json({ ok: false, error: "driver 不能为空" });
      }

      sitesObj[key] = {
        enabled: body.enabled !== false,
        driver,
        schedule: String(body.schedule || "0 9 * * *").trim(),
        note: String(body.note || body.name || key).trim(),
        notify: body.notify !== false,
        retry: Number.isFinite(Number(body.retry)) ? Number(body.retry) : 2,
        retry_delay_ms: Number.isFinite(Number(body.retryDelayMs)) ? Number(body.retryDelayMs) : 10000,
        timeout: Number.isFinite(Number(body.timeout)) ? Number(body.timeout) : 30000,
        base_url: String(body.baseUrl || "https://example.com").trim(),
      };

      if (body.proxyMode && ["auto", "on", "off"].includes(body.proxyMode)) {
        applySiteProxyMode(sitesObj[key], body.proxyMode);
      }
      if (body.signinMode) sitesObj[key].signin_mode = String(body.signinMode).trim();

      sitesRaw.sites = sitesObj;
      writeSitesRaw(sitesRaw);
      res.json({ ok: true, data: { site: key, config: sitesObj[key] } });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.patch("/api/sites/:siteName", (req, res) => {
    try {
      const siteName = req.params.siteName;
      const body = req.body || {};
      const sitesRaw = readSitesRaw();
      const sitesObj = sitesRaw.sites || {};
      const key = findSiteKey(sitesObj, siteName);
      if (!key) {
        return res.status(404).json({ ok: false, error: `站点 "${siteName}" 不存在` });
      }

      const site = sitesObj[key];
      if (Object.prototype.hasOwnProperty.call(body, "enabled")) site.enabled = body.enabled !== false;
      if (Object.prototype.hasOwnProperty.call(body, "schedule")) site.schedule = String(body.schedule || "").trim();
      if (Object.prototype.hasOwnProperty.call(body, "note")) site.note = String(body.note || key).trim();
      if (Object.prototype.hasOwnProperty.call(body, "baseUrl")) site.base_url = String(body.baseUrl || "").trim();
      if (Object.prototype.hasOwnProperty.call(body, "timeout")) site.timeout = Number(body.timeout) || site.timeout || 30000;
      if (Object.prototype.hasOwnProperty.call(body, "retry")) site.retry = Number(body.retry) || 0;
      if (Object.prototype.hasOwnProperty.call(body, "signinMode")) site.signin_mode = String(body.signinMode || "").trim();
      if (body.proxyMode && ["auto", "on", "off"].includes(body.proxyMode)) applySiteProxyMode(site, body.proxyMode);

      sitesObj[key] = site;
      sitesRaw.sites = sitesObj;
      writeSitesRaw(sitesRaw);
      res.json({ ok: true, data: { site: key, config: site } });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.delete("/api/sites/:siteName", (req, res) => {
    try {
      const siteName = req.params.siteName;
      const sitesRaw = readSitesRaw();
      const sitesObj = sitesRaw.sites || {};
      const key = findSiteKey(sitesObj, siteName);
      if (!key) {
        return res.status(404).json({ ok: false, error: `站点 "${siteName}" 不存在` });
      }

      const removed = sitesObj[key];
      delete sitesObj[key];
      sitesRaw.sites = sitesObj;
      writeSitesRaw(sitesRaw);
      res.json({ ok: true, data: { site: key, removed } });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ========================================
  // API: 签到历史
  // ========================================
  app.get("/api/history", async (req, res) => {
    try {
      const site = req.query.site || null;
      const limit = Math.min(parseInt(req.query.limit) || 50, 200);
      const data = await store.getHistory(site, limit);
      res.json({ ok: true, data });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ========================================
  // API: Cookie / 凭据维护
  // ========================================
  app.get("/api/credentials", (_req, res) => {
    try {
      const { sites } = loadConfig();
      const secrets = readSecrets();
      const data = sites.map(site => {
        const key = site.driver;
        const siteSecrets = secrets[key] || {};
        const cookie = siteSecrets.cookie || "";
        const sessionOnly = siteSecrets.session_only || "";
        return {
          key,
          name: site.note || key,
          driver: site.driver,
          enabled: site.enabled !== false,
          cookie,
          cookieMasked: maskSecret(cookie),
          sessionOnly,
          sessionOnlyMasked: maskSecret(sessionOnly),
          hasCookie: !isPlaceholderSecret(cookie || sessionOnly),
        };
      });
      res.json({ ok: true, data });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.post("/api/credentials/:siteName", (req, res) => {
    try {
      const siteName = req.params.siteName;
      let { cookie = "", sessionOnly = "" } = req.body || {};
      cookie = normalizeCookieValue(cookie);
      sessionOnly = normalizeSessionValue(sessionOnly);
      if (hasInvalidCookieChars(cookie) || hasInvalidCookieChars(sessionOnly)) {
        return res.status(400).json({ ok: false, error: "Cookie/session 含非法字符（例如中文省略号 …），请重新从浏览器复制原始值" });
      }
      const secrets = readSecrets();
      const current = secrets[siteName] || {};

      secrets[siteName] = {
        ...current,
        ...(cookie.trim() ? { cookie: cookie.trim() } : {}),
        ...(sessionOnly.trim() ? { session_only: sessionOnly.trim() } : {}),
      };

      if (!cookie.trim() && Object.prototype.hasOwnProperty.call(secrets[siteName], "cookie")) {
        delete secrets[siteName].cookie;
      }
      if (!sessionOnly.trim() && Object.prototype.hasOwnProperty.call(secrets[siteName], "session_only")) {
        delete secrets[siteName].session_only;
      }

      writeSecrets(secrets);
      res.json({ ok: true, data: { site: siteName, hasCookie: Boolean(secrets[siteName].cookie || secrets[siteName].session_only) } });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ========================================
  // API: 代理设置
  // ========================================
  app.get("/api/proxy", (_req, res) => {
    try {
      const sitesRaw = readSitesRaw();
      const proxy = getGlobalProxy(sitesRaw);
      const sites = Object.entries(sitesRaw.sites || {}).map(([key, site]) => ({
        key,
        driver: site.driver || key,
        name: site.note || site.driver || key,
        proxyMode: siteProxyMode(site),
      }));
      res.json({ ok: true, data: { ...proxy, sites } });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.post("/api/proxy", (req, res) => {
    try {
      const sitesRaw = readSitesRaw();
      setGlobalProxy(sitesRaw, req.body || {});
      writeSitesRaw(sitesRaw);
      res.json({ ok: true, data: getGlobalProxy(sitesRaw) });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.post("/api/sites/:siteName/proxy", (req, res) => {
    try {
      const siteName = req.params.siteName;
      const mode = req.body?.mode || "auto";
      if (!["auto", "on", "off"].includes(mode)) {
        return res.status(400).json({ ok: false, error: "代理模式必须是 auto / on / off" });
      }
      const sitesRaw = readSitesRaw();
      const sitesObj = sitesRaw.sites || {};
      const key = findSiteKey(sitesObj, siteName);
      if (!key) {
        return res.status(404).json({ ok: false, error: `站点 "${siteName}" 不存在` });
      }
      applySiteProxyMode(sitesObj[key], mode);
      sitesRaw.sites = sitesObj;
      writeSitesRaw(sitesRaw);
      res.json({ ok: true, data: { site: key, mode } });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.post("/api/proxy/test", async (req, res) => {
    try {
      const sitesRaw = readSitesRaw();
      const current = getGlobalProxy(sitesRaw);
      const proxyUrl = req.body?.url ?? current.url;
      const testUrl = req.body?.testUrl || current.testUrl;
      const [direct, proxy] = await Promise.all([
        testDirect(testUrl, 8000),
        proxyUrl ? testProxy(proxyUrl, testUrl, 10000) : Promise.resolve({ ok: false, error: "代理地址为空" }),
      ]);
      res.json({ ok: true, data: { testUrl, direct, proxy } });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ========================================
  // API: 日志
  // ========================================
  app.get("/api/logs", (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 100, 500);
    const logs = logBuffer.slice(-limit);
    res.json({ ok: true, data: logs });
  });

  // ========================================
  // API: 手动触发签到
  // ========================================
  app.post("/api/signin/:siteName?", async (req, res) => {
    try {
      const { sites, secrets } = loadConfig();
      const siteName = req.params.siteName;

      if (siteName) {
        // 触发单个站点
        const site = sites.find(s => s.driver === siteName);
        if (!site) {
          return res.status(404).json({ ok: false, error: `站点 "${siteName}" 不存在` });
        }
        logger.info(`[手动] 开始签到: ${site.note || siteName}`);
        const result = await runSingle(site, secrets);
        await store.addEntry(site.note || siteName, result);
        res.json({ ok: true, data: { site: site.note || siteName, ...result } });
      } else {
        // 触发全部
        logger.info("[手动] 开始全部签到");
        const results = await runAll();

        // 记录到 store
        for (const r of results) {
          await store.addEntry(r.site, r);
        }

        res.json({ ok: true, data: results });
      }
    } catch (err) {
      logger.error(`[手动签到] 异常: ${err.message}`);
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ========================================
  // API: Server 信息
  // ========================================
  app.get("/api/info", (_req, res) => {
    res.json({
      ok: true,
      data: {
        version: "1.0.0",
        uptime: Math.floor(process.uptime()),
        timezone: process.env.TZ || "UTC",
        nodeVersion: process.version,
        memoryMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
      },
    });
  });

  // ---- 启动 ----
  return new Promise((resolve, reject) => {
    const server = app.listen(PORT, "0.0.0.0", () => {
      logger.info(`[Web] 管理面板已启动 → http://0.0.0.0:${PORT}`);
      resolve(server);
    });
    server.on("error", reject);
  });
}
