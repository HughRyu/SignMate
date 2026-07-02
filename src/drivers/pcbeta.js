// ============================================================
// pcbeta — PCBeta Discuz task-based daily check-in driver
//
// Flow reproduced from the Automa export:
// 1. Open /home.php?mod=task and apply the daily task.
// 2. Open /home.php?mod=task&item=doing and enter the task topic.
// 3. Submit a fastpost reply.
// 4. Return to the task page and draw the reward.
// ============================================================

import BaseDriver from "./base.js";
import logger from "../utils/logger.js";
import { createHttpSession, getCookieForSite, htmlToText, pageTitleFromHtml, readText } from "../utils/http-session.js";

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

function loggedIn(text = "", title = "") {
  const head = compactText(text).slice(0, 2000);
  if (/登录/.test(title) || /立即登录|用户登录|登录\s*注册|请先登录/.test(head)) return false;
  return /退出|我的|设置|消息|提醒|积分|个人中心|个人资料|快捷导航|HughRyu/.test(head);
}

function alreadyDone(text = "") {
  const normalized = compactText(text);
  return /已经领取|已领取奖励|任务已完成|今天已完成|今日已完成|今天已领取|今日已领取|明天再来|下次再来/.test(normalized);
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

function parseInputs(formHtml = "") {
  const inputs = {};
  for (const tag of String(formHtml || "").matchAll(/<input\b[^>]*>/gi)) {
    const raw = tag[0];
    const name = decodeHtml(raw.match(/name=["']([^"']+)/i)?.[1] || "");
    if (!name) continue;
    inputs[name] = decodeHtml(raw.match(/value=["']([^"']*)/i)?.[1] || "");
  }
  return inputs;
}

function linkText(rawHtml = "") {
  return compactText(htmlToText(rawHtml));
}

function findTaskActionUrl(html = "", baseUrl = "", action) {
  const links = [...String(html || "").matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)]
    .map(match => {
      const attrs = match[1] || "";
      const href = decodeHtml(attrs.match(/href=["']([^"']+)/i)?.[1] || "");
      const cls = attrs.match(/class=["']([^"']+)/i)?.[1] || "";
      return { href, cls, text: linkText(match[2] || "") };
    })
    .filter(item => item.href);

  const actionRe = action === "draw" ? /do=draw|领取|奖励/ : /do=apply|立即申请|申请/;
  const picked = links.find(item => /taskbtn/.test(item.cls) && actionRe.test(`${item.href} ${item.text}`))
    || links.find(item => /home\.php\?mod=task/i.test(item.href) && actionRe.test(`${item.href} ${item.text}`));
  return picked ? absUrl(baseUrl, picked.href) : "";
}

function findTaskTopicUrl(html = "", baseUrl = "") {
  const links = [...String(html || "").matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)]
    .map(match => {
      const attrs = match[1] || "";
      const href = decodeHtml(attrs.match(/href=["']([^"']+)/i)?.[1] || "");
      const cls = attrs.match(/class=["']([^"']+)/i)?.[1] || "";
      return { href, cls, text: linkText(match[2] || "") };
    })
    .filter(item => item.href);

  const taskLink = links.find(item => /xs2/.test(item.cls) && /home\.php\?mod=task/i.test(item.href))
    || links.find(item => /home\.php\?mod=task/i.test(item.href) && /do=view/i.test(item.href) && /回帖|打卡|签到|福利|每日/.test(item.text));
  if (taskLink) return absUrl(baseUrl, taskLink.href);

  const threadLink = links.find(item => /forum\.php\?mod=viewthread|thread-\d+/i.test(item.href) && /回帖|回复|打卡|签到|每日|主题/.test(item.text))
    || links.find(item => /forum\.php\?mod=viewthread|thread-\d+/i.test(item.href));
  return threadLink ? absUrl(baseUrl, threadLink.href) : "";
}

function findReplyTargetUrl(html = "", baseUrl = "") {
  const links = [...String(html || "").matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)]
    .map(match => {
      const attrs = match[1] || "";
      const href = decodeHtml(attrs.match(/href=["']([^"']+)/i)?.[1] || "");
      return { href, text: linkText(match[2] || "") };
    })
    .filter(item => item.href);
  const picked = links.find(item => /forum\.php\?mod=viewthread|thread-\d+/i.test(item.href) && /回复|回帖|主题|打卡|签到/.test(item.text))
    || links.find(item => /forum\.php\?mod=viewthread|thread-\d+/i.test(item.href));
  return picked ? absUrl(baseUrl, picked.href) : "";
}

function parseFastPost(html = "", threadUrl = "") {
  const form = String(html || "").match(/<form\b[^>]*(?:id=["']fastpostform["']|name=["']fastpostform["'])[^>]*>[\s\S]*?<\/form>/i)?.[0] || "";
  if (!form) return null;
  const action = decodeHtml(form.match(/action=["']([^"']+)/i)?.[1] || "");
  const inputs = parseInputs(form);
  const hash = inputs.formhash || formHash(html);
  if (hash) inputs.formhash = hash;
  inputs.message = "";
  return { action: action ? absUrl(threadUrl, action) : "", inputs };
}

function parseReward(text = "") {
  const normalized = compactText(text);
  const taskReward = normalized.match(/积分\s*(PB币)\s*(\d+)/);
  if (taskReward) return `${taskReward[2]} ${taskReward[1]}`;
  return normalized.match(/(?:奖励|获得|得到|积分)\D{0,10}(\d+)\s*(积分|金币|威望|经验|PB币)?/)?.slice(1).filter(Boolean).join(" ") || "";
}

function numberFrom(text = "", pattern) {
  const raw = compactText(text).match(pattern)?.[1];
  if (!raw) return null;
  const value = Number.parseInt(String(raw).replace(/,/g, ""), 10);
  return Number.isFinite(value) ? value : null;
}

function parseRewardPbCoins(reward = "") {
  const value = numberFrom(reward, /(\d[\d,]*)\s*PB币/i);
  return value ?? (/PB币/i.test(reward) ? numberFrom(reward, /(\d[\d,]*)/) : null);
}

function parseCreditStats(text = "") {
  const normalized = compactText(text);
  return {
    totalPoints: numberFrom(normalized, /积分\s*[:：]\s*(\d[\d,]*)/) ?? numberFrom(normalized, /统计信息[\s\S]{0,80}?积分\s+(\d[\d,]*)/),
    totalPbCoins: numberFrom(normalized, /PB币\s*[:：]\s*(\d[\d,]*)/i) ?? numberFrom(normalized, /统计信息[\s\S]{0,100}?PB币\s+(\d[\d,]*)/i),
  };
}

function mergeCreditStats(...statsList) {
  return statsList.reduce((out, stats = {}) => ({
    totalPoints: out.totalPoints ?? stats.totalPoints,
    totalPbCoins: out.totalPbCoins ?? stats.totalPbCoins,
  }), { totalPoints: null, totalPbCoins: null });
}

function parseDoneTaskRewards(text = "") {
  const normalized = compactText(text);
  return {
    dailyPbCoins: numberFrom(normalized, /每日打卡[\s\S]{0,120}?积分\s*PB币\s*(\d[\d,]*)/i),
    replyPbCoins: numberFrom(normalized, /回帖打卡[\s\S]{0,120}?积分\s*PB币\s*(\d[\d,]*)/i),
  };
}

function pbCoinText(value) {
  return Number.isFinite(value) ? `+${value} PB币` : "+PB币";
}

function taskDetails({ signTime, pageTitle, reward = "", stats = {}, taskUrl = "", threadUrl = "", threadTitle = "", dailyPbCoins = null, replyPbCoins = null, extra = {} } = {}) {
  const rewardPbCoins = parseRewardPbCoins(reward);
  const replyLabel = threadTitle || "回帖打卡";
  const replyUrl = threadUrl || taskUrl;
  return {
    signTime,
    reward,
    rewardPbCoins,
    totalPoints: stats.totalPoints,
    totalPbCoins: stats.totalPbCoins,
    dailyTask: taskUrl ? `每日打卡 获得 [${pbCoinText(dailyPbCoins)}](${taskUrl})` : `每日打卡 获得 ${pbCoinText(dailyPbCoins)}`,
    replyTask: replyUrl ? `${replyLabel} 获得 [${pbCoinText(replyPbCoins)}](${replyUrl})` : `${replyLabel} 获得 ${pbCoinText(replyPbCoins)}`,
    pageTitle,
    ...extra,
  };
}

function taskProgress(text = "") {
  const hit = compactText(text).match(/已完成\s*(\d+)\s*%/);
  const value = hit ? Number.parseInt(hit[1], 10) : NaN;
  return Number.isFinite(value) ? value : null;
}

function todayTaskDone(text = "", date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "numeric", day: "numeric" })
    .formatToParts(date)
    .reduce((out, part) => ({ ...out, [part.type]: part.value }), {});
  const month = Number.parseInt(parts.month, 10);
  const day = Number.parseInt(parts.day, 10);
  const pattern = new RegExp(`完成于\\s*${parts.year}-0?${month}-0?${day}\\b`);
  return pattern.test(compactText(text));
}

async function openText(session, url, steps, label) {
  const res = await session.get(url);
  const html = await readText(res);
  const text = htmlToText(html);
  steps.push({ label, ok: res.status >= 200 && res.status < 400, status: res.status, detail: url.length < 120 ? url : new URL(url).pathname });
  return { res, html, text, title: pageTitleFromHtml(html) };
}

export default class PCBetaDriver extends BaseDriver {
  getCookie() {
    return getCookieForSite(this.secrets, this.siteConfig);
  }

  async signIn() {
    const {
      base_url = "https://i.pcbeta.com",
      timeout = 60_000,
      proxy_url,
      reply_message = "每日论坛打卡签到 duerduerduer哒哒哒",
    } = this.siteConfig;
    const cookie = this.getCookie();
    if (!cookie) return { success: false, message: "⚠️ Cookie 未配置，请点击「维护 Cookie」填写" };

    const signTime = formatSignTime();
    const steps = [];
    const session = createHttpSession({ baseUrl: base_url, cookie, proxyUrl: proxy_url || "", timeout });
    const origin = String(base_url || "https://i.pcbeta.com").replace(/\/+$/, "");
    const taskUrl = `${origin}/home.php?mod=task`;
    const doingUrl = `${origin}/home.php?mod=task&item=doing`;
    const dailyTaskUrl = `${origin}/home.php?mod=task&do=view&id=149`;
    const creditUrl = `${origin}/home.php?mod=spacecp&ac=credit`;

    logger.info(`[PCBeta/API] 步骤 1/6：打开任务页 → ${taskUrl}`);
    const taskPage = await openText(session, taskUrl, steps, "HTTP 打开 PCBeta 任务页面");
    let taskStats = parseCreditStats(taskPage.text);
    if (!loggedIn(taskPage.text, taskPage.title)) {
      return { success: false, message: "PCBeta 登录态无效或 Cookie 不完整，请重新维护 Cookie", details: taskDetails({ signTime, pageTitle: taskPage.title, stats: taskStats, taskUrl: dailyTaskUrl }), steps };
    }

    const creditPage = await openText(session, creditUrl, steps, "HTTP 读取 PCBeta 积分信息").catch(err => {
      steps.push({ label: "HTTP 读取 PCBeta 积分信息", ok: false, detail: err.message });
      return null;
    });
    taskStats = mergeCreditStats(parseCreditStats(creditPage?.text || ""), taskStats);

    const applyUrl = findTaskActionUrl(taskPage.html, taskUrl, "apply");
    if (applyUrl) {
      logger.info("[PCBeta/API] 步骤 2/6：申请每日任务");
      const apply = await openText(session, applyUrl, steps, "HTTP 申请 PCBeta 每日任务");
      if (apply.res.status >= 400 || /请先登录|登录后|失败|错误/.test(compactText(apply.text).slice(0, 800))) {
        return { success: false, message: `申请任务失败：${compactText(apply.text).slice(0, 160)}`, details: taskDetails({ signTime, pageTitle: apply.title || taskPage.title, stats: mergeCreditStats(parseCreditStats(apply.text), taskStats), taskUrl: dailyTaskUrl }), steps };
      }
    } else if (alreadyDone(taskPage.text)) {
      const drawUrl = findTaskActionUrl(taskPage.html, taskUrl, "draw");
      if (!drawUrl) {
        steps.push({ label: "HTTP 检查任务状态", ok: true, detail: "页面显示任务已完成或已领取" });
        return { success: true, message: `今天已完成 PCBeta 签到任务；签到时间：${signTime}`, details: taskDetails({ signTime, pageTitle: taskPage.title, stats: taskStats, taskUrl: dailyTaskUrl, extra: { alreadySigned: true, clickedSignIn: false, checkinAction: "api_already_signed" } }), steps };
      }
    } else {
      logger.info("[PCBeta/API] 步骤 2/6：任务页未发现申请入口，继续检查进行中任务");
      steps.push({ label: "HTTP 查找任务申请入口", ok: true, detail: "未发现申请入口，继续检查进行中任务" });
    }

    logger.info(`[PCBeta/API] 步骤 3/6：打开进行中任务 → ${doingUrl}`);
    const doing = await openText(session, doingUrl, steps, "HTTP 打开 PCBeta 进行中任务");
    const doingStats = parseCreditStats(doing.text);
    const immediateDrawUrl = findTaskActionUrl(doing.html, doingUrl, "draw");
    if (immediateDrawUrl && taskProgress(doing.text) === 100) {
      logger.info("[PCBeta/API] 进行中任务已可领取奖励，跳过回帖步骤");
      return await this.drawReward({ session, drawUrl: immediateDrawUrl, taskUrl, steps, signTime, taskUrlForDetails: dailyTaskUrl, priorStats: mergeCreditStats(doingStats, taskStats) });
    }
    if (alreadyDone(doing.text) && !/回帖|回复|进行中|领取/.test(compactText(doing.text).slice(0, 2000))) {
      return { success: true, message: `今天已完成 PCBeta 签到任务；签到时间：${signTime}`, details: taskDetails({ signTime, pageTitle: doing.title, stats: mergeCreditStats(doingStats, taskStats), taskUrl: dailyTaskUrl, extra: { alreadySigned: true, clickedSignIn: false, checkinAction: "api_already_signed" } }), steps };
    }

    const taskDetailUrl = findTaskTopicUrl(doing.html, doingUrl);
    if (!taskDetailUrl) {
      const drawUrl = findTaskActionUrl(`${taskPage.html}\n${doing.html}`, doingUrl, "draw");
      if (drawUrl) return await this.drawReward({ session, drawUrl, taskUrl, steps, signTime, taskUrlForDetails: dailyTaskUrl, priorStats: mergeCreditStats(doingStats, taskStats) });
      if (/暂无进行中的任务|没有进行中的任务/.test(doing.text)) {
        const doneUrl = `${origin}/home.php?mod=task&item=done`;
        const done = await openText(session, doneUrl, steps, "HTTP 检查 PCBeta 已完成任务");
        if (todayTaskDone(done.text)) {
          const reward = parseReward(done.text);
          const stats = mergeCreditStats(parseCreditStats(done.text), doingStats, taskStats);
          const taskRewards = parseDoneTaskRewards(done.text);
          return {
            success: true,
            message: `今天已完成 PCBeta 签到任务${reward ? `，奖励 ${reward}` : ""}；签到时间：${signTime}`,
            details: taskDetails({ signTime, pageTitle: done.title || doing.title, reward, stats, taskUrl: dailyTaskUrl, dailyPbCoins: taskRewards.dailyPbCoins, replyPbCoins: taskRewards.replyPbCoins, extra: { alreadySigned: true, clickedSignIn: false, checkinAction: "api_already_signed" } }),
            steps,
          };
        }
      }
      return { success: false, message: `未找到 PCBeta 回帖任务入口：${compactText(doing.text).slice(0, 160)}`, details: taskDetails({ signTime, pageTitle: doing.title, stats: mergeCreditStats(doingStats, taskStats), taskUrl: dailyTaskUrl }), steps };
    }

    logger.info("[PCBeta/API] 步骤 4/6：进入任务详情/主题页");
    const taskDetail = await openText(session, taskDetailUrl, steps, "HTTP 打开 PCBeta 任务详情");
    const threadUrl = /forum\.php\?mod=viewthread|thread-\d+/i.test(taskDetailUrl) ? taskDetailUrl : findReplyTargetUrl(taskDetail.html, taskDetailUrl);
    if (!threadUrl) return { success: false, message: `未找到 PCBeta 回复主题入口：${compactText(taskDetail.text).slice(0, 160)}`, details: taskDetails({ signTime, pageTitle: taskDetail.title, stats: mergeCreditStats(parseCreditStats(taskDetail.text), doingStats, taskStats), taskUrl: dailyTaskUrl }), steps };

    const thread = /forum\.php\?mod=viewthread|thread-\d+/i.test(taskDetailUrl) ? taskDetail : await openText(session, threadUrl, steps, "HTTP 打开 PCBeta 回复主题");
    const threadTitle = thread.title && !/PCBeta/i.test(thread.title) ? thread.title : "回帖打卡";
    const fastPost = parseFastPost(thread.html, threadUrl);
    if (!fastPost?.action || !fastPost.inputs.formhash) {
      return { success: false, message: "未找到 PCBeta 快速回复表单或 formhash", details: taskDetails({ signTime, pageTitle: thread.title, stats: mergeCreditStats(parseCreditStats(thread.text), parseCreditStats(taskDetail.text), doingStats, taskStats), taskUrl: dailyTaskUrl, threadUrl, threadTitle }), steps };
    }

    logger.info("[PCBeta/API] 步骤 5/6：提交回帖打卡");
    const payload = { ...fastPost.inputs, message: reply_message, usesig: fastPost.inputs.usesig || "1" };
    const reply = await session.postForm(fastPost.action, payload, { referer: threadUrl });
    const replyText = htmlToText(await readText(reply));
    const replyOk = reply.status >= 200 && reply.status < 400 && !/未定义操作|请先登录|登录后|失败|错误|验证码|审核/.test(compactText(replyText).slice(0, 1000));
    steps.push({ label: "HTTP 提交 PCBeta 回帖", ok: replyOk, status: reply.status, detail: compactText(replyText).slice(0, 160) || "已提交" });
    if (!replyOk) return { success: false, message: `回帖失败：${compactText(replyText).slice(0, 160) || `HTTP ${reply.status}`}`, details: taskDetails({ signTime, pageTitle: thread.title, stats: mergeCreditStats(parseCreditStats(thread.text), parseCreditStats(taskDetail.text), doingStats, taskStats), taskUrl: dailyTaskUrl, threadUrl, threadTitle }), steps };

    logger.info("[PCBeta/API] 步骤 6/6：领取任务奖励");
    const verifyDoing = await openText(session, doingUrl, steps, "HTTP 复查 PCBeta 进行中任务");
    if (/暂无进行中的任务|没有进行中的任务/.test(verifyDoing.text)) {
      const completed = await openText(session, taskDetailUrl, steps, "HTTP 复查 PCBeta 任务完成状态");
      if (/完成于|已完成|已经完成|再次申请/.test(compactText(completed.text))) {
        const reward = parseReward(completed.text);
        const stats = mergeCreditStats(parseCreditStats(completed.text), parseCreditStats(verifyDoing.text), parseCreditStats(thread.text), parseCreditStats(taskDetail.text), doingStats, taskStats);
        const taskRewards = parseDoneTaskRewards(completed.text);
        return {
          success: true,
          message: `签到成功${reward ? `，奖励 ${reward}` : ""}；签到时间：${signTime}`,
          details: taskDetails({ signTime, pageTitle: completed.title || verifyDoing.title, reward, stats, taskUrl: dailyTaskUrl, threadUrl, threadTitle, dailyPbCoins: taskRewards.dailyPbCoins, replyPbCoins: taskRewards.replyPbCoins, extra: { alreadySigned: false, clickedSignIn: true, submitted: true, checkinAction: "api_signed" } }),
          steps,
        };
      }
    }
    const drawUrl = findTaskActionUrl(verifyDoing.html, doingUrl, "draw");
    if (!drawUrl) {
      const verify = await openText(session, taskUrl, steps, "HTTP 复查 PCBeta 任务页面");
      const fallbackDrawUrl = findTaskActionUrl(`${verify.html}\n${verifyDoing.html}`, taskUrl, "draw");
      if (!fallbackDrawUrl && alreadyDone(`${verify.text} ${verifyDoing.text}`)) {
        return { success: true, message: `签到成功；任务已完成；签到时间：${signTime}`, details: taskDetails({ signTime, pageTitle: verify.title || verifyDoing.title, stats: mergeCreditStats(parseCreditStats(verify.text), parseCreditStats(verifyDoing.text), parseCreditStats(thread.text), parseCreditStats(taskDetail.text), doingStats, taskStats), taskUrl: dailyTaskUrl, threadUrl, threadTitle, extra: { alreadySigned: true, clickedSignIn: true, submitted: true, checkinAction: "api_signed" } }), steps };
      }
      if (!fallbackDrawUrl) return { success: false, message: `回帖已提交，但未找到 PCBeta 领奖入口：${compactText(verifyDoing.text).slice(0, 160)}`, details: taskDetails({ signTime, pageTitle: verify.title || verifyDoing.title, stats: mergeCreditStats(parseCreditStats(verify.text), parseCreditStats(verifyDoing.text), parseCreditStats(thread.text), parseCreditStats(taskDetail.text), doingStats, taskStats), taskUrl: dailyTaskUrl, threadUrl, threadTitle }), steps };
      return await this.drawReward({ session, drawUrl: fallbackDrawUrl, taskUrl, steps, signTime, replySubmitted: true, taskUrlForDetails: dailyTaskUrl, threadUrl, threadTitle, priorStats: mergeCreditStats(parseCreditStats(verify.text), parseCreditStats(verifyDoing.text), parseCreditStats(thread.text), parseCreditStats(taskDetail.text), doingStats, taskStats) });
    }
    return await this.drawReward({ session, drawUrl, taskUrl, steps, signTime, replySubmitted: true, taskUrlForDetails: dailyTaskUrl, threadUrl, threadTitle, priorStats: mergeCreditStats(parseCreditStats(verifyDoing.text), parseCreditStats(thread.text), parseCreditStats(taskDetail.text), doingStats, taskStats) });
  }

  async drawReward({ session, drawUrl, taskUrl, steps, signTime, replySubmitted = false, taskUrlForDetails = "", threadUrl = "", threadTitle = "", priorStats = {} }) {
    const draw = await openText(session, drawUrl, steps, "HTTP 领取 PCBeta 任务奖励");
    const finalPage = await openText(session, taskUrl, steps, "HTTP 复查 PCBeta 奖励状态").catch(() => null);
    const combined = `${draw.text} ${finalPage?.text || ""}`;
    const reward = parseReward(combined);
    const stats = mergeCreditStats(parseCreditStats(combined), priorStats);
    const taskRewards = parseDoneTaskRewards(combined);
    const ok = draw.res.status < 400 && (/领取|奖励|获得|完成|已完成|已领取|今天已|今日已/.test(combined)) && !/请先登录|登录后|失败|错误/.test(compactText(combined).slice(0, 1000));
    const prefix = replySubmitted ? "签到成功" : "今天已完成 PCBeta 签到任务";
    return {
      success: ok,
      message: ok ? `${prefix}${reward ? `，奖励 ${reward}` : ""}；签到时间：${signTime}` : `领取奖励失败：${compactText(combined).slice(0, 180)}`,
      details: taskDetails({ signTime, pageTitle: finalPage?.title || draw.title, reward, stats, taskUrl: taskUrlForDetails || taskUrl, threadUrl, threadTitle, dailyPbCoins: taskRewards.dailyPbCoins, replyPbCoins: taskRewards.replyPbCoins, extra: { alreadySigned: !replySubmitted, clickedSignIn: replySubmitted, submitted: replySubmitted, checkinAction: replySubmitted ? "api_signed" : "api_already_signed" } }),
      steps,
    };
  }

  formatResult(result) {
    const icon = result.success ? "✅" : "❌";
    return `${icon} ${this.name}\n📝 ${result.message}`;
  }
}
