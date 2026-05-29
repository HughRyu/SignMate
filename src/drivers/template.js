// ============================================================
// template — 新论坛签到 Driver 模板
//
// 添加新论坛步骤:
//   1. 复制此文件为 <forum_name>.js
//   2. 修改 class 名称和 extends BaseDriver
//   3. 实现 signIn() 方法
//   4. 在 config/sites.yaml 中添加站点配置
//   5. 在 config/secrets.yaml 中添加凭据
// ============================================================
//
// 支持的签到模式（参考实现）:
//   - API POST + Cookie:            见 nodeseek.js
//   - API POST + Bearer Token:      见下方注释
//   - 表单提交（需解析 HTML）:      见下方注释
//   - 无头浏览器交互:               见下方注释
//

import BaseDriver from "./base.js";
import { postJSON, get, safeJson } from "../utils/http.js";
import logger from "../utils/logger.js";

export default class TemplateDriver extends BaseDriver {
  async signIn() {
    const { base_url, timeout } = this.siteConfig;
    const secrets = this.secrets?.example_forum || {};

    // --- 模式 A: API POST + Cookie ---
    // 参考 nodeseek.js 完整实现

    // --- 模式 B: API POST + Bearer Token ---
    /*
    const response = await postJSON(`${base_url}/api/checkin`, {
      body: {},
      headers: {
        "Authorization": `Bearer ${secrets.token}`,
      },
      timeout,
    });
    const data = await safeJson(response);

    if (response.ok && data?.status === 1) {
      return { success: true, message: data.msg || "签到成功", raw: data };
    }
    return { success: false, message: data?.msg || `HTTP ${response.status}`, raw: data };
    */

    // --- 模式 C: GET 请求签到 ---
    /*
    const response = await get(`${base_url}/plugin.php?id=checkin`, {
      headers: { "Cookie": secrets.cookie },
      timeout,
    });
    const text = await response.text();

    if (text.includes("签到成功") || text.includes("已签到")) {
      return { success: true, message: "签到成功" };
    }
    return { success: false, message: `HTTP ${response.status}` };
    */

    // --- 模式 D: 表单 POST（需 <form> 解析）---
    // 可用 cheerio 解析页面获取 form action / token
    /*
    import * as cheerio from "cheerio";
    const page = await get(`${base_url}/signin.php`, {
      headers: { "Cookie": secrets.cookie },
    });
    const $ = cheerio.load(await page.text());
    const formHash = $("input[name=formhash]").val();
    const response = await postForm(`${base_url}/signin.php?action=checkin`, {
      body: { formhash: formHash },
      headers: { "Cookie": secrets.cookie },
    });
    */

    // 默认占位（新 driver 需实现）
    throw new Error("TemplateDriver 需要实现 signIn() 方法");
  }
}

// ============================================================
// 独立测试入口
// ============================================================
if (process.argv[1] === import.meta.filename) {
  logger.info("TemplateDriver — 请复制此文件并实现 signIn() 方法");
}
