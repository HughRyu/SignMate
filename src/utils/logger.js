// ============================================================
// logger — 结构化日志
// 支持 console 输出 + 文件日志，可设置不同级别
// ============================================================

import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { format, inspect } from "node:util";

const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const LOG_COLORS = {
  debug: "\x1b[90m",    // gray
  info:  "\x1b[36m",    // cyan
  warn:  "\x1b[33m",    // yellow
  error: "\x1b[31m",    // red
};
const RESET = "\x1b[0m";

const LOG_DIR = process.env.LOG_DIR || join(import.meta.dirname, "..", "..", "logs");
const MAX_LOG_FILES = 7; // 保留最近 7 天

class Logger {
  #minLevel;
  #logDir;

  constructor(level = "info", logDir = LOG_DIR) {
    this.#minLevel = LOG_LEVELS[level] ?? LOG_LEVELS.info;
    this.#logDir = logDir;
  }

  /** 格式化时间戳 */
  #timestamp() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
           `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  /** 格式化参数为字符串 */
  #formatArgs(args) {
    if (args.length === 0) return "";
    if (args.length === 1) {
      const a = args[0];
      return typeof a === "string" ? a : inspect(a, { depth: 4, colors: false });
    }
    // 第一个参数是格式化字符串（类似 console.log style）
    if (typeof args[0] === "string" && args[0].includes("%")) {
      return format(...args);
    }
    return args.map(a => (typeof a === "string" ? a : inspect(a, { depth: 3, colors: false }))).join(" ");
  }

  #write(level, args) {
    const lvl = LOG_LEVELS[level];
    if (lvl == null || lvl < this.#minLevel) return;

    const ts = this.#timestamp();
    const msg = this.#formatArgs(args);
    const color = LOG_COLORS[level] ?? "";

    // Console 输出（带颜色）
    console.log(`${color}[${ts}] [${level.toUpperCase()}]${RESET} ${msg}`);

    // 文件日志（无颜色，追加模式）
    const dateStr = new Date().toISOString().slice(0, 10);
    const line = `[${ts}] [${level.toUpperCase()}] ${msg}\n`;
    appendFile(join(this.#logDir, `signmate-${dateStr}.log`), line).catch(() => {});
  }

  debug(...args) { this.#write("debug", args); }
  info(...args)  { this.#write("info", args); }
  warn(...args)  { this.#write("warn", args); }
  error(...args) { this.#write("error", args); }

  /** 运行时修改日志级别 */
  setLevel(level) {
    if (LOG_LEVELS[level] != null) {
      this.#minLevel = LOG_LEVELS[level];
    }
  }
}

// 创建全局单例
export const logger = new Logger(process.env.LOG_LEVEL || "info", process.env.LOG_DIR);

export default logger;
