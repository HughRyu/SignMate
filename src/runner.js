// ============================================================
// runner — Driver 加载与签到执行引擎
// ============================================================

import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { parse, stringify } from "yaml";
import { dirname } from "node:path";
import logger from "./utils/logger.js";
import notifier from "./notify.js";
import { getGlobalProxy, siteProxyMode, testDirect, selectProxyUrl, isProxyCacheFresh } from "./utils/proxy.js";
import BUILTIN_SITES from "./builtin-sites.js";

// Driver 注册表: name → class
const DRIVER_REGISTRY = {};

const DEFAULT_SITE_CATEGORIES = [
  { key: "forum", label: "论坛", emoji: "💬" },
  { key: "pt", label: "PT站点", emoji: "📀" },
];

function normalizeCategoryKey(value = "") {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
}

function loadCategoryMetaSafe() {
  try {
    const path = new URL("../config/sites.yaml", import.meta.url).pathname;
    const raw = existsSync(path) ? (parse(readFileSync(path, "utf-8")) || {}) : {};
    const source = Array.isArray(raw.categories) && raw.categories.length ? raw.categories : DEFAULT_SITE_CATEGORIES;
    const out = new Map();
    for (const item of source) {
      const key = normalizeCategoryKey(item?.key);
      if (!key || out.has(key)) continue;
      out.set(key, { key, label: String(item.label || key).trim(), emoji: String(item.emoji || "🏷️").trim() });
    }
    return out.size ? out : new Map(DEFAULT_SITE_CATEGORIES.map(item => [item.key, item]));
  } catch {
    return new Map(DEFAULT_SITE_CATEGORIES.map(item => [item.key, item]));
  }
}

function siteCategory(siteConfig = {}) {
  return normalizeCategoryKey(siteConfig.category || (siteConfig.kind === "visit" ? "pt" : "forum")) || "forum";
}

function stripUserCapabilityFields(sitesRaw = {}) {
  let changed = false;
  const sites = sitesRaw.sites || {};
  for (const site of Object.values(sites)) {
    if (!site || typeof site !== "object") continue;
    for (const field of ["kind", "signin_mode", "enforced_kind"]) {
      if (Object.prototype.hasOwnProperty.call(site, field)) {
        delete site[field];
        changed = true;
      }
    }
  }
  return changed;
}

function mergeSiteWithBuiltin(key, override = {}) {
  const { kind: _kind, signin_mode: _signinMode, enforced_kind: _enforcedKind, ...userConfig } = override || {};
  return { ...(BUILTIN_SITES[key] || {}), ...userConfig };
}

function firstNonEmpty(...values) {
  return values.map(v => String(v ?? "").trim()).find(Boolean) || "";
}

function inferResultStatus(result = {}) {
  const details = result.details || {};
  const steps = Array.isArray(result.steps) ? result.steps : [];
  const message = String(result.message || "");
  const stepText = steps.map(s => `${s.label || ""} ${s.detail || ""}`).join("；");
  const allText = `${message}；${stepText}`;
  const siteKind = result.kind || "signin";

  if (details.checkinAction === "already_signed_before_run" || /运行前已是已签到状态|今日已完成签到|已签到\d+天/.test(allText)) return "✓ 今日已签到";
  if (details.checkinAction === "captcha_solved" || (result.success && /OCR 验证码通过|验证码通过/.test(allText))) return "✓ 验证码通过，签到成功";
  // 成功结果优先按成功摘要处理，避免步骤名“验证码/OCR”导致通知误判为拦截。
  if (result.success && /已点击|点击签到|签到成功|签到已得|本次签到获得|签到获得|领取|获得|奖励|魔力值|分享率|check.?in/i.test(allText)) return siteKind === "visit" ? "✓ 保活成功" : "✓ 签到成功";
  if (details.checkinBlockedByCaptcha || details.verificationBlocked || /验证码|极验|captcha|人机|验证措施|验证码输入错误/.test(allText)) return "⚠ 验证码拦截";
  if (result.success) return siteKind === "visit" ? "✓ 保活完成" : "✓ 状态正常";
  if (/Cookie 未配置|登录态异常|访问失败或登录态异常|未识别到登录用户|未登录|账号态|请更新 Cookie|Cookie.*失效|HTTP 401|HTTP 403/.test(allText)) return "⚠ 登录态异常";
  if (/站点离线|直连失败|没有可用代理|ENOTFOUND|ETIMEDOUT|ECONN|timeout/i.test(allText)) return "⚠ 站点不可达";
  return siteKind === "visit" ? "✗ 保活失败" : "✗ 签到失败";
}

function compactResultForNotify(result = {}) {
  const formatted = String(result.formatted || "");
  const lines = formatted.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const head = lines[0] || `${result.success ? "✅" : "❌"} ${result.site || "站点"}`;
  const detailLine = lines.find(line => line.startsWith("📝")) || `📝 ${result.message || ""}`;
  const detail = detailLine.replace(/^📝\s*/, "").trim();
  const details = result.details || {};
  const status = inferResultStatus(result);

  const parts = detail.split(/[；;]+/).map(part => part.trim()).filter(Boolean)
    .filter(part => part !== status && !/^✓\s*(签到成功|今日已签到)$/.test(part));
  const picked = [];
  const prefer = [/连续签到|累计签到|已签到\s*\d+\s*天/, /总签到/, /魔力值|分享率|积分|金币|鸡腿|经验|碎银子|等级|用户|活跃|能量/, /检查时间|签到时间/];
  for (const re of prefer) {
    const idx = parts.findIndex(part => re.test(part) && !picked.includes(part));
    if (idx >= 0) picked.push(parts[idx]);
  }
  for (const part of parts) {
    if (picked.length >= 3) break;
    if (!picked.includes(part)) picked.push(part);
  }

  if (details.beforeDays !== null && details.beforeDays !== undefined && details.afterDays !== null && details.afterDays !== undefined) {
    const delta = Number(details.daysDelta ?? (details.afterDays - details.beforeDays));
    const summary = `天数 ${details.beforeDays} → ${details.afterDays}${Number.isFinite(delta) ? `（+${delta}）` : ""}`;
    if (!picked.some(part => part.includes("天数 "))) picked.unshift(summary);
  }

  const detailLines = [`📝 ${status}`];
  for (let i = 0; i < Math.min(picked.length, 2); i++) detailLines.push(`   ${picked[i]}`);
  if (picked.length > 2) detailLines.push(`   ${picked.slice(2).join("；")}`);
  return [head, ...detailLines].join("\n");
}

function buildCategorizedNotifyMessages(results = []) {
  const categoryMeta = loadCategoryMetaSafe();
  const groups = new Map();
  for (const result of results) {
    if (!result?.formatted) continue;
    const key = result.category || "forum";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(result);
  }

  const order = ["forum", "pt", ...categoryMeta.keys()];
  const seen = new Set();
  const out = [];
  for (const key of order) {
    if (seen.has(key) || !groups.has(key)) continue;
    seen.add(key);
    const items = groups.get(key);
    const meta = categoryMeta.get(key) || { label: key, emoji: "🏷️" };
    const ok = items.filter(item => item.success).length;
    out.push(`${meta.emoji || "🏷️"} ${meta.label || key}（${ok}/${items.length}）`);
    for (const item of items) out.push(compactResultForNotify(item));
  }
  return out;
}

function loadNotifyConfigSafe() {
  try {
    const path = new URL("../config/notify.yaml", import.meta.url).pathname;
    if (!existsSync(path)) return {};
    return parse(readFileSync(path, "utf-8")) || {};
  } catch {
    return {};
  }
}


const BATCH_STATE_PATH = new URL("../data/batch-state.json", import.meta.url).pathname;
let activeBatchRun = null;
let batchInterruptedNotified = false;

export class BatchAlreadyRunningError extends Error {
  constructor(state) {
    super("已有批量任务正在执行，请等待完成或先终止当前任务");
    this.name = "BatchAlreadyRunningError";
    this.code = "BATCH_ALREADY_RUNNING";
    this.state = state || { active: true };
  }
}

function assertNoActiveBatchRun() {
  if (!activeBatchRun) return;
  throw new BatchAlreadyRunningError(getBatchState());
}

function readBatchStateSafe() {
  try {
    if (!existsSync(BATCH_STATE_PATH)) return null;
    return JSON.parse(readFileSync(BATCH_STATE_PATH, "utf-8"));
  } catch (err) {
    logger.warn(`[批量状态] 读取失败: ${err.message}`);
    return null;
  }
}

function writeBatchStateSafe(state) {
  try {
    mkdirSync(dirname(BATCH_STATE_PATH), { recursive: true });
    writeFileSync(BATCH_STATE_PATH, JSON.stringify(state, null, 2), "utf-8");
  } catch (err) {
    logger.warn(`[批量状态] 写入失败: ${err.message}`);
  }
}

function clearBatchStateSafe() {
  try {
    if (existsSync(BATCH_STATE_PATH)) unlinkSync(BATCH_STATE_PATH);
  } catch (err) {
    logger.warn(`[批量状态] 清理失败: ${err.message}`);
  }
}

function batchKindLabel(kind) {
  return kind === "visit" ? "访问保活" : "全部签到";
}

function compactBatchStateForNotify(state = {}, reason = "未知原因") {
  const done = Number(state.done || 0);
  const total = Number(state.total || 0);
  const ok = Number(state.successCount || 0);
  const failed = Number(state.failureCount || 0);
  const started = state.startedAt ? new Date(state.startedAt).toLocaleString("zh-CN", { timeZone: process.env.TZ || "Asia/Shanghai", hour12: false }) : "未知";
  const current = state.currentSite ? `；中断时正在处理：${state.currentSite}` : "";
  const last = Array.isArray(state.results) && state.results.length
    ? state.results.slice(-5).map(r => `${r.success ? "✅" : "❌"} ${r.site || r.key || "站点"}`).join("、")
    : "暂无已完成站点";
  return [
    `⚠️ ${batchKindLabel(state.kind)}任务被中断：${reason}`,
    `进度：${done}/${total}；成功 ${ok}；失败 ${failed}${current}`,
    `开始时间：${started}`,
    `最近结果：${last}`,
    "说明：这通常发生在容器重启、docker compose 重建、主机重启或进程被终止时。",
  ];
}

async function notifyBatchInterrupted(state, reason) {
  if (!state || state.completedAt || state.interruptedNotifiedAt || batchInterruptedNotified) return false;
  batchInterruptedNotified = true;
  const title = `SignMate ${batchKindLabel(state.kind)}被中断`;
  const messages = compactBatchStateForNotify(state, reason);
  try {
    await notifier.send(title, messages, "signin");
    writeBatchStateSafe({ ...state, interruptedNotifiedAt: new Date().toISOString(), interruptReason: reason });
    return true;
  } catch (err) {
    logger.warn(`[批量状态] 中断通知发送失败: ${err.message}`);
    return false;
  }
}

export async function notifyInterruptedBatchOnStartup() {
  const state = readBatchStateSafe();
  if (!state || state.completedAt || state.interruptedNotifiedAt) return false;
  logger.warn(`[批量状态] 检测到上次${batchKindLabel(state.kind)}未完成: ${state.done || 0}/${state.total || 0}`);
  return notifyBatchInterrupted(state, "服务重启后检测到上次批量任务未完成");
}

export async function notifyActiveBatchBeforeExit(signal = "SIGTERM") {
  const state = activeBatchRun || readBatchStateSafe();
  if (!state || state.completedAt) return false;
  const withSignal = { ...state, interruptedAt: new Date().toISOString(), interruptSignal: signal };
  writeBatchStateSafe(withSignal);
  return notifyBatchInterrupted(withSignal, `收到 ${signal}，服务正在退出`);
}

export function getBatchState() {
  const state = activeBatchRun || readBatchStateSafe();
  if (!state) return { active: false };
  const active = !!activeBatchRun || (!state.completedAt && !state.interruptedNotifiedAt && !state.cancelledAt);
  return { ...state, active };
}

export function requestBatchCancel(reason = "用户手动终止") {
  const now = new Date().toISOString();
  const state = activeBatchRun || readBatchStateSafe();
  if (!state || state.completedAt) {
    return { active: false, message: "当前没有正在执行的批量任务", state: state || { active: false } };
  }
  const next = {
    ...state,
    cancelRequestedAt: now,
    cancelReason: reason,
    stoppedByUser: true,
  };
  if (activeBatchRun) Object.assign(activeBatchRun, next);
  writeBatchStateSafe(next);
  return { active: !!activeBatchRun, message: activeBatchRun ? "已请求终止；当前站点结束后停止后续站点" : "已标记终止", state: getBatchState() };
}

export function resumeInterruptedBatchState() {
  const state = readBatchStateSafe();
  if (!state || state.completedAt || !state.interruptedNotifiedAt || Number(state.total || 0) <= 0) {
    return { ok: false, error: "没有可继续的中断批量任务", state: state || { active: false } };
  }
  const completedKeys = new Set([
    ...(Array.isArray(state.completedKeys) ? state.completedKeys : []),
    ...(Array.isArray(state.results) ? state.results : []).map(r => r.key || r.siteKey).filter(Boolean),
  ].filter(Boolean).map(String));
  return {
    ok: true,
    options: {
      kind: state.kind === "visit" ? "visit" : undefined,
      skipKeys: [...completedKeys],
      resumedFromBatchId: state.id,
      originalTotal: Number(state.total || 0),
    },
    state,
    remaining: Math.max(0, Number(state.total || 0) - completedKeys.size),
  };
}


/**
 * 注册一个 driver
 * @param {string} name    driver 名称（对应 sites.yaml 中的 driver 字段）
 * @param {class}  driverClass 继承自 BaseDriver 的类
 */
export function registerDriver(name, driverClass) {
  DRIVER_REGISTRY[name] = driverClass;
}

/**
 * 加载所有配置
 */
export function loadConfig() {
  // 加载 sites.yaml（可选）。全新部署没有 sites.yaml 时应能启动，
  // 但站点列表保持为空；内置站点只作为后续“添加站点/模板”和已有配置 merge 的来源。
  const sitesPath = new URL("../config/sites.yaml", import.meta.url).pathname;
  const hasSitesConfig = existsSync(sitesPath);
  let sitesRaw = {};
  if (hasSitesConfig) {
    sitesRaw = parse(readFileSync(sitesPath, "utf-8")) || {};
    if (stripUserCapabilityFields(sitesRaw)) {
      writeFileSync(sitesPath, stringify(sitesRaw), "utf-8");
      logger.info("[配置] 已清理用户配置中的站点能力字段");
    }
  } else {
    logger.warn(`[配置] 未找到 sites.yaml，按全新部署空站点启动: ${sitesPath}`);
  }
  const proxy = getGlobalProxy(sitesRaw);
  const overrideSites = sitesRaw.sites || {};
  // 只运行/展示用户已经添加到 sites.yaml 的站点。
  // BUILTIN_SITES 只用于给已添加站点补默认字段，不能因为 sites.yaml 存在就自动展开全部内置站点。
  const siteKeys = Object.keys(overrideSites);
  const mergedSites = Object.fromEntries(
    siteKeys.map(key => [key, mergeSiteWithBuiltin(key, overrideSites[key])])
  );
  const sites = Object.entries(mergedSites).filter(([, site]) => site.hidden !== true).map(([key, site]) => {
    const rawProxyMode = siteProxyMode(site);
    const proxyUrl = site.proxy_url || selectProxyUrl(proxy) || "";
    const hasUsableProxy = Boolean(proxyUrl) && (proxy.health?.usableUrls?.length ? true : !proxy.health || proxy.health.ok !== false);
    return {
      key,
      ...site,
      // 站点代理模式必须按站点配置/自动判断执行，不能因全局代理开关关闭而静默改成 off。
      // 全局开关只影响“未明确配置代理策略”的默认状态；proxy:on 和 proxy:auto 的已保存判断都应生效。
      proxy_mode: rawProxyMode,
      proxy_url: proxyUrl,
      proxy_global_enabled: proxy.enabled,
      proxy_available: (rawProxyMode === "on" || rawProxyMode === "auto") ? hasUsableProxy : false,
      proxy_checked_at: site.proxy_checked_at || site.proxyCheckedAt || null,
      proxy_direct_ok: site.proxy_direct_ok ?? site.proxyDirectOk ?? null,
    };
  });

  // 加载 secrets.yaml（可选）
  let secrets = {};
  const secretsPath = new URL("../config/secrets.yaml", import.meta.url).pathname;
  if (existsSync(secretsPath)) {
    secrets = parse(readFileSync(secretsPath, "utf-8"));
  }

  return { sites, secrets, proxy };
}


async function resolveProxyForSite(siteConfig, forceProxy = false) {
  const proxyMode = siteConfig.proxy_mode || siteProxyMode(siteConfig);
  const proxyUrl = siteConfig.proxy_url || process.env.SIGNMATE_PROXY_URL || "";

  if (proxyMode === "off") {
    return { ...siteConfig, proxy_url: "", proxy_used: false, proxy_reason: "disabled", proxy_mode_used: "direct" };
  }

  if (forceProxy || proxyMode === "on") {
    if (!proxyUrl || siteConfig.proxy_available === false) {
      return { ...siteConfig, proxy_used: false, proxy_reason: "no_valid_proxy", proxy_mode_used: "offline", site_offline: true, offline_reason: "代理不可用：没有健康可用的代理" };
    }
    logger.info(`[代理] ${siteConfig.note || siteConfig.driver} → ${forceProxy ? "手动强制代理" : "强制使用代理"}`);
    return { ...siteConfig, proxy_url: proxyUrl, proxy_used: true, proxy_reason: forceProxy ? "forced_manual" : "forced", proxy_mode_used: "proxy" };
  }

  // 自动模式只使用“保存代理策略时”写入的判断结果，签到/保活运行时不再重新探测直连。
  // 避免运行时网络抖动把自动模式临时改判成离线，也符合“保存时判定”的产品语义。
  if (siteConfig.proxy_direct_ok === true || siteConfig.proxy_last_mode === "direct") {
    logger.info(`[代理] ${siteConfig.note || siteConfig.driver} → 自动模式使用已保存判断：直连`);
    return { ...siteConfig, proxy_url: "", proxy_used: false, proxy_reason: "saved_direct", proxy_mode_used: "direct" };
  }

  if (siteConfig.proxy_direct_ok === false || siteConfig.proxy_last_mode === "proxy") {
    if (!proxyUrl || siteConfig.proxy_available === false) {
      logger.warn(`[代理] ${siteConfig.note || siteConfig.driver} → 自动模式已保存为代理，但当前没有健康可用的代理`);
      return { ...siteConfig, proxy_used: false, proxy_reason: "saved_proxy_no_valid_proxy", proxy_mode_used: "offline", site_offline: true, offline_reason: "代理不可用：自动模式已保存为走代理，但当前没有健康可用的代理" };
    }
    logger.info(`[代理] ${siteConfig.note || siteConfig.driver} → 自动模式使用已保存判断：代理`);
    return { ...siteConfig, proxy_url: proxyUrl, proxy_used: true, proxy_reason: "saved_proxy", proxy_mode_used: "proxy" };
  }

  // 旧配置没有保存过自动判断时，默认直连；下次保存“自动”时会写入明确结果。
  logger.info(`[代理] ${siteConfig.note || siteConfig.driver} → 自动模式未保存判断，默认直连`);
  return { ...siteConfig, proxy_url: "", proxy_used: false, proxy_reason: "auto_unchecked_direct", proxy_mode_used: "direct" };
}

function rememberProxyMode(siteConfig, mode, directOk = null) {
  if (!mode || mode === "offline") return;
  try {
    const sitesPath = new URL("../config/sites.yaml", import.meta.url).pathname;
    const raw = parse(readFileSync(sitesPath, "utf-8")) || {};
    const entries = Object.entries(raw.sites || {});
    const targetKey = siteConfig.key || "";
    const matched = entries.find(([key]) => targetKey && key === targetKey)
      || entries.find(([, site]) => !targetKey && site.note === siteConfig.note)
      || entries.find(([, site]) => !targetKey && site.driver === siteConfig.driver && site.note === siteConfig.note);
    if (!matched) return;
    const [, site] = matched;
    site.proxy_last_mode = mode;
    site.proxy_checked_at = new Date().toISOString();
    site.proxy_direct_ok = directOk ?? (mode === "direct");
    writeFileSync(sitesPath, stringify(raw), "utf-8");
  } catch (err) {
    logger.warn(`[代理] 记录上次代理模式失败: ${err.message}`);
  }
}

/**
 * 执行单个站点的签到
 *
 * @param {object} siteConfig  站点配置
 * @param {object} secrets     全局凭据
 * @returns {Promise<{success: boolean, message: string, site: string}>}
 */
export async function runSingle(siteConfig, secrets) {
  const driverName = siteConfig.driver;
  const DriverClass = DRIVER_REGISTRY[driverName];

  if (!DriverClass) {
    logger.warn(`[跳过] Driver "${driverName}" 未注册，请确认已 import`);
    return { success: false, message: `Driver "${driverName}" 未注册`, site: siteConfig.note || driverName, kind: siteConfig.kind || "signin" };
  }

  let effectiveSiteConfig = await resolveProxyForSite(siteConfig);
  if (effectiveSiteConfig.site_offline) {
    return { success: false, message: effectiveSiteConfig.offline_reason || "站点离线：直连和代理均不可用", site: siteConfig.note || driverName, formatted: `❌ ${siteConfig.note || driverName}
📝 ${effectiveSiteConfig.offline_reason || "站点离线"}`, kind: siteConfig.kind || "signin", category: siteCategory(siteConfig), categoryLabel: (loadCategoryMetaSafe().get(siteCategory(siteConfig))?.label || siteCategory(siteConfig)), details: { proxyModeUsed: "offline", proxyUsed: false, proxyReason: effectiveSiteConfig.proxy_reason }, steps: [{ label: "判断站点连通性", ok: false, detail: effectiveSiteConfig.offline_reason || "站点离线" }] };
  }
  let driver = new DriverClass(effectiveSiteConfig, secrets);
  let result = await driver.runWithRetry();

  result.details = { ...(result.details || {}), proxyModeUsed: effectiveSiteConfig.proxy_mode_used, proxyUsed: effectiveSiteConfig.proxy_used, proxyReason: effectiveSiteConfig.proxy_reason };
  if (result.success) rememberProxyMode(siteConfig, effectiveSiteConfig.proxy_mode_used, effectiveSiteConfig.proxy_mode_used === "direct");
  const logLine = driver.formatResult(result);
  logger.info(logLine);

  return {
    success: result.success,
    message: result.message,
    site: siteConfig.note || driverName,
    siteKey: siteConfig.key || driverName,
    formatted: logLine,
    kind: siteConfig.kind || (siteConfig.driver === "website" || siteConfig.driver === "visit" ? "visit" : "signin"),
    category: siteCategory(siteConfig),
    categoryLabel: (loadCategoryMetaSafe().get(siteCategory(siteConfig))?.label || siteCategory(siteConfig)),
    details: result.details || null,
    steps: result.steps || [],
  };
}

/**
 * 执行所有已启用的站点任务（签到或保活）
 */
export async function runAll(options = {}) {
  assertNoActiveBatchRun();
  const { sites, secrets } = loadConfig();
  const kind = options.kind || null;
  const autoOnly = options.autoOnly === true;
  const skipKeys = new Set(Array.isArray(options.skipKeys) ? options.skipKeys.map(String) : []);
  const enabled = sites.filter(s => {
    if (s.enabled === false) return false;
    const key = String(s.key || s.driver || "");
    if (skipKeys.has(key)) return false;
    const siteKind = s.kind || (s.driver === "website" || s.driver === "visit" ? "visit" : "signin");
    if (kind && siteKind !== kind) return false;
    if (autoOnly && s.schedule && s.schedule !== "auto") return false;
    if (autoOnly && options.scheduleMode) {
      const defaultMode = options.defaultScheduleMode === "random" ? "random" : "fixed";
      const rawMode = s.schedule_mode || s.scheduleMode || defaultMode;
      const mode = rawMode === "independent" ? "independent" : (rawMode === "random" ? "random" : "fixed");
      if (mode !== options.scheduleMode) return false;
    }
    return true;
  });

  if (enabled.length === 0) {
    logger.info("[签到] 没有已启用的站点");
    return [];
  }

  logger.info(`[${kind === "visit" ? "保活" : "签到"}] 开始执行 (${enabled.length} 个站点)`);

  const results = [];
  const batchState = {
    id: `${kind || "signin"}-${Date.now()}`,
    kind: kind === "visit" ? "visit" : "signin",
    startedAt: new Date().toISOString(),
    total: Number(options.originalTotal || 0) || enabled.length,
    done: skipKeys.size,
    successCount: 0,
    failureCount: 0,
    currentSite: "",
    currentKey: "",
    results: [],
    completedKeys: [],
    ...(options.resumedFromBatchId ? { resumedFromBatchId: options.resumedFromBatchId } : {}),
    ...(skipKeys.size ? { skippedKeys: [...skipKeys] } : {}),
  };
  activeBatchRun = batchState;
  batchInterruptedNotified = false;
  writeBatchStateSafe(batchState);

  for (const site of enabled) {
    if (batchState.cancelRequestedAt) {
      logger.warn(`[${kind === "visit" ? "保活" : "签到"}] 已终止，跳过剩余站点: ${batchState.done}/${batchState.total}`);
      break;
    }
    logger.info(`[${"-".repeat(40)}]`);
    batchState.currentSite = site.note || site.key || site.driver || "未知站点";
    batchState.currentKey = site.key || site.driver || "";
    writeBatchStateSafe(batchState);
    try {
      const result = await runSingle(site, secrets);
      const runScheduleMode = options.scheduleMode || options.manualScheduleMode || null;
      if (runScheduleMode) {
        result.details = { ...(result.details || {}), scheduleMode: runScheduleMode };
        result.scheduleMode = runScheduleMode;
      }
      results.push(result);
    } catch (err) {
      const siteName = site.note || site.key || site.driver || "未知站点";
      const message = `执行异常：${err?.message || String(err)}`;
      logger.error(`[${siteName}] ${message}`);
      results.push({
        site: siteName,
        key: site.key,
        category: siteCategory(site),
        kind: site.kind || (site.driver === "website" || site.driver === "visit" ? "visit" : "signin"),
        success: false,
        message,
        details: { error: err?.stack || err?.message || String(err), ...((options.scheduleMode || options.manualScheduleMode) ? { scheduleMode: options.scheduleMode || options.manualScheduleMode } : {}) },
        scheduleMode: options.scheduleMode || options.manualScheduleMode || null,
        steps: [{ label: "执行异常", ok: false, detail: err?.message || String(err) }],
        formatted: `❌ ${siteName}\n📝 ${message}`,
        timestamp: new Date().toISOString(),
        time: Date.now(),
      });
    } finally {
      const latest = results[results.length - 1];
      batchState.done = skipKeys.size + results.length;
      batchState.successCount = results.filter(r => r.success).length;
      batchState.failureCount = results.length - batchState.successCount;
      if (latest) {
        batchState.results = results.slice(-20).map(r => ({ site: r.site, key: r.key || r.siteKey, siteKey: r.siteKey || r.key, success: !!r.success, message: String(r.message || "").slice(0, 200), time: r.time || Date.now() }));
        batchState.completedKeys = [...skipKeys, ...results.map(r => r.key || r.siteKey).filter(Boolean)];
      }
      writeBatchStateSafe(batchState);
    }
  }

  batchState.currentSite = "";
  batchState.currentKey = "";
  batchState.completedAt = new Date().toISOString();
  if (batchState.cancelRequestedAt) batchState.cancelledAt = batchState.completedAt;
  writeBatchStateSafe(batchState);
  activeBatchRun = null;

  logger.info(`[${kind === "visit" ? "保活" : "签到"}] ${batchState.cancelRequestedAt ? "已终止" : "完成"}: ${results.filter(r => r.success).length}/${results.length} 成功`);

  // 发送通知
  if (results.some(r => r.formatted)) {
    const successCount = results.filter(r => r.success).length;
    const totalCount = results.length;
    const title = `${batchState.cancelRequestedAt ? "已终止 · " : ""}${kind === "visit" ? "访问保活报告" : (kind ? "自动签到报告" : "全部签到/保活报告")} (${successCount}/${totalCount})`;
    const notifyConfig = loadNotifyConfigSafe();
    const signinNotify = notifyConfig.signin || {};
    const onlyFailures = signinNotify.only_failures === true;
    const notifyResults = onlyFailures ? results.filter(r => !r.success) : results;
    const out = buildCategorizedNotifyMessages(notifyResults);
    if (out.length > 0) {
      try {
        await notifier.send(title, out, "signin");
      } catch (err) {
        batchState.notifyFailedAt = new Date().toISOString();
        batchState.notifyError = err?.message || String(err);
        writeBatchStateSafe(batchState);
        logger.error(`[通知] 批量结果通知失败，保留批量状态供前台提示: ${batchState.notifyError}`);
      }
    }
  }

  if (!batchState.cancelRequestedAt && !batchState.notifyFailedAt) clearBatchStateSafe();
  return results;
}
