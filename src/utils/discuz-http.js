// ============================================================
// discuz-http — experimental HTTP/API-first helpers for Discuz
// plugin-style daily sign-in drivers.
//
// Used only in the 6999 experimental SignMate branch unless promoted.
// Keeps Cookie values private: never log or return Cookie contents.
// ============================================================

import logger from "./logger.js";
import { createHttpSession, getCookieForSite, htmlToText, pageTitleFromHtml, readText } from "./http-session.js";

export function wantsHttpMode(siteConfig = {}) {
  const value = String(
    siteConfig.experimental_signin_mode
    || siteConfig.protocol_mode
    || process.env.SIGNMATE_EXPERIMENTAL_SIGNIN_MODE
    || ""
  ).trim().toLowerCase();
  return ["api", "api-first", "api_preferred", "http", "http-first", "protocol"].includes(value);
}

export function allowsHttpFallback(siteConfig = {}) {
  const value = siteConfig.api_fallback_playwright ?? siteConfig.protocol_fallback_playwright ?? process.env.SIGNMATE_API_FALLBACK_PLAYWRIGHT;
  if (value === false) return false;
  if (typeof value === "string" && /^(0|false|no|off)$/i.test(value.trim())) return false;
  return true;
}

function formatSignTime(date = new Date()) {
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

function decodeHtml(value = "") {
  return String(value || "")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function absUrl(base, href = "") {
  return new URL(decodeHtml(href || ""), base).toString();
}

function originOf(baseUrl = "") {
  return String(baseUrl || "").replace(/\/+$/, "");
}

function loggedIn(text = "", title = "") {
  const head = compactText(text).slice(0, 1600);
  if (/登录/.test(title) || /立即登录|用户登录|登录\s*注册|安全登录|请先登录/.test(head)) return false;
  return /HughRyu|RyuHwang|readchichi|退出|我的|设置|消息|提醒|积分|个人中心|个人资料|快捷导航/.test(head);
}

function alreadySigned(text = "") {
  return /今天已签|今日已签|今天已完成|今日已完成|已经签到|已签到|您今天已经签到|签到成功|签到完毕|明天再来|下次再来|连续签到|签到记录/.test(text);
}

function numberFrom(text = "", regex) {
  const hit = compactText(text).match(regex);
  const num = hit ? Number.parseInt(hit[1], 10) : NaN;
  return Number.isFinite(num) ? num : null;
}

function inputValue(html = "", idOrName = "") {
  const source = String(html || "");
  const byId = source.match(new RegExp(`<[^>]+id=["']${idOrName}["'][^>]*>`, "i"))?.[0] || "";
  const byName = source.match(new RegExp(`<[^>]+name=["']${idOrName}["'][^>]*>`, "i"))?.[0] || "";
  const tag = byId || byName;
  return decodeHtml(tag.match(/value=["']([^"']*)/i)?.[1] || "");
}

function formHash(html = "", text = "") {
  return decodeHtml(
    String(html || "").match(/formhash=([a-z0-9]+)/i)?.[1]
    || String(html || "").match(/name=["']formhash["'][^>]*value=["']([^"']+)/i)?.[1]
    || String(html || "").match(/FORMHASH\s*=\s*["']([^"']+)/i)?.[1]
    || String(text || "").match(/FORMHASH\s*=\s*["']([^"']+)/i)?.[1]
    || ""
  );
}

function parseInputsFromForm(html = "", formPattern = /<form[\s\S]*?<\/form>/i) {
  const form = String(html || "").match(formPattern)?.[0] || "";
  const inputs = {};
  for (const tag of form.matchAll(/<input\b[^>]*>/gi)) {
    const raw = tag[0];
    const name = decodeHtml(raw.match(/name=["']([^"']+)/i)?.[1] || "");
    if (!name) continue;
    inputs[name] = decodeHtml(raw.match(/value=["']([^"']*)/i)?.[1] || "");
  }
  return { form, inputs };
}

function formAction(html = "", base = "", formPattern = /<form[\s\S]*?<\/form>/i) {
  const form = String(html || "").match(formPattern)?.[0] || "";
  const action = decodeHtml(form.match(/action=["']([^"']+)/i)?.[1] || "");
  return action ? absUrl(base, action) : "";
}

function parseNaixiStats(text = "", html = "") {
  const rewardExp = Number.parseInt(inputValue(html, "lxreward") || "", 10);
  const streakDays = Number.parseInt(inputValue(html, "lxdays") || "", 10);
  const totalDays = Number.parseInt(inputValue(html, "lxtdays") || "", 10);
  const reward = Number.isFinite(rewardExp) ? `${rewardExp} 经验` : (compactText(text).match(/(?:奖励|获得|得到)\s*(\d+)\s*(经验|金币|积分|奶昔|威望)/)?.slice(1).join(" ") || "");
  return {
    reward,
    rewardExp: Number.isFinite(rewardExp) ? rewardExp : null,
    streakDays: Number.isFinite(streakDays) ? streakDays : null,
    totalDays: Number.isFinite(totalDays) ? totalDays : null,
  };
}

function parseDsuStats(text = "") {
  const normalized = compactText(text);
  const reward = normalized.match(/上次获得的奖励为[:：]\s*([^\s，,。.；;]+)\s*(\d+)/) || normalized.match(/(?:上次奖励|奖励)\s*[:：]?\s*([^\s，,。.；;\d]+)\s*(\d+)/);
  return {
    totalDays: numberFrom(normalized, /(?:累计已签到|总天数|总签到|累计签到|已签到)[:：\s]*(\d+)\s*天?/),
    monthDays: numberFrom(normalized, /(?:本月已累计签到|月天数|本月签到)[:：\s]*(\d+)\s*天?/),
    rewardAmount: reward ? Number.parseInt(reward[2], 10) : (numberFrom(normalized, /上次获得的奖励为[:：]\s*绝对值\s*(\d+)/) ?? numberFrom(normalized, /奖励[^0-9]*(\d+)/)),
    rewardUnit: reward?.[1] || (normalized.includes("绝对值") ? "绝对值" : ""),
    totalRewardPoints: numberFrom(normalized, /总奖励为[:：]\s*绝对值\s*(\d+)/),
    totalPoints: numberFrom(normalized, /积分[:：]\s*(\d+)/) ?? numberFrom(normalized, /绝对值[:：]\s*(\d+)/),
    level: normalized.match(/用户组[:：]\s*([^\s|]+)/)?.[1] || normalized.match(/您目前的等级[:：]\s*(\[[^\]]+\][^,，\s]+)/)?.[1] || "",
  };
}

function dsuMessage(prefix, stats = {}, signTime = "") {
  const parts = [prefix];
  if (Number.isFinite(stats.rewardAmount) && stats.rewardUnit) parts.push(`奖励 ${stats.rewardAmount} ${stats.rewardUnit}`);
  else if (Number.isFinite(stats.rewardAmount)) parts.push(`奖励 ${stats.rewardAmount}`);
  if (Number.isFinite(stats.totalPoints)) parts.push(`积分 ${stats.totalPoints}`);
  if (stats.level) parts.push(`用户组 ${stats.level}`);
  if (Number.isFinite(stats.totalDays)) parts.push(`总签到 ${stats.totalDays} 天`);
  if (Number.isFinite(stats.monthDays)) parts.push(`本月 ${stats.monthDays} 天`);
  if (signTime) parts.push(`签到时间：${signTime}`);
  return parts.join("；");
}

function parseRightStats(text = "") {
  const normalized = compactText(text);
  return {
    rewardPoints: numberFrom(normalized, /今日积分[:：]\s*(\d+)/),
    streakDays: numberFrom(normalized, /连续签到[:：]\s*(\d+)\s*天/),
    totalDays: numberFrom(normalized, /总签到天数[:：]\s*(\d+)\s*天/),
    totalPoints: numberFrom(normalized, /积分[:：]\s*(\d+)/),
  };
}

function rightMessage(prefix, stats = {}, signTime = "") {
  const parts = [prefix];
  if (Number.isFinite(stats.rewardPoints)) parts.push(`今日积分 ${stats.rewardPoints}`);
  if (Number.isFinite(stats.streakDays)) parts.push(`连续签到 ${stats.streakDays} 天`);
  if (Number.isFinite(stats.totalDays)) parts.push(`总签到 ${stats.totalDays} 天`);
  if (signTime) parts.push(`签到时间：${signTime}`);
  return parts.join("；");
}

function todayStamp(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

function cookieValue(cookieHeader = "", name = "") {
  for (const part of String(cookieHeader || "").split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return "";
}

function decodeMaybeBase64(value = "") {
  if (!value) return "";
  try { return Buffer.from(decodeURIComponent(String(value)), "base64").toString("utf8"); }
  catch {
    try { return Buffer.from(String(value), "base64").toString("utf8"); }
    catch { return ""; }
  }
}

function parseKafanStats(text = "", cookie = "") {
  const normalized = compactText(text);
  const decoded = compactText(decodeMaybeBase64(cookieValue(cookie, "r6pb_69df_dsu_amupper")));
  const ownAddup = Number.parseInt(decoded.match(/!addup!\s*<[^>]*>\s*(\d+)\s*<\/[^>]+>\s*!times!/i)?.[1] || "", 10);
  const ownCons = Number.parseInt(decoded.match(/!cons!\s*<[^>]*>\s*(\d+)\s*<\/[^>]+>\s*!times!/i)?.[1] || "", 10);
  const last = decoded.match(/!last![:：]?\s*([0-9-]{10}\s+[0-9:]{8})/)?.[1] || "";
  return {
    points: numberFrom(normalized, /积分[:：]?\s*(\d+)/),
    experience: numberFrom(normalized, /经验[:：]?\s*(\d+)/),
    vitality: numberFrom(normalized, /活力[:：]?\s*(\d+)/),
    addup: numberFrom(normalized, /累计签到\s*(\d+)\s*次/) ?? (Number.isFinite(ownAddup) ? ownAddup : null),
    cons: numberFrom(normalized, /连续签到\s*(\d+)\s*次/) ?? (Number.isFinite(ownCons) ? ownCons : null),
    rewardAmount: numberFrom(normalized, /特奖励[:：]\s*[^\d\s]+\s*(\d+)/),
    rewardUnit: normalized.match(/特奖励[:：]\s*([^\d\s，。；;]+)\s*\d+/)?.[1] || "",
    nextRewardAmount: numberFrom(normalized, /明日签到将获得[^0-9]*(\d+)/),
    last,
  };
}

function kafanMessage(prefix, stats = {}, signTime = "") {
  const parts = [prefix];
  if (Number.isFinite(stats.rewardAmount) && stats.rewardUnit) parts.push(`签到${stats.rewardUnit} +${stats.rewardAmount}`);
  if (Number.isFinite(stats.cons)) parts.push(`连续签到 ${stats.cons} 次`);
  if (Number.isFinite(stats.addup)) parts.push(`总签到 ${stats.addup} 次`);
  if (Number.isFinite(stats.experience)) parts.push(`总经验 ${stats.experience}`);
  if (Number.isFinite(stats.points)) parts.push(`积分 ${stats.points}`);
  if (Number.isFinite(stats.vitality)) parts.push(`活力 ${stats.vitality}`);
  if (signTime) parts.push(`签到时间：${signTime}`);
  return parts.join("；");
}

function parsePojiePoints(text = "") {
  const normalized = compactText(text);
  const credit = normalized.match(/(?:吾爱币|金币|CB)[:：]?\s*(-?\d+)/i)?.[1];
  const points = normalized.match(/(?:积分|威望|贡献)[:：]\s*(-?\d+)/)?.[1];
  return {
    totalCoins: credit !== undefined ? Number.parseInt(credit, 10) : null,
    totalPoints: points !== undefined ? Number.parseInt(points, 10) : null,
  };
}

function cleanPojieMessage(text = "") {
  const normalized = compactText(text);
  if (/已完成|已申请|已经申请|明天|下次再来|今天/.test(normalized)) return "今天已完成签到";
  if (/成功|完成|领取|申请/.test(normalized)) return "签到成功";
  return normalized.slice(0, 120) || "签到完成";
}

async function openText(session, path, steps, label, baseForTitle = "") {
  const res = await session.get(path);
  const html = await readText(res);
  const text = htmlToText(html);
  steps.push({ label, ok: res.status >= 200 && res.status < 400, status: res.status, detail: typeof path === "string" && path.length < 120 ? path : baseForTitle });
  return { res, html, text, title: pageTitleFromHtml(html) };
}

function buildSession(siteConfig = {}, secrets = {}) {
  const cookie = siteConfig.http_cookie_override || getCookieForSite(secrets, siteConfig);
  if (!cookie) return { error: "⚠️ Cookie 未配置，请点击「维护 Cookie」填写" };
  const baseUrl = siteConfig.base_url;
  const session = createHttpSession({ baseUrl, cookie, proxyUrl: siteConfig.proxy_url || "", timeout: siteConfig.timeout || 60_000 });
  return { session, cookie };
}

async function runNaixi(siteConfig, secrets) {
  const signTime = formatSignTime();
  const steps = [];
  const { session, cookie, error } = buildSession(siteConfig, secrets);
  if (error) return { success: false, message: error };
  const origin = originOf(siteConfig.base_url || "https://forum.naixi.net");
  logger.info(`[奶昔论坛/API] HTTP 打开签到页 → ${origin}/k_misign-sign.html`);
  const page = await openText(session, `${origin}/k_misign-sign.html`, steps, "HTTP 打开奶昔签到页面");
  if (!loggedIn(page.text, page.title)) return { success: false, message: "奶昔论坛登录态无效或 Cookie 不完整，请重新维护 Cookie", details: { signTime, pageTitle: page.title }, steps };
  let stats = parseNaixiStats(page.text, page.html);
  if (alreadySigned(page.text)) {
    steps.push({ label: "HTTP 读取签到状态", ok: true, detail: "页面显示今天已签到" });
    return { success: true, message: `今天已完成签到${stats.reward ? `，奖励 ${stats.reward}` : ""}${Number.isFinite(stats.streakDays) ? `；连续签到 ${stats.streakDays} 天` : ""}；签到时间：${signTime}`, details: { signTime, alreadySigned: true, clickedSignIn: false, checkinAction: "api_already_signed", ...stats, pageTitle: page.title }, steps };
  }
  const href = decodeHtml(page.html.match(/href=["']([^"']*operation=qiandao[^"']*)/i)?.[1] || "");
  if (!href) return { success: false, message: "HTTP 未找到奶昔论坛签到链接", details: { signTime, pageTitle: page.title }, steps };
  const signed = await openText(session, absUrl(`${origin}/k_misign-sign.html`, href), steps, "HTTP 提交奶昔签到");
  stats = parseNaixiStats(`${signed.text} ${page.text}`, signed.html || page.html);
  const ok = signed.res.status < 400 && /签到成功|恭喜|获得奖励|已签到|今日已签|今天已签|您今天已经签到/.test(signed.text);
  return { success: ok, message: ok ? `签到成功${stats.reward ? `，奖励 ${stats.reward}` : ""}${Number.isFinite(stats.streakDays) ? `；连续签到 ${stats.streakDays} 天` : ""}；签到时间：${signTime}` : `签到失败：${compactText(signed.text).slice(0, 160)}`, details: { signTime, clickedSignIn: true, checkinAction: ok ? "api_signed" : "api_failed", ...stats, pageTitle: signed.title || page.title }, steps };
}

async function runDsu(siteConfig, secrets, flavor) {
  const signTime = formatSignTime();
  const steps = [];
  const { session, error } = buildSession(siteConfig, secrets);
  if (error) return { success: false, message: error };
  const origin = originOf(siteConfig.base_url || (flavor === "qianmoju" ? "https://www.1000qm.vip" : "https://www.pceva.com.cn"));
  const signPageUrl = `${origin}/plugin.php?id=dsu_paulsign:sign`;
  logger.info(`[${flavor}/API] HTTP 打开 DSU 签到页 → ${signPageUrl}`);
  const page = await openText(session, signPageUrl, steps, "HTTP 打开 DSU 签到页面");
  if (!loggedIn(page.text, page.title)) return { success: false, message: `${flavor === "qianmoju" ? "阡陌居" : "PCEVA"} 登录态无效或 Cookie 不完整，请重新维护 Cookie`, details: { signTime, pageTitle: page.title }, steps };
  let stats = parseDsuStats(page.text);
  const already = alreadySigned(page.text) && !/今天签到了吗[？?]?请选择|【今天未签到】/.test(page.text);
  if (already) {
    steps.push({ label: "HTTP 检查签到状态", ok: true, detail: "页面显示今天已签到" });
    return { success: true, message: dsuMessage("今天已完成签到", stats, signTime), details: { signTime, alreadySigned: true, clickedSignIn: false, checkinAction: "api_already_signed", ...stats, pageTitle: page.title }, steps };
  }
  const formPattern = /<form[^>]+(?:id=["']qiandao["']|action=["'][^"']*dsu_paulsign[^"']*qiandao)[\s\S]*?<\/form>/i;
  const action = formAction(page.html, signPageUrl, formPattern) || `${origin}/plugin.php?id=dsu_paulsign:sign&operation=qiandao&infloat=1`;
  const { inputs } = parseInputsFromForm(page.html, formPattern);
  if (!inputs.formhash && formHash(page.html, page.text)) inputs.formhash = formHash(page.html, page.text);
  inputs.qdxq ||= "kx";
  inputs.qdmode ||= "1";
  inputs.todaysay ||= flavor === "qianmoju" ? "开心是一种选择，快乐融入日常。" : "自动签到";
  const submit = await session.postForm(action, inputs, { referer: signPageUrl });
  const submitText = htmlToText(await readText(submit));
  steps.push({ label: "HTTP 提交 DSU 签到表单", ok: submit.status >= 200 && submit.status < 400, status: submit.status, detail: compactText(submitText).slice(0, 160) });
  const verify = await openText(session, signPageUrl, steps, "HTTP 复查 DSU 签到状态");
  stats = parseDsuStats(`${submitText} ${verify.text}`);
  const combined = `${submitText} ${verify.text}`;
  const ok = submit.status < 400 && /签到成功|恭喜|今天已签到|今日已签到|已签到|签到完毕/.test(combined) && !/失败|错误|请先登录|登录后/.test(compactText(combined).slice(0, 800));
  return { success: ok, message: ok ? dsuMessage("签到成功", stats, signTime) : `签到失败：${compactText(combined).slice(0, 180)}`, details: { signTime, alreadySigned: false, clickedSignIn: true, checkinAction: ok ? "api_signed" : "api_failed", ...stats, pageTitle: verify.title || page.title }, steps };
}

async function runRight(siteConfig, secrets) {
  const signTime = formatSignTime();
  const steps = [];
  const { session, error } = buildSession(siteConfig, secrets);
  if (error) return { success: false, message: error };
  const base = originOf(siteConfig.base_url || "https://www.right.com.cn/forum");
  const signPageUrl = `${base}/erling_qd-sign_in.html`;
  logger.info(`[恩山/API] HTTP 打开签到页 → ${signPageUrl}`);
  const page = await openText(session, signPageUrl, steps, "HTTP 打开恩山签到页面");
  if (!loggedIn(page.text, page.title)) return { success: false, message: "恩山无线论坛登录态无效或 Cookie 不完整，请重新维护 Cookie", details: { signTime, pageTitle: page.title }, steps };
  let stats = parseRightStats(page.text);
  if (alreadySigned(page.text) && !/signin-btn|签到中|立即签到/.test(page.text)) {
    steps.push({ label: "HTTP 检查签到状态", ok: true, detail: "页面显示今天已签到" });
    return { success: true, message: rightMessage("今天已完成签到", stats, signTime), details: { signTime, alreadySigned: true, clickedSignIn: false, checkinAction: "api_already_signed", ...stats, pageTitle: page.title }, steps };
  }
  const hash = formHash(page.html, page.text);
  const submit = await session.postForm(`${base}/plugin.php?id=erling_qd:action&action=sign`, { formhash: hash }, { referer: signPageUrl, headers: { accept: "application/json, text/javascript, */*; q=0.01" } });
  const submitRaw = await readText(submit);
  let json = null;
  try { json = JSON.parse(submitRaw); } catch {}
  const submitText = json?.message || json?.msg || htmlToText(submitRaw);
  steps.push({ label: "HTTP 提交恩山签到 AJAX", ok: submit.status >= 200 && submit.status < 400, status: submit.status, detail: compactText(submitText).slice(0, 160) });
  const verify = await openText(session, signPageUrl, steps, "HTTP 复查恩山签到状态");
  stats = parseRightStats(`${submitText} ${verify.text}`);
  const ok = submit.status < 400 && (json?.success === true || /成功|已签到|今日已签|今天已签/.test(`${submitText} ${verify.text}`));
  return { success: ok, message: ok ? rightMessage(/已签到|今日已签|今天已签/.test(submitText) ? "今天已完成签到" : "签到成功", stats, signTime) : `签到失败：${compactText(submitText).slice(0, 180)}`, details: { signTime, alreadySigned: false, clickedSignIn: true, checkinAction: ok ? "api_signed" : "api_failed", ...stats, pageTitle: verify.title || page.title }, steps };
}

async function runKafan(siteConfig, secrets) {
  const signTime = formatSignTime();
  const steps = [];
  const { session, cookie, error } = buildSession(siteConfig, secrets);
  if (error) return { success: false, message: error };
  const origin = originOf(siteConfig.base_url || "https://bbs.kafan.cn");
  const listUrl = `${origin}/plugin.php?id=dsu_amupper:pperlist`;
  logger.info(`[卡饭/API] HTTP 打开 dsu_amupper 页面 → ${listUrl}`);
  const page = await openText(session, listUrl, steps, "HTTP 打开卡饭 dsu_amupper 页面");
  if (!loggedIn(page.text, page.title)) return { success: false, message: "卡饭登录态无效或 Cookie 不完整，请重新维护 Cookie", details: { signTime, pageTitle: page.title }, steps };
  let stats = parseKafanStats(page.text, cookie);
  const alreadyByCookie = stats.last ? stats.last.slice(0, 10) === todayStamp() : false;
  const href = decodeHtml(page.html.match(/<a[^>]+id=["']pper_a["'][^>]+href=["']([^"']+)/i)?.[1] || page.html.match(/href=["']([^"']*ppersubmit=true[^"']*)/i)?.[1] || "");
  const hash = formHash(page.html, page.text);
  const submitUrl = href ? absUrl(listUrl, href) : (hash ? `${origin}/plugin.php?id=dsu_amupper&ppersubmit=true&formhash=${encodeURIComponent(hash)}` : "");
  if (alreadyByCookie && !submitUrl) {
    steps.push({ label: "HTTP 读取签到状态", ok: true, detail: "Cookie/页面显示今天已签到" });
    return { success: true, message: kafanMessage("今日已签到", stats, signTime), details: { signTime, alreadySigned: true, clickedSignIn: false, checkinAction: "api_already_signed", ...stats, totalDays: stats.addup, streakDays: stats.cons, pageTitle: page.title }, steps };
  }
  if (!submitUrl) {
    const alreadyText = /已经|已签到|今日|今天/.test(compactText(page.text).slice(0, 1500));
    return { success: alreadyText, message: alreadyText ? kafanMessage("今日已签到", stats, signTime) : "HTTP 未找到卡饭签到入口", details: { signTime, alreadySigned: alreadyText, clickedSignIn: false, checkinAction: alreadyText ? "api_already_signed" : "api_not_found", ...stats, pageTitle: page.title }, steps };
  }
  const submit = await openText(session, submitUrl, steps, "HTTP 提交卡饭签到");
  const verify = await openText(session, listUrl, steps, "HTTP 复查卡饭签到状态");
  stats = parseKafanStats(`${submit.text} ${verify.text}`, cookie);
  const combined = `${submit.text} ${verify.text}`;
  const ok = submit.res.status < 400 && /成功|已签到|今日|今天|特奖励|连续签到/.test(combined) && !/请先登录|失败|错误/.test(compactText(combined).slice(0, 800));
  return { success: ok, message: ok ? kafanMessage("签到成功", stats, signTime) : `签到失败：${compactText(combined).slice(0, 180)}`, details: { signTime, alreadySigned: false, clickedSignIn: true, checkinAction: ok ? "api_signed" : "api_failed", ...stats, totalDays: stats.addup, streakDays: stats.cons, pageTitle: verify.title || page.title }, steps };
}

async function runPojie52(siteConfig, secrets) {
  const signTime = formatSignTime();
  const steps = [];
  const { session, error } = buildSession(siteConfig, secrets);
  if (error) return { success: false, message: error };
  const origin = originOf(siteConfig.base_url || "https://www.52pojie.cn");
  const taskUrl = `${origin}/home.php?mod=task`;
  logger.info(`[吾爱破解/API] HTTP 打开任务页面 → ${taskUrl}`);
  const page = await openText(session, taskUrl, steps, "HTTP 打开吾爱破解任务页面");
  if (!loggedIn(page.text, page.title)) return { success: false, message: "吾爱破解登录态无效或 Cookie 不完整，请重新维护 Cookie", details: { signTime, pageTitle: page.title }, steps };
  const before = parsePojiePoints(page.text);
  const linkMatches = [...page.html.matchAll(/<a\b[^>]+href=["']([^"']*home\.php\?mod=task[^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi)]
    .map(m => ({ href: decodeHtml(m[1]), text: htmlToText(m[2]) }))
    .filter(x => /(do=(apply|draw)|领取|申请|完成|每日|登录|打卡|签到)/i.test(`${x.href} ${x.text}`));
  const first = linkMatches.find(x => /do=(apply|draw)/.test(x.href)) || linkMatches[0];
  const candidates = first ? [absUrl(taskUrl, first.href)] : [`${origin}/home.php?mod=task&do=apply&id=2`, `${origin}/home.php?mod=task&do=draw&id=2`];
  let taskText = "";
  let taskStatus = null;
  let taskRunUrl = "";
  for (const url of candidates) {
    const res = await session.get(url, { headers: { "x-requested-with": "XMLHttpRequest" }, referer: taskUrl });
    taskStatus = res.status;
    taskRunUrl = url;
    taskText = htmlToText(await readText(res));
    steps.push({ label: "HTTP 执行吾爱破解每日任务", ok: res.status >= 200 && res.status < 400, status: res.status, detail: compactText(taskText).slice(0, 160) });
    if (/成功|完成|领取|申请|已完成|已申请|积分|吾爱币|金币|CB|今天|明天/.test(taskText)) break;
  }
  const verify = await openText(session, taskUrl, steps, "HTTP 复查吾爱破解任务状态");
  const after = parsePojiePoints(verify.text || taskText);
  const combined = `${taskText} ${verify.text}`;
  const alreadyDone = /已完成|已申请|已经申请|明天|下次再来|今天已/.test(combined);
  const ok = (taskStatus >= 200 && taskStatus < 400) && (alreadyDone || /成功|完成|领取|申请/.test(combined));
  const rewardPoints = Number.isFinite(after.totalPoints) && Number.isFinite(before.totalPoints) && after.totalPoints !== before.totalPoints ? Math.max(0, after.totalPoints - before.totalPoints) : (alreadyDone ? Number.parseInt(siteConfig.daily_reward_points ?? "", 10) : null);
  const rewardText = Number.isFinite(rewardPoints) ? `，奖励 ${rewardPoints} 积分` : "";
  const totalText = `${Number.isFinite(after.totalPoints) ? `；总积分 ${after.totalPoints}` : ""}${Number.isFinite(after.totalCoins) ? `；吾爱币 ${after.totalCoins}` : ""}`;
  return { success: ok, message: ok ? `${cleanPojieMessage(combined)}${rewardText}${totalText}；签到时间：${signTime}` : `签到失败：${cleanPojieMessage(combined || "未找到每日任务入口")}`, details: { signTime, rewardPoints, totalPoints: after.totalPoints ?? before.totalPoints, totalCoins: after.totalCoins ?? before.totalCoins, alreadySigned: alreadyDone, clickedSignIn: !alreadyDone, checkinAction: alreadyDone ? "api_already_signed" : (ok ? "api_signed" : "api_failed"), taskUrl: taskRunUrl, pageTitle: verify.title || page.title }, steps };
}

export async function runDiscuzHttp(siteConfig = {}, secrets = {}, driverName = "") {
  const key = siteConfig.key || siteConfig.driver || driverName;
  try {
    switch (driverName || key) {
      case "naixi": return await runNaixi(siteConfig, secrets);
      case "pceva": return await runDsu(siteConfig, secrets, "pceva");
      case "qianmoju": return await runDsu(siteConfig, secrets, "qianmoju");
      case "right": return await runRight(siteConfig, secrets);
      case "kafan": return await runKafan(siteConfig, secrets);
      case "pojie52": return await runPojie52(siteConfig, secrets);
      default: return { success: false, message: `HTTP/API mode not implemented for ${key}`, details: { checkinAction: "api_not_supported" }, steps: [] };
    }
  } catch (err) {
    return { success: false, message: `HTTP/API 执行失败：${err.message}`, raw: { error: err.message }, details: { checkinAction: "api_error" }, steps: [] };
  }
}
