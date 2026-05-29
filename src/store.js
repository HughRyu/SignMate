// ============================================================
// store — 持久化签到记录
// 文件存储于 data/history.json
// ============================================================

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import logger from "./utils/logger.js";

const STORE_PATH = join(import.meta.dirname, "..", "data", "history.json");
const DATA_DIR = join(import.meta.dirname, "..", "data");
const MAX_ENTRIES = 500;

// 内存缓存
let cache = [];
let loaded = false;

function dayKey(value = Date.now()) {
  const d = value instanceof Date ? value : new Date(value || Date.now());
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

function entryDay(entry = {}) {
  return dayKey(entry.time || entry.timestamp || Date.now());
}

function isSameBusinessDay(a = {}, b = {}) {
  return entryDay(a) === entryDay(b);
}

function isSuccessfulSignin(entry = {}) {
  const kind = entry.details?.kind || entry.kind || "signin";
  return kind !== "visit" && entry.success === true;
}

function signRewardValue(entry = {}) {
  const details = entry.details || {};
  const candidates = [details.rewardExp, details.rewardAmount, details.rewardPoints, details.rewardCopper, details.rewardChickenLegs, details.bonusGain];
  for (const value of candidates) {
    const num = Number(String(value ?? "").replace(/,/g, ""));
    if (Number.isFinite(num) && num > 0) return num;
  }
  const message = `${entry.message || ""} ${entry.formatted || ""}`;
  const hit = message.match(/(?:签到经验|签到奖励|奖励)\s*\+?\s*(\d+)/);
  return hit ? Number.parseInt(hit[1], 10) : null;
}

function hasSignReward(entry = {}) {
  return signRewardValue(entry) !== null;
}

function mergePreferredSigninEntry(preferred = {}, latest = {}) {
  const preferredDetails = preferred.details || {};
  const latestDetails = latest.details || {};
  const rewardKeys = ["rewardExp", "rewardAmount", "rewardUnit", "rewardPoints", "rewardCopper", "rewardChickenLegs", "bonusGain", "nextRewardAmount"];
  const details = { ...preferredDetails, ...latestDetails };
  for (const key of ["userGroup", "points", "experience", "totalExp", "vitality", "username", "proxyModeUsed", "proxyUsed", "proxyReason", "fengLevel", "level", "levelTitle", "currentExperience", "creditsLower", "creditsHigher", "fengCoins", "totalCoins", "joinDays", "totalDays", "signInDays", "streakDays"]) {
    if ((details[key] === null || details[key] === undefined || details[key] === "") && latestDetails[key] !== undefined) details[key] = latestDetails[key];
  }
  for (const key of rewardKeys) {
    if (preferredDetails[key] !== undefined && preferredDetails[key] !== null && preferredDetails[key] !== "") details[key] = preferredDetails[key];
  }
  return { ...preferred, ...latest, details, steps: latest.steps?.length ? latest.steps : preferred.steps };
}

/** 读取历史记录 */
async function load() {
  if (loaded) return cache;
  try {
    if (!existsSync(STORE_PATH)) {
      await mkdir(DATA_DIR, { recursive: true });
      await writeFile(STORE_PATH, "[]", "utf-8");
      cache = [];
      loaded = true;
      return cache;
    }
    const raw = await readFile(STORE_PATH, "utf-8");
    cache = JSON.parse(raw) || [];
    loaded = true;
  } catch (err) {
    logger.warn(`[Store] 加载历史失败: ${err.message}`);
    cache = [];
    loaded = true;
  }
  return cache;
}

/** 写入一条签到记录 */
export async function addEntry(siteName, result) {
  await load();
  const details = result.details ? { ...result.details } : null;
  const currentPoints = Number(String(details?.points ?? "").replace(/,/g, ""));
  if (details && Number.isFinite(currentPoints)) {
    const previous = cache.find(e => e.site === siteName && e.details?.points !== undefined);
    const previousPoints = Number(String(previous?.details?.points ?? "").replace(/,/g, ""));
    if (Number.isFinite(previousPoints) && currentPoints >= previousPoints) details.pointsGain = currentPoints - previousPoints;
  }
  const entry = {
    site: siteName,
    siteKey: result.siteKey || result.key || null,
    kind: result.kind || details?.kind || "signin",
    category: result.category || details?.category || null,
    success: result.success,
    message: result.message,
    details,
    steps: Array.isArray(result.steps) ? result.steps : [],
    formatted: result.formatted || "",
    timestamp: new Date().toISOString(),
    time: Date.now(),
  };
  cache.unshift(entry);

  // 裁剪旧记录
  if (cache.length > MAX_ENTRIES) {
    cache.length = MAX_ENTRIES;
  }

  try {
    await writeFile(STORE_PATH, JSON.stringify(cache, null, 2), "utf-8");
  } catch (err) {
    logger.warn(`[Store] 写入失败: ${err.message}`);
  }

  return entry;
}

/** 获取签到历史 */
export async function getHistory(siteName = null, limit = 50) {
  await load();
  let entries = cache;
  if (siteName) {
    entries = entries.filter(e => e.site === siteName);
  }
  return entries.slice(0, limit);
}

/** 获取各站点最新状态 */
export async function getSitesStatus() {
  await load();
  const statusMap = new Map();

  for (const entry of cache) {
    const current = statusMap.get(entry.site);
    if (!current) {
      statusMap.set(entry.site, entry);
      continue;
    }
    // 不允许同一天后续调试/重复运行的失败覆盖已经成功的签到状态。
    // 同一天重复签到如果只返回“今日已签到”，也不要覆盖第一次真正签到时的奖励信息。
    const currentKind = current.details?.kind || current.kind || "signin";
    if (currentKind !== "visit" && isSameBusinessDay(current, entry) && isSuccessfulSignin(entry) && !isSuccessfulSignin(current)) {
      statusMap.set(entry.site, entry);
    } else if (currentKind !== "visit" && isSameBusinessDay(current, entry) && isSuccessfulSignin(entry) && isSuccessfulSignin(current) && !hasSignReward(current) && hasSignReward(entry)) {
      statusMap.set(entry.site, mergePreferredSigninEntry(entry, current));
    }
  }

  return Array.from(statusMap.entries()).map(([site, entry]) => ({
    site,
    siteKey: entry.siteKey || null,
    kind: entry.kind || null,
    category: entry.category || null,
    lastSuccess: entry.success,
    lastMessage: entry.message,
    lastTime: entry.timestamp,
    details: entry.details || null,
    proxyModeUsed: entry.details?.proxyModeUsed || null,
    proxyUsed: entry.details?.proxyUsed ?? null,
    steps: entry.steps || [],
  }));
}


/** 清空签到历史 */
export async function clearHistory() {
  await load();
  cache = [];
  try {
    await mkdir(DATA_DIR, { recursive: true });
    await writeFile(STORE_PATH, "[]", "utf-8");
  } catch (err) {
    logger.warn(`[Store] 清空历史失败: ${err.message}`);
    throw err;
  }
  return true;
}
