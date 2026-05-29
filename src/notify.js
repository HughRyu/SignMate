// ============================================================
// notify — 签到结果通知
//
// 支持:
//   - Console（默认）
//   - Telegram Bot
//   - 可扩展更多通知渠道
// ============================================================

import { ProxyAgent } from "undici";
import logger from "./utils/logger.js";

export class Notifier {
  constructor() {
    this.channels = [new ConsoleChannel()];
  }

  /** 添加通知通道 */
  addChannel(channel) {
    if (channel && typeof channel.send === "function") {
      this.channels.push(channel);
    }
  }

  /** 移除指定名称的通知通道 */
  removeChannelByName(name) {
    this.channels = this.channels.filter(channel => channel.name !== name);
  }

  /** 发送通知到所有已注册通道 */
  async send(title, messages, event = "signin") {
    const failures = [];
    let attempted = 0;
    let externalAttempted = 0;
    for (const channel of this.channels) {
      try {
        if (Array.isArray(channel.events) && !channel.events.includes(event)) continue;
        attempted += 1;
        if (channel.name !== "Console") externalAttempted += 1;
        await channel.send(title, messages, event);
      } catch (err) {
        failures.push(`${channel.name}: ${err.message}`);
        logger.error(`[通知] ${channel.name} 发送失败: ${err.message}`);
      }
    }
    const externalFailures = failures.filter(item => !item.startsWith("Console:"));
    if (externalAttempted > 0 && externalFailures.length === externalAttempted) {
      throw new Error(externalFailures.join("; "));
    }
    return { attempted, externalAttempted, failures };
  }
}

// --------------------------------------------------
// Console 通道（默认）
// --------------------------------------------------
class ConsoleChannel {
  name = "Console";

  async send(title, messages) {
    const lines = messages.map((m, i) => `  ${i + 1}. ${m}`).join("\n");
    logger.info(`[签到报告] ${title}\n${lines}`);
  }
}

function sleep(ms = 0) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function chunkTelegramText(header = "", messages = [], limit = 3900) {
  const chunks = [];
  let current = header;
  const reset = () => { current = header; };
  const push = () => { if (current.trim() && current !== header) chunks.push(current); reset(); };
  for (const raw of messages) {
    const message = String(raw || "");
    const sep = current === header ? "" : "\n\n";
    if ((current + sep + message).length <= limit) {
      current += sep + message;
      continue;
    }
    push();
    if ((header + message).length <= limit) {
      current += message;
      continue;
    }
    const room = Math.max(500, limit - header.length - 20);
    let rest = message;
    while ((header + rest).length > limit) {
      chunks.push(header + rest.slice(0, room) + "…");
      rest = "…" + rest.slice(room);
    }
    current = header + rest;
  }
  push();
  return chunks.length ? chunks : [header.trim()];
}

// --------------------------------------------------
// Telegram Bot 通道
// --------------------------------------------------
export class TelegramChannel {
  name = "Telegram";
  events;
  #botToken;
  #chatId;
  #proxyUrl;

  /**
   * @param {string} botToken  Bot Token（@BotFather 获取）
   * @param {string} chatId    接收通知的 Chat ID
   * @param {string} [proxyUrl] SignMate 代理地址
   */
  constructor(botToken, chatId, proxyUrl = "", events = ["signin", "cookie", "proxy"]) {
    if (!botToken || !chatId) {
      throw new Error("TelegramChannel: 需要 botToken 和 chatId");
    }
    this.#botToken = botToken;
    this.#chatId = chatId;
    this.#proxyUrl = proxyUrl;
    this.events = events;
  }

  async send(title, messages) {
    const dateStr = new Date().toLocaleString("zh-CN", {
      timeZone: process.env.TZ || "Asia/Shanghai",
      hour12: false,
    });

    const header = [`<b>📋 ${title}</b>`, `<code>${dateStr}</code>`, ""].join("\n");
    const safeMessages = messages.map(m => String(m || "").replace(/</g, "&lt;").replace(/>/g, "&gt;"));
    const chunks = chunkTelegramText(header, safeMessages);
    const url = `https://api.telegram.org/bot${this.#botToken}/sendMessage`;

    for (let i = 0; i < chunks.length; i++) {
      const text = chunks.length > 1
        ? chunks[i].replace(`<b>📋 ${title}</b>`, `<b>📋 ${title} (${i + 1}/${chunks.length})</b>`)
        : chunks[i];
      const payload = {
        chat_id: this.#chatId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      };
      const attempts = this.#proxyUrl
        ? [
          { label: `proxy ${this.#proxyUrl}`, dispatcher: new ProxyAgent(this.#proxyUrl) },
          { label: `proxy retry ${this.#proxyUrl}`, dispatcher: new ProxyAgent(this.#proxyUrl) },
          { label: "direct", dispatcher: null },
        ]
        : [
          { label: "direct", dispatcher: null },
          { label: "direct retry", dispatcher: null },
        ];
      let sent = false;
      let lastError = "";
      for (let attemptIndex = 0; attemptIndex < attempts.length; attemptIndex++) {
        const attempt = attempts[attemptIndex];
        try {
          const fetchOptions = {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(25_000),
          };
          if (attempt.dispatcher) fetchOptions.dispatcher = attempt.dispatcher;
          const response = await fetch(url, fetchOptions);
          if (!response.ok) {
            const err = await response.text().catch(() => "unknown");
            lastError = `HTTP ${response.status} — ${err.slice(0, 200)}`;
            logger.warn(`[Telegram] 通知发送失败${chunks.length > 1 ? ` (${i + 1}/${chunks.length})` : ""}: ${lastError}`);
            // 400 通常是内容格式/长度问题，重试网络路径没有意义。
            if (response.status >= 400 && response.status < 500) break;
          } else {
            logger.info(`[Telegram] 通知发送成功${chunks.length > 1 ? ` (${i + 1}/${chunks.length})` : ""}${attempt.label ? ` via ${attempt.label}` : ""}`);
            sent = true;
            break;
          }
        } catch (err) {
          lastError = `${err.name || "Error"}: ${err.message || String(err)}${err.cause?.message ? ` (${err.cause.message})` : ""}`;
          logger.warn(`[Telegram] 通知发送异常${chunks.length > 1 ? ` (${i + 1}/${chunks.length})` : ""} via ${attempt.label}: ${lastError}`);
          if (attemptIndex < attempts.length - 1) await sleep(1200);
        }
      }
      if (!sent) throw new Error(lastError || "Telegram send failed");
    }
  }
}

// 全局单例
export const notifier = new Notifier();
export default notifier;


// --------------------------------------------------
// Bark 通道
// --------------------------------------------------
export class BarkChannel {
  name = "Bark";
  events;
  #url;

  constructor(url, events = ["signin", "cookie", "proxy"]) {
    if (!url) throw new Error("BarkChannel: 需要 Bark 地址");
    this.#url = url.replace(/\/+$/, "");
    this.events = events;
  }

  async send(title, messages) {
    const text = messages.join("\n\n");
    const endpoint = `${this.#url}/${encodeURIComponent(title)}/${encodeURIComponent(text)}?automaticallyCopy=1`;
    const response = await fetch(endpoint, { method: "GET" });
    const body = await response.text().catch(() => "");
    if (!response.ok) {
      logger.warn(`[Bark] 通知发送失败: HTTP ${response.status} — ${(body || "unknown").slice(0, 200)}`);
    } else {
      logger.info(`[Bark] 通知发送成功: ${body.slice(0, 120)}`);
    }
  }
}
