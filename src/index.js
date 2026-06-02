// ============================================================
// signmate — 签伴 SignMate
// 入口文件
// ============================================================
//
// 架构:
//   index.js          → 主入口，加载配置 → 初始化
//   scheduler.js      → Cron 定时调度
//   runner.js         → 执行引擎
//   drivers/base.js   → Driver 基类
//   drivers/*.js      → 各论坛具体实现
//   notify.js         → 通知系统
//   utils/logger.js   → 日志系统
//   utils/http.js     → HTTP 客户端
//

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import logger from "./utils/logger.js";
import { registerDriver, loadConfig, runAll, notifyInterruptedBatchOnStartup, notifyActiveBatchBeforeExit } from "./runner.js";
import { startScheduler } from "./scheduler.js";
import { notifier, TelegramChannel, BarkChannel } from "./notify.js";
import { startServer } from "./server.js";
import { getGlobalProxy, selectProxyUrl, testProxyPool } from "./utils/proxy.js";
import * as store from "./store.js";

// ---- 注册所有内置 Driver ----
import NodeSeekDriver from "./drivers/nodeseek.js";
import TemplateDriver from "./drivers/template.js";
import V2EXDriver from "./drivers/v2ex.js";
import NaixiDriver from "./drivers/naixi.js";
import RightDriver from "./drivers/right.js";
import WebsiteDriver from "./drivers/website.js";
import Pojie52Driver from "./drivers/pojie52.js";
import NodeLocDriver from "./drivers/nodeloc.js";
import PcevaDriver from "./drivers/pceva.js";
import ChiphellDriver from "./drivers/chiphell.js";
import NexusPhpDriver from "./drivers/nexusphp.js";
import QianmojuDriver from "./drivers/qianmoju.js";
import KafanDriver from "./drivers/kafan.js";
import FengDriver from "./drivers/feng.js";
import TiebaDriver from "./drivers/tieba.js";
import MTeamDriver from "./drivers/mteam.js";

registerDriver("nodeseek", NodeSeekDriver);
registerDriver("template", TemplateDriver);
registerDriver("v2ex", V2EXDriver);
registerDriver("naixi", NaixiDriver);
registerDriver("right", RightDriver);
registerDriver("website", WebsiteDriver);
registerDriver("visit", WebsiteDriver);
registerDriver("pojie52", Pojie52Driver);
registerDriver("nodeloc", NodeLocDriver);
registerDriver("pceva", PcevaDriver);
registerDriver("chiphell", ChiphellDriver);
registerDriver("nexusphp", NexusPhpDriver);
registerDriver("qianmoju", QianmojuDriver);
registerDriver("kafan", KafanDriver);
registerDriver("feng", FengDriver);
registerDriver("tieba", TiebaDriver);
registerDriver("mteam", MTeamDriver);

function loadNotifyConfig() {
  const path = join(import.meta.dirname, "..", "config", "notify.yaml");
  if (!existsSync(path)) return {};
  try {
    return parse(readFileSync(path, "utf-8")) || {};
  } catch (err) {
    logger.warn(`[通知] 读取 notify.yaml 失败: ${err.message}`);
    return {};
  }
}

// ---- 初始化通知通道 ----
function initNotifier() {
  const notifyConfig = loadNotifyConfig();
  const botToken = process.env.TELEGRAM_BOT_TOKEN || notifyConfig.telegram?.bot_token;
  const chatId = process.env.TELEGRAM_CHAT_ID || notifyConfig.telegram?.chat_id;

  const tgConf = notifyConfig.telegram || {};
  let proxyUrl = "";
  if (tgConf.proxy !== false) {
    try {
      const sitesPath = join(import.meta.dirname, "..", "config", "sites.yaml");
      if (existsSync(sitesPath)) {
        const sitesRaw = parse(readFileSync(sitesPath, "utf-8")) || {};
        const proxy = getGlobalProxy(sitesRaw);
        // Telegram 是外部通知通道；“全局代理启用”只控制站点 auto 代理判断，不应禁止通知通道使用已配置代理。
        proxyUrl = selectProxyUrl(proxy);
      }
    } catch { /* 代理读取失败不影响启动 */ }
  }

  if (botToken && chatId) {
    try {
      const tg = new TelegramChannel(botToken, chatId, proxyUrl, [tgConf.signin !== false ? "signin" : "", tgConf.cookie !== false ? "cookie" : "", tgConf.proxy !== false ? "proxy" : ""].filter(Boolean));
      notifier.addChannel(tg);
      logger.info(`[通知] Telegram 通知已启用${proxyUrl ? " (走 SignMate 代理)" : ""}`);
    } catch (err) {
      logger.warn(`[通知] Telegram 初始化失败: ${err.message}`);
    }
  }
  const bark = notifyConfig.bark || {};
  if (bark.enabled === true && bark.url) {
    try { notifier.addChannel(new BarkChannel(bark.url, [bark.signin !== false ? "signin" : "", bark.cookie !== false ? "cookie" : "", bark.proxy !== false ? "proxy" : ""].filter(Boolean))); logger.info("[通知] Bark 通知已启用"); }
    catch (err) { logger.warn(`[通知] Bark 初始化失败: ${err.message}`); }
  }
  if (!(botToken && chatId) && !(bark.enabled === true && bark.url)) logger.info("[通知] 未配置外部通知，仅 Console 通知");
}

// ---- 启动 ----
async function main() {
  logger.info("");
  logger.info("=".repeat(50));
  logger.info("  signmate — 签伴 SignMate v1.0.0");
  logger.info("=".repeat(50));
  logger.info("");

  // 初始化通知
  initNotifier();

  // 检查上次是否有被部署/重启打断的批量任务
  await notifyInterruptedBatchOnStartup();

  // 加载配置
  const { sites, secrets } = loadConfig();
  const enabledSites = sites.filter(s => s.enabled !== false);

  logger.info(`[配置] 共 ${sites.length} 个站点，已启用 ${enabledSites.length} 个`);

  // 注册定时任务
  const taskCount = startScheduler(enabledSites, secrets);

  // 启动 Web 管理面板
  const server = await startServer();

  // 启动时默认不立刻执行签到，避免全新部署尚未维护 Cookie 时自动跑全站。
  // 只有显式设置 RUN_ON_START=true 才执行。
  if (String(process.env.RUN_ON_START || "").toLowerCase() === "true") {
    logger.info("[启动] RUN_ON_START=true，立即执行首次签到...");
    try {
      const results = await runAll();
      for (const r of results) await store.addEntry(r.site, r);
    } catch (err) {
      logger.error(`[启动] 首次签到异常: ${err.message}`);
    }
  }

  setInterval(async () => {
    try {
      const sitesPath = join(import.meta.dirname, "..", "config", "sites.yaml");
      if (!existsSync(sitesPath)) return;
      const sitesRaw = parse(readFileSync(sitesPath, "utf-8")) || {};
      const proxy = getGlobalProxy(sitesRaw);
      if (!proxy.enabled || !proxy.urls.length) return;
      const health = await testProxyPool(proxy.urls, proxy.testUrls, 10000);
      const before = sitesRaw.proxy?.health;
      sitesRaw.proxy = { ...(sitesRaw.proxy || {}), health };
      const { writeFileSync } = await import("node:fs");
      const { stringify } = await import("yaml");
      writeFileSync(sitesPath, stringify(sitesRaw), "utf-8");
      if (before?.ok !== false && health.ok === false) await notifier.send("SignMate 代理失效", health.proxies.map(p => `${p.url}: ${p.tests.map(t => t.error || t.status || "失败").join("；")}`), "proxy");
    } catch (err) { logger.warn(`[代理健康检查] ${err.message}`); }
  }, 3 * 60 * 60 * 1000);

  logger.info("[启动] 调度器运行中，等待定时触发...");
}

main().catch(err => {
  logger.error(`[致命错误] ${err.message}`);
  console.error(err);
  process.exit(1);
});

// ---- 优雅退出 ----
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`[退出] 收到 ${signal}，正在退出...`);
  await Promise.race([
    notifyActiveBatchBeforeExit(signal),
    new Promise(resolve => setTimeout(resolve, 3500)),
  ]).catch(err => logger.warn(`[退出] 批量中断通知失败: ${err.message}`));
  process.exit(0);
}
process.on("SIGTERM", () => { void shutdown("SIGTERM"); });
process.on("SIGINT", () => { void shutdown("SIGINT"); });
