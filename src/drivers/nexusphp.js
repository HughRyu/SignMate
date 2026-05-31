// ============================================================
// nexusphp — Generic NexusPHP PT sign-in/check-in driver
//
// 使用 Cookie 打开 NexusPHP 站点，读取登录态和关键 PT 指标；
// 若发现“签到”入口则尝试点击。若出现验证码/验证措施，标记为失败且不误报成功。
// ============================================================

import WebsiteDriver from "./website.js";
import logger from "../utils/logger.js";
import { ocr } from "../captcha-ocr.js";
import { createHmac } from "node:crypto";
import { createHttpSession, getCookieForSite, htmlToText, pageTitleFromHtml, readText } from "../utils/http-session.js";
import { resolveChromiumExecutablePath, launchBrowser } from "../utils/browser.js";


const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function getTotpSecret(secrets = {}, siteConfig = {}) {
  const key = siteConfig.key || siteConfig.driver || "";
  const siteSecrets = secrets?.[key] || secrets?.[siteConfig.driver] || {};
  return String(siteSecrets.totp_secret || siteSecrets.twofa_secret || siteSecrets["2fa_secret"] || siteSecrets.otp_secret || "").replace(/\s+/g, "").toUpperCase();
}

function base32ToBuffer(secret = "") {
  const clean = String(secret || "").replace(/=+$/g, "").toUpperCase();
  let bits = "";
  for (const ch of clean) {
    const value = BASE32_ALPHABET.indexOf(ch);
    if (value < 0) throw new Error("2FA Secret 不是有效的 Base32 格式");
    bits += value.toString(2).padStart(5, "0");
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

function generateTotp(secret, { step = 30, digits = 6, timestamp = Date.now() } = {}) {
  const key = base32ToBuffer(secret);
  const counter = Math.floor(timestamp / 1000 / step);
  const msg = Buffer.alloc(8);
  msg.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  msg.writeUInt32BE(counter >>> 0, 4);
  const hmac = createHmac("sha1", key).update(msg).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code = ((hmac[offset] & 0x7f) << 24)
    | ((hmac[offset + 1] & 0xff) << 16)
    | ((hmac[offset + 2] & 0xff) << 8)
    | (hmac[offset + 3] & 0xff);
  return String(code % (10 ** digits)).padStart(digits, "0");
}

function isTwoFactorPage(text = "", pageUrl = "") {
  const body = String(text || "");
  const url = String(pageUrl || "");
  if (/take2fa\.php/i.test(url)) return true;
  // HHanClub/Piggo/NexusPHP 首页可能把“2FA/两步验证”文案、菜单或历史提示混在正文里。
  // 只有存在真实 2FA 输入框/提交字段，或明确的异地登录 2FA 页面标题时，才判定为需要 TOTP。
  const hasTotpField = /name=["']?(?:2fa|otp|totp)["']?/i.test(body) || /两步验证码\s*[:：]?\s*(?:提交|验证)?/i.test(body);
  const explicitChallenge = /异地登录安全验证|异地登录提醒|请完成两步验证|两步验证码/i.test(body);
  return hasTotpField && (explicitChallenge || /2FA|two[-\s]?factor|二步验证|两步验证/i.test(body));
}

function summarizeTotpFailure(text = "", pageUrl = "") {
  const source = String(text || "").replace(/\s+/g, " ").trim();
  const explicit = source.match(/(?:验证码|兩步|两步|2FA|TOTP)[^。；;\n]{0,60}(?:错误|錯誤|不正确|不正確|无效|無效|过期|過期|失败|失敗)/i)?.[0]
    || source.match(/(?:错误|錯誤|不正确|不正確|无效|無效|过期|過期|失败|失敗)[^。；;\n]{0,60}(?:验证码|兩步|两步|2FA|TOTP)/i)?.[0]
    || "";
  if (explicit) return explicit;
  if (/take2fa\.php/i.test(pageUrl || "")) return "提交后仍停留在 take2fa 验证页，可能是验证码已过期、Secret 不匹配，或站点未接受当前登录环境";
  return "提交后页面仍显示两步验证，可能是验证码已过期、Secret 不匹配，或站点未接受当前登录环境";
}

async function submitTotpForm(page, code) {
  const input = page.locator('input[name="2fa"], input[name*="otp" i], input[name*="totp" i], input[type="text"]').first();
  await input.fill(code, { timeout: 8000 });

  // NexusPHP 的 2FA 页面有些主题会把 <form> 提前闭合，导致常规 click submit
  // 不携带隐藏字段/2fa 字段。这里直接构造一个标准 POST 表单提交，兼容 Piggo/HDDolby 这类页面。
  const info = await page.evaluate(() => {
    const pick = selector => document.querySelector(selector)?.getAttribute("value") || "";
    const input = document.querySelector('input[name="2fa"], input[name*="otp" i], input[name*="totp" i], input[type="text"]');
    const form = input?.form || document.querySelector('form[action*="take2fa"], form');
    const action = form?.getAttribute("action") || "take2fa.php";
    const params = new URLSearchParams(location.search);
    return {
      action: new URL(action, location.href).toString(),
      type: pick('input[name="type"]') || "save",
      returnto: pick('input[name="returnto"]') || params.get("returnto") || "index.php",
      name: input?.getAttribute("name") || "2fa",
    };
  });

  await Promise.all([
    page.waitForLoadState("domcontentloaded", { timeout: 12_000 }).catch(() => {}),
    page.evaluate(({ info, code }) => {
      const form = document.createElement("form");
      form.method = "post";
      form.action = info.action;
      const append = (name, value) => {
        const el = document.createElement("input");
        el.type = "hidden";
        el.name = name;
        el.value = value;
        form.appendChild(el);
      };
      append("type", info.type || "save");
      append("returnto", info.returnto || "index.php");
      append(info.name || "2fa", code);
      document.body.appendChild(form);
      form.submit();
    }, { info, code }),
  ]);
  await page.waitForLoadState("networkidle", { timeout: 12_000 }).catch(() => {});
}

async function trySubmitTotp(page, secret, name, steps) {
  const body = await page.locator("body").innerText({ timeout: 5000 }).catch(() => "");
  if (!isTwoFactorPage(body, page.url())) return { present: false, submitted: false, passed: false };
  if (!secret) {
    steps.push({ label: "检测两步验证", ok: false, detail: `${name} 要求两步验证码，但未配置 2FA Secret` });
    return { present: true, submitted: false, passed: false, reason: "missing_secret" };
  }
  const code = generateTotp(secret);
  logger.info(`[NexusPHP] ${name} 检测到两步验证，使用已保存 2FA Secret 生成 TOTP`);
  await submitTotpForm(page, code);
  await page.waitForTimeout(1800);
  const after = await page.locator("body").innerText({ timeout: 5000 }).catch(() => "");
  const still2fa = isTwoFactorPage(after, page.url());
  const failureReason = still2fa ? summarizeTotpFailure(after, page.url()) : "";
  steps.push({ label: "提交两步验证", ok: !still2fa, detail: still2fa ? `${name} 已提交 TOTP，但未通过：${failureReason}` : `${name} 已通过两步验证` });
  return { present: true, submitted: true, passed: !still2fa, reason: still2fa ? "still_2fa" : undefined, failureReason };
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

function numberFromMetric(value = "") {
  const n = Number(String(value || "").replace(/,/g, "").match(/[0-9]+(?:\.[0-9]+)?/)?.[0] || "");
  return Number.isFinite(n) ? n : null;
}

function formatMetricDelta(value) {
  if (!Number.isFinite(value) || value <= 0) return "";
  const fixed = Math.round(value * 1000) / 1000;
  return fixed.toLocaleString("en-US", { maximumFractionDigits: 3 });
}

function bonusDelta(before = "", after = "") {
  const a = numberFromMetric(before);
  const b = numberFromMetric(after);
  if (a === null || b === null) return "";
  return formatMetricDelta(b - a);
}

function parsePtStats(text = "", siteKey = "") {
  const normalized = String(text || "").replace(/\s+/g, " ");
  const username = normalized.match(/欢迎回来\s*[,，]\s*([^\s\[，,]+)/)?.[1]
    || normalized.match(/([^\s,，]+)\s*[,，]\s*歡迎回來/)?.[1]
    || normalized.match(/嗨[,，]\s*([^\s🎈\[]+)/)?.[1]
    || normalized.match(/\b(HugHRyu|HughRyu|HugRyu)\b/)?.[1]
    || "";
  const bonus = normalized.match(/魔力值\s*[：:]?\s*(?:\([^)]*\)\s*)?(?:\[[^\]]*\]\s*)?[:：]?\s*([0-9,.]+)/)?.[1]
    || normalized.match(/\[魔力值\s*[:：]\s*([0-9,.]+)\s*使用\]/)?.[1]
    || normalized.match(/鲸币\s*(?:\[使用\])?\s*[:：]?\s*([0-9,.]+)/)?.[1]
    || normalized.match(/憨豆\s*(?:\[使用\])?\s*[:：]?\s*([0-9,.]+)/)?.[1]
    || normalized.match(/猫粮\s*(?:\[[^\]]*\])?\s*[:：]?\s*([0-9,.]+)/)?.[1]
    || normalized.match(/魔力\s*[:：]?\s*([0-9,.]+)/)?.[1]
    || "";
  let ratio = normalized.match(/\[?分享率\]?\s*[:：]\s*(≥?\s*[0-9.]+)/)?.[1]?.replace(/\s+/g, "") || "";
  let upload = normalized.match(/\[?(?:上传|上傳)(?:量)?\]?\s*[:：]\s*([0-9.]+\s*[KMGTPE]?B)/i)?.[1]?.replace(/\s+(?=[KMGTPE]?B$)/i, " ") || "";
  let download = normalized.match(/\[?(?:下载|下載)(?:量)?\]?\s*[:：]\s*([0-9.]+\s*[KMGTPE]?B)/i)?.[1]?.replace(/\s+(?=[KMGTPE]?B$)/i, " ") || "";
  let seedPoints = "";
  let audiencesBonus = "";
  if (siteKey === "audiences-me") {
    const audienceRow = normalized.match(/(?:HugHRyu|HughRyu|HugRyu)\s+(\d+(?:\.\d+)?)\s+([0-9.]+\s*[KMGTPE]?B)\s+([0-9.]+\s*[KMGTPE]?B)\s+([0-9,.]+)\s+([0-9,.]+)/i);
    if (audienceRow) {
      ratio = ratio || audienceRow[1];
      upload = upload || audienceRow[2];
      download = download || audienceRow[3];
      audiencesBonus = audienceRow[4];
      seedPoints = audienceRow[5];
    }
    audiencesBonus = audiencesBonus || normalized.match(/爆米花\s*[:：]?\s*([0-9,.]+)/)?.[1] || "";
    seedPoints = seedPoints || normalized.match(/做种积分\s*[:：]?\s*([0-9,.]+)/)?.[1] || "";
  }
  const hhanPanel = siteKey === "hhanclub-net"
    ? normalized.match(/\[签到得憨豆\]\s*\[邀请\]\s*[:：]\s*([0-9]+)\s+([0-9,]+)\s*\[勋章\]\s*([0-9.]+\s*[KMGTPE]?B)\s+[0-9]+\s+([0-9.]+\s*[KMGTPE]?B)/i)
    : null;
  const normalizedBonus = hhanPanel?.[2] || audiencesBonus || bonus;
  const normalizedUpload = hhanPanel?.[3] || upload;
  const normalizedDownload = hhanPanel?.[4] || download;
  const invite = hhanPanel?.[1]
    || normalized.match(/(?:邀请|邀請)\s*\[\s*(?:发送|發送)\s*\]\s*[:：]\s*([^\s]+)/)?.[1]
    || normalized.match(/\[(?:邀请|邀請)\s*[:：]\s*([^\s\]]+)/)?.[1]
    || normalized.match(/私人邀请\s*[:：]\s*([0-9]+)/)?.[1]
    || normalized.match(/\[邀请\]\s*[:：]\s*([0-9]+)/)?.[1]
    || "";
  let signText = normalized.match(/这是您的第\s*\d+\s*次[签簽]到[^。]*本次签到获得\s*[0-9,.]+\s*个[^。；;]*/)?.[0]
    || normalized.match(/本次[签簽]到获得\s*[0-9,.]+\s*个[^。；;]*/)?.[0]
    || normalized.match(/[签簽]到获得\s*[0-9,.]+\s*个[^。；;]*/)?.[0]
    || normalized.match(/[签簽]到已得\s*[0-9,.]+/)?.[0]
    || normalized.match(/[签簽]到[^\]\s]*(?:已得\s*[0-9,.]+|获得\s*[0-9,.]+|魔力值?\s*\+?\s*[0-9,.]+)?[^\]。；;]*/)?.[0]
    || "";
  if (siteKey === "hdsky-me" && /^签到$/.test(signText) && /已签到|Showed\s*Up/i.test(normalized)) {
    signText = "今日已签到";
  }
  let bonusGain = signText.match(/(?:已得|获得)\s*([0-9,.]+)/)?.[1]
    || signText.match(/魔力值?\s*\+?\s*([0-9,.]+)/)?.[1]
    || normalized.match(/[签簽]到已得\s*([0-9,.]+)/)?.[1]
    || normalized.match(/[签簽]到获得魔力值?\s*\+?\s*([0-9,.]+)/)?.[1]
    || normalized.match(/本次[签簽]到获得\s*([0-9,.]+)/)?.[1]
    || (siteKey === "hhanclub-net" ? normalized.match(/(?:[签簽]到获得|本次[签簽]到获得)\s*([0-9,.]+)\s*个?憨豆/)?.[1] : "")
    || "";
  bonusGain = String(bonusGain || "").replace(/[，,。；;]+$/g, "");
  let rewardName = signText.match(/(?:已得|获得)\s*[0-9,.]+\s*个?\s*([^。；;\s]+)/)?.[1] || "";
  if (siteKey === "hhanclub-net" && bonusGain) rewardName = "憨豆";
  if (siteKey === "pterclub-net" && bonusGain) rewardName = "猫粮";
  rewardName = rewardName.replace(/^[,，。；;)）\]】]+|[,，。；;)）\]】]+$/g, "");
  if (/^[,，。；;\[\]【】()（）0]+$/.test(rewardName)) rewardName = "";
  return { username, bonus: normalizedBonus, bonusGain, rewardName, ratio, upload: normalizedUpload, download: normalizedDownload, seedPoints, ...buildInviteStats(normalized, invite), signText };
}

function hasVerification(text = "") {
  return /验证码|验证中|验证措施|人机验证|机器人|captcha|geetest|turnstile|cloudflare|滑块|点击下图|安全校验|滑动认证|拖动滑块|客户端异常|请确认您是合法用户/i.test(String(text || ""));
}

function wantsApiMode(siteConfig = {}) {
  const mode = String(siteConfig.experimental_signin_mode || siteConfig.protocol_mode || process.env.SIGNMATE_EXPERIMENTAL_SIGNIN_MODE || "api-first").trim().toLowerCase();
  return !["playwright", "browser", "off", "false", "0", "disabled"].includes(mode);
}

function allowsBrowserFallback(siteConfig = {}) {
  if (siteConfig.api_fallback_playwright === false || siteConfig.protocol_fallback_playwright === false) return false;
  return process.env.SIGNMATE_API_FALLBACK_PLAYWRIGHT !== "false";
}

function supportsNexusApi(siteConfig = {}) {
  return siteConfig.driver === "nexusphp";
}

function nexusApiStatusPaths(siteKey = "") {
  if (siteKey === "hhanclub-net") return ["/attendance.php"];
  // OurBits is keepalive-only because attendance.php requires Cloudflare Turnstile.
  // Never visit the sign-in page from the API-first keepalive path.
  return [];
}

function mergeSignOnlyStats(base = {}, extra = {}) {
  const picked = {};
  for (const key of ["signText", "bonusGain", "rewardName"]) {
    if (extra[key]) picked[key] = extra[key];
  }
  return { ...base, ...picked };
}

function sanitizeInstructionalSignStats(siteKey = "", stats = {}, text = "") {
  if (siteKey !== "ourbits-club") return stats;
  const signText = String(stats.signText || "");
  const source = String(text || "");
  const instructional = /首次[签簽]到获得|每次[签簽]到可额外获得|连续[签簽]到\s*\d+\s*天后/.test(signText)
    || (/首次[签簽]到获得\s*10\s*个魔力值/.test(source) && /^(?:签到获得 10 个魔力值|签到)$/.test(signText));
  if (!instructional) return stats;
  return { ...stats, signText: "", bonusGain: "", rewardName: "" };
}

function hasOurBitsTurnstile(text = "") {
  return /challenges\.cloudflare\.com\/turnstile|TurnstileCallback|captcha_note|请耐心等待签到验证程序加载/.test(String(text || ""));
}

async function readAdditionalNexusStatusPages(session, siteKey = "", stats = {}, steps = []) {
  let combinedText = "";
  let mergedStats = stats;
  for (const path of nexusApiStatusPaths(siteKey)) {
    try {
      const res = await session.get(path);
      const html = await readText(res);
      const text = htmlToText(html);
      combinedText += `\n${text}`;
      mergedStats = mergeSignOnlyStats(mergedStats, parsePtStats(text, siteKey));
      steps.push({ label: "HTTP 读取签到状态页", ok: res.status >= 200 && res.status < 400, status: res.status, detail: path });
    } catch (err) {
      steps.push({ label: "HTTP 读取签到状态页", ok: false, detail: `${path}: ${err.message}` });
    }
  }
  return { text: combinedText, stats: mergedStats };
}

async function readNexusControlStats(session, siteKey = "", stats = {}, steps = []) {
  let mergedStats = stats;
  try {
    const res = await session.get("/usercp.php");
    const html = await readText(res);
    const text = htmlToText(html);
    const controlStats = buildInviteStats(text, stats.invite);
    mergedStats = mergeStats(mergedStats, controlStats);
    steps.push({ label: "HTTP 读取控制面板", ok: res.status >= 200 && res.status < 400, status: res.status, detail: controlStats.inviteDisplay ? `邀请数 ${controlStats.inviteDisplay}` : "/usercp.php" });
  } catch (err) {
    steps.push({ label: "HTTP 读取控制面板", ok: false, detail: err.message });
  }
  return mergedStats;
}

function loginOkFromText(text = "", stats = {}) {
  return /欢迎回来|歡迎回來|退出|控制面板|用户中心|我的账户|嗨[,，]/.test(text) && !!stats.username;
}

function buildPtInfoDetail(stats = {}) {
  return [`用户 ${stats.username || "-"}`, stats.bonus ? `魔力 ${stats.bonus}` : "", stats.ratio ? `分享率 ${stats.ratio}` : "", stats.upload ? `上传 ${stats.upload}` : "", stats.download ? `下载 ${stats.download}` : "", stats.inviteDisplay ? `邀请数 ${stats.inviteDisplay}` : ""].filter(Boolean).join("；");
}

function buildVisitMessage(ok, stats = {}, signTime = "") {
  const messageParts = [];
  messageParts.push(ok ? "HTTP API 保活完成" : "HTTP API 访问失败或登录态异常");
  if (stats.bonus) messageParts.push(`魔力值 ${stats.bonus}`);
  if (stats.ratio) messageParts.push(`分享率 ${stats.ratio}`);
  if (stats.upload) messageParts.push(`上传 ${stats.upload}`);
  if (stats.download) messageParts.push(`下载 ${stats.download}`);
  messageParts.push(`检查时间：${signTime}`);
  return messageParts.join("；");
}

async function runNexusApi(siteConfig = {}, secrets = {}, driverName = "NexusPHP") {
  const { base_url, timeout = 60_000, proxy_url } = siteConfig;
  if (!base_url) return { handled: true, result: { success: false, message: "基础 URL 未配置" } };
  const siteKey = siteConfig.key || siteConfig.id || siteConfig.driver || "";
  if (!supportsNexusApi(siteConfig)) return { handled: false, reason: "site_api_not_supported" };

  const signTime = formatTime();
  const url = base_url.replace(/\/$/, "");
  const cookie = getCookieForSite(secrets, siteConfig);
  const session = createHttpSession({ baseUrl: url, cookie, proxyUrl: proxy_url, timeout });
  const steps = [];
  if (!cookie) {
    steps.push({ label: "检查 Cookie", ok: false, detail: "未配置 Cookie" });
    return { handled: true, result: { success: false, message: `${driverName} Cookie 未配置；检查时间：${signTime}`, details: { signTime, clickedSignIn: false, alreadySigned: false, verificationBlocked: false }, steps } };
  }

  logger.info(`[NexusPHP/API] ${driverName} 步骤 1/4：HTTP 打开站点 → ${url}${proxy_url ? `，代理: ${proxy_url}` : ""}`);
  const homeResp = await session.get("/");
  const homeHtml = await readText(homeResp);
  const homeText = htmlToText(homeHtml);
  const title = pageTitleFromHtml(homeHtml);
  let stats = sanitizeInstructionalSignStats(siteKey, parsePtStats(homeText, siteKey), homeText);
  const extraStatus = await readAdditionalNexusStatusPages(session, siteKey, stats, steps);
  const allStatusText = `${homeText}\n${extraStatus.text || ""}`;
  stats = sanitizeInstructionalSignStats(siteKey, mergeStats(parsePtStats(allStatusText, siteKey), extraStatus.stats), allStatusText);
  if (!stats.inviteDisplay || siteKey === "audiences-me") {
    stats = await readNexusControlStats(session, siteKey, stats, steps);
  }
  const loggedIn = loginOkFromText(allStatusText, stats);
  steps.push({ label: "HTTP 打开站点", ok: homeResp.status >= 200 && homeResp.status < 400, status: homeResp.status, detail: url });
  steps.push({ label: "确认登录态", ok: loggedIn, detail: stats.username ? `用户 ${stats.username}` : "未识别到登录用户" });

  if ((siteConfig.kind || "signin") === "visit") {
    const ok = homeResp.status >= 200 && homeResp.status < 400 && loggedIn;
    steps.push({ label: "HTTP 保活访问", ok, detail: ok ? "API/HTTP 已打开站点并确认登录态" : "未确认登录态，保活失败" });
    steps.push({ label: "读取 PT 账号信息", ok: !!stats.username || !!stats.bonus, detail: buildPtInfoDetail(stats) });
    return {
      handled: true,
      result: {
        success: ok,
        message: buildVisitMessage(ok, stats, signTime),
        details: { ...stats, signTime, pageTitle: title, status: homeResp.status, clickedSignIn: false, alreadySigned: false, verificationBlocked: false, checkinAction: "api_keepalive" },
        steps,
      },
    };
  }

  const already = /已签到|Showed\s*Up|今日已[签簽]到|已经[签簽]到|这是您的第\s*\d+\s*次[签簽]到/i.test(allStatusText);
  if (siteKey === "hdsky-me") {
    if (already) {
      stats = { ...stats, signText: stats.signText || "今日已签到" };
      steps.push({ label: "检查签到状态", ok: true, detail: "HTTP 页面显示今日已签到" });
      steps.push({ label: "读取 PT 账号信息", ok: !!stats.username || !!stats.bonus, detail: buildPtInfoDetail(stats) });
      return {
        handled: true,
        result: {
          success: loggedIn,
          message: `今日已签到${stats.bonus ? `；魔力值 ${stats.bonus}` : ""}${stats.ratio ? `；分享率 ${stats.ratio}` : ""}；检查时间：${signTime}`,
          details: { ...stats, signTime, pageTitle: title, status: homeResp.status, clickedSignIn: false, alreadySigned: true, verificationBlocked: false, checkinAction: "api_already_signed" },
          steps,
        },
      };
    }
    return { handled: false, reason: "hdsky_captcha_not_promoted" };
  }

  if (siteKey === "ourbits-club" && hasOurBitsTurnstile(allStatusText) && !already) {
    steps.push({ label: "HTTP 检测 OurBits Turnstile", ok: false, detail: "签到页需要 Cloudflare Turnstile，未确认已签到" });
    return { handled: false, reason: "ourbits_turnstile_required" };
  }

  const signedByHttp = already || !!stats.bonusGain || /[签簽]到已得|已[签簽]到|今日已[签簽]到|已经[签簽]到|本次[签簽]到获得|[签簽]到获得\s*[0-9,.]+/i.test(stats.signText || "");
  if (signedByHttp) {
    steps.push({ label: "HTTP 检查签到状态", ok: true, detail: stats.signText || "HTTP 页面显示今日已签到" });
    steps.push({ label: "读取 PT 账号信息", ok: !!stats.username || !!stats.bonus, detail: buildPtInfoDetail(stats) });
    return {
      handled: true,
      result: {
        success: loggedIn,
        message: `${stats.signText || "今日已签到"}${stats.bonus ? `；魔力值 ${stats.bonus}` : ""}${stats.ratio ? `；分享率 ${stats.ratio}` : ""}；检查时间：${signTime}`,
        details: { ...stats, signTime, pageTitle: title, status: homeResp.status, clickedSignIn: false, alreadySigned: true, verificationBlocked: false, checkinAction: "api_already_signed" },
        steps,
      },
    };
  }
  return { handled: false, reason: "signin_submit_api_not_implemented" };
}



function mergeStats(base = {}, extra = {}) {
  return Object.fromEntries(Object.entries({ ...base, ...extra }).map(([key, value]) => [key, value || base[key] || ""]));
}

function buildInviteStats(text = "", fallback = "") {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  const headerInvite = normalized.match(/(?:邀请|邀請)(?!人)(?:\s*\[\s*(?:发送|發送)\s*\])?[^:：0-9]{0,30}[:：]\s*(\d+)(?:\s*\/\s*(\d+))?/i);
  if (headerInvite) {
    const normalInvite = headerInvite[1] || "";
    const tempInvite = headerInvite[2] ?? "";
    const hasNormalInvite = normalInvite !== "";
    const hasTempInvite = tempInvite !== "";
    const inviteDisplay = hasTempInvite ? `${normalInvite || 0}+${tempInvite}` : (normalInvite || "");
    const inviteNote = hasTempInvite
      ? `邀请数：正式 ${normalInvite || 0}，临时 ${tempInvite}`
      : (hasNormalInvite ? `邀请数：${normalInvite}` : "");
    return { invite: normalInvite, tempInvite, inviteDisplay, inviteNote };
  }
  const first = patterns => {
    for (const pattern of patterns) {
      const value = normalized.match(pattern)?.[1];
      if (value !== undefined && value !== null && value !== "") return String(value).replace(/[^0-9]/g, "");
    }
    return "";
  };
  const normalInvite = first([
    /(?:正式|普通|永久|可用|剩余|剩餘)?\s*(?:邀请|邀請)(?!人)(?:\s*\[(?:发送|發送)\])?\s*[:：]?\s*(\d+)\s*\/\s*\d+/i,
    /(?:正式|普通|永久|可用|剩余|剩餘)?\s*(?:邀请|邀請)(?!人)(?:\s*\[(?:发送|發送)\])?\s*[:：]?\s*([0-9]+)/i,
    /(?:invite|invites)(?!r)[^0-9]{0,16}([0-9]+)/i,
  ]) || String(fallback || "").match(/^[0-9]+$/)?.[0] || "";
  const tempInvite = first([
    /(?:正式|普通|永久|可用|剩余|剩餘)?\s*(?:邀请|邀請)(?!人)(?:\s*\[(?:发送|發送)\])?\s*[:：]?\s*\d+\s*\/\s*(\d+)/i,
    /(?:临时|臨時|暂时|暫時|temporary)\s*(?:邀请|邀請|invite)[^0-9]{0,20}([0-9]+)/i,
    /(?:邀请|邀請|invite)[^。；;]{0,18}(?:临时|臨時|暂时|暫時|temporary)[^0-9]{0,20}([0-9]+)/i,
  ]);
  const hasNormalInvite = normalInvite !== "";
  const hasTempInvite = tempInvite !== "";
  const inviteDisplay = hasTempInvite ? `${normalInvite || 0}+${tempInvite}` : (normalInvite || "");
  const inviteNote = hasTempInvite
    ? `邀请数：正式 ${normalInvite || 0}，临时 ${tempInvite}`
    : (hasNormalInvite ? `邀请数：${normalInvite}` : "");
  return { invite: normalInvite, tempInvite, inviteDisplay, inviteNote };
}


async function waitForTurnstileChallenge(page, siteName = "NexusPHP", timeoutMs = 25_000) {
  const present = await page.evaluate(() => {
    return !!(
      document.querySelector(".cf-turnstile")
      || document.querySelector('input[name="cf-turnstile-response"]')
      || [...document.scripts].some(script => /challenges\.cloudflare\.com\/turnstile/i.test(script.src || script.textContent || ""))
    );
  }).catch(() => false);
  if (!present) return { present: false, passed: false };

  logger.info(`[NexusPHP] ${siteName} 检测到 Cloudflare Turnstile，等待浏览器自然完成验证`);
  const deadline = Date.now() + timeoutMs;
  let tokenLength = 0;
  let continued = false;
  while (Date.now() < deadline) {
    const state = await page.evaluate(() => {
      const token = document.querySelector('input[name="cf-turnstile-response"]')?.value || "";
      const body = String(document.body?.innerText || "").replace(/\s+/g, " ");
      return {
        tokenLength: token.length,
        hasVerificationText: /验证中|驗證中|Cloudflare|Turnstile/i.test(body),
        hasTurnstile: !!document.querySelector(".cf-turnstile"),
        hasForm: !!document.querySelector("#attendance-form"),
      };
    }).catch(() => ({ tokenLength: 0, hasVerificationText: false, hasTurnstile: false, hasForm: false }));
    tokenLength = state.tokenLength || 0;
    continued = !state.hasVerificationText && (!state.hasTurnstile || page.url().includes("attendance.php"));
    if (tokenLength > 0 || continued) {
      if (tokenLength > 0 && state.hasForm) {
        await page.evaluate(() => document.querySelector("#attendance-form")?.submit()).catch(() => {});
      }
      await Promise.race([
        page.waitForLoadState("domcontentloaded", { timeout: 8000 }).catch(() => {}),
        page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {}),
      ]);
      await page.waitForTimeout(1500);
      return { present: true, passed: true, tokenLength };
    }
    await page.waitForTimeout(1000);
  }
  return { present: true, passed: false, tokenLength };
}

async function solveSimpleSlideCheck(page, siteName = "NexusPHP") {
  const hasSlider = await page.locator("#dragContainer #dragHandler").count().catch(() => 0);
  if (!hasSlider) return false;
  const title = await page.title().catch(() => "");
  const body = await page.locator("body").innerText({ timeout: 2000 }).catch(() => "");
  if (!/滑动认证|拖动滑块验证|验证/.test(`${title}
${body}`)) return false;

  logger.info(`[NexusPHP] ${siteName} 检测到简单滑块认证，尝试拖动通过`);
  const container = await page.locator("#dragContainer").boundingBox().catch(() => null);
  const handler = await page.locator("#dragHandler").boundingBox().catch(() => null);
  if (!container || !handler) return false;

  const startX = handler.x + handler.width / 2;
  const startY = handler.y + handler.height / 2;
  const endX = container.x + container.width - handler.width / 2 - 2;

  await page.mouse.move(startX, startY);
  await page.mouse.down();
  // 分段移动，模拟真实拖动；该站点脚本只校验是否拖到最右，不做轨迹识别。
  const steps = 16;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const eased = 1 - Math.pow(1 - t, 2);
    await page.mouse.move(startX + (endX - startX) * eased, startY + Math.sin(t * Math.PI) * 2, { steps: 2 });
    await page.waitForTimeout(20 + Math.round(Math.random() * 25));
  }
  await page.mouse.up();

  await Promise.race([
    page.waitForLoadState("domcontentloaded", { timeout: 8000 }).catch(() => {}),
    page.waitForURL(url => !/attendance\.php(?:$|[?#])/.test(String(url)) || true, { timeout: 8000 }).catch(() => {}),
  ]);
  await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
  await page.waitForTimeout(1500);

  const afterText = await page.locator("body").innerText({ timeout: 3000 }).catch(() => "");
  return !/拖动滑块验证/.test(afterText);
}

export default class NexusPhpDriver extends WebsiteDriver {
  async signIn() {
    if (wantsApiMode(this.siteConfig)) {
      try {
        const api = await runNexusApi(this.siteConfig, this.secrets, this.name);
        if (api.handled) return api.result;
        if (!allowsBrowserFallback(this.siteConfig)) {
          return { success: false, message: `HTTP/API 模式未能处理：${api.reason || "未实现"}` };
        }
        logger.warn(`[NexusPHP/API] ${this.name} HTTP/API 未处理，回退 Playwright：${api.reason || "unknown"}`);
      } catch (err) {
        if (!allowsBrowserFallback(this.siteConfig)) return { success: false, message: `HTTP/API 执行失败：${err.message}` };
        logger.warn(`[NexusPHP/API] ${this.name} HTTP/API 失败，回退 Playwright：${err.message}`);
      }
    }
    const { chromium } = await import("playwright-core");
    const {
      base_url,
      timeout = 60_000,
      proxy_url,
      chromium_executable_path = await resolveChromiumExecutablePath(chromium),
    } = this.siteConfig;
    if (!base_url) return { success: false, message: "基础 URL 未配置" };

    const signTime = formatTime();
    const cookie = this.getCookie();
    const url = base_url.replace(/\/$/, "");
    const proxy = proxy_url ? { server: proxy_url } : undefined;
    const steps = [];
    const totpSecret = getTotpSecret(this.secrets, this.siteConfig);

    logger.info(`[NexusPHP] ${this.name} 步骤 1/6：启动 Playwright 浏览器${proxy_url ? `，代理: ${proxy_url}` : ""}`);
    const browser = await launchBrowser({
      chromium,
      siteConfig: this.siteConfig,
      launchOptions: { executablePath: chromium_executable_path, headless: true, proxy, args: ["--no-sandbox"], timeout },
    });
    try {
      const context = await browser.newContext({
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
        locale: "zh-CN",
        timezoneId: "Asia/Shanghai",
        viewport: { width: 1440, height: 1000 },
      });
      steps.push({ label: "启动 Playwright 浏览器", ok: true });

      if (cookie) logger.info(`[NexusPHP] ${this.name} 步骤 2/6：注入 Cookie`);
      // WebsiteDriver helper is not exported, so parse cookie locally through inherited getCookie + URL domain.
      const hostname = new URL(url).hostname;
      const domain = hostname.startsWith("www.") ? `.${hostname.slice(4)}` : `.${hostname}`;
      const cookies = String(cookie || "").split(";").map(p => p.trim()).filter(Boolean).map(p => {
        const i = p.indexOf("=");
        if (i < 0) return null;
        return { name: p.slice(0, i), value: p.slice(i + 1), domain, path: "/", secure: true, httpOnly: false, sameSite: "Lax" };
      }).filter(Boolean);
      if (cookies.length) await context.addCookies(cookies);
      steps.push({ label: cookies.length ? "注入 Cookie" : "检查 Cookie", ok: cookies.length > 0, detail: cookies.length ? "已注入" : "未配置 Cookie" });

      const page = await context.newPage();
      logger.info(`[NexusPHP] ${this.name} 步骤 3/6：打开站点 → ${url}`);
      const response = await page.goto(url, { waitUntil: "commit", timeout });
      await page.waitForLoadState("domcontentloaded", { timeout: Math.min(timeout, 15_000) }).catch(() => {});
      await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
      await page.waitForTimeout(this.siteConfig.playwright_wait_ms || 1500);
      const status = response?.status() || 0;
      let title = await page.title().catch(() => "");
      steps.push({ label: "打开站点", ok: status >= 200 && status < 400, status, detail: url });

      let text = await page.locator("body").innerText({ timeout: 5000 }).catch(() => "");
      const siteKey = this.siteConfig.key || this.siteConfig.id || "";
      const isVisitOnly = (this.siteConfig.kind || "signin") === "visit";
      const initialTotp = await trySubmitTotp(page, totpSecret, this.name, steps);
      if (initialTotp.present && !initialTotp.passed) {
        const blockedStats = parsePtStats(text, siteKey);
        return {
          success: false,
          message: initialTotp.reason === "missing_secret" ? `${this.name} 需要两步验证码，未配置 2FA Secret；检查时间：${signTime}` : `${this.name} 两步验证码提交后仍未通过${initialTotp.failureReason ? `：${initialTotp.failureReason}` : ""}；检查时间：${signTime}`,
          details: { ...blockedStats, signTime, pageTitle: title, status, clickedSignIn: false, alreadySigned: false, verificationBlocked: true, verificationType: "2fa", twoFactorRequired: true, twoFactorSubmitted: initialTotp.submitted, twoFactorPassed: false, twoFactorFailureReason: initialTotp.failureReason || "" },
          steps,
        };
      }
      if (initialTotp.passed) {
        await page.goto(url, { waitUntil: "commit", timeout }).catch(() => {});
        await page.waitForLoadState("domcontentloaded", { timeout: Math.min(timeout, 15_000) }).catch(() => {});
        await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
        await page.waitForTimeout(this.siteConfig.playwright_wait_ms || 1500);
        text = await page.locator("body").innerText({ timeout: 5000 }).catch(() => "");
        title = await page.title().catch(() => title);
      }
      const readStructuredSiteStats = async () => {
        return page.evaluate(siteKey => {
          const textOf = el => String(el?.innerText || el?.textContent || "").replace(/\s+/g, " ").trim();
          if (siteKey === "hhanclub-net") {
            const panel = document.querySelector("#user-info-panel");
            const valueAfterIcon = alt => {
              const img = panel?.querySelector(`img[alt="${alt}"]`);
              const row = img?.closest("div, a") || img?.parentElement;
              return textOf(row).replace(/^\[[^\]]+\]\s*[:：]?\s*/, "").trim();
            };
            return {
              panelText: textOf(panel),
              stats: {
                username: textOf(panel?.querySelector(".User_Name")),
                bonus: valueAfterIcon("憨豆"),
                upload: valueAfterIcon("上传"),
                download: valueAfterIcon("下载"),
                invite: valueAfterIcon("邀请").replace(/[^0-9].*$/, ""),
                ratio: textOf(panel).match(/\[?分享率\]?\s*[:：]\s*([0-9.]+)/)?.[1] || "",
              },
            };
          }
          if (siteKey === "audiences-me") {
            const bar = document.querySelector(".site-userbar, .site-userbar__compact, #info_block, body");
            const linkTitle = pattern => [...document.querySelectorAll("a[title]")].map(a => a.getAttribute("title") || "").find(t => pattern.test(t)) || "";
            const titleBonus = linkTitle(/爆米花/);
            const titleInvite = linkTitle(/邀請|邀请|invite/i);
            const body = textOf(bar);
            const nums = body.match(/HughRyu\s+([0-9.]+)\s+([0-9.]+\s*[KMGTPE]?B)\s+([0-9.]+\s*[KMGTPE]?B)\s+([0-9,.]+)\s+([0-9,.]+)/i);
            const invite = titleInvite.match(/(?:邀請|邀请|invite)[^0-9]*([0-9]+)/i)?.[1]
              || body.match(/(?:邀請|邀请|invite)[^0-9]{0,20}([0-9]+)/i)?.[1]
              || "";
            return {
              panelText: body,
              stats: {
                username: "HughRyu",
                ratio: nums?.[1] || "",
                upload: nums?.[2] || "",
                download: nums?.[3] || "",
                bonus: titleBonus.match(/爆米花\s*([0-9,.]+)/)?.[1] || nums?.[4] || "",
                seedPoints: nums?.[5] || "",
                invite,
              },
            };
          }
          return { panelText: "", stats: {} };
        }, siteKey).catch(() => ({ panelText: "", stats: {} }));
      };
      let siteExtra = await readStructuredSiteStats();
      let stats = sanitizeInstructionalSignStats(siteKey, mergeStats(parsePtStats(`${text}
${siteExtra.panelText}`, siteKey), siteExtra.stats), `${text}
${siteExtra.panelText}`);
      if (!stats.inviteDisplay) {
        const controlUrl = new URL("/usercp.php", url).toString();
        const controlPage = await context.newPage();
        try {
          await controlPage.goto(controlUrl, { waitUntil: "domcontentloaded", timeout: Math.min(timeout, 20_000) });
          const controlText = await controlPage.locator("body").innerText({ timeout: 5000 }).catch(() => "");
          stats = mergeStats(stats, buildInviteStats(controlText, stats.invite));
        } catch (err) {
          logger.warn(`[NexusPHP] ${this.name} 读取邀请数量失败: ${err.message}`);
          stats = mergeStats(stats, buildInviteStats(`邀请 ${stats.invite || ""}`, stats.invite));
        } finally {
          await controlPage.close().catch(() => {});
        }
      }
      let loggedIn = /欢迎回来|退出|控制面板/.test(text) && !!stats.username;
      steps.push({ label: "确认登录态", ok: loggedIn, detail: stats.username ? `用户 ${stats.username}` : "未识别到登录用户" });

      // 保活站点只确认登录态并读取账号基础信息，不点击签到入口，避免触发无法自动通过的验证/WAF。
      if ((this.siteConfig.kind || "signin") === "visit") {
        const ok = status >= 200 && status < 400 && loggedIn;
        const messageParts = [];
        messageParts.push(ok ? (initialTotp.passed ? "两步验证已通过，登录保活完成" : "登录保活完成") : "访问失败或登录态异常");
        if (stats.bonus) messageParts.push(`魔力值 ${stats.bonus}`);
        if (stats.ratio) messageParts.push(`分享率 ${stats.ratio}`);
        if (stats.upload) messageParts.push(`上传 ${stats.upload}`);
        if (stats.download) messageParts.push(`下载 ${stats.download}`);
        messageParts.push(`检查时间：${signTime}`);
        steps.push({
          label: "保活访问",
          ok,
          detail: ok ? "已打开站点并保持登录态；保活模式不会触发签到入口" : "未确认登录态，保活失败",
        });
        steps.push({ label: "读取 PT 账号信息", ok: !!stats.username || !!stats.bonus, detail: [`用户 ${stats.username || "-"}`, stats.bonus ? `魔力 ${stats.bonus}` : "", stats.ratio ? `分享率 ${stats.ratio}` : "", stats.upload ? `上传 ${stats.upload}` : "", stats.download ? `下载 ${stats.download}` : "", stats.inviteDisplay ? `邀请数 ${stats.inviteDisplay}` : ""].filter(Boolean).join("；") });
        return {
          success: ok,
          message: messageParts.join("；"),
          details: { ...stats, signTime, pageTitle: title, status, clickedSignIn: false, alreadySigned: false, verificationBlocked: false },
          steps,
        };
      }

      const beforeBonus = stats.bonus || "";
      let clicked = false;
      let already = /[签簽]到已得|已[签簽]到|今日已[签簽]到|已经[签簽]到/.test(text);
      let blocked = false;
      let clickDetail = "未发现签到入口";
      let hasOpenCdCaptchaFrame = false;
      let openCdCaptchaSolved = false;
      if (!already) {
        const signLink = page.locator('#showup, a:has-text("签到"), a:has-text("簽到"), button:has-text("签到"), button:has-text("簽到"), input[value*="签到"], input[value*="簽到"]').first();
        if ((await signLink.count().catch(() => 0)) > 0) {
          clicked = true;
          // 针对 #showup / image_code_ajax 的 AJAX 签到：在点击前设置响应拦截
          let ajaxSigninResult = null;
          let ajaxPromise = null;
          const isShowupStyle = await page.locator("#showup").count().catch(() => 0) > 0
            || /image_code_ajax/i.test(page.url())
            || (await page.locator('script').filter({ hasText: /initshowupajax|showup/i }).count().catch(() => 0)) > 0;
          if (siteKey === "pterclub-net") {
            ajaxPromise = page.waitForResponse(
              r => r.url().includes("attendance-ajax.php") && r.status() === 200,
              { timeout: 15_000 }
            ).then(async r => { try { return JSON.parse(await r.text()); } catch { return null; } }).catch(() => null);
          } else if (isShowupStyle) {
            ajaxPromise = page.waitForResponse(
              r => r.url().includes("image_code_ajax.php") && r.request().method() === "POST" && r.status() === 200,
              { timeout: 15_000 }
            ).then(async r => { try { return JSON.parse(await r.text()); } catch { return null; } }).catch(() => null);
          }

          // 点击签到入口
          logger.info(`[NexusPHP] ${this.name} 步骤 5/6：点击签到入口`);
          await signLink.click({ timeout: 8000 }).catch(async () => {
            const href = await page.locator('a:has-text("签到"), a:has-text("簽到")').first().getAttribute("href").catch(() => "");
            if (href) await page.goto(new URL(href, page.url()).toString(), { waitUntil: "domcontentloaded", timeout }).catch(() => {});
          });
          await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
          await page.waitForTimeout(1800);

          // OpenCD: 检测并 OCR 解决图片验证码
          let openCdSigninFrame = page.frameLocator('iframe#i_signin, iframe[src*="plugin_sign-in.php"]').first();
          let openCdSigninResponse = null;
          const openCdImagehash = await openCdSigninFrame.locator('input[name="imagehash"]').first().getAttribute("value").catch(() => "");
          if (openCdImagehash) {
            hasOpenCdCaptchaFrame = true;
            steps.push({ label: "检测图片验证码 (OpenCD)", ok: true, detail: "准备 OCR 自动识别" });
            try {
              let captchaImg = openCdSigninFrame.locator('img[src*="image.php"]').first();
              const maxOcrAttempts = Math.max(1, Math.min(siteKey === "open-cd" ? 8 : 3, Number(this.siteConfig.ocr_attempts || (siteKey === "open-cd" ? 8 : 3))));
              let lastCaptchaText = "";
              for (let attempt = 1; attempt <= maxOcrAttempts && !openCdCaptchaSolved; attempt++) {
                const captchaBuf = await captchaImg.screenshot({ type: "png", timeout: 8_000 });
                logger.info(`[NexusPHP] ${this.name} 验证码截图已获取 (${attempt}/${maxOcrAttempts}), ${captchaBuf.length} bytes`);
                const captchaText = await ocr(captchaBuf, siteKey === "open-cd" ? { minLen: 6, maxLen: 6, width: 300, psm: "8" } : {});
                lastCaptchaText = captchaText;
                logger.info(`[NexusPHP] ${this.name} OCR 识别结果 (${attempt}/${maxOcrAttempts}): "${captchaText}"`);
                if (captchaText && (siteKey === "open-cd" ? /^[A-Z0-9]{6}$/.test(captchaText) : (captchaText.length >= 4 && captchaText.length <= 8))) {
                  await openCdSigninFrame.locator('input#imagestring, input[name="imagestring"]').first().fill(captchaText, { timeout: 5000 }).catch(() => {});
                  const responsePromise = page.waitForResponse(
                    r => r.url().includes("plugin_sign-in.php?cmd=signin") && r.request().method() === "POST",
                    { timeout: 12_000 }
                  ).then(async r => {
                    const raw = await r.text().catch(() => "");
                    try { return JSON.parse(raw); } catch { return { state: "parse_error", raw: raw.slice(0, 300) }; }
                  }).catch(() => null);
                  await openCdSigninFrame.locator('button#ok, button:has-text("签到")').first().click({ timeout: 5000 }).catch(() => {});
                  openCdSigninResponse = await responsePromise;
                  await page.waitForTimeout(3000);
                  await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => {});
                  const stillHasFrame = await page.locator('iframe#i_signin').count().catch(() => 0) > 0;
                  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20_000 }).catch(() => {});
                  await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
                  await page.waitForTimeout(1500);
                  const verifyText = await page.locator("body").innerText({ timeout: 5000 }).catch(() => "");
                  const verifyExtra = await readStructuredSiteStats();
                  const verifyStats = sanitizeInstructionalSignStats(siteKey, mergeStats(parsePtStats(`${verifyText}
${verifyExtra.panelText}`, siteKey), verifyExtra.stats), `${verifyText}
${verifyExtra.panelText}`);
                  const verifyGain = bonusDelta(beforeBonus, verifyStats.bonus || stats.bonus);
                  const remainingOpenCdSignEntry = siteKey === "open-cd"
                    ? (await page.locator('#showup, a:has-text("签到"), a:has-text("簽到"), button:has-text("签到"), button:has-text("簽到"), input[value*="签到"], input[value*="簽到"]').count().catch(() => 0)) > 0
                    : false;
                  const signedTextConfirmed = /[签簽]到已得|已[签簽]到|[签簽]到成功|今日已[签簽]到|已经[签簽]到|本次[签簽]到获得|[签簽]到获得\s*[0-9,.]+\s*个/.test(verifyText);
                  const responseConfirmed = openCdSigninResponse?.state === "success";
                  const responseReward = responseConfirmed ? String(openCdSigninResponse.integral ?? "") : "";
                  const openCdConfirmed = siteKey === "open-cd" ? responseConfirmed : (verifyGain || signedTextConfirmed);
                  if (openCdConfirmed) {
                    openCdCaptchaSolved = true;
                    stats = mergeStats(stats, verifyStats);
                    if (siteKey === "open-cd") {
                      stats = { ...stats, bonusGain: responseReward, rewardName: "魔力值", signText: `签到成功，连续 ${openCdSigninResponse.signindays ?? "?"} 天${responseReward ? `，本次增加魔力 ${responseReward}` : ""}` };
                    } else if (verifyGain) stats = { ...stats, bonusGain: verifyGain, rewardName: stats.rewardName || "魔力值" };
                    steps.push({ label: "OCR 验证码通过", ok: true, detail: siteKey === "open-cd" ? `第 ${attempt} 次识别 ${captchaText}，站点返回 success${responseReward ? `，奖励 ${responseReward}` : ""}` : `第 ${attempt} 次识别 ${captchaText}，签到已确认${verifyGain ? `，魔力值 +${verifyGain}` : ""}` });
                    break;
                  }
                  const responseDetail = openCdSigninResponse ? `，站点返回 ${openCdSigninResponse.state || "未知"}${openCdSigninResponse.msg ? `: ${openCdSigninResponse.msg}` : ""}` : "，未收到签到接口响应";
                  steps.push({ label: "OCR 验证码提交", ok: false, detail: `第 ${attempt} 次识别 ${captchaText} 后未确认签到成功${siteKey === "open-cd" ? responseDetail : (stillHasFrame ? "，验证码仍在" : (remainingOpenCdSignEntry ? "，签到入口仍存在" : "，页面未出现已签到状态"))}` });
                } else {
                  steps.push({ label: "OCR 识别验证码", ok: false, detail: `第 ${attempt} 次 OCR 结果异常: "${captchaText}" (需 4-8 位字母数字)` });
                }
                if (attempt < maxOcrAttempts) {
                  if (siteKey === "open-cd") {
                    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20_000 }).catch(() => {});
                    await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => {});
                    const retrySignLink = page.locator('#showup, a:has-text("签到"), a:has-text("簽到"), button:has-text("签到"), button:has-text("簽到"), input[value*="签到"], input[value*="簽到"]').first();
                    await retrySignLink.click({ timeout: 8000 }).catch(() => {});
                    await page.waitForTimeout(1200);
                    openCdSigninFrame = page.frameLocator('iframe#i_signin, iframe[src*="plugin_sign-in.php"]').first();
                    captchaImg = openCdSigninFrame.locator('img[src*="image.php"]').first();
                  } else {
                    await captchaImg.click({ timeout: 2000 }).catch(() => {});
                    await page.waitForTimeout(800);
                  }
                }
              }
              if (!openCdCaptchaSolved && lastCaptchaText) {
                steps.push({ label: "OCR 验证码流程", ok: false, detail: `已尝试 ${maxOcrAttempts} 次，最后结果: "${lastCaptchaText}"` });
              }
            } catch (e) {
              steps.push({ label: "OCR 验证码流程", ok: false, detail: `异常: ${String(e.message || e).slice(0, 100)}` });
            }
          }

          // OCR 成功后直接标记已签到
          if (openCdCaptchaSolved) {
            already = true;
            blocked = false;
            const afterOcrText = await page.locator("body").innerText({ timeout: 5000 }).catch(() => "");
            text = afterOcrText || text;
            siteExtra = await readStructuredSiteStats();
            const afterOcrStats = mergeStats(parsePtStats(`${text}\n${siteExtra.panelText}`, siteKey), siteExtra.stats);
            const gain = bonusDelta(beforeBonus, afterOcrStats.bonus || stats.bonus);
            stats = mergeStats(stats, afterOcrStats);
            if (gain) stats = { ...stats, bonusGain: gain, rewardName: stats.rewardName || "魔力值" };
            stats = { ...stats, signText: stats.signText || "签到成功 (OCR 验证码)" };
          } else {
            // 继续原流程
          

          // 等待 AJAX 响应并解析结果
          if (ajaxPromise) {
            try { ajaxSigninResult = await ajaxPromise; } catch {}
          }
          }

          const turnstile = await waitForTurnstileChallenge(page, this.name, this.siteConfig.turnstile_wait_ms || 25_000);
          let turnstileStep = null;
          if (turnstile.present) {
            turnstileStep = {
              label: "等待 Cloudflare Turnstile 验证",
              ok: turnstile.passed,
              detail: turnstile.passed ? "验证 token 已生成/页面已继续" : "未生成验证 token，需人工验证或更可信浏览器环境",
            };
            // 只有验证明确通过，或最终确实因此失败时，才展示 Turnstile 步骤。
            // OurBits 这类站点可能未显式生成 token，但后续已通过签到文案/魔力增量确认成功；这种情况不展示误导性警告。
            if (turnstile.passed) steps.push(turnstileStep);
          }
          const slideSolved = turnstile.present ? false : await solveSimpleSlideCheck(page, this.name);
          if (slideSolved) {
            steps.push({ label: "通过简单滑块认证", ok: true, detail: "已拖动滑块并刷新签到页" });
          }
          let afterClickText = await page.locator("body").innerText({ timeout: 5000 }).catch(() => "");
          const clickTotp = await trySubmitTotp(page, totpSecret, this.name, steps);
          if (clickTotp.present && clickTotp.passed) {
            await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20_000 }).catch(() => {});
            await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
            await page.waitForTimeout(1500);
            afterClickText = await page.locator("body").innerText({ timeout: 5000 }).catch(() => afterClickText);
          }
          text = afterClickText || text;
          siteExtra = await readStructuredSiteStats();
          const afterClickStats = sanitizeInstructionalSignStats(siteKey, mergeStats(parsePtStats(`${text}
${siteExtra.panelText}`, siteKey), siteExtra.stats), `${text}
${siteExtra.panelText}`);
          stats = sanitizeInstructionalSignStats(siteKey, mergeStats(stats, afterClickStats), `${text}
${siteExtra.panelText}`);
          if (!stats.bonusGain) {
            const gain = bonusDelta(beforeBonus, afterClickStats.bonus || stats.bonus);
            if (gain) stats = { ...stats, bonusGain: gain, rewardName: stats.rewardName || "魔力值" };
          }

          // 如果 AJAX 响应明确返回 success/status=1，直接标记为已签到
          const ajaxSuccess = ajaxSigninResult && (ajaxSigninResult.success === true || ajaxSigninResult.status === "1" || ajaxSigninResult.status === 1);
          if (ajaxSuccess) {
            already = true;
            blocked = false;
            const ajaxText = String(ajaxSigninResult.message || ajaxSigninResult.data || "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ");
            const gain2 = bonusDelta(beforeBonus, stats.bonus) || ajaxText.match(/(?:获得|已得)\s*([0-9,.]+)\s*(?:克)?(?:猫粮|魔力值)?/)?.[1] || "";
            if (gain2 && !stats.bonusGain) stats = { ...stats, bonusGain: gain2, rewardName: stats.rewardName || (siteKey === "pterclub-net" ? "猫粮" : "魔力值") };
            stats = {
              ...stats,
              signText: stats.signText || ajaxText.match(/(?:这是您的第[^。]+。\s*)?本次签到获得\s*[0-9,.]+\s*(?:克)?[^。；;]*/)?.[0] || ajaxText.match(/签到已得\s*[0-9,.]+/)?.[0] || "签到成功 (AJAX)",
              bonusGain: stats.bonusGain || "",
            };
          } else {
            blocked = (hasOpenCdCaptchaFrame && !openCdCaptchaSolved) || hasVerification(text.replace(/未验证用户\s*\d+|被警告用户\s*\d+|被禁用户\s*\d+/g, "")) || isTwoFactorPage(text, page.url());
          }
          already = already || (siteKey !== "ourbits-club" && /[签簽]到已得|已[签簽]到|[签簽]到成功|今日已[签簽]到|已经[签簽]到|本次[签簽]到获得|[签簽]到获得\s*[0-9,.]+\s*个/.test(text));
          if (already && stats.bonusGain) {
            loggedIn = true;
            blocked = false;
          }
          if (blocked && turnstileStep && turnstileStep.ok === false && !steps.includes(turnstileStep)) {
            steps.push(turnstileStep);
          }
          if (blocked && !ajaxSuccess) {
            // 验证页常包含“首次签到获得 xx”的规则说明，不能当作本次签到收益。
            stats = { ...stats, signText: "", bonusGain: "", rewardName: "" };
            already = false;
          }
          clickDetail = blocked
            ? (hasOpenCdCaptchaFrame && !openCdCaptchaSolved ? "图片验证码 OCR 未通过，需人工输入" : (isTwoFactorPage(text, page.url()) ? "两步验证未通过，需检查 2FA Secret/验证码时效/登录环境" : (turnstile.present && !turnstile.passed ? "Cloudflare Turnstile 未通过，需人工验证或更可信浏览器环境" : "出现验证措施，未自动通过")))
            : (already ? (stats.signText || "签到入口已处理/已签到") : (slideSolved ? "已通过滑块认证，等待站点确认签到状态" : "已点击签到入口，未发现明确成功提示"));
        }
      } else {
        clickDetail = stats.signText || "页面显示已签到";
      }
      steps.push({ label: clicked ? "执行签到" : "检查签到状态", ok: !blocked && (already || !clicked), detail: clickDetail });

      const implicitNoEntryOk = !clicked && !blocked && loggedIn && ["pt-btschool-club"].includes(siteKey) && (!!stats.bonus || !!stats.username);
      if (siteKey === "ourbits-club" && clicked && !already && hasOurBitsTurnstile(text)) {
        blocked = true;
        stats = { ...stats, signText: "", bonusGain: "", rewardName: "" };
        steps.push({ label: "确认 OurBits 签到结果", ok: false, detail: "签到页仍显示 Turnstile/验证加载说明，未确认签到成功" });
      }
      const gainConfirmsSign = siteKey !== "open-cd" && siteKey !== "ourbits-club" && !!stats.bonusGain;
      const signConfirmed = implicitNoEntryOk || already || gainConfirmsSign || (siteKey !== "ourbits-club" && /已[签簽]到|[签簽]到成功|本次[签簽]到获得|[签簽]到已得|[签簽]到获得\s*[0-9,.]+\s*个/.test(stats.signText || ""));
      const ok = status >= 200 && status < 400 && loggedIn && signConfirmed && !blocked;
      const messageParts = [];
      if (blocked) messageParts.push(steps.some(s => /Cloudflare Turnstile/.test(s.label + " " + (s.detail || ""))) ? "签到遇到 Cloudflare Turnstile 验证，需人工验证或更可信浏览器环境" : (steps.some(s => /图片验证码|OpenCD/.test(s.label + " " + (s.detail || ""))) ? "签到遇到图片验证码，OCR 未通过" : "签到遇到验证措施"));
      else if (!loggedIn) messageParts.push("访问失败或登录态异常");
      else if (!signConfirmed) messageParts.push("未确认签到成功");
      if (signConfirmed && stats.signText) messageParts.push(stats.signText.replace(/,/g, "，"));
      else if (stats.bonusGain) messageParts.push(`签到获得 ${stats.bonusGain}${stats.rewardName ? ` 个${stats.rewardName}` : ""}`);
      else if (!blocked && signConfirmed) messageParts.push("今日签到状态已确认");
      if (stats.bonus) messageParts.push(`魔力值 ${stats.bonus}`);
      if (stats.ratio) messageParts.push(`分享率 ${stats.ratio}`);
      messageParts.push(`检查时间：${signTime}`);

      steps.push({ label: "读取 PT 账号信息", ok: !!stats.username || !!stats.bonusGain, detail: [`用户 ${stats.username || "-"}`, stats.bonus ? `魔力 ${stats.bonus}` : "", stats.ratio ? `分享率 ${stats.ratio}` : "", stats.bonusGain ? `本次获得 ${stats.bonusGain}${stats.rewardName ? ` 个${stats.rewardName}` : ""}` : ""].filter(Boolean).join("；") });

      return {
        success: ok,
        message: messageParts.join("；"),
        details: { ...stats, signTime, pageTitle: title, status, clickedSignIn: clicked, alreadySigned: already, verificationBlocked: blocked, verificationType: isTwoFactorPage(text, page.url()) ? "2fa" : undefined, twoFactorRequired: isTwoFactorPage(text, page.url()) || undefined, checkinAction: openCdCaptchaSolved ? "captcha_solved" : undefined },
        steps,
      };
    } finally {
      await browser.close().catch(() => {});
    }
  }
}
