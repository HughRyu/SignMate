// ============================================================
// base — 签到 Driver 基类
//
// 所有签到 driver 必须继承此类并实现 signIn() 方法。
// 返回格式: { success: boolean, message: string, raw?: any }
// ============================================================

import logger from "../utils/logger.js";
import { request, safeJson } from "../utils/http.js";

export default class BaseDriver {
  /**
   * @param {object} siteConfig  来自 config/sites.yaml 的站点配置
   * @param {object} secrets     来自 config/secrets.yaml 的凭据
   */
  constructor(siteConfig, secrets) {
    this.siteConfig = siteConfig;
    this.secrets = secrets;
    this.name = siteConfig.note || siteConfig.driver;
    this.logger = logger;
  }

  /**
   * 签到入口（子类必须实现）
   * @returns {Promise<{success: boolean, message: string, raw?: any}>}
   */
  async signIn() {
    throw new Error(`Driver "${this.constructor.name}" 未实现 signIn() 方法`);
  }

  /**
   * 带重试的签到执行
   */
  async runWithRetry() {
    const { retry = 0, retry_delay_ms = 5000, timeout = 30000 } = this.siteConfig;
    let lastError;

    for (let attempt = 0; attempt <= retry; attempt++) {
      try {
        if (attempt > 0) {
          logger.info(`[${this.name}] 第 ${attempt + 1}/${retry + 1} 次尝试...`);
        }
        const result = await this.signIn();
        return result;
      } catch (err) {
        lastError = err;
        logger.warn(`[${this.name}] 签到失败 (attempt ${attempt + 1}/${retry + 1}): ${err.message}`);

        if (attempt < retry) {
          await sleep(retry_delay_ms);
        }
      }
    }

    return { success: false, message: lastError?.message || "未知错误" };
  }

  /**
   * 格式化签到结果为通知文本（子类可覆盖）
   */
  formatResult(result) {
    const icon = result.success ? "✅" : "❌";
    return `${icon} ${this.name}: ${result.message}`;
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
