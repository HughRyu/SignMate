// ============================================================
// scheduler — Cron 调度器
// 基于 node-cron 管理各站点的定时签到任务
// ============================================================

import cron from "node-cron";
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { parse } from "yaml";
import { join } from "node:path";
import logger from "./utils/logger.js";
import notifier from "./notify.js";
import * as store from "./store.js";

/**
 * 注册所有定时签到任务
 * @param {Array}  enabledSites  已启用的站点列表
 * @param {object} secrets       凭据
 * @returns {number} 注册的任务数
 */
function loadNotifyConfigSafe() {
  try {
    const path = new URL("../config/notify.yaml", import.meta.url).pathname;
    if (!existsSync(path)) return {};
    return parse(readFileSync(path, "utf-8")) || {};
  } catch {
    return {};
  }
}

function batchTimeToCron(value, fallback) {
  const v = String(value || "auto").trim();
  const time = v === "auto" ? fallback : v;
  const m = time.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return "";
  const hour = Math.max(0, Math.min(23, Number(m[1])));
  const minute = Math.max(0, Math.min(59, Number(m[2])));
  return `${minute} ${hour} * * *`;
}

function loadBatchConfigSafe() {
  try {
    const path = new URL("../config/sites.yaml", import.meta.url).pathname;
    if (!existsSync(path)) return {};
    return (parse(readFileSync(path, "utf-8")) || {}).batch || {};
  } catch { return {}; }
}

function parseTime(value = "00:00", fallback = "00:00") {
  const m = String(value || fallback).match(/^(\d{1,2}):(\d{2})$/) || String(fallback).match(/^(\d{1,2}):(\d{2})$/);
  return {
    hour: Math.max(0, Math.min(23, Number(m?.[1] || 0))),
    minute: Math.max(0, Math.min(59, Number(m?.[2] || 0))),
  };
}

function randomCronBetween(start = "02:00", end = "22:00") {
  const a = parseTime(start, "02:00");
  const b = parseTime(end, "22:00");
  const startMin = a.hour * 60 + a.minute;
  const endMin = b.hour * 60 + b.minute;
  const [lo, hi] = startMin <= endMin ? [startMin, endMin] : [endMin, startMin];
  const picked = lo + Math.floor(Math.random() * (hi - lo + 1));
  return `${picked % 60} ${Math.floor(picked / 60)} * * *`;
}

function effectiveScheduleMode(site = {}, defaultMode = "fixed") {
  const mode = site.schedule_mode || site.scheduleMode || defaultMode;
  return mode === "independent" ? "independent" : (mode === "random" ? "random" : "fixed");
}

const DATA_DIR = new URL("../data", import.meta.url).pathname;
const RANDOM_STATE_PATH = join(DATA_DIR, "random-schedule-state.json");
const runningBatchKinds = new Set();

function localParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: process.env.TZ || "Asia/Shanghai",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(date).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hour: Number(parts.hour || 0),
    minute: Number(parts.minute || 0),
  };
}

function minuteOfDayFromTime(value = "09:00", fallback = "09:00") {
  const t = parseTime(value, fallback);
  return t.hour * 60 + t.minute;
}

function timeFromMinute(minute = 0) {
  const m = Math.max(0, Math.min(1439, Number(minute) || 0));
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

function readRandomStateSafe() {
  try {
    if (!existsSync(RANDOM_STATE_PATH)) return {};
    return JSON.parse(readFileSync(RANDOM_STATE_PATH, "utf-8")) || {};
  } catch (err) {
    logger.warn(`[随机调度] 读取状态失败: ${err.message}`);
    return {};
  }
}

function writeRandomStateSafe(state = {}) {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(RANDOM_STATE_PATH, JSON.stringify(state, null, 2), "utf-8");
  } catch (err) {
    logger.warn(`[随机调度] 写入状态失败: ${err.message}`);
  }
}

function siteNamesForMatch(site = {}) {
  return new Set([site.key, site.driver, site.note, site.name].filter(Boolean).map(v => String(v)));
}

async function todayLooksAlreadyBatchRan(kind, eligibleSites, today) {
  if (!eligibleSites.length) return false;
  try {
    const history = await store.getHistory(null, 500);
    const names = new Set();
    for (const site of eligibleSites) for (const name of siteNamesForMatch(site)) names.add(name);
    const matched = new Set();
    for (const entry of history) {
      const p = localParts(new Date(entry.timestamp || entry.time || Date.now()));
      if (p.date !== today) continue;
      const entryKind = entry.kind || entry.details?.kind || "signin";
      if (kind && entryKind !== kind) continue;
      const candidates = [entry.site, entry.siteKey, entry.key].filter(Boolean).map(v => String(v));
      if (candidates.some(v => names.has(v))) matched.add(candidates.find(v => names.has(v)) || candidates[0]);
    }
    const threshold = eligibleSites.length <= 2 ? eligibleSites.length : Math.max(2, Math.ceil(eligibleSites.length * 0.5));
    return matched.size >= threshold;
  } catch (err) {
    logger.warn(`[随机调度] 检查今日历史失败: ${err.message}`);
    return false;
  }
}

function eligibleAutoSites(enabledSites, kind, mode, defaultBatchMode) {
  return enabledSites.filter(site => {
    const siteKind = site.kind || (site.driver === "website" || site.driver === "visit" ? "visit" : "signin");
    return siteKind === kind && (!site.schedule || site.schedule === "auto") && effectiveScheduleMode(site, defaultBatchMode) === mode;
  });
}

function randomMinuteInWindow(start, end, nowMinute) {
  const lo0 = minuteOfDayFromTime(start, "02:00");
  const hi0 = minuteOfDayFromTime(end, "22:00");
  const [lo, hi] = lo0 <= hi0 ? [lo0, hi0] : [hi0, lo0];
  let from = lo;
  if (nowMinute >= lo && nowMinute <= hi) from = Math.min(hi, nowMinute + 5);
  if (nowMinute > hi) return null;
  return from + Math.floor(Math.random() * (hi - from + 1));
}

async function ensureRandomPlan({ state, kind, batch, defaultBatchMode, enabledSites, now }) {
  const key = kind === "visit" ? "visit" : "signin";
  const start = String(batch.random_start || "02:00");
  const end = String(batch.random_end || "22:00");
  const current = state[key] || {};
  const eligible = eligibleAutoSites(enabledSites, key, "random", defaultBatchMode);
  if (!eligible.length) return null;
  const settingsChanged = current.mode !== "random" || current.rangeStart !== start || current.rangeEnd !== end;
  if (current.date === now.date && !settingsChanged) return current;

  if (await todayLooksAlreadyBatchRan(key, eligible, now.date)) {
    const skipped = {
      date: now.date,
      mode: "random",
      rangeStart: start,
      rangeEnd: end,
      dueMinute: null,
      dueTime: "今日已批量执行，跳过随机补跑",
      completedDate: now.date,
      skippedReason: "today_batch_already_ran",
      generatedAt: new Date().toISOString(),
    };
    state[key] = skipped;
    writeRandomStateSafe(state);
    logger.info(`[随机调度] ${key === "visit" ? "保活" : "签到"} 今日已有批量执行记录，跳过当天随机执行`);
    return skipped;
  }

  const nowMinute = now.hour * 60 + now.minute;
  const dueMinute = randomMinuteInWindow(start, end, nowMinute);
  const plan = {
    date: now.date,
    mode: "random",
    rangeStart: start,
    rangeEnd: end,
    dueMinute,
    dueTime: dueMinute === null ? "明日重新随机" : timeFromMinute(dueMinute),
    completedDate: null,
    generatedAt: new Date().toISOString(),
  };
  state[key] = plan;
  writeRandomStateSafe(state);
  logger.info(`[随机调度] ${key === "visit" ? "保活" : "签到"} 今日随机时间 → ${plan.dueTime} (${start}~${end})`);
  return plan;
}

async function runBatchJob(mode, label, defaultBatchMode, options = {}) {
  const kind = options.kind || "all";
  const runKey = `${kind}:${mode}`;
  if (runningBatchKinds.has(runKey)) return false;
  runningBatchKinds.add(runKey);
  try {
    const { runAll } = await import("./runner.js");
    logger.info(`[定时触发] ${label}`);
    const results = await runAll({ autoOnly: true, scheduleMode: mode, defaultScheduleMode: defaultBatchMode, ...(options.kind ? { kind: options.kind } : {}) });
    for (const r of results) {
      r.details = { ...(r.details || {}), scheduleMode: mode };
      r.scheduleMode = mode;
      await store.addEntry(r.site, r);
    }
    return true;
  } catch (err) {
    if (err?.code === "BATCH_ALREADY_RUNNING") {
      logger.warn(`[定时触发] ${label} 跳过：已有批量任务正在执行`);
      return false;
    }
    throw err;
  } finally {
    runningBatchKinds.delete(runKey);
  }
}

function siteAutoKind(site = {}) {
  return site.kind || (site.driver === "website" || site.driver === "visit" ? "visit" : "signin");
}

function eligibleAutoSitesAll(enabledSites, mode, defaultBatchMode) {
  return enabledSites.filter(site => (!site.schedule || site.schedule === "auto") && effectiveScheduleMode(site, defaultBatchMode) === mode);
}

function eligibleAutoSitesByKind(enabledSites, mode, defaultBatchMode, kind) {
  return eligibleAutoSitesAll(enabledSites, mode, defaultBatchMode).filter(site => siteAutoKind(site) === kind);
}

async function todayLooksAlreadyBatchRanAll(eligibleSites, today) {
  if (!eligibleSites.length) return false;
  try {
    const history = await store.getHistory(null, 800);
    const names = new Set();
    for (const site of eligibleSites) for (const name of siteNamesForMatch(site)) names.add(name);
    const matched = new Set();
    for (const entry of history) {
      const p = localParts(new Date(entry.timestamp || entry.time || Date.now()));
      if (p.date !== today) continue;
      const candidates = [entry.site, entry.siteKey, entry.key].filter(Boolean).map(v => String(v));
      if (candidates.some(v => names.has(v))) matched.add(candidates.find(v => names.has(v)) || candidates[0]);
    }
    const threshold = eligibleSites.length <= 2 ? eligibleSites.length : Math.max(2, Math.ceil(eligibleSites.length * 0.5));
    return matched.size >= threshold;
  } catch (err) {
    logger.warn(`[随机调度] 检查今日历史失败: ${err.message}`);
    return false;
  }
}

async function ensureRandomPlanAll({ state, batch, defaultBatchMode, enabledSites, now }) {
  const key = "all";
  const start = String(batch.random_start || "02:00");
  const end = String(batch.random_end || "22:00");
  const current = state[key] || {};
  const eligible = eligibleAutoSitesAll(enabledSites, "random", defaultBatchMode);
  if (!eligible.length) return null;
  const settingsChanged = current.mode !== "random" || current.rangeStart !== start || current.rangeEnd !== end;
  if (current.date === now.date && !settingsChanged) return current;

  if (await todayLooksAlreadyBatchRanAll(eligible, now.date)) {
    const skipped = {
      date: now.date,
      mode: "random",
      rangeStart: start,
      rangeEnd: end,
      dueMinute: null,
      dueTime: "今日已批量执行，跳过随机补跑",
      completedDate: now.date,
      skippedReason: "today_batch_already_ran",
      generatedAt: new Date().toISOString(),
    };
    state[key] = skipped;
    writeRandomStateSafe(state);
    logger.info("[随机调度] 今日已有批量签到/保活记录，跳过当天随机执行");
    return skipped;
  }

  const nowMinute = now.hour * 60 + now.minute;
  const dueMinute = randomMinuteInWindow(start, end, nowMinute);
  const plan = {
    date: now.date,
    mode: "random",
    rangeStart: start,
    rangeEnd: end,
    dueMinute,
    dueTime: dueMinute === null ? "明日重新随机" : timeFromMinute(dueMinute),
    completedDate: null,
    generatedAt: new Date().toISOString(),
  };
  state[key] = plan;
  writeRandomStateSafe(state);
  logger.info(`[随机调度] 批量签到/保活今日随机时间 → ${plan.dueTime} (${start}~${end})`);
  return plan;
}

async function checkDynamicBatchSchedule(enabledSites) {
  const batch = loadBatchConfigSafe();
  const defaultBatchMode = batch.mode === "independent" ? "independent" : (batch.mode === "fixed" ? "fixed" : "random");
  if (defaultBatchMode === "independent") return;
  const now = localParts();
  const nowMinute = now.hour * 60 + now.minute;
  const state = readRandomStateSafe();

  const fixedSignins = eligibleAutoSitesByKind(enabledSites, "fixed", defaultBatchMode, "signin");
  const fixedVisits = eligibleAutoSitesByKind(enabledSites, "fixed", defaultBatchMode, "visit");
  const fixedJobs = [
    { key: "signin:fixed", kind: "signin", label: "批量签到", minute: minuteOfDayFromTime(batch.signin_time || "09:00", "09:00"), eligible: fixedSignins },
    { key: "visit:fixed", kind: "visit", label: "批量保活", minute: minuteOfDayFromTime(batch.visit_time || "09:30", "09:30"), eligible: fixedVisits },
  ];
  for (const job of fixedJobs) {
    if (!job.eligible.length) continue;
    if (nowMinute === job.minute && state[job.key]?.completedDate !== now.date) {
      const ran = await runBatchJob("fixed", job.label, defaultBatchMode, { kind: job.kind });
      if (ran) {
        state[job.key] = { date: now.date, completedDate: now.date, completedAt: new Date().toISOString(), dueTime: timeFromMinute(job.minute), mode: "fixed", kind: job.kind };
        writeRandomStateSafe(state);
      }
    }
  }

  if (defaultBatchMode === "random" || eligibleAutoSitesAll(enabledSites, "random", defaultBatchMode).length) {
    const plan = await ensureRandomPlanAll({ state, batch, defaultBatchMode, enabledSites, now });
    if (plan && plan.completedDate !== now.date && plan.dueMinute !== null && nowMinute >= plan.dueMinute) {
      await runBatchJob("random", "随机批量签到/保活", defaultBatchMode);
      const latest = readRandomStateSafe();
      latest.all = { ...(latest.all || plan), completedDate: now.date, completedAt: new Date().toISOString() };
      writeRandomStateSafe(latest);
    }
  }
}

export function startScheduler(enabledSites, secrets) {
  let taskCount = 0;
  cron.schedule("* * * * *", async () => {
    try { await checkDynamicBatchSchedule(enabledSites); }
    catch (err) { logger.warn(`[动态批量调度] ${err.message}`); }
  });
  taskCount++;
  logger.info("[调度] 动态批量调度已启用（支持每天重新随机）");

  for (const site of enabledSites) {
    const schedule = site.schedule;
    if (!schedule || schedule === "auto") {
      logger.info(`[${site.note || site.driver}] 使用批量自动时间，跳过单独定时`);
      continue;
    }
    if (!cron.validate(schedule)) {
      logger.warn(`[${site.note || site.driver}] 无效 cron 表达式: "${schedule}"，跳过定时`);
      continue;
    }

    // 异步导入 runner，避免循环依赖
    cron.schedule(schedule, async () => {
      const { runSingle } = await import("./runner.js");
      logger.info(`[定时触发] ${site.note || site.driver}`);
      const result = await runSingle(site, secrets);
      await store.addEntry(result.site || site.note || site.driver, result);
      const notifyConfig = loadNotifyConfigSafe();
      const onlyFailures = notifyConfig.signin?.only_failures === true;
      if (result.formatted && (!onlyFailures || !result.success)) {
        await notifier.send(`自动签到：${result.site || site.note || site.driver}`, [result.formatted], "signin");
      }
    });

    taskCount++;
    logger.info(`[调度] ${site.note || site.driver} → ${schedule}`);
  }

  logger.info(`[调度] 已注册 ${taskCount} 个定时任务`);
  return taskCount;
}
