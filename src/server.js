// ============================================================
// server — Express 管理面板服务器
// 端口: 9999
// 提供: 仪表盘页面 + REST API
// ============================================================

import express from "express";
import { readFileSync, existsSync, writeFileSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { join, basename, extname } from "node:path";
import { parse, stringify } from "yaml";
import logger from "./utils/logger.js";
import { loadConfig, runSingle, runAll, getBatchState, requestBatchCancel, resumeInterruptedBatchState } from "./runner.js";
import { notifier, TelegramChannel, BarkChannel } from "./notify.js";
import * as store from "./store.js";
import { applySiteProxyMode, getGlobalProxy, setGlobalProxy, siteProxyMode, testDirect, testProxy, normalizeProxyUrl, testProxyPool, selectProxyUrl, isProxyCacheFresh } from "./utils/proxy.js";
import { ProxyAgent, fetch as undiciFetch } from "undici";
import CryptoJS from "crypto-js";
import { timingSafeEqual, randomBytes } from "node:crypto";
import BUILTIN_SITES from "./builtin-sites.js";

const PORT = parseInt(process.env.WEB_PORT || "9999", 10);
const WEB_DIR = join(import.meta.dirname, "web");
const CONFIG_DIR = join(import.meta.dirname, "..", "config");
const ENV_PATH = join(CONFIG_DIR, "settings.env");
const LEGACY_ENV_PATH = join(import.meta.dirname, "..", ".env");
const SECRETS_PATH = join(CONFIG_DIR, "secrets.yaml");
const NOTIFY_PATH = join(CONFIG_DIR, "notify.yaml");
const SITES_PATH = join(CONFIG_DIR, "sites.yaml");
const DATA_DIR = join(import.meta.dirname, "..", "data");
const MAINTENANCE_STATE_PATH = join(DATA_DIR, "maintenance-state.json");
const BRANDING_PATH = join(CONFIG_DIR, "branding.json");
const ASSETS_DIR = join(DATA_DIR, "assets");
const DRIVERS_DIR = join(import.meta.dirname, "drivers");
const DEFAULT_SITE_CATEGORIES = [
  { key: "forum", label: "论坛", emoji: "💬" },
  { key: "pt", label: "PT站点", emoji: "📀" },
  { key: "website", label: "网站", emoji: "🌐" },
  { key: "game", label: "游戏", emoji: "🎮" },
];



function readJsonFileSafe(path, fallback = {}) {
  try {
    if (!existsSync(path)) return fallback;
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch (err) {
    logger.warn(`[状态] 读取 ${basename(path)} 失败: ${err.message}`);
    return fallback;
  }
}

function writeJsonFileSafe(path, value) {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(path, JSON.stringify(value, null, 2), "utf-8");
  } catch (err) {
    logger.warn(`[状态] 写入 ${basename(path)} 失败: ${err.message}`);
  }
}

function maintenanceState() {
  return readJsonFileSafe(MAINTENANCE_STATE_PATH, {});
}

function updateMaintenanceState(section, patch = {}) {
  const state = maintenanceState();
  state[section] = { ...(state[section] || {}), ...patch, updatedAt: new Date().toISOString() };
  writeJsonFileSafe(MAINTENANCE_STATE_PATH, state);
  return state[section];
}

function newestCookieCloudUpdatedAt() {
  const secrets = readSecrets();
  let latest = "";
  let source = "";
  let count = 0;
  for (const item of Object.values(secrets || {})) {
    if (!item || typeof item !== "object" || !item.cookiecloud_updated_at) continue;
    count += 1;
    const at = new Date(item.cookiecloud_updated_at).toISOString();
    if (!latest || at > latest) {
      latest = at;
      source = item.cookiecloud_source || "";
    }
  }
  return { latest, source, count };
}

function enrichCookieCloudConfig(config = readCookieCloudConfig()) {
  const state = maintenanceState().cookiecloud || {};
  const newest = newestCookieCloudUpdatedAt();
  const lastSuccessAt = state.lastSuccessAt || newest.latest || "";
  const intervalMs = Math.max(15, Number(config.autoIntervalMinutes || 180) || 180) * 60 * 1000;
  return {
    ...config,
    lastSuccessAt,
    lastAttemptAt: state.lastAttemptAt || "",
    lastErrorAt: state.lastErrorAt || "",
    lastError: state.lastError || "",
    lastUpdatedCount: Number(state.lastUpdatedCount ?? newest.count ?? 0) || 0,
    lastSource: state.lastSource || newest.source || "",
    nextSyncAt: config.autoSync && lastSuccessAt ? new Date(new Date(lastSuccessAt).getTime() + intervalMs).toISOString() : "",
  };
}

function latestWebDavBackupNameTime() {
  const local = maintenanceState().webdav || {};
  if (local.lastSuccessAt) return { latest: local.lastSuccessAt, name: local.lastBackupName || "" };
  return { latest: "", name: "" };
}

function webDavBackupTimeFromName(name = "") {
  const m = String(name || "").match(/(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)/);
  if (!m) return "";
  return m[1].replace(/T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/, "T$1:$2:$3.$4Z");
}

function enrichWebDavConfig(config = readWebDavConfig()) {
  const state = maintenanceState().webdav || {};
  const latest = latestWebDavBackupNameTime();
  const lastSuccessAt = state.lastSuccessAt || latest.latest || "";
  const lastKnownBackupAt = state.lastKnownBackupAt || "";
  const displayLastAt = lastSuccessAt || lastKnownBackupAt;
  const intervalMs = Math.max(60, Number(config.autoIntervalMinutes || 1440) || 1440) * 60 * 1000;
  return {
    ...config,
    lastSuccessAt,
    lastAttemptAt: state.lastAttemptAt || "",
    lastErrorAt: state.lastErrorAt || "",
    lastError: state.lastError || "",
    lastBackupName: state.lastBackupName || state.lastKnownBackupName || latest.name || "",
    lastKnownBackupAt,
    lastKnownBackupName: state.lastKnownBackupName || "",
    nextBackupAt: config.enabled && config.autoBackup && displayLastAt ? new Date(new Date(displayLastAt).getTime() + intervalMs).toISOString() : "",
  };
}

function latestWebDavCheckpointAt() {
  const state = maintenanceState().webdav || {};
  return state.lastSuccessAt || state.lastKnownBackupAt || "";
}

function isWebDavBackupDue(config = readWebDavConfig(), now = new Date()) {
  if (!config.enabled || !config.autoBackup) return false;
  const last = latestWebDavCheckpointAt();
  if (!last) return true;
  const lastMs = new Date(last).getTime();
  if (!Number.isFinite(lastMs)) return true;
  const intervalMs = Math.max(60, Number(config.autoIntervalMinutes || 1440) || 1440) * 60 * 1000;
  return now.getTime() - lastMs >= intervalMs;
}

let webDavAutoBackupRunning = false;
async function runWebDavAutoBackupOnce(reason = "auto") {
  if (webDavAutoBackupRunning) return false;
  webDavAutoBackupRunning = true;
  const attemptAt = new Date().toISOString();
  try {
    updateMaintenanceState("webdav", { lastAttemptAt: attemptAt, lastAutoReason: reason, lastError: "" });
    const result = await backupWebDavFromSavedConfig({ source: "auto" });
    updateMaintenanceState("webdav", { lastSuccessAt: new Date().toISOString(), lastBackupName: result.name || "", lastAutoReason: reason, lastError: "" });
    logger.info(`[WebDAV] 自动备份完成：${result.name}${reason ? `（${reason}）` : ""}`);
    return true;
  } catch (err) {
    updateMaintenanceState("webdav", { lastErrorAt: new Date().toISOString(), lastError: err.message, lastAutoReason: reason });
    logger.warn(`[WebDAV] 自动备份失败：${err.message}`);
    return false;
  } finally {
    webDavAutoBackupRunning = false;
  }
}


// ---- Cookie / secrets helpers ----

function readSitesRaw() {
  return parse(readFileSync(SITES_PATH, "utf-8")) || { sites: {} };
}

function writeSitesRaw(sitesRaw) {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(SITES_PATH, stringify(sitesRaw), "utf-8");
}

function normalizeClockTime(value, fallback = "09:00") {
  const raw = value ?? fallback;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    const total = Math.max(0, Math.min(23 * 60 + 59, Math.round(raw)));
    const hour = Math.floor(total / 60);
    const minute = total % 60;
    return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  }
  const text = String(raw).trim();
  if (/^\d+$/.test(text)) return normalizeClockTime(Number(text), fallback);
  const m = text.match(/^(\d{1,2}):(\d{1,2})$/) || String(fallback).match(/^(\d{1,2}):(\d{1,2})$/);
  const hour = Math.max(0, Math.min(23, Number(m?.[1] || 9)));
  const minute = Math.max(0, Math.min(59, Number(m?.[2] || 0)));
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function mergeSiteCatalog(sites = {}) {
  return Object.fromEntries(
    [...new Set([...Object.keys(BUILTIN_SITES), ...Object.keys(sites || {})])]
      .map(key => [key, { ...(BUILTIN_SITES[key] || {}), ...((sites || {})[key] || {}) }])
  );
}

function mergedSitesRaw(sitesRaw = readSitesRaw()) {
  return { ...sitesRaw, sites: mergeSiteCatalog(sitesRaw.sites || {}) };
}

function siteOverrideFor(key, sitesRaw = readSitesRaw()) {
  sitesRaw.sites = sitesRaw.sites || {};
  const base = sitesRaw.sites[key] || {};
  sitesRaw.sites[key] = { ...base };
  return sitesRaw.sites[key];
}
function cleanSiteOverrides(sitesRaw = readSitesRaw()) {
  const out = {};
  for (const [key, site] of Object.entries(sitesRaw.sites || {})) {
    out[key] = { ...site };
  }
  return { ...sitesRaw, sites: out };
}

function normalizeCategoryKey(value = "") {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
}

function getCategoriesRaw(sitesRaw = readSitesRaw()) {
  const source = Array.isArray(sitesRaw.categories) ? sitesRaw.categories : DEFAULT_SITE_CATEGORIES;
  const out = [];
  const seen = new Set();
  for (const item of source) {
    const key = normalizeCategoryKey(item?.key);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ key, label: String(item.label || key).trim(), emoji: String(item.emoji || "🏷️").trim() });
  }
  return out.length ? out : [...DEFAULT_SITE_CATEGORIES];
}

function setCategoriesRaw(categories = []) {
  const sitesRaw = readSitesRaw();
  const clean = [];
  const seen = new Set();
  for (const item of categories) {
    const key = normalizeCategoryKey(item?.key);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    clean.push({ key, label: String(item.label || key).trim(), emoji: String(item.emoji || "🏷️").trim() });
  }
  sitesRaw.categories = clean.length ? clean : DEFAULT_SITE_CATEGORIES;
  writeSitesRaw(sitesRaw);
  return getCategoriesRaw(sitesRaw);
}


function readEnvRaw() {
  const legacyText = existsSync(LEGACY_ENV_PATH) ? readFileSync(LEGACY_ENV_PATH, "utf-8") : "";
  const settingsText = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, "utf-8") : "";
  const fileText = [legacyText, settingsText].filter(Boolean).join("\n");
  const fileEnv = parseEnvText(fileText);
  const runtimeLines = [];
  for (const key of [
    "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID", "TZ", "LOG_LEVEL", "RUN_ON_START", "HTTP_TIMEOUT", "WEB_PORT",
    "SIGNMATE_AUTH_USERNAME", "SIGNMATE_AUTH_PASSWORD", "SIGNMATE_AUTH_DISABLED",
    "COOKIECLOUD_ENABLED", "COOKIECLOUD_HOST", "COOKIECLOUD_UUID", "COOKIECLOUD_PASSWORD", "COOKIECLOUD_AUTO_SYNC", "COOKIECLOUD_INCLUDE_DISABLED", "COOKIECLOUD_AUTO_INTERVAL_MINUTES",
    "WEBDAV_ENABLED", "WEBDAV_URL", "WEBDAV_USERNAME", "WEBDAV_PASSWORD", "WEBDAV_AUTO_BACKUP", "WEBDAV_AUTO_INTERVAL_MINUTES",
  ]) {
    if (!Object.prototype.hasOwnProperty.call(fileEnv, key) && process.env[key] !== undefined) runtimeLines.push(`${key}=${process.env[key]}`);
  }
  return [fileText, ...runtimeLines].filter(Boolean).join("\n");
}

function parseEnvText(text = "") {
  const out = {};
  String(text || "").split(/\r?\n/).forEach(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return;
    const eq = trimmed.indexOf("=");
    if (eq < 0) return;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    value = value.replace(/^[\'\"]|[\'\"]$/g, "");
    out[key] = value;
  });
  return out;
}

function upsertEnvValues(values = {}) {
  const lines = (existsSync(ENV_PATH) ? readFileSync(ENV_PATH, "utf-8") : "").split(/\r?\n/);
  const seen = new Set();
  const next = lines.map(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) return line;
    const key = trimmed.slice(0, trimmed.indexOf("=")).trim();
    if (!Object.prototype.hasOwnProperty.call(values, key)) return line;
    seen.add(key);
    return `${key}=${values[key] || ""}`;
  });
  for (const [key, value] of Object.entries(values)) {
    if (!seen.has(key)) next.push(`${key}=${value || ""}`);
  }
  writeFileSync(ENV_PATH, next.join("\n"), "utf-8");
}

function readNotifyConfig() {
  if (!existsSync(NOTIFY_PATH)) return {};
  return parse(readFileSync(NOTIFY_PATH, "utf-8")) || {};
}

function writeNotifyConfig(config = {}) {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(NOTIFY_PATH, stringify(config), "utf-8");
}

function getTelegramProxyUrl(tg = {}) {
  if (tg.proxy === false) return "";
  try {
    const proxy = getGlobalProxy(readSitesRaw());
    // Telegram 是外部通知通道，不应受“启用全局代理”限制；只要勾选 Telegram 走代理且有代理地址，就使用健康代理。
    return selectProxyUrl(proxy);
  } catch {
    return "";
  }
}


function safeEqualString(a = "", b = "") {
  const aa = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}

function authSettings() {
  const env = parseEnvText(readEnvRaw());
  return {
    username: env.SIGNMATE_AUTH_USERNAME || process.env.SIGNMATE_AUTH_USERNAME || "admin",
    passwordSet: Boolean(env.SIGNMATE_AUTH_PASSWORD || process.env.SIGNMATE_AUTH_PASSWORD),
    password: env.SIGNMATE_AUTH_PASSWORD || process.env.SIGNMATE_AUTH_PASSWORD || "",
    disabled: String(env.SIGNMATE_AUTH_DISABLED || process.env.SIGNMATE_AUTH_DISABLED || "false").toLowerCase() === "true",
  };
}

function publicAuthSettings() {
  const s = authSettings();
  return { enabled: !s.disabled && s.passwordSet, disabled: s.disabled, username: s.username, passwordSet: s.passwordSet };
}

function isLoopbackAddress(ip = "") {
  const value = String(ip || "").replace(/^::ffff:/, "");
  return value === "127.0.0.1" || value === "::1" || value === "localhost";
}

function requireBasicAuth(req, res, next) {
  const settings = authSettings();
  if (settings.disabled) return next();
  if (!settings.passwordSet) {
    if (isLoopbackAddress(req.ip) || isLoopbackAddress(req.socket?.remoteAddress)) return next();
    res.setHeader("WWW-Authenticate", 'Basic realm="SignMate", charset="UTF-8"');
    return res.status(401).send("SignMate authentication is not configured. Set SIGNMATE_AUTH_USERNAME and SIGNMATE_AUTH_PASSWORD.");
  }
  const header = String(req.headers.authorization || "");
  const match = header.match(/^Basic\s+(.+)$/i);
  if (match) {
    const decoded = Buffer.from(match[1], "base64").toString("utf-8");
    const idx = decoded.indexOf(":");
    const user = idx >= 0 ? decoded.slice(0, idx) : decoded;
    const pass = idx >= 0 ? decoded.slice(idx + 1) : "";
    if (safeEqualString(user, settings.username) && safeEqualString(pass, settings.password)) return next();
  }
  res.setHeader("WWW-Authenticate", 'Basic realm="SignMate", charset="UTF-8"');
  return res.status(401).send("Authentication required");
}

function readBranding() {
  return readJsonFileSafe(BRANDING_PATH, { title: "SignMate", logoUrl: "" });
}

function writeBranding(value = {}) {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(BRANDING_PATH, JSON.stringify({ title: String(value.title || "SignMate").trim() || "SignMate", logoUrl: String(value.logoUrl || "") }, null, 2), "utf-8");
}

function sanitizeLogoDataUrl(value = "") {
  const text = String(value || "").trim();
  if (!text) return "";
  const match = text.match(/^data:(image\/(?:png|jpeg|jpg|webp|gif|svg\+xml));base64,([A-Za-z0-9+/=]+)$/i);
  if (!match) throw new Error("仅支持 png/jpeg/webp/gif/svg 图片 data URL");
  const bytes = Buffer.from(match[2], "base64");
  if (bytes.length > 1024 * 1024) throw new Error("Logo 图片不能超过 1MB");
  const mime = match[1].toLowerCase().replace("jpg", "jpeg");
  const ext = mime.includes("png") ? ".png" : mime.includes("webp") ? ".webp" : mime.includes("gif") ? ".gif" : mime.includes("svg") ? ".svg" : ".jpg";
  mkdirSync(ASSETS_DIR, { recursive: true });
  const file = `logo-${Date.now()}-${randomBytes(4).toString("hex")}${ext}`;
  writeFileSync(join(ASSETS_DIR, file), bytes);
  return `/assets/${file}`;
}

function eventsFromConfig(channel = {}) {
  const events = [];
  if (channel.signin !== false) events.push("signin");
  if (channel.cookie !== false) events.push("cookie");
  if (channel.proxy !== false) events.push("proxy");
  return events.length ? events : ["signin", "cookie", "proxy"];
}

function configureNotifyChannels(config = readNotifyConfig()) {
  notifier.removeChannelByName?.("Telegram");
  notifier.removeChannelByName?.("Bark");
  const tg = config.telegram || {};
  const botToken = process.env.TELEGRAM_BOT_TOKEN || tg.bot_token;
  const chatId = process.env.TELEGRAM_CHAT_ID || tg.chat_id;
  if (tg.enabled !== false && botToken && chatId) notifier.addChannel(new TelegramChannel(botToken, chatId, getTelegramProxyUrl(tg), eventsFromConfig(tg)));
  const bark = config.bark || {};
  if (bark.enabled === true && bark.url) notifier.addChannel(new BarkChannel(bark.url, eventsFromConfig(bark)));
}

function configureTelegramChannel(botToken, chatId) {
  const cfg = readNotifyConfig();
  cfg.telegram = { ...(cfg.telegram || {}), bot_token: botToken, chat_id: chatId };
  configureNotifyChannels(cfg);
}

async function runProxyHealthCheck({ notify = false } = {}) {
  const sitesRaw = readSitesRaw();
  const proxy = getGlobalProxy(sitesRaw);
  const health = proxy.enabled ? await testProxyPool(proxy.urls, proxy.testUrls, 10000) : { checkedAt: new Date().toISOString(), ok: false, proxies: [], usableUrls: [] };
  const before = sitesRaw.proxy?.health;
  sitesRaw.proxy = { ...(sitesRaw.proxy || {}), health };
  writeSitesRaw(sitesRaw);
  if (notify && proxy.enabled && before?.ok !== false && health.ok === false && health.proxies.length) {
    const failed = health.proxies.map(p => `${p.url}: ${p.tests.map(t => `${t.testUrl} ${t.status || t.error || "失败"}`).join("；")}`);
    await notifier.send("SignMate 代理失效", failed, "proxy");
  }
  return health;
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


// ---- CookieCloud helpers ----
function normalizeCookieCloudHost(host = "") {
  const value = String(host || "").trim().replace(/\/+$/, "");
  if (!value) throw new Error("CookieCloud 地址不能为空");
  const url = new URL(value);
  if (!/^https?:$/.test(url.protocol)) throw new Error("CookieCloud 地址只支持 http/https");
  return url.toString().replace(/\/+$/, "");
}

function decryptCookieCloud(uuid = "", encrypted = "", password = "") {
  const cleanUuid = String(uuid || "").trim();
  const cleanPassword = String(password || "").trim();
  if (!cleanUuid || !cleanPassword) throw new Error("UUID 和密码不能为空");
  const key = CryptoJS.MD5(`${cleanUuid}-${cleanPassword}`).toString().substring(0, 16);
  const decrypted = CryptoJS.AES.decrypt(String(encrypted || ""), key).toString(CryptoJS.enc.Utf8);
  if (!decrypted) throw new Error("CookieCloud 解密失败，请检查 UUID/密码");
  const parsed = JSON.parse(decrypted);
  const cookieData = parsed.cookie_data || parsed;
  if (!cookieData || typeof cookieData !== "object") throw new Error("CookieCloud 数据格式不正确");
  return { cookieData, localStorageData: parsed.local_storage_data || {} };
}

async function fetchCookieCloud({ host, uuid, password, timeout = 15000 }) {
  const apiHost = normalizeCookieCloudHost(host);
  const cleanUuid = String(uuid || "").trim();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await undiciFetch(`${apiHost}/get/${encodeURIComponent(cleanUuid)}`, { signal: controller.signal });
    if (!res.ok) throw new Error(`CookieCloud 服务返回 HTTP ${res.status}`);
    const json = await res.json();
    if (!json?.encrypted) throw new Error("CookieCloud 响应中没有 encrypted 字段");
    return decryptCookieCloud(cleanUuid, json.encrypted, password);
  } finally {
    clearTimeout(timer);
  }
}

function cookieDomainMatch(hostname = "", domain = "") {
  const host = String(hostname || "").toLowerCase().replace(/^www\./, "");
  const clean = String(domain || "").toLowerCase().replace(/^\./, "").replace(/^www\./, "");
  return !!host && !!clean && (host === clean || host.endsWith(`.${clean}`) || clean.endsWith(`.${host}`));
}

function cookieExpiresOk(cookie = {}) {
  const exp = Number(cookie.expirationDate || cookie.expires || 0);
  return !Number.isFinite(exp) || exp <= 0 || exp > Date.now() / 1000;
}

function cookieToHeader(cookies = []) {
  const seen = new Set();
  const pairs = [];
  // CookieCloud may provide several records with the same name but different paths/domains.
  // Keep the newest occurrence for duplicate names instead of the first stale one; some sites
  // (notably Discuz/Chiphell) reject login when an old duplicate auth cookie is kept.
  for (const item of [...cookies].reverse()) {
    if (!item || !item.name || item.value == null || !cookieExpiresOk(item)) continue;
    const name = String(item.name).trim();
    const value = String(item.value);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    pairs.unshift(`${name}=${value}`);
  }
  return normalizeCookieValue(pairs.join("; "));
}

function buildCookieCloudMatches(cookieData = {}, { includeDisabled = false } = {}) {
  const { sites, secrets = {} } = loadConfig();
  const domainBuckets = Object.entries(cookieData || {}).map(([domain, cookies]) => ({ domain, cookies: Array.isArray(cookies) ? cookies : [] }));
  return sites.map(site => {
    const key = site.key || site.driver;
    const baseUrl = site.base_url || "";
    let hostname = "";
    try { hostname = new URL(baseUrl).hostname; } catch {}
    const matched = domainBuckets.filter(bucket => cookieDomainMatch(hostname, bucket.domain));
    const cookies = matched.flatMap(bucket => bucket.cookies);
    const cookie = cookieToHeader(cookies);
    return {
      key,
      name: site.note || key,
      enabled: site.enabled !== false,
      kind: site.kind || (site.driver === "website" || site.driver === "visit" ? "visit" : "signin"),
      category: site.category || "forum",
      baseUrl,
      host: hostname,
      matchedDomains: matched.map(x => x.domain),
      cookieCount: cookies.filter(cookieExpiresOk).length,
      cookieMasked: maskSecret(cookie),
      hasCookie: Boolean(cookie),
      signmateHasCookie: !isPlaceholderSecret((secrets[key] || {}).cookie || (secrets[key] || {}).session_only || (secrets[key] || {}).userInfo || (secrets[key] || {}).userInfoShared || (secrets[key] || {})["userInfo-shared"] || (secrets[key] || {}).accessToken || ""),
      cookie,
    };
  }).filter(item => (includeDisabled || item.enabled) && item.hasCookie);
}

function publicCookieCloudMatches(matches = []) {
  return matches.map(({ cookie, ...item }) => item);
}

function readCookieCloudConfig() {
  const env = parseEnvText(readEnvRaw());
  return {
    enabled: env.COOKIECLOUD_ENABLED === "true" || Boolean(env.COOKIECLOUD_HOST || env.COOKIECLOUD_UUID || env.COOKIECLOUD_PASSWORD || env.COOKIECLOUD_AUTO_SYNC === "true"),
    host: env.COOKIECLOUD_HOST || "",
    uuid: env.COOKIECLOUD_UUID || "",
    passwordSaved: Boolean(env.COOKIECLOUD_PASSWORD),
    autoSync: env.COOKIECLOUD_AUTO_SYNC === "true",
    autoIntervalMinutes: Math.max(15, Number(env.COOKIECLOUD_AUTO_INTERVAL_MINUTES || 180) || 180),
    includeDisabled: env.COOKIECLOUD_INCLUDE_DISABLED === "true",
  };
}

function readCookieCloudConfigFull() {
  const env = parseEnvText(readEnvRaw());
  return { ...readCookieCloudConfig(), password: env.COOKIECLOUD_PASSWORD || "" };
}

function applyCookieCloudConfigFull(cfg = {}) {
  const values = {
    COOKIECLOUD_ENABLED: cfg.enabled === false ? "false" : "true",
    COOKIECLOUD_AUTO_SYNC: cfg.autoSync === true ? "true" : "false",
    COOKIECLOUD_INCLUDE_DISABLED: cfg.includeDisabled === true ? "true" : "false",
    COOKIECLOUD_AUTO_INTERVAL_MINUTES: String(Math.max(15, Number(cfg.autoIntervalMinutes || 180) || 180)),
  };
  if (Object.prototype.hasOwnProperty.call(cfg, "host")) values.COOKIECLOUD_HOST = cfg.host ? normalizeCookieCloudHost(cfg.host) : "";
  if (Object.prototype.hasOwnProperty.call(cfg, "uuid")) values.COOKIECLOUD_UUID = String(cfg.uuid || "").trim();
  if (Object.prototype.hasOwnProperty.call(cfg, "password")) values.COOKIECLOUD_PASSWORD = String(cfg.password || "");
  upsertEnvValues(values);
}

async function syncCookieCloudFromSavedConfig({ source = "auto" } = {}) {
  const cfg = readCookieCloudConfig();
  const env = parseEnvText(readEnvRaw());
  if (!cfg.host || !cfg.uuid || !env.COOKIECLOUD_PASSWORD) throw new Error("CookieCloud 自动同步未配置 host/uuid/password");
  const { cookieData } = await fetchCookieCloud({ host: cfg.host, uuid: cfg.uuid, password: env.COOKIECLOUD_PASSWORD });
  const matches = buildCookieCloudMatches(cookieData, { includeDisabled: cfg.includeDisabled });
  const secrets = readSecrets();
  const now = new Date().toISOString();
  for (const item of matches) {
    secrets[item.key] = { ...(secrets[item.key] || {}), cookie: item.cookie, cookiecloud_updated_at: now, cookiecloud_source: source };
  }
  writeSecrets(secrets);
  return matches;
}


// ---- WebDAV backup helpers ----
function readWebDavConfig() {
  const env = parseEnvText(readEnvRaw());
  return {
    enabled: env.WEBDAV_ENABLED === "true",
    url: env.WEBDAV_URL || "",
    username: env.WEBDAV_USERNAME || "",
    passwordSaved: Boolean(env.WEBDAV_PASSWORD),
    autoBackup: env.WEBDAV_AUTO_BACKUP === "true",
    autoIntervalMinutes: Math.max(60, Number(env.WEBDAV_AUTO_INTERVAL_MINUTES || 1440) || 1440),
  };
}

function readWebDavConfigFull() {
  const env = parseEnvText(readEnvRaw());
  return { ...readWebDavConfig(), password: env.WEBDAV_PASSWORD || "" };
}

function applyWebDavConfigFull(cfg = {}) {
  const values = {
    WEBDAV_ENABLED: cfg.enabled === true ? "true" : "false",
    WEBDAV_AUTO_BACKUP: cfg.autoBackup === true ? "true" : "false",
    WEBDAV_AUTO_INTERVAL_MINUTES: String(Math.max(60, Number(cfg.autoIntervalMinutes || 1440) || 1440)),
  };
  if (Object.prototype.hasOwnProperty.call(cfg, "url")) values.WEBDAV_URL = cfg.url ? normalizeWebDavBase(cfg.url) : "";
  if (Object.prototype.hasOwnProperty.call(cfg, "username")) values.WEBDAV_USERNAME = String(cfg.username || "").trim();
  if (Object.prototype.hasOwnProperty.call(cfg, "password")) values.WEBDAV_PASSWORD = String(cfg.password || "");
  upsertEnvValues(values);
}

function webDavAuthHeaders(username = "", password = "") {
  const headers = {};
  if (username || password) headers.Authorization = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
  return headers;
}

function normalizeWebDavBase(url = "") {
  const value = String(url || "").trim().replace(/\/+$/, "");
  if (!value) throw new Error("WebDAV 地址不能为空");
  const parsed = new URL(value);
  if (!/^https?:$/.test(parsed.protocol)) throw new Error("WebDAV 地址只支持 http/https");
  return parsed.toString().replace(/\/+$/, "");
}

function safeFilePart(value = "") {
  return String(value || "").trim().replace(/^https?:\/\//i, "").replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "unknown";
}

async function deleteWebDavFile({ base, username, password, name }) {
  const response = await undiciFetch(`${base}/${encodeURIComponent(name)}`, { method: "DELETE", headers: webDavAuthHeaders(username, password) });
  return response.ok || response.status === 404;
}

async function pruneWebDavBackups({ url, username, password, keep = 99 }) {
  const base = normalizeWebDavBase(url);
  const backups = await listWebDavBackups({ url, username, password });
  const old = backups.slice(keep);
  for (const name of old) await deleteWebDavFile({ base, username, password, name }).catch(() => false);
  return { total: backups.length, removed: old.length };
}

function safeReadText(path, fallback = "") {
  try { return existsSync(path) ? readFileSync(path, "utf-8") : fallback; } catch { return fallback; }
}

function readPackageMeta() {
  try {
    const pkgPath = join(import.meta.dirname, "..", "package.json");
    return existsSync(pkgPath) ? JSON.parse(readFileSync(pkgPath, "utf-8")) : {};
  } catch {
    return {};
  }
}

function buildBackupPayload() {
  const sitesRaw = readSitesRaw();
  const proxy = getGlobalProxy(sitesRaw);
  return {
    meta: {
      app: "SignMate",
      version: readPackageMeta().version || "unknown",
      createdAt: new Date().toISOString(),
      backupVersion: 2,
      scope: "full-user-data",
      note: "包含完整用户配置与敏感凭据；不包含运行日志和签到历史。请像密码文件一样保存。",
      excluded: ["logs/**", "data/history.json", "data/batch-state.json", "data/debug/**"],
    },
    files: {
      "config/sites.yaml": safeReadText(SITES_PATH, "sites: {}\n"),
      "config/secrets.yaml": safeReadText(SECRETS_PATH, "{}\n"),
      "config/notify.yaml": safeReadText(NOTIFY_PATH, "{}\n"),
      "config/proxy-settings.json": JSON.stringify(proxy, null, 2),
      "config/cookiecloud-settings.json": JSON.stringify(readCookieCloudConfigFull(), null, 2),
      "config/webdav-settings.json": JSON.stringify(readWebDavConfigFull(), null, 2),
      "config/settings.env": readEnvRaw(),
    },
  };
}

async function putWebDavBackup({ url, username, password }) {
  const base = normalizeWebDavBase(url);
  const payload = buildBackupPayload();
  const hostPart = safeFilePart(new URL(base).host || "webdav");
  const timePart = new Date().toISOString().replace(/[:.]/g, "-");
  const name = `SignMate-${hostPart}-${timePart}.json`;
  const target = `${base}/${name}`;
  await assertWebDavEndpoint({ url, username, password });
  const response = await undiciFetch(target, { method: "PUT", headers: { ...webDavAuthHeaders(username, password), "content-type": "application/json" }, body: JSON.stringify(payload, null, 2) });
  if (!response.ok && response.status !== 201 && response.status !== 204) throw new Error(webDavWriteError(response.status));
  const prune = await pruneWebDavBackups({ url, username, password, keep: 99 }).catch(() => ({ total: 0, removed: 0 }));
  return { name, url: target, size: Buffer.byteLength(JSON.stringify(payload)), prune };
}

function isLikelyWebDavResponse(response, body = "") {
  const dav = String(response.headers.get("dav") || "").trim();
  const contentType = String(response.headers.get("content-type") || "").toLowerCase();
  return Boolean(dav) || /<[^:>]*:?multistatus[\s>]/i.test(body) || (contentType.includes("xml") && /<[^:>]*:?response[\s>]/i.test(body));
}

async function assertWebDavEndpoint({ url, username, password }) {
  const base = normalizeWebDavBase(url);
  const response = await undiciFetch(base + "/", { method: "PROPFIND", headers: { ...webDavAuthHeaders(username, password), Depth: "0" } });
  const body = await response.text().catch(() => "");
  if (!response.ok) throw new Error(`WebDAV 连接失败 HTTP ${response.status}`);
  if (!isLikelyWebDavResponse(response, body)) {
    throw new Error("当前地址不像 WebDAV 端点：服务器返回了普通网页，请填写真实 WebDAV 地址/目录");
  }
  return { base, status: response.status };
}

function webDavWriteError(status) {
  if (status === 401 || status === 403) return `WebDAV 备份失败 HTTP ${status}：账号无写入权限，或填写的是 DSM/网页地址而不是 WebDAV 目录`;
  if (status === 404 || status === 405) return `WebDAV 备份失败 HTTP ${status}：当前地址不支持上传，请填写真实 WebDAV 目录地址`;
  return `WebDAV 备份失败 HTTP ${status}`;
}

async function listWebDavBackups({ url, username, password }) {
  const base = normalizeWebDavBase(url);
  const response = await undiciFetch(base + "/", { method: "PROPFIND", headers: { ...webDavAuthHeaders(username, password), Depth: "1" } });
  const xml = await response.text().catch(() => "");
  if (!response.ok) throw new Error(`WebDAV 列表失败 HTTP ${response.status}`);
  if (!isLikelyWebDavResponse(response, xml)) {
    throw new Error("当前地址不像 WebDAV 端点：服务器返回了普通网页，请填写真实 WebDAV 地址/目录");
  }
  const hrefs = [...xml.matchAll(/<[^:>]*:?href[^>]*>([^<]+)<\/[^:>]*:?href>/g)].map(m => decodeURIComponent(m[1]));
  return hrefs.map(h => basename(h)).filter(n => /^(?:signmate-backup-|SignMate-).*\.json$/i.test(n)).sort().reverse();
}

async function getWebDavBackup({ url, username, password, name }) {
  const base = normalizeWebDavBase(url);
  const file = name || (await listWebDavBackups({ url, username, password }))[0];
  if (!file) throw new Error("WebDAV 目录中没有 SignMate 备份");
  const response = await undiciFetch(`${base}/${encodeURIComponent(file)}`, { headers: webDavAuthHeaders(username, password) });
  if (!response.ok) throw new Error(`WebDAV 下载失败 HTTP ${response.status}`);
  const json = await response.json();
  if (!json?.files || typeof json.files !== "object") throw new Error("备份文件格式不正确");
  return { name: file, backup: json };
}

function restoreBackupPayload(backup) {
  const files = backup?.files || {};
  const changed = [];
  const writeIfPresent = (key, path) => {
    if (typeof files[key] !== "string") return false;
    writeFileSync(path, files[key], "utf-8");
    changed.push(key);
    return true;
  };
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeIfPresent("config/site-overrides.yaml", SITES_PATH) || writeIfPresent("config/sites.yaml", SITES_PATH);
  writeIfPresent("config/secrets.yaml", SECRETS_PATH);
  writeIfPresent("config/notify.yaml", NOTIFY_PATH);
  if (typeof files["config/settings.env"] === "string" || typeof files["config/.env"] === "string" || typeof files[".env"] === "string") {
    writeFileSync(ENV_PATH, String(files["config/settings.env"] ?? files["config/.env"] ?? files[".env"] ?? ""), "utf-8");
    changed.push("config/settings.env");
  }
  if (typeof files["config/cookiecloud-settings.json"] === "string") {
    applyCookieCloudConfigFull(JSON.parse(files["config/cookiecloud-settings.json"] || "{}"));
    changed.push("config/cookiecloud-settings.json");
  }
  if (typeof files["config/webdav-settings.json"] === "string") {
    applyWebDavConfigFull(JSON.parse(files["config/webdav-settings.json"] || "{}"));
    changed.push("config/webdav-settings.json");
  }
  return changed;
}

async function backupWebDavFromSavedConfig({ source = "auto" } = {}) {
  const cfg = readWebDavConfig();
  const env = parseEnvText(readEnvRaw());
  if (!cfg.enabled || !cfg.url) throw new Error("WebDAV 自动备份未启用或未配置 URL");
  const result = await putWebDavBackup({ url: cfg.url, username: cfg.username, password: env.WEBDAV_PASSWORD || "" });
  return { ...result, source };
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
  app.use(express.json({ limit: "2mb" }));

  // 登录认证：默认启用；未配置密码时仅允许本机访问，避免公开部署裸奔。
  app.use(requireBasicAuth);

  // 静态文件
  app.use("/assets", express.static(ASSETS_DIR));
  app.use(express.static(WEB_DIR));
  app.get("/", (_req, res) => res.sendFile(join(WEB_DIR, "index.html")));


  const cookieCloudAutoTimer = (() => {
    const cfg = readCookieCloudConfig();
    if (!cfg.autoSync) return null;
    const intervalMs = cfg.autoIntervalMinutes * 60 * 1000;
    logger.info(`[CookieCloud] 自动同步已启用，每 ${cfg.autoIntervalMinutes} 分钟执行一次`);
    return setInterval(async () => {
      try {
        updateMaintenanceState("cookiecloud", { lastAttemptAt: new Date().toISOString(), lastError: "" });
        const matches = await syncCookieCloudFromSavedConfig({ source: "auto" });
        updateMaintenanceState("cookiecloud", { lastSuccessAt: new Date().toISOString(), lastUpdatedCount: matches.length, lastSource: "auto", lastError: "" });
        logger.info(`[CookieCloud] 自动同步完成：${matches.length} 个站点`);
      } catch (err) {
        updateMaintenanceState("cookiecloud", { lastErrorAt: new Date().toISOString(), lastError: err.message });
        logger.warn(`[CookieCloud] 自动同步失败：${err.message}`);
      }
    }, intervalMs);
  })();


  const webDavAutoTimer = (() => {
    const cfg = readWebDavConfig();
    if (!cfg.enabled || !cfg.autoBackup) return null;
    const intervalMs = Math.max(60, Number(cfg.autoIntervalMinutes || 1440) || 1440) * 60 * 1000;
    logger.info(`[WebDAV] 自动备份已启用，每 ${Math.round(cfg.autoIntervalMinutes / 60)} 小时执行一次`);
    setTimeout(async () => {
      const latest = latestWebDavCheckpointAt();
      if (isWebDavBackupDue(readWebDavConfig())) {
        logger.info(`[WebDAV] 检测到自动备份已到期${latest ? `（上次：${latest}）` : "（未找到上次成功备份）"}，启动后补跑一次`);
        await runWebDavAutoBackupOnce("startup-due");
      } else {
        logger.info(`[WebDAV] 自动备份未到期，启动后不补跑；下次约 ${enrichWebDavConfig(readWebDavConfig()).nextBackupAt || "未知"}`);
      }
    }, 10_000);
    return setInterval(async () => {
      if (isWebDavBackupDue(readWebDavConfig())) await runWebDavAutoBackupOnce("interval-due");
    }, Math.min(intervalMs, 60 * 60 * 1000));
  })();


  app.get("/api/app-settings", (_req, res) => {
    res.json({ ok: true, data: { auth: publicAuthSettings(), branding: readBranding() } });
  });

  app.post("/api/app-settings/auth", (req, res) => {
    try {
      const username = String(req.body?.username || "admin").trim() || "admin";
      const password = String(req.body?.password || "");
      const disabled = req.body?.disabled === true;
      if (!disabled && password && password.length < 8) throw new Error("管理员密码至少 8 位");
      const values = { SIGNMATE_AUTH_USERNAME: username, SIGNMATE_AUTH_DISABLED: disabled ? "true" : "false" };
      if (password) values.SIGNMATE_AUTH_PASSWORD = password;
      upsertEnvValues(values);
      res.json({ ok: true, data: publicAuthSettings() });
    } catch (err) { res.status(400).json({ ok: false, error: err.message }); }
  });

  app.post("/api/app-settings/branding", (req, res) => {
    try {
      const current = readBranding();
      const title = String(req.body?.title || current.title || "SignMate").trim() || "SignMate";
      let logoUrl = req.body?.clearLogo === true ? "" : (current.logoUrl || "");
      if (req.body?.logoDataUrl) logoUrl = sanitizeLogoDataUrl(req.body.logoDataUrl);
      writeBranding({ title, logoUrl });
      res.json({ ok: true, data: readBranding() });
    } catch (err) { res.status(400).json({ ok: false, error: err.message }); }
  });

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
        if (s.siteKey) statusLookup[s.siteKey] = s;
      }

      const secrets = readSecrets();
      const result = sites.map(site => {
        const key = site.key || site.driver;
        const name = site.note || key;
        const status = statusLookup[key] || statusLookup[name] || {};
        const siteSecrets = secrets[key] || {};
        const hasCredential = !isPlaceholderSecret(siteSecrets.cookie || siteSecrets.session_only || siteSecrets.userInfo || siteSecrets.userInfoShared || siteSecrets["userInfo-shared"] || siteSecrets.accessToken || "");
        const hasCookie = hasCredential;
        const totpSecret = siteSecrets.totp_secret || siteSecrets.twofa_secret || siteSecrets["2fa_secret"] || siteSecrets.otp_secret || "";
        const hasTotpSecret = !isPlaceholderSecret(totpSecret);
        const cookieMessage = hasCredential ? "" : "⚠️ 凭据未配置，请点击下方「维护 Cookie」";
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
          driver: site.driver || "",
          adaptedKind: site.adapted_kind || site.adaptedKind || (site.driver === "website" || site.driver === "visit" ? "visit" : (/保活|访问|每日访问|Cookie\s*检查/i.test(`${site.note || ""} ${name || ""}`) ? "visit" : (site.kind === "visit" ? "visit" : "signin"))),
          enabled: site.enabled !== false,
          schedule: site.schedule || "",
          scheduleMode: site.schedule_mode || site.scheduleMode || (["random", "independent"].includes((readSitesRaw().batch || {}).mode) ? (readSitesRaw().batch || {}).mode : "fixed"),
          randomStart: site.random_start || site.randomStart || "02:00",
          randomEnd: site.random_end || site.randomEnd || "22:00",
          proxyMode: site.proxy_mode || siteProxyMode(site),
          proxyGlobalEnabled: site.proxy_global_enabled === true,
          proxyModeUsed: status.details?.proxyModeUsed || null,
          proxyUsed: status.details?.proxyUsed ?? null,
          category: site.category || "forum",
          kind: site.kind || (site.driver === "website" || site.driver === "visit" ? "visit" : "signin"),
          baseUrl: site.base_url || "",
          verificationType: site.verification_type || "",
          verificationAuto: site.verification_auto === true,
          signinBlockedByVerification: site.signin_blocked_by_verification === true,
          hasCookie,
          hasTotpSecret,
          totpSecretMasked: maskSecret(totpSecret),
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
      const sitesObj = mergeSiteCatalog(sitesRaw.sites || {});
      const key = findSiteKey(sitesObj, siteName);

      if (!key) {
        return res.status(404).json({ ok: false, error: `站点 "${siteName}" 不存在` });
      }

      siteOverrideFor(key, sitesRaw).enabled = enabled;
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
      const sitesObj = mergeSiteCatalog(sitesRaw.sites || {});
      if (sitesObj[key]) {
        return res.status(409).json({ ok: false, error: `站点 "${key}" 已存在` });
      }

      const driver = normalizeSiteKey(body.driver || key);
      if (!driver) {
        return res.status(400).json({ ok: false, error: "driver 不能为空" });
      }
      const baseUrl = String(body.baseUrl || "").trim();
      if (!baseUrl) {
        return res.status(400).json({ ok: false, error: "基础 URL 不能为空" });
      }

      sitesRaw.sites = sitesRaw.sites || {};
      sitesRaw.sites[key] = {
        enabled: body.enabled !== false,
        driver,
        schedule: String(body.schedule || "0 9 * * *").trim(),
        schedule_mode: body.scheduleMode === "independent" ? "independent" : (body.scheduleMode === "random" ? "random" : "fixed"),
        random_start: normalizeClockTime(body.randomStart, "02:00"),
        random_end: normalizeClockTime(body.randomEnd, "22:00"),
        note: String(body.note || body.name || key).trim(),
        notify: body.notify !== false,
        retry: Number.isFinite(Number(body.retry)) ? Number(body.retry) : 2,
        retry_delay_ms: Number.isFinite(Number(body.retryDelayMs)) ? Number(body.retryDelayMs) : 10000,
        timeout: Number.isFinite(Number(body.timeout)) ? Number(body.timeout) : 30000,
        base_url: baseUrl,
        category: body.category || "forum",
        kind: body.kind === "visit" ? "visit" : "signin",
        ...(body.loginKeyword ? { login_keyword: String(body.loginKeyword).trim() } : {}),
      };

      applySiteProxyMode(sitesRaw.sites[key], ["auto", "on", "off"].includes(body.proxyMode) ? body.proxyMode : "auto");
      if (body.signinMode) sitesRaw.sites[key].signin_mode = String(body.signinMode).trim();

      writeSitesRaw(sitesRaw);
      res.json({ ok: true, data: { site: key, config: { ...BUILTIN_SITES[key], ...sitesRaw.sites[key] } } });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.patch("/api/sites/:siteName", (req, res) => {
    try {
      const siteName = req.params.siteName;
      const body = req.body || {};
      const sitesRaw = readSitesRaw();
      const sitesObj = mergeSiteCatalog(sitesRaw.sites || {});
      const key = findSiteKey(sitesObj, siteName);
      if (!key) {
        return res.status(404).json({ ok: false, error: `站点 "${siteName}" 不存在` });
      }

      const site = { ...(sitesObj[key] || {}) };
      if (Object.prototype.hasOwnProperty.call(body, "enabled")) site.enabled = body.enabled !== false;
      if (Object.prototype.hasOwnProperty.call(body, "schedule")) site.schedule = String(body.schedule || "").trim();
      if (Object.prototype.hasOwnProperty.call(body, "scheduleMode")) site.schedule_mode = body.scheduleMode === "independent" ? "independent" : (body.scheduleMode === "random" ? "random" : "fixed");
      if (Object.prototype.hasOwnProperty.call(body, "randomStart")) site.random_start = normalizeClockTime(body.randomStart, "02:00");
      if (Object.prototype.hasOwnProperty.call(body, "randomEnd")) site.random_end = normalizeClockTime(body.randomEnd, "22:00");
      if (Object.prototype.hasOwnProperty.call(body, "note")) site.note = String(body.note || key).trim();
      if (Object.prototype.hasOwnProperty.call(body, "baseUrl")) site.base_url = String(body.baseUrl || "").trim();
      if (Object.prototype.hasOwnProperty.call(body, "timeout")) site.timeout = Number(body.timeout) || site.timeout || 30000;
      if (Object.prototype.hasOwnProperty.call(body, "retry")) site.retry = Number(body.retry) || 0;
      if (Object.prototype.hasOwnProperty.call(body, "signinMode")) site.signin_mode = String(body.signinMode || "").trim();
      if (Object.prototype.hasOwnProperty.call(body, "category")) site.category = String(body.category || "forum").trim();
      if (Object.prototype.hasOwnProperty.call(body, "kind")) site.kind = body.kind === "visit" ? "visit" : "signin";
      if (Object.prototype.hasOwnProperty.call(body, "loginKeyword")) site.login_keyword = String(body.loginKeyword || "").trim();
      if (body.proxyMode && ["auto", "on", "off"].includes(body.proxyMode)) applySiteProxyMode(site, body.proxyMode);

      sitesRaw.sites = sitesRaw.sites || {};
      sitesRaw.sites[key] = { ...(sitesRaw.sites[key] || {}), ...site };
      writeSitesRaw(sitesRaw);
      res.json({ ok: true, data: { site: key, config: { ...BUILTIN_SITES[key], ...sitesRaw.sites[key] } } });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.delete("/api/sites/:siteName", (req, res) => {
    try {
      const siteName = req.params.siteName;
      const sitesRaw = readSitesRaw();
      const sitesObj = mergeSiteCatalog(sitesRaw.sites || {});
      const key = findSiteKey(sitesObj, siteName);
      if (!key) {
        return res.status(404).json({ ok: false, error: `站点 "${siteName}" 不存在` });
      }

      const removed = sitesObj[key];
      sitesRaw.sites = sitesRaw.sites || {};
      if (BUILTIN_SITES[key]) {
        sitesRaw.sites[key] = { ...(sitesRaw.sites[key] || {}), enabled: false, hidden: true };
      } else {
        delete sitesRaw.sites[key];
      }
      writeSitesRaw(sitesRaw);
      res.json({ ok: true, data: { site: key, removed, builtin: Boolean(BUILTIN_SITES[key]) } });
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

  app.delete("/api/history", async (_req, res) => {
    try {
      await store.clearHistory();
      res.json({ ok: true, data: { cleared: true } });
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
        const key = site.key || site.driver;
        const siteSecrets = secrets[key] || secrets[site.driver] || {};
        const cookie = siteSecrets.cookie || "";
        const sessionOnly = siteSecrets.session_only || "";
        const localStorageCredential = siteSecrets.userInfo || siteSecrets.userInfoShared || siteSecrets["userInfo-shared"] || siteSecrets.accessToken || "";
        const totpSecret = siteSecrets.totp_secret || siteSecrets.twofa_secret || siteSecrets["2fa_secret"] || siteSecrets.otp_secret || "";
        return {
          key,
          name: site.note || key,
          driver: site.driver,
          enabled: site.enabled !== false,
          cookie: "",
          cookieMasked: maskSecret(cookie || localStorageCredential),
          sessionOnly: "",
          sessionOnlyMasked: maskSecret(sessionOnly),
          hasCookie: !isPlaceholderSecret(cookie || sessionOnly || localStorageCredential),
          totpSecret: "",
          totpSecretMasked: maskSecret(totpSecret),
          hasTotpSecret: !isPlaceholderSecret(totpSecret),
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
      let { cookie = "", sessionOnly = "", clearCookie = false, totpSecret = "", clearTotpSecret = false } = req.body || {};
      cookie = normalizeCookieValue(cookie);
      sessionOnly = normalizeSessionValue(sessionOnly);
      totpSecret = String(totpSecret || "").replace(/\s+/g, "").toUpperCase();
      if (hasInvalidCookieChars(cookie) || hasInvalidCookieChars(sessionOnly)) {
        return res.status(400).json({ ok: false, error: "Cookie/session 含非法字符（例如中文省略号 …），请重新从浏览器复制原始值" });
      }
      if (totpSecret && !/^[A-Z2-7]+=*$/.test(totpSecret)) {
        return res.status(400).json({ ok: false, error: "2FA Secret 格式不正确，请填写 Base32 TOTP Secret" });
      }
      const secrets = readSecrets();
      const current = secrets[siteName] || {};
      const next = { ...current };

      if (clearCookie) {
        delete next.cookie;
        delete next.session_only;
        delete next.userInfo;
        delete next.userInfoShared;
        delete next["userInfo-shared"];
        delete next.accessToken;
        delete next.cookiecloud_updated_at;
        delete next.cookiecloud_source;
      }
      if (clearTotpSecret) {
        delete next.totp_secret;
        delete next.twofa_secret;
        delete next["2fa_secret"];
        delete next.otp_secret;
      }
      if (cookie.trim()) next.cookie = cookie.trim();
      if (sessionOnly.trim()) next.session_only = sessionOnly.trim();
      if (totpSecret.trim()) next.totp_secret = totpSecret.trim();

      if (Object.keys(next).length) secrets[siteName] = next;
      else delete secrets[siteName];

      // 空提交表示“不修改现有 Cookie/2FA”；clearCookie/clearTotpSecret=true 才会清除已保存凭据。
      writeSecrets(secrets);
      res.json({ ok: true, data: { site: siteName, hasCookie: Boolean(secrets[siteName]?.cookie || secrets[siteName]?.session_only), hasTotpSecret: Boolean(secrets[siteName]?.totp_secret || secrets[siteName]?.twofa_secret || secrets[siteName]?.["2fa_secret"] || secrets[siteName]?.otp_secret), cleared: Boolean(clearCookie), clearedTotpSecret: Boolean(clearTotpSecret) } });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });


  app.get("/api/cookiecloud/config", (_req, res) => {
    try {
      res.json({ ok: true, data: enrichCookieCloudConfig(readCookieCloudConfig()) });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.post("/api/cookiecloud/preview", async (req, res) => {
    try {
      const body = req.body || {};
      const cfg = readCookieCloudConfig();
      const host = body.host || cfg.host;
      const uuid = body.uuid || cfg.uuid;
      const password = body.password || parseEnvText(readEnvRaw()).COOKIECLOUD_PASSWORD || "";
      const { cookieData } = await fetchCookieCloud({ host, uuid, password });
      const matches = buildCookieCloudMatches(cookieData, { includeDisabled: body.includeDisabled === true });
      res.json({ ok: true, data: { totalDomains: Object.keys(cookieData || {}).length, matched: publicCookieCloudMatches(matches) } });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  app.post("/api/cookiecloud/config", (req, res) => {
    try {
      const body = req.body || {};
      const current = readCookieCloudConfig();
      const enabled = body.enabled !== undefined ? body.enabled === true : Boolean(current.host || current.uuid || current.passwordSaved || current.autoSync);
      const host = Object.prototype.hasOwnProperty.call(body, "host") ? String(body.host || "").trim() : current.host;
      const uuid = Object.prototype.hasOwnProperty.call(body, "uuid") ? String(body.uuid || "").trim() : current.uuid;
      const values = {
        ...(host ? { COOKIECLOUD_HOST: normalizeCookieCloudHost(host) } : {}),
        ...(uuid ? { COOKIECLOUD_UUID: uuid } : {}),
        ...(body.password ? { COOKIECLOUD_PASSWORD: String(body.password).trim() } : {}),
        COOKIECLOUD_ENABLED: enabled ? "true" : "false",
        COOKIECLOUD_AUTO_SYNC: body.autoSync === true ? "true" : "false",
        COOKIECLOUD_INCLUDE_DISABLED: body.includeDisabled === true ? "true" : "false",
        COOKIECLOUD_AUTO_INTERVAL_MINUTES: String(Math.max(15, Number(body.autoIntervalMinutes || current.autoIntervalMinutes || 180) || 180)),
      };
      upsertEnvValues(values);
      res.json({ ok: true, data: enrichCookieCloudConfig(readCookieCloudConfig()) });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  app.post("/api/cookiecloud/sync", async (req, res) => {
    try {
      const body = req.body || {};
      const cfg = readCookieCloudConfig();
      const host = body.host || cfg.host;
      const uuid = body.uuid || cfg.uuid;
      const password = body.password || parseEnvText(readEnvRaw()).COOKIECLOUD_PASSWORD || "";
      const { cookieData } = await fetchCookieCloud({ host, uuid, password });
      const matches = buildCookieCloudMatches(cookieData, { includeDisabled: body.includeDisabled === true });
      const selected = Array.isArray(body.sites) && body.sites.length ? new Set(body.sites.map(String)) : null;
      const toWrite = matches.filter(item => !selected || selected.has(item.key));
      const secrets = readSecrets();
      const now = new Date().toISOString();
      for (const item of toWrite) {
        secrets[item.key] = { ...(secrets[item.key] || {}), cookie: item.cookie, cookiecloud_updated_at: now, cookiecloud_source: "manual" };
      }
      writeSecrets(secrets);
      updateMaintenanceState("cookiecloud", { lastAttemptAt: now, lastSuccessAt: now, lastUpdatedCount: toWrite.length, lastSource: "manual", lastError: "" });
      if (body.saveConfig === true) {
        upsertEnvValues({ COOKIECLOUD_ENABLED: body.enabled === false ? "false" : "true", COOKIECLOUD_HOST: normalizeCookieCloudHost(host), COOKIECLOUD_UUID: String(uuid || "").trim(), ...(body.password ? { COOKIECLOUD_PASSWORD: String(body.password).trim() } : {}), COOKIECLOUD_AUTO_SYNC: body.autoSync === true ? "true" : "false", COOKIECLOUD_INCLUDE_DISABLED: body.includeDisabled === true ? "true" : "false", COOKIECLOUD_AUTO_INTERVAL_MINUTES: String(Math.max(15, Number(body.autoIntervalMinutes || 180) || 180)) });
      }
      res.json({ ok: true, data: { updated: publicCookieCloudMatches(toWrite), skipped: Math.max(0, matches.length - toWrite.length) } });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });


  app.get("/api/webdav/config", (_req, res) => {
    try { res.json({ ok: true, data: enrichWebDavConfig(readWebDavConfig()) }); }
    catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  app.post("/api/webdav/config", (req, res) => {
    try {
      const body = req.body || {};
      const values = {
        WEBDAV_ENABLED: body.enabled === true ? "true" : "false",
        ...(body.url ? { WEBDAV_URL: normalizeWebDavBase(body.url) } : {}),
        WEBDAV_USERNAME: Object.prototype.hasOwnProperty.call(body, "username") ? String(body.username || "").trim() : readWebDavConfig().username,
        ...(body.password ? { WEBDAV_PASSWORD: String(body.password).trim() } : {}),
        WEBDAV_AUTO_BACKUP: body.autoBackup === true ? "true" : "false",
        WEBDAV_AUTO_INTERVAL_MINUTES: String(Math.max(60, Number(body.autoIntervalMinutes || (Number(body.autoIntervalHours || 24) * 60)) || 1440)),
      };
      upsertEnvValues(values);
      res.json({ ok: true, data: enrichWebDavConfig(readWebDavConfig()) });
    } catch (err) { res.status(400).json({ ok: false, error: err.message }); }
  });

  app.post("/api/webdav/test", async (req, res) => {
    try {
      const cfg = readWebDavConfig(); const body = req.body || {};
      const url = body.url || cfg.url; const username = body.username ?? cfg.username; const password = body.password || parseEnvText(readEnvRaw()).WEBDAV_PASSWORD || "";
      const backups = await listWebDavBackups({ url, username, password });
      if (backups[0]) updateMaintenanceState("webdav", { lastKnownBackupAt: webDavBackupTimeFromName(backups[0]), lastKnownBackupName: backups[0] });
      res.json({ ok: true, data: { reachable: true, backups: backups.slice(0, 10) } });
    } catch (err) { res.status(400).json({ ok: false, error: err.message }); }
  });

  app.post("/api/webdav/backup", async (req, res) => {
    try {
      const cfg = readWebDavConfig(); const body = req.body || {};
      const url = body.url || cfg.url; const username = body.username ?? cfg.username; const password = body.password || parseEnvText(readEnvRaw()).WEBDAV_PASSWORD || "";
      if (body.saveConfig === true) upsertEnvValues({ WEBDAV_ENABLED: body.enabled === true ? "true" : "false", WEBDAV_URL: normalizeWebDavBase(url), WEBDAV_USERNAME: String(username || "").trim(), ...(body.password ? { WEBDAV_PASSWORD: String(body.password).trim() } : {}), WEBDAV_AUTO_BACKUP: body.autoBackup === true ? "true" : "false", WEBDAV_AUTO_INTERVAL_MINUTES: String(Math.max(60, Number(body.autoIntervalMinutes || (Number(body.autoIntervalHours || 24) * 60)) || 1440)) });
      const result = await putWebDavBackup({ url, username, password });
      updateMaintenanceState("webdav", { lastAttemptAt: new Date().toISOString(), lastSuccessAt: new Date().toISOString(), lastBackupName: result.name || "", lastError: "" });
      res.json({ ok: true, data: result });
    } catch (err) { res.status(400).json({ ok: false, error: err.message }); }
  });

  app.post("/api/webdav/history", async (req, res) => {
    try {
      const cfg = readWebDavConfig(); const body = req.body || {};
      const url = body.url || cfg.url; const username = body.username ?? cfg.username; const password = body.password || parseEnvText(readEnvRaw()).WEBDAV_PASSWORD || "";
      const backups = await listWebDavBackups({ url, username, password });
      if (backups[0]) updateMaintenanceState("webdav", { lastKnownBackupAt: webDavBackupTimeFromName(backups[0]), lastKnownBackupName: backups[0] });
      res.json({ ok: true, data: { backups: backups.slice(0, 99) } });
    } catch (err) { res.status(400).json({ ok: false, error: err.message }); }
  });

  app.post("/api/webdav/restore-latest", async (req, res) => {
    try {
      const cfg = readWebDavConfig(); const body = req.body || {};
      const url = body.url || cfg.url; const username = body.username ?? cfg.username; const password = body.password || parseEnvText(readEnvRaw()).WEBDAV_PASSWORD || "";
      const { name, backup } = await getWebDavBackup({ url, username, password, name: body.name });
      const changed = restoreBackupPayload(backup);
      res.json({ ok: true, data: { name, changed } });
    } catch (err) { res.status(400).json({ ok: false, error: err.message }); }
  });

  app.get("/api/categories", (_req, res) => {
    try {
      res.json({ ok: true, data: getCategoriesRaw() });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.post("/api/categories", (req, res) => {
    try {
      const body = req.body || {};
      const key = normalizeCategoryKey(body.key || body.label);
      if (!key) return res.status(400).json({ ok: false, error: "分类标识不能为空" });
      const categories = getCategoriesRaw();
      if (categories.some(c => c.key === key)) return res.status(409).json({ ok: false, error: `分类 "${key}" 已存在` });
      categories.push({ key, label: String(body.label || key).trim(), emoji: String(body.emoji || "🏷️").trim() });
      res.json({ ok: true, data: setCategoriesRaw(categories) });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.patch("/api/categories/:key", (req, res) => {
    try {
      const key = normalizeCategoryKey(req.params.key);
      const body = req.body || {};
      const categories = getCategoriesRaw();
      const item = categories.find(c => c.key === key);
      if (!item) return res.status(404).json({ ok: false, error: `分类 "${key}" 不存在` });
      if (Object.prototype.hasOwnProperty.call(body, "label")) item.label = String(body.label || item.key).trim();
      if (Object.prototype.hasOwnProperty.call(body, "emoji")) item.emoji = String(body.emoji || "🏷️").trim();
      res.json({ ok: true, data: setCategoriesRaw(categories) });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.delete("/api/categories/:key", (req, res) => {
    try {
      const key = normalizeCategoryKey(req.params.key);
      if (key === "forum") return res.status(400).json({ ok: false, error: "默认分类不能删除" });
      const sitesRaw = readSitesRaw();
      let moved = 0;
      for (const site of Object.values(sitesRaw.sites || {})) {
        if ((site.category || "forum") === key) {
          site.category = "forum";
          moved += 1;
        }
      }
      sitesRaw.categories = getCategoriesRaw(sitesRaw).filter(c => c.key !== key);
      writeSitesRaw(sitesRaw);
      res.json({ ok: true, data: { categories: getCategoriesRaw(readSitesRaw()), moved } });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.get("/api/available-sites", (_req, res) => {
    try {
      const sitesRaw = readSitesRaw();
      const existing = new Set(Object.keys(sitesRaw.sites || {}));
      const files = readdirSync(DRIVERS_DIR)
        .filter(file => file.endsWith(".js") && !["base.js"].includes(file))
        .map(file => file.replace(/\.js$/, ""));
      const defaults = {
        nodeseek: { key: "nodeseek", name: "NodeSeek 每日签到", baseUrl: "https://www.nodeseek.com", signinMode: "playwright", category: "forum" },
        v2ex: { key: "v2ex", name: "V2EX 每日签到", baseUrl: "https://www.v2ex.com", signinMode: "playwright", category: "forum" },
        naixi: { key: "naixi", name: "奶昔论坛每日签到", baseUrl: "https://forum.naixi.net", signinMode: "playwright", category: "forum" },
        right: { key: "right", name: "恩山无线论坛每日签到", baseUrl: "https://www.right.com.cn/forum", signinMode: "playwright", category: "forum" },
        pojie52: { key: "pojie52", name: "吾爱破解每日签到", baseUrl: "https://www.52pojie.cn", signinMode: "playwright", category: "forum" },
        nodeloc: { key: "nodeloc", name: "NodeLoc 每日访问", baseUrl: "https://www.nodeloc.com", signinMode: "playwright", category: "forum" },
        pceva: { key: "pceva", name: "PCEVA 每日签到", baseUrl: "https://www.pceva.com.cn", signinMode: "playwright", category: "forum" },
        website: { key: "website", name: "网站 Cookie 检查", baseUrl: "", signinMode: "playwright", category: "website" },
        template: { key: "template", name: "模板站点", baseUrl: "https://example.com", signinMode: "", category: "website" },
      };
      const data = files.map(driver => ({
        driver,
        key: defaults[driver]?.key || driver,
        name: defaults[driver]?.name || driver,
        baseUrl: defaults[driver]?.baseUrl || "",
        signinMode: defaults[driver]?.signinMode || "",
        category: defaults[driver]?.category || "website",
        added: existing.has(defaults[driver]?.key || driver) || Object.values(sitesRaw.sites || {}).some(site => site.driver === driver),
      }));
      res.json({ ok: true, data });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });



  app.get("/api/meta", (_req, res) => {
    try {
      const pkgPath = join(import.meta.dirname, "..", "package.json");
      const pkg = existsSync(pkgPath) ? JSON.parse(readFileSync(pkgPath, "utf-8")) : {};
      res.json({ ok: true, data: { name: pkg.displayName || "SignMate", packageName: pkg.name || "signmate", productName: pkg.productName || "SignMate 签伴", version: pkg.version || "unknown" } });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  // ========================================
  // API: 维护 / 用户数据导入导出 / 批量时间
  // ========================================
  app.get("/api/maintenance/export", (_req, res) => {
    try {
      const readText = (path, fallback = "") => existsSync(path) ? readFileSync(path, "utf-8") : fallback;
      const exportFiles = {
        "config/sites.yaml": readText(SITES_PATH, "sites: {}\n"),
        "config/secrets.yaml": readText(SECRETS_PATH, "{}\n"),
        "config/notify.yaml": readText(NOTIFY_PATH, "{}\n"),
        "config/proxy-settings.json": JSON.stringify(getGlobalProxy(readSitesRaw()), null, 2),
        "config/cookiecloud-settings.json": JSON.stringify(readCookieCloudConfigFull(), null, 2),
        "config/webdav-settings.json": JSON.stringify(readWebDavConfigFull(), null, 2),
        "config/settings.env": readEnvRaw(),
      };
      res.json({ ok: true, data: {
        exportedAt: new Date().toISOString(),
        version: 2,
        scope: "full-user-data",
        note: "包含完整用户配置与敏感凭据；不包含运行日志和签到历史。请像密码文件一样保存。",
        excluded: ["logs/**", "data/history.json", "data/batch-state.json", "data/debug/**"],
        files: exportFiles,
      }});
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  app.post("/api/maintenance/import", (req, res) => {
    try {
      const files = req.body?.files || {};
      const backupDir = join(import.meta.dirname, "..", "backups", `ui-import-${new Date().toISOString().replace(/[:.]/g, "-")}`);
      mkdirSync(backupDir, { recursive: true });
      const writeIfPresent = (rel, abs) => {
        if (!Object.prototype.hasOwnProperty.call(files, rel)) return false;
        if (existsSync(abs)) writeFileSync(join(backupDir, rel.replace(/[\/]/g, "__")), readFileSync(abs, "utf-8"), "utf-8");
        mkdirSync(rel.startsWith("config/") ? CONFIG_DIR : join(import.meta.dirname, ".."), { recursive: true });
        writeFileSync(abs, String(files[rel] || ""), "utf-8");
        return true;
      };
      const parseSettings = (rel) => {
        if (!Object.prototype.hasOwnProperty.call(files, rel)) return null;
        const raw = files[rel];
        return typeof raw === "string" ? JSON.parse(raw || "{}") : (raw || {});
      };
      const changed = [];
      if (writeIfPresent("config/sites.yaml", SITES_PATH) || writeIfPresent("config/site-overrides.yaml", SITES_PATH)) changed.push("config/sites.yaml");
      if (writeIfPresent("config/secrets.yaml", SECRETS_PATH)) changed.push("config/secrets.yaml");
      if (writeIfPresent("config/notify.yaml", NOTIFY_PATH)) changed.push("config/notify.yaml");
      if (Object.prototype.hasOwnProperty.call(files, "config/settings.env") || Object.prototype.hasOwnProperty.call(files, "config/.env") || Object.prototype.hasOwnProperty.call(files, ".env")) {
        if (existsSync(ENV_PATH)) writeFileSync(join(backupDir, "config__settings.env"), readFileSync(ENV_PATH, "utf-8"), "utf-8");
        writeFileSync(ENV_PATH, String(files["config/settings.env"] ?? files["config/.env"] ?? files[".env"] ?? ""), "utf-8");
        changed.push("config/settings.env");
      }
      const cookieCloudSettings = parseSettings("config/cookiecloud-settings.json");
      if (cookieCloudSettings) { applyCookieCloudConfigFull(cookieCloudSettings); changed.push("config/cookiecloud-settings.json"); }
      const webDavSettings = parseSettings("config/webdav-settings.json");
      if (webDavSettings) { applyWebDavConfigFull(webDavSettings); changed.push("config/webdav-settings.json"); }
      res.json({ ok: true, data: { changed, backupDir } });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  app.get("/api/batch-settings", (_req, res) => {
    try {
      const sitesRaw = readSitesRaw();
      const batch = sitesRaw.batch || {};
      res.json({ ok: true, data: {
        signinTime: batch.signin_time || "auto",
        visitTime: batch.visit_time || "auto",
        mode: batch.mode || "random",
        randomStart: batch.random_start || "02:00",
        randomEnd: batch.random_end || "22:00",
      }});
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  app.post("/api/batch-settings", (req, res) => {
    try {
      const sitesRaw = readSitesRaw();
      const body = req.body || {};
      const previousMode = sitesRaw.batch?.mode || "fixed";
      const nextMode = body.mode === "independent" ? "independent" : (body.mode === "fixed" ? "fixed" : (body.mode === "random" ? "random" : (sitesRaw.batch?.mode || "random")));
      sitesRaw.batch = {
        ...(sitesRaw.batch || {}),
        signin_time: Object.prototype.hasOwnProperty.call(body, "signinTime") ? (String(body.signinTime || "auto").trim() || "auto") : (sitesRaw.batch?.signin_time || "auto"),
        visit_time: Object.prototype.hasOwnProperty.call(body, "visitTime") ? (String(body.visitTime || "auto").trim() || "auto") : (sitesRaw.batch?.visit_time || "auto"),
        mode: nextMode,
        random_start: normalizeClockTime(body.randomStart || sitesRaw.batch?.random_start, "02:00"),
        random_end: normalizeClockTime(body.randomEnd || sitesRaw.batch?.random_end, "22:00"),
        random_changed_at: previousMode !== "random" && nextMode === "random" ? new Date().toISOString() : sitesRaw.batch?.random_changed_at,
      };
      writeSitesRaw(sitesRaw);
      res.json({ ok: true, data: sitesRaw.batch });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  // ========================================
  // API: 通知设置
  // ========================================
  app.get("/api/notify", (_req, res) => {
    try {
      const notifyConfig = readNotifyConfig();
      const tg = notifyConfig.telegram || {};
      const bark = notifyConfig.bark || {};
      const botToken = process.env.TELEGRAM_BOT_TOKEN || tg.bot_token || "";
      const chatId = process.env.TELEGRAM_CHAT_ID || tg.chat_id || "";
      res.json({ ok: true, data: {
        signin: { onlyFailures: notifyConfig.signin?.only_failures === true, consolidated: notifyConfig.signin?.consolidated !== false },
        telegram: { enabled: tg.enabled !== false && Boolean(botToken && chatId), hasBotToken: Boolean(botToken), chatId, signin: tg.signin !== false, cookie: tg.cookie !== false, proxy: tg.proxy !== false },
        bark: { enabled: bark.enabled === true, server: bark.server || (bark.url ? String(bark.url).replace(/\/+[^/]+$/, "") : "https://api.day.app"), key: bark.key || (bark.url ? String(bark.url).split("/").filter(Boolean).pop() : ""), url: bark.url || "", signin: bark.signin !== false, cookie: bark.cookie !== false, proxy: bark.proxy !== false },
      }});
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  app.post("/api/notify", (req, res) => {
    try {
      const body = req.body || {};
      const notifyConfig = readNotifyConfig();
      notifyConfig.signin = { ...(notifyConfig.signin || {}), only_failures: body.signin?.onlyFailures === true, consolidated: body.signin?.consolidated !== false };
      const tgCurrent = notifyConfig.telegram || {};
      const tgBody = body.telegram || {};
      const botToken = tgBody.botToken === undefined || String(tgBody.botToken || "").trim() === "" ? (tgCurrent.bot_token || process.env.TELEGRAM_BOT_TOKEN || "") : String(tgBody.botToken || "").trim();
      notifyConfig.telegram = { ...tgCurrent, enabled: tgBody.enabled !== false, bot_token: botToken, chat_id: String(tgBody.chatId ?? tgCurrent.chat_id ?? process.env.TELEGRAM_CHAT_ID ?? "").trim(), signin: tgBody.signin !== false, cookie: tgBody.cookie !== false, proxy: tgBody.proxy !== false };
      const barkBody = body.bark || {};
      const barkServer = String(barkBody.server ?? notifyConfig.bark?.server ?? "https://api.day.app").trim().replace(/\/+$/, "");
      const barkKey = String(barkBody.key ?? notifyConfig.bark?.key ?? "").trim().replace(/^\/+|\/+$/g, "");
      const barkUrl = String(barkBody.url || (barkServer && barkKey ? `${barkServer}/${barkKey}` : notifyConfig.bark?.url || "")).trim();
      notifyConfig.bark = { ...(notifyConfig.bark || {}), enabled: barkBody.enabled === true, server: barkServer, key: barkKey, url: barkUrl, signin: barkBody.signin !== false, cookie: barkBody.cookie !== false, proxy: barkBody.proxy !== false };
      writeNotifyConfig(notifyConfig);
      process.env.TELEGRAM_BOT_TOKEN = notifyConfig.telegram.bot_token || "";
      process.env.TELEGRAM_CHAT_ID = notifyConfig.telegram.chat_id || "";
      configureNotifyChannels(notifyConfig);
      res.json({ ok: true, data: { saved: true } });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  app.post("/api/notify/test", async (req, res) => {
    try {
      const notifyConfig = readNotifyConfig();
      configureNotifyChannels(notifyConfig);
      await notifier.send("SignMate 通知测试", ["✅ 通知通道测试成功"], req.body?.event || "proxy");
      res.json({ ok: true, data: { sent: true } });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  // 兼容旧 Telegram API
  app.get("/api/telegram", (_req, res) => {
    const cfg = readNotifyConfig(); const tg = cfg.telegram || {}; const botToken = process.env.TELEGRAM_BOT_TOKEN || tg.bot_token || ""; const chatId = process.env.TELEGRAM_CHAT_ID || tg.chat_id || "";
    res.json({ ok: true, data: { enabled: Boolean(botToken && chatId), hasBotToken: Boolean(botToken), chatId } });
  });
  app.post("/api/telegram", (req, res) => {
    const cfg = readNotifyConfig(); cfg.telegram = { ...(cfg.telegram || {}), bot_token: String(req.body?.botToken || cfg.telegram?.bot_token || process.env.TELEGRAM_BOT_TOKEN || "").trim(), chat_id: String(req.body?.chatId || cfg.telegram?.chat_id || process.env.TELEGRAM_CHAT_ID || "").trim() }; writeNotifyConfig(cfg); configureNotifyChannels(cfg); res.json({ ok: true, data: { saved: true } });
  });
  app.post("/api/telegram/test", async (_req, res) => {
    try { configureNotifyChannels(readNotifyConfig()); await notifier.send("SignMate Telegram 通知测试", ["✅ SignMate Telegram 通知测试成功"], "signin"); res.json({ ok: true, data: { sent: true } }); } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  // ========================================
  // API: 代理设置
  // ========================================
  app.get("/api/proxy", (_req, res) => {
    try {
      const sitesRaw = readSitesRaw();
      const proxy = getGlobalProxy(sitesRaw);
      const sites = Object.entries(mergedSitesRaw(sitesRaw).sites || {}).map(([key, site]) => ({
        key,
        driver: site.driver || key,
        name: site.note || site.driver || key,
        proxyMode: siteProxyMode(site),
        baseUrl: site.base_url || "",
        proxyLastMode: site.proxy_last_mode || null,
        proxyCheckedAt: site.proxy_checked_at || null,
        proxyDirectOk: site.proxy_direct_ok ?? null,
        proxyCacheFresh: isProxyCacheFresh(site.proxy_checked_at),
      }));
      const notifyConfig = readNotifyConfig();
      res.json({ ok: true, data: { ...proxy, telegramNotifyProxy: notifyConfig.telegram?.proxy !== false, sites } });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.post("/api/proxy", (req, res) => {
    try {
      const sitesRaw = readSitesRaw();
      const body = req.body || {};
      setGlobalProxy(sitesRaw, body);
      writeSitesRaw(sitesRaw);
      if (Object.prototype.hasOwnProperty.call(body, "telegramNotifyProxy")) {
        const notifyConfig = readNotifyConfig();
        notifyConfig.telegram = { ...(notifyConfig.telegram || {}), proxy: body.telegramNotifyProxy !== false };
        writeNotifyConfig(notifyConfig);
        configureNotifyChannels(notifyConfig);
      }
      const notifyConfig = readNotifyConfig();
      res.json({ ok: true, data: { ...getGlobalProxy(sitesRaw), telegramNotifyProxy: notifyConfig.telegram?.proxy !== false } });
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
      const sitesObj = mergeSiteCatalog(sitesRaw.sites || {});
      const key = findSiteKey(sitesObj, siteName);
      if (!key) {
        return res.status(404).json({ ok: false, error: `站点 "${siteName}" 不存在` });
      }
      const override = siteOverrideFor(key, sitesRaw);
      applySiteProxyMode(override, mode);
      writeSitesRaw(sitesRaw);
      res.json({ ok: true, data: { site: key, mode } });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });


  app.post("/api/sites/:siteName/proxy-check", async (req, res) => {
    try {
      const siteName = req.params.siteName;
      const force = req.body?.force === true;
      const sitesRaw = readSitesRaw();
      const sitesObj = mergeSiteCatalog(sitesRaw.sites || {});
      const key = findSiteKey(sitesObj, siteName);
      if (!key) return res.status(404).json({ ok: false, error: `站点 "${siteName}" 不存在` });
      const site = sitesObj[key];
      const proxy = getGlobalProxy(sitesRaw);
      // 保存/切回“自动”时必须重新判断；运行签到/保活时只读取这里保存的结果。
      const testUrl = site.base_url || proxy.testUrl || "https://www.nodeseek.com/";
      const timeoutMs = Math.min(site.timeout || 30000, 8000);
      const direct = await testDirect(testUrl, timeoutMs);
      const proxyUrl = selectProxyUrl(proxy, site.proxy_url || "");
      const proxied = direct.ok || !proxyUrl ? null : await testProxy(proxyUrl, testUrl, Math.max(timeoutMs, 10000));
      const override = siteOverrideFor(key, sitesRaw);
      override.proxy_checked_at = new Date().toISOString();
      override.proxy_direct_ok = direct.ok === true;
      override.proxy_last_mode = direct.ok ? "direct" : (proxied?.ok ? "proxy" : "offline");
      Object.assign(site, override);
      writeSitesRaw(sitesRaw);
      res.json({ ok: true, data: { site: key, cached: false, testUrl, direct, proxy: proxied, directOk: site.proxy_direct_ok, mode: site.proxy_last_mode, checkedAt: site.proxy_checked_at } });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.post("/api/proxy/test", async (req, res) => {
    try {
      const sitesRaw = readSitesRaw();
      const current = getGlobalProxy(sitesRaw);
      const proxyUrls = req.body?.urls ?? req.body?.url ?? current.urls;
      const testUrls = req.body?.testUrls ?? req.body?.testUrl ?? current.testUrls;
      const firstTestUrl = Array.isArray(testUrls) ? testUrls[0] : String(testUrls || current.testUrl).split(/[\r\n,]+/)[0];
      const [direct, pool] = await Promise.all([
        testDirect(firstTestUrl, 8000),
        proxyUrls ? testProxyPool(proxyUrls, testUrls, 10000) : Promise.resolve({ ok: false, proxies: [], error: "代理地址为空" }),
      ]);
      res.json({ ok: true, data: { testUrl: firstTestUrl, direct, proxy: pool, pool } });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });


  app.post("/api/proxy/test-one", async (req, res) => {
    try {
      const proxyUrl = normalizeProxyUrl(req.body?.proxyUrl || req.body?.proxy || "");
      const testUrl = String(req.body?.testUrl || req.body?.url || "").trim();
      if (!proxyUrl) return res.status(400).json({ ok: false, error: "代理地址不能为空" });
      if (!testUrl) return res.status(400).json({ ok: false, error: "测试 URL 不能为空" });
      const timeoutMs = Math.min(Math.max(parseInt(req.body?.timeoutMs || 5000, 10), 1000), 30000);
      const data = await testProxy(proxyUrl, testUrl, timeoutMs);
      res.json({ ok: true, data: { proxyUrl, testUrl, ...data } });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.post("/api/proxy/health-check", async (_req, res) => {
    try { res.json({ ok: true, data: await runProxyHealthCheck({ notify: true }) }); }
    catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  // ========================================
  // API: 验证码解题（已移除 SMZDM/Geetest 专用入口）
  // ========================================
  app.post("/api/signin/:siteName/solve-captcha", (_req, res) => {
    return res.status(410).json({ ok: false, error: "SMZDM/Geetest captcha solver has been removed" });
  });

  // ========================================
  // API: 日志
  // ========================================
  app.get("/api/logs", (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 100, 1000);
    const parseLogLine = line => {
      const m = String(line || "").match(/^\[(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})\]\s+\[([^\]]+)\]\s*(.*)$/);
      if (!m) return null;
      const time = new Date(`${m[1]}T${m[2]}+08:00`).toISOString();
      return { time, msg: `[${m[1]} ${m[2]}] [${m[3]}] ${m[4]}` };
    };
    let fileLogs = [];
    try {
      const logDir = join(import.meta.dirname, "..", "logs");
      const files = existsSync(logDir)
        ? readdirSync(logDir).filter(name => /^signmate-\d{4}-\d{2}-\d{2}\.log$/.test(name)).sort().slice(-3)
        : [];
      const lines = [];
      for (const file of files) {
        const text = readFileSync(join(logDir, file), "utf-8");
        lines.push(...text.split(/\r?\n/).filter(Boolean));
      }
      fileLogs = lines.slice(-Math.max(limit * 2, 300)).map(parseLogLine).filter(Boolean);
    } catch (err) {
      fileLogs = [];
    }
    const merged = [...fileLogs, ...logBuffer]
      .filter(item => item && item.msg)
      .sort((a, b) => Date.parse(a.time || 0) - Date.parse(b.time || 0));
    const deduped = [];
    const seen = new Set();
    for (const item of merged) {
      const key = `${item.time}|${String(item.msg).replace(/\x1b\[[0-9;]*m/g, "")}`;
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(item);
    }
    res.json({ ok: true, data: deduped.slice(-limit) });
  });


  app.get("/api/batch-summary", async (_req, res) => {
    try {
      const history = await store.getHistory(null, 500);
      const sitesRaw = readSitesRaw();
      const batch = sitesRaw.batch || {};
      const batchMode = batch.mode === "fixed" ? "fixed" : (batch.mode === "random" ? "random" : (batch.mode === "independent" ? "independent" : "random"));
      const fixedTime = normalizeClockTime(batch.signin_time || "09:00", "09:00");
      const summary = {
        mode: batchMode,
        fixed: { signin: null, visit: null, dueTime: fixedTime },
        random: { signin: null, visit: null, dueTime: null },
        manual: { all: null, signin: null, visit: null },
        latest: { signin: null, visit: null },
      };
      for (const entry of history) {
        const kind = entry.kind || entry.details?.kind || "signin";
        if (kind !== "signin" && kind !== "visit") continue;
        const item = {
          site: entry.site,
          siteKey: entry.siteKey || entry.key || null,
          success: entry.success,
          time: entry.timestamp || entry.time || null,
        };
        if (!summary.latest[kind]) summary.latest[kind] = item;
        const mode = entry.details?.scheduleMode || entry.details?.schedule_mode || entry.scheduleMode || entry.schedule_mode || null;
        const hasExplicitMode = mode === "manual" || mode === "fixed" || mode === "random";
        if (mode === "manual") {
          if (!summary.manual[kind]) summary.manual[kind] = item;
          if (!summary.manual.all) summary.manual.all = item;
          continue;
        }
        if (mode === "fixed" || mode === "random") {
          if (!summary[mode][kind]) summary[mode][kind] = item;
          continue;
        }
        // 兼容旧历史：之前手动“一键签到/保活”没有写 scheduleMode。
        // 同一分钟内出现大量站点结果时，归为 manual，避免小时钟空白。
        if (!hasExplicitMode) {
          if (!summary.manual[kind]) summary.manual[kind] = item;
          if (!summary.manual.all) summary.manual.all = item;
        }
      }
      try {
        const statePath = join(import.meta.dirname, "..", "data", "random-schedule-state.json");
        const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf-8")) : {};
        summary.random.dueTime = state?.all?.dueTime || null;
        summary.random.completedAt = state?.all?.completedAt || null;
      } catch {}
      res.json({ ok: true, data: summary });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ========================================
  // API: 批量任务状态
  // ========================================
  app.get("/api/batch-state", (_req, res) => {
    try {
      res.json({ ok: true, data: getBatchState() });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.post("/api/batch-cancel", (req, res) => {
    try {
      const reason = String(req.body?.reason || "用户手动终止").trim() || "用户手动终止";
      const result = requestBatchCancel(reason);
      res.json({ ok: true, data: result });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.post("/api/batch-resume", async (_req, res) => {
    try {
      const resume = resumeInterruptedBatchState();
      if (!resume.ok) return res.status(400).json({ ok: false, error: resume.error, data: resume.state });
      logger.info(`[手动] 继续上次中断批量任务: ${resume.remaining} 个剩余站点`);
      const results = await runAll(resume.options || {});
      for (const r of results) await store.addEntry(r.site, r);
      res.json({ ok: true, data: results });
    } catch (err) {
      logger.error(`[批量继续] 异常: ${err.message}`);
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ========================================
  // API: 手动触发签到
  // ========================================
  app.post("/api/visit/run", async (_req, res) => {
    try {
      logger.info("[手动] 开始全部访问保活");
      const results = await runAll({ kind: "visit" });
      for (const r of results) await store.addEntry(r.site, r);
      res.json({ ok: true, data: results });
    } catch (err) {
      logger.error(`[保活] 执行失败: ${err.message}`);
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.post("/api/signin/:siteName?", async (req, res) => {
    try {
      const { sites, secrets } = loadConfig();
      const siteName = req.params.siteName;

      if (siteName) {
        // 触发单个站点
        const site = sites.find(s => s.key === siteName || s.driver === siteName);
        if (!site) {
          return res.status(404).json({ ok: false, error: `站点 "${siteName}" 不存在` });
        }
        const dryRun = req.body?.dryRun === true || req.body?.captchaAiDryRun === true;
        const compareModels = req.body?.compareModels === true || req.body?.captchaAiCompareModels === true;
        const saveSamples = req.body?.saveSamples === true || req.body?.captchaSaveSamples === true;
        const enableSliderSolver = req.body?.enableSliderSolver === true || req.body?.captchaSliderSolverEnabled === true;
        const sliderDiagnostic = req.body?.sliderDiagnostic === true || req.body?.captchaSliderDiagnostic === true;
        const sliderFullDiagnostic = req.body?.sliderFullDiagnostic === true || req.body?.captchaSliderFullDiagnostic === true;
        const explicitFlags = {
          
        };
        const runSite = dryRun
          ? { ...site, ...explicitFlags, captcha_ai_dry_run: true, captcha_ai_local_only: req.body?.localOnly !== false, captcha_ai_compare_models: false, captcha_ai_save_samples: saveSamples, tcaptcha_stealth_diagnostic: !!req.body?.stealthDiagnostic }
          : (sliderDiagnostic ? { ...site, ...explicitFlags, captcha_slider_diagnostic_only: true, captcha_ai_save_samples: saveSamples, captcha_slider_diagnostic_fraction: req.body?.diagnosticFraction }
            : (sliderFullDiagnostic ? { ...site, ...explicitFlags, captcha_slider_full_diagnostic: true, captcha_slider_solver_enabled: true, captcha_ai_save_samples: saveSamples, captcha_slider_slow_trajectory: req.body?.slowTrajectory !== false, tcaptcha_stealth_diagnostic: !!req.body?.stealthDiagnostic }
              : (enableSliderSolver ? { ...site, ...explicitFlags, captcha_slider_solver_enabled: true, captcha_ai_save_samples: saveSamples, tcaptcha_stealth_diagnostic: !!req.body?.stealthDiagnostic, captcha_block_geetest_autoclick: req.body?.blockGeetestAutoclick !== false } : { ...site, ...explicitFlags })));
        logger.info(`[手动] 开始${dryRun ? "AI干跑" : "签到"}: ${site.note || siteName}`);
        const result = await runSingle(runSite, secrets);
        const diagnosticOnlyResult = sliderDiagnostic || sliderFullDiagnostic || result.details?.checkinAction === "tcaptcha_partial_diagnostic" || result.details?.checkinAction === "tcaptcha_full_diagnostic_failed" || result.details?.checkinAction === "tcaptcha_full_diagnostic_solved" || result.details?.tcaptchaDragResult?.diagnosticOnly === true;
        if (!dryRun && !diagnosticOnlyResult && result.details?.dryRun !== true) await store.addEntry(site.note || siteName, result);
        res.json({ ok: true, data: { site: site.note || siteName, dryRun: dryRun || sliderDiagnostic || sliderFullDiagnostic, diagnostic: sliderDiagnostic || sliderFullDiagnostic, ...result } });
      } else {
        // 触发全部：包含签到站点和保活站点，保活站点只访问确认登录态，不点击签到入口。
        logger.info("[手动] 开始全部签到/保活");
        const results = await runAll({ manualScheduleMode: "manual" });

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
