// ============================================================
// site-http — HTTP/API-first helpers for selected non-NexusPHP
// SignMate drivers: Chiphell, NodeLoc, V2EX. Playwright remains
// the fallback when a site blocks HTTP or success is unconfirmed.
// ============================================================

import logger from "./logger.js";
import { createHttpSession, getCookieForSite, htmlToText, pageTitleFromHtml, readJson, readText } from "./http-session.js";
import { normalizeProxyUrl } from "./proxy.js";

export function wantsHttpMode(siteConfig = {}) {
  const value = String(
    siteConfig.experimental_signin_mode
    || siteConfig.protocol_mode
    || process.env.SIGNMATE_EXPERIMENTAL_SIGNIN_MODE
    || "api-first"
  ).trim().toLowerCase();
  return !["playwright", "browser", "off", "false", "0", "disabled"].includes(value);
}

export function allowsHttpFallback(siteConfig = {}) {
  const value = siteConfig.api_fallback_playwright ?? siteConfig.protocol_fallback_playwright ?? process.env.SIGNMATE_API_FALLBACK_PLAYWRIGHT;
  if (value === false) return false;
  if (typeof value === "string" && /^(0|false|no|off)$/i.test(value.trim())) return false;
  return true;
}

function formatTime(date = new Date()) {
  return date.toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai",
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function compactText(text = "") {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function alternateProxyUrl(siteConfig = {}, currentProxyUrl = "") {
  const current = normalizeProxyUrl(currentProxyUrl || siteConfig.proxy_url || "");
  const candidates = [
    siteConfig.proxy_candidate_url,
    siteConfig.proxy_url,
    siteConfig.proxyUrl,
    process.env.SIGNMATE_PROXY_URL,
    process.env.HTTP_PROXY,
    process.env.HTTPS_PROXY,
    process.env.ALL_PROXY,
  ].map(v => normalizeProxyUrl(v || "")).filter(Boolean);
  return candidates.find(v => v && v !== current) || "";
}

function buildSession(siteConfig = {}, secrets = {}) {
  const cookie = getCookieForSite(secrets, siteConfig);
  if (!cookie) return { error: "⚠️ Cookie 未配置，请点击「维护 Cookie」填写" };
  const session = createHttpSession({
    baseUrl: siteConfig.base_url,
    cookie,
    proxyUrl: siteConfig.proxy_url || "",
    timeout: siteConfig.timeout || 60_000,
  });
  return { session, cookie };
}

async function getHtml(session, path, options = {}) {
  const res = await session.get(path, options);
  const html = await readText(res);
  return { res, html, text: htmlToText(html), title: pageTitleFromHtml(html) };
}

function looksLikeJsChallenge(text = "", html = "") {
  const source = `${text}\n${html}`;
  return /Please enable JavaScript and refresh the page|Just a moment|cf-mitigated|challenge-platform|Cloudflare|Turnstile|安全验证|人机验证/i.test(source);
}

function parseChiphellProfile(text = "") {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  let username = normalized.match(/导读\s+([^\s|]+)\s*\|\s*我的/)?.[1]
    || normalized.match(/([^\s|]{2,40})\s*\|\s*我的\s*\|\s*设置/)?.[1]
    || normalized.match(/切换到窄版\s+切换风格\s+([^\s|]+)\s*\|我的/)?.[1]
    || normalized.match(/更换论坛皮肤\s+([^\s|]+)\s*\|设置/)?.[1]
    || "";
  if (/消息|提醒|设置|帖子|收藏|好友/.test(username)) username = "";
  const points = normalized.match(/积分\s*[:：]\s*([0-9]+)/)?.[1] || "";
  const userGroup = normalized.match(/用户组\s*[:：]\s*([^\s|]+)/)?.[1] || "";
  const loggedIn = /\|退出|安全中心|提醒|\|我的/.test(normalized) && !!username;
  return { username, points, userGroup, loggedIn };
}

async function readChiphellPage(siteConfig = {}, secrets = {}, proxyUrl = "") {
  const cookie = getCookieForSite(secrets, siteConfig);
  if (!cookie) return { error: "⚠️ Cookie 未配置，请点击「维护 Cookie」填写" };
  const rawUrl = siteConfig.base_url || "https://www.chiphell.com/forum.php";
  const url = String(rawUrl).replace(/^http:\/\//i, "https://");
  const session = createHttpSession({
    baseUrl: url,
    cookie,
    proxyUrl,
    timeout: siteConfig.timeout || 60_000,
  });
  const page = await getHtml(session, url, {
    headers: {
      "upgrade-insecure-requests": "1",
      "sec-fetch-site": "none",
      "sec-fetch-mode": "navigate",
      "sec-fetch-user": "?1",
      "sec-fetch-dest": "document",
      "sec-ch-ua": '"Chromium";v="142", "Google Chrome";v="142", "Not_A Brand";v="99"',
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": '"Windows"',
    },
  });
  return { page, url, proxyUrl };
}

async function runChiphell(siteConfig = {}, secrets = {}) {
  const visitTime = formatTime();
  const steps = [];
  const first = await readChiphellPage(siteConfig, secrets, siteConfig.proxy_url || "");
  if (first.error) return { success: false, message: first.error, steps };
  let { page, url } = first;
  logger.info(`[Chiphell/API] HTTP 打开首页 → ${url}`);
  steps.push({ label: "HTTP 打开 Chiphell 首页", ok: page.res.status >= 200 && page.res.status < 400, status: page.res.status, detail: url });

  if (page.res.status === 567 && !siteConfig.proxy_url) {
    const retryProxy = alternateProxyUrl(siteConfig, "");
    if (retryProxy) {
      const retry = await readChiphellPage(siteConfig, secrets, retryProxy);
      page = retry.page;
      steps.push({ label: "HTTP 使用代理重试 Chiphell", ok: page.res.status >= 200 && page.res.status < 400, status: page.res.status, detail: "直连 HTTP 567，代理重试" });
    }
  }

  if (looksLikeJsChallenge(page.text, page.html)) return { success: false, message: "Chiphell HTTP 遇到 JS/验证页，需要浏览器兜底", details: { visitTime, pageTitle: page.title, checkinAction: "api_challenge" }, steps };
  const profile = parseChiphellProfile(page.text);
  const ok = page.res.status >= 200 && page.res.status < 400 && !!profile.username && !!profile.points && !!profile.userGroup;
  steps.push({ label: "HTTP 确认登录态", ok: !!profile.loggedIn, detail: profile.loggedIn ? "页面包含用户菜单与退出入口" : "未识别到登录菜单" });
  steps.push({ label: "HTTP 读取账号信息", ok, detail: `用户名 ${profile.username || "-"}；积分 ${profile.points || "-"}；用户组 ${profile.userGroup || "-"}` });
  return {
    success: ok,
    message: ok ? `访问完成；用户名 ${profile.username}；积分 ${profile.points}；用户组 ${profile.userGroup}；访问时间：${visitTime}` : `访问失败：未能完整读取用户名、积分、用户组（HTTP ${page.res.status || "unknown"}）`,
    details: { ...profile, visitTime, pageTitle: page.title, status: page.res.status, checkinAction: ok ? "api_keepalive" : "api_failed" },
    steps,
  };
}

function pickUserName(current = {}) {
  return current?.username || current?.name || "";
}

function findDirectoryItem(directory = {}, userId, username) {
  const items = directory?.directory_items || [];
  return items.find(item => item.id === userId || item.user?.id === userId || item.user?.username === username) || null;
}

async function getJson(session, path, steps, label) {
  const res = await session.get(path, { headers: { accept: "application/json, text/plain, */*" } });
  const { json, text } = await readJson(res);
  steps.push({ label, ok: res.status >= 200 && res.status < 400 && !!json, status: res.status, detail: json ? "JSON OK" : compactText(text).slice(0, 140) });
  return { res, json, text };
}

async function runNodeLoc(siteConfig = {}, secrets = {}) {
  const signTime = formatTime();
  const steps = [];
  const { session, error } = buildSession(siteConfig, secrets);
  if (error) return { success: false, message: error, steps };
  const origin = String(siteConfig.base_url || "https://www.nodeloc.com").replace(/\/+$/, "");
  logger.info(`[NodeLoc/API] HTTP 读取当前用户 → ${origin}/session/current.json`);
  const currentRes = await getJson(session, `${origin}/session/current.json`, steps, "HTTP 读取当前用户");
  const current = currentRes.json?.current_user || {};
  const username = pickUserName(current);
  if (!current?.id || !username) {
    const home = await getHtml(session, `${origin}/`);
    steps.push({ label: "HTTP 打开 NodeLoc 首页", ok: home.res.status >= 200 && home.res.status < 400, status: home.res.status, detail: `${origin}/` });
    const challenge = looksLikeJsChallenge(home.text, home.html);
    return { success: false, message: challenge ? "NodeLoc HTTP 遇到 JS/验证页，需要浏览器兜底" : `NodeLoc 登录态无效或 Cookie 不完整，请重新维护 Cookie（current_user HTTP ${currentRes.res.status || "unknown"}）`, details: { signTime, pageTitle: home.title, checkinAction: challenge ? "api_challenge" : "api_login_failed" }, steps };
  }
  const [userRes, dirRes, dailyRes] = await Promise.all([
    getJson(session, `${origin}/u/${encodeURIComponent(username)}.json`, steps, "HTTP 读取用户资料").catch(err => ({ json: null, error: err.message })),
    getJson(session, `${origin}/directory_items.json?period=all&order=likes_received`, steps, "HTTP 读取总榜数据").catch(err => ({ json: null, error: err.message })),
    getJson(session, `${origin}/directory_items.json?period=daily&order=likes_received`, steps, "HTTP 读取日榜数据").catch(err => ({ json: null, error: err.message })),
  ]);
  const user = userRes.json?.user || {};
  const dirItem = findDirectoryItem(dirRes.json, current.id, username);
  const dailyDirItem = findDirectoryItem(dailyRes.json, current.id, username);
  const score = dirItem?.gamification_score ?? user?.gamification_score ?? current?.gamification_score ?? null;
  const rawTodayEnergy = dailyDirItem?.gamification_score ?? dailyDirItem?.daily_score ?? dailyDirItem?.score_today ?? dirItem?.daily_score ?? dirItem?.score_today ?? user?.daily_score ?? user?.score_today ?? current?.daily_score ?? current?.score_today ?? null;
  const todayEnergy = Number.isFinite(rawTodayEnergy) && rawTodayEnergy > 0 ? rawTodayEnergy : null;
  const daysVisited = dirItem?.days_visited ?? user?.days_visited ?? null;
  const postCount = dirItem?.post_count ?? user?.post_count ?? null;
  const likesReceived = dirItem?.likes_received ?? user?.likes_received ?? null;
  const trustLevel = current.trust_level ?? user.trust_level ?? null;
  const metricParts = [];
  if (Number.isFinite(todayEnergy)) metricParts.push(`今日能量 ${todayEnergy}`);
  if (Number.isFinite(score)) metricParts.push(`总能量 ${score}`);
  if (Number.isFinite(daysVisited)) metricParts.push(`访问 ${daysVisited} 天`);
  if (Number.isFinite(postCount)) metricParts.push(`帖子 ${postCount}`);
  steps.push({ label: "HTTP 汇总活跃/能量数据", ok: true, detail: metricParts.join("；") || "已完成访问" });
  return {
    success: true,
    message: `${metricParts.join("；") || "检查完成"}；签到时间：${signTime}`,
    details: { signTime, username, totalEnergy: Number.isFinite(score) ? score : null, rewardEnergy: Number.isFinite(todayEnergy) ? todayEnergy : null, totalDays: Number.isFinite(daysVisited) ? daysVisited : null, postCount: Number.isFinite(postCount) ? postCount : null, likesReceived: Number.isFinite(likesReceived) ? likesReceived : null, trustLevel: Number.isFinite(trustLevel) ? trustLevel : null, checkinAction: "api_keepalive" },
    raw: { current_user: current, directory: dirItem, dailyDirectory: dailyDirItem, user: { id: user.id, username: user.username, trust_level: user.trust_level } },
    steps,
  };
}

function includesV2Login(body = "") {
  return /Sign Out|Settings|Notes|Planet/i.test(body);
}

function v2AlreadyRedeemed(body = "") {
  return /already redeemed|已领取|每日登录奖励已领取|Daily login reward already redeemed/i.test(body);
}

function extractCoinStats(text = "") {
  const normalized = String(text || "").replace(/\s+/g, " ");
  const pick = (...patterns) => {
    for (const pattern of patterns) {
      const match = normalized.match(pattern);
      const num = match ? Number.parseInt(match[1], 10) : NaN;
      if (Number.isFinite(num)) return num;
    }
    return null;
  };
  return {
    rewardCopper: pick(/(?:获得|奖励|received|reward)\s*(\d+)\s*(?:铜币|bronze)/i, /(\d+)\s*(?:铜币|bronze)\s*(?:奖励|reward)/i),
    totalGold: pick(/金币[:：]?\s*(\d+)/, /(\d+)\s*(?:金币|gold)/i),
    totalSilver: pick(/银币[:：]?\s*(\d+)/, /(\d+)\s*(?:银币|silver)/i),
    totalCopper: pick(/铜币[:：]?\s*(\d+)/, /(\d+)\s*(?:铜币|bronze)/i),
  };
}


function parseBalanceAreaStats(html = "") {
  const source = String(html || "");
  let area = "";
  for (const match of source.matchAll(/<div[^>]+class=["'][^"']*balance_area[^"']*["'][^>]*>([\s\S]*?)<\/div>/gi)) {
    const candidate = match[1] || "";
    // The referral/help blocks can contain small balance_area snippets inside
    // comments. The real account balance is the one containing bronze (B),
    // usually alongside G/S/B icons.
    if (/alt=["']B["']/i.test(candidate)) { area = candidate; break; }
  }
  const pick = (alt) => {
    const re = new RegExp(`([0-9]+)\\s*<img[^>]+alt=["']${alt}["']`, "i");
    const num = Number.parseInt(area.match(re)?.[1] || "", 10);
    return Number.isFinite(num) ? num : null;
  };
  return { totalGold: pick("G"), totalSilver: pick("S"), totalCopper: pick("B") };
}

function mergeCoinStats(...items) {
  return Object.assign({}, ...items.filter(Boolean).map(item => Object.fromEntries(Object.entries(item).filter(([, value]) => Number.isFinite(value)))));
}

function coinMessage(stats = {}) {
  const parts = [];
  if (Number.isFinite(stats.rewardCopper)) parts.push(`奖励 ${stats.rewardCopper} 个铜币`);
  const totals = [];
  if (Number.isFinite(stats.totalGold)) totals.push(`金币 ${stats.totalGold}`);
  if (Number.isFinite(stats.totalSilver)) totals.push(`银币 ${stats.totalSilver}`);
  if (Number.isFinite(stats.totalCopper)) totals.push(`铜币 ${stats.totalCopper}`);
  if (totals.length) parts.push(totals.join(" / "));
  return parts.join("；");
}

function todayV2EXDate() {
  return new Date().toLocaleDateString("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).replace(/\//g, "");
}

function parseV2Balance(text = "") {
  const stats = {};
  const today = todayV2EXDate();
  const normalized = compactText(text);
  const loginRow = normalized.split(/(?=\d{4}-\d{2}-\d{2}|\d{8})/).find(row => row.includes(today) && /每日登录奖励/.test(row)) || "";
  const reward = loginRow.match(/每日登录奖励\s+([0-9]+(?:\.0)?)/)?.[1]
    || loginRow.match(/每日登录奖励\s*(\d+)\s*铜币/)?.[1]
    || loginRow.match(/奖励\s*(\d+)\s*铜币/)?.[1];
  if (reward) stats.rewardCopper = Math.trunc(Number.parseFloat(reward));
  return stats;
}

function findV2RedeemHref(html = "") {
  const source = String(html || "");
  for (const m of source.matchAll(/<a\b[^>]+href=["']([^"']*)["'][^>]*>/gi)) {
    const href = (m[1] || "").replace(/&amp;/g, "&");
    try {
      const parsed = new URL(href, "https://www.v2ex.com/mission/daily");
      if ((parsed.hostname === "www.v2ex.com" || parsed.hostname === "v2ex.com") && parsed.pathname === "/mission/daily/redeem" && parsed.searchParams.has("once")) return href;
    } catch {}
  }
  return "";
}

function v2RedeemConfirmed(text = "") {
  return /already redeemed|Daily login reward already redeemed|每日登录奖励已领取|已领取|每日登录奖励\s+\d+|获得\s*\d+\s*(?:铜币|bronze)|奖励\s*\d+\s*(?:铜币|bronze)/i.test(String(text || ""));
}

async function readV2Balance(session, origin, steps) {
  const page = await getHtml(session, `${origin}/balance`);
  steps.push({ label: "HTTP 读取 V2EX 余额", ok: page.res.status >= 200 && page.res.status < 400, status: page.res.status, detail: "/balance" });
  return mergeCoinStats(parseV2Balance(page.text), parseBalanceAreaStats(page.html));
}

async function runV2EX(siteConfig = {}, secrets = {}) {
  const signTime = formatTime();
  const steps = [];
  const { session, error } = buildSession(siteConfig, secrets);
  if (error) return { success: false, message: error, steps };
  const origin = String(siteConfig.base_url || "https://www.v2ex.com").replace(/\/+$/, "");
  const dailyUrl = `${origin}/mission/daily`;
  logger.info(`[V2EX/API] HTTP 打开每日任务页面 → ${dailyUrl}`);
  const daily = await getHtml(session, dailyUrl);
  steps.push({ label: "HTTP 打开 V2EX 每日任务页面", ok: daily.res.status >= 200 && daily.res.status < 400, status: daily.res.status, detail: dailyUrl });
  if (looksLikeJsChallenge(daily.text, daily.html)) return { success: false, message: "V2EX HTTP 遇到 JS/验证页，需要浏览器兜底", details: { signTime, pageTitle: daily.title, checkinAction: "api_challenge" }, steps };
  if (!includesV2Login(daily.text)) return { success: false, message: "V2EX 登录态无效或 Cookie 不完整，请重新维护 Cookie", details: { signTime, pageTitle: daily.title, checkinAction: "api_login_failed" }, steps };
  if (v2AlreadyRedeemed(daily.text)) {
    const coinStats = mergeCoinStats(extractCoinStats(daily.text), await readV2Balance(session, origin, steps));
    const extra = coinMessage(coinStats);
    steps.push({ label: "HTTP 读取签到状态", ok: true, detail: `页面显示 Daily login reward already redeemed${extra ? `；${extra}` : ""}` });
    return { success: true, message: `今天已完成签到${extra ? `；${extra}` : ""}；签到时间：${signTime}`, details: { signTime, alreadySigned: true, clickedSignIn: false, checkinAction: "api_already_signed", ...coinStats, pageTitle: daily.title }, steps };
  }
  const href = findV2RedeemHref(daily.html);
  if (!href) return { success: false, message: "HTTP 未找到 V2EX 每日奖励领取链接，可能页面结构变化或已无可领取奖励", details: { signTime, pageTitle: daily.title, checkinAction: "api_not_found" }, steps };
  const redeemUrl = new URL(href, dailyUrl).toString();
  const redeem = await getHtml(session, redeemUrl);
  steps.push({ label: "HTTP 访问 V2EX 领取链接", ok: redeem.res.status >= 200 && redeem.res.status < 400, status: redeem.res.status, detail: redeemUrl });
  const verify = await getHtml(session, dailyUrl);
  steps.push({ label: "HTTP 复查 V2EX 每日任务状态", ok: verify.res.status >= 200 && verify.res.status < 400, status: verify.res.status, detail: dailyUrl });
  const coinStats = mergeCoinStats(extractCoinStats(daily.text), extractCoinStats(redeem.text), extractCoinStats(verify.text), await readV2Balance(session, origin, steps));
  const extra = coinMessage(coinStats);
  const combined = `${redeem.text} ${verify.text} ${daily.text}`;
  const ok = redeem.res.status >= 200 && redeem.res.status < 400 && v2RedeemConfirmed(combined);
  return { success: ok, message: ok ? `签到成功${extra ? `；${extra}` : ""}；签到时间：${signTime}` : "签到未确认：领取后未看到 V2EX 已领取状态", details: { signTime, clickedSignIn: true, checkinAction: ok ? "api_signed" : "api_unconfirmed", ...coinStats, pageTitle: verify.title || redeem.title || daily.title }, raw: compactText(combined).slice(0, 220), steps };
}

export async function runSiteHttp(siteConfig = {}, secrets = {}, driverName = "") {
  const key = driverName || siteConfig.driver || siteConfig.key;
  try {
    switch (key) {
      case "chiphell": return await runChiphell(siteConfig, secrets);
      case "nodeloc": return await runNodeLoc(siteConfig, secrets);
      case "v2ex": return await runV2EX(siteConfig, secrets);
      default: return { success: false, message: `HTTP/API mode not implemented for ${key}`, details: { checkinAction: "api_not_supported" }, steps: [] };
    }
  } catch (err) {
    return { success: false, message: `HTTP/API 执行失败：${err.message}`, raw: { error: err.message }, details: { checkinAction: "api_error" }, steps: [] };
  }
}
