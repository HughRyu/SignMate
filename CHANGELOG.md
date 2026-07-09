# Changelog

所有重要变更都会记录在这里。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本遵循语义化版本的 patch 递增节奏。

## [0.1.23] - 2026-07-09

### 修复

- 修复 Node.js 24 内置 fetch 与项目依赖 `undici` 的 `ProxyAgent` 混用导致代理请求报 `UND_ERR_INVALID_ARG` 的问题。
- 修复 Telegram/Bark 通知在代理模式下可能因 fetch/dispatcher 版本不兼容发送失败的问题。
- 修复批量任务已完成但通知发送失败后，主页进度卡缺少“知道了”清理入口而长期残留的问题。

### 优化

- 代理 HTTP 请求统一使用同一 `undici` 实例的 `fetch` 与 `ProxyAgent`，避免 Node 运行时内置 Undici 版本变化引发兼容问题。
- 新增安全的批量完成态清理接口，仅允许清理已完成、已终止或通知失败的非运行中状态。

## [0.1.22] - 2026-07-08

### 修复

- 修复代理链接更新后仍沿用旧健康检查失败缓存，导致手动签到继续报“没有健康可用的代理”的问题。
- 修复全部签到/保活批量任务在外层异常或通知失败状态下可能残留主页进度的问题。

### 优化

- 代理可用性判断现在会确认健康缓存是否对应当前代理地址，避免旧代理失败状态误伤新配置。
- 批量任务状态收尾增加外层保护，确保异常时释放 active 状态并向前端展示明确中断信息。

## [0.1.21] - 2026-07-06

### 新增

- 自动批量执行失败后会立即按失败站点列表补跑一次，避免重新执行已经成功的站点。
- 新增每天 23:00 失败站点补跑，只补跑当天失败且当天没有后续成功记录的自动站点。

### 优化

- 全部签到/保活执行前会读取当天历史，自动跳过当天已经成功的同类站点。
- 失败补跑和当天成功跳过支持按 `key`、`driver`、`note`、`name`、`siteKey`、`site` 多种名称匹配历史记录。
- V2EX 成功识别增加 `has been redeemed`、`reward redeemed`、`每日登录奖励已发放` 等状态，并支持通过铜币余额变化确认领取成功。

### 修复

- 收紧 PCBeta 领奖成功判定，需由领奖响应或已完成任务页确认，避免泛匹配“奖励/完成”造成误报。
- 修复 driver 未注册和站点离线这类早退失败缺少 `siteKey`，导致失败补跑无法定位站点的问题。
- 修正批量状态进度统计，把当天已成功跳过的站点纳入 `done` 和 `completedKeys`。

## [0.1.20] - 2026-07-02

### 新增

- 新增 PCBeta 签到驱动，支持远景论坛每日任务申请、回帖打卡、奖励领取与已完成状态识别。
- PCBeta 支持读取累计积分、累计 PB币、本次每日打卡 PB币和回帖打卡 PB币，并在面板累计栏与详情中展示。

### 优化

- PCBeta 内置站点显示名简化为 `PCBeta`。
- PCBeta 执行摘要按每日打卡与回帖打卡分别展示获得的 PB币。

### 修复

- 修复登录页未登录状态下 Logo 静态资源被鉴权重定向导致无法正确显示的问题。

## [0.1.19] - 2026-06-09

### 修复

- 登录页改用 SignMate 项目 Logo，不再显示默认蓝底对勾。
- 更新主面板 favicon、导航栏 Logo 与前端兜底 Logo 的缓存版本，确保浏览器加载当前 Logo。
- README 顶部增加 SignMate Logo 展示。

## [0.1.18] - 2026-06-09

### 修复

- 更新前端静态资源缓存版本，确保管理面板加载最新 `app.js` 与 `style.css`。
- 延续 `v0.1.17` 的可访问性增强与运行时版本显示修复。

## [0.1.17] - 2026-06-09

### 修复

- 增强管理面板弹窗可访问性：新增焦点初始化、Tab 焦点循环、Esc 关闭和关闭后焦点恢复。
- 增加全局 `focus-visible` 兜底，避免历史样式覆盖导致键盘焦点不可见。
- 增加 `prefers-reduced-motion` 支持，降低动效对敏感用户的影响。
- 统一运行时版本展示，启动日志和 `/api/info` 现在读取 `package.json` 版本。

## [0.1.16] - 2026-06-07

### 优化

- 精简定时任务通知内容，避免自动签到/保活通知直接发送完整原始结果。
- 新增 `compactResultForNotify()`，统一提取站点名称、状态和关键指标。
- M-Team API Token 保活通知增加专门摘要，突出 API 令牌有效性、用户和魔力值。
- 通知详情去重，过滤重复的“签到成功 / 保活成功 / 保活完成”等片段。

### 发布

- 将 `main` 中通知精简优化正式提升为 `v0.1.16`。

## [0.1.15] - 2026-06-02

### 新增

- 新增 M-Team 保活驱动，支持使用 API Token 做账号保活和信息读取。
- 内置站点目录增加 M-Team 配置。
- `config/secrets.yaml.example` 增加 M-Team API Token 配置示例。

### 优化

- 完善 M-Team 生产可用性支持。
- 前端凭据状态区分 Cookie / Token 场景，Token 类型使用更清晰的背景和状态展示。
- README 更新 M-Team 相关说明。

### 修复

- 修复导航栏标题和布局回退问题。

## [0.1.14] - 2026-06-01

### 修复

- 调整 V2EX 相关执行逻辑和 HTTP 工具行为。
- 改进服务端配置处理和前端交互细节。
- 修复若干 `v0.1.13` 后的小稳定性问题。

## [0.1.13] - 2026-06-01

### 新增

- 新增发布流程文档 `docs/release-process.md`。
- 新增发布检查脚本 `scripts/release-check.js`。
- 新增站点 smoke test 辅助脚本 `scripts/smoke-sites.js`。
- 增加执行方式 badges，区分 API / HTTP / 浏览器等执行路径。
- 增加 CookieCloud 快速同步入口和 skipped 同步详情展示。

### 优化

- 大幅优化桌面端和移动端 UI：导航、状态条、筛选器、按钮布局、内容边距和状态 pill。
- 优化批量执行进度、取消状态、时钟 tooltip 和错过签到预览。
- 规范 PT 站点指标展示，统一邀请数、积分、魔力、等级等字段。
- 移动端状态和搜索体验更紧凑，增加搜索清除能力。

### 修复

- 修复 Audiences 指标解析和展示。
- 恢复 OurBits 邀请数指标。
- 修复邀请数为 0 时的展示问题。
- 修复移动端状态重叠问题。
- 增强 NexusPHP 控制面板邀请数读取。

## [0.1.12] - 2026-05-31

### 新增

- 新增百度贴吧签到驱动。
- 新增一批 HTTP-first 安全签到能力和通用工具：`site-http`、`http-session`、`discuz-http`。
- 多个站点接入安全 HTTP-first 执行路径。
- Docker compose 增加浏览器相关配置支持。

### 优化

- 将 API-first 作为默认策略，优先使用更稳定、低侵入的执行方式。
- 更新 README 中的站点执行方式说明和 Docker 镜像 tag 文案。
- CookieCloud 增加不完整 Cookie 防护。

### 修复

- 修复 Tieba 指标和已签到摘要。
- 修复 52pojie 金币解析。
- 修复 NexusPHP 浏览器启动和 PterClub attendance 行为。
- 强化 V2EX redeem 验证和浏览器发现。
- OurBits 从签到改为保活，避免 Turnstile / false positive 误判。
- 防止 OurBits Turnstile 文案导致假成功。

## [0.1.11] - 2026-05-30

### 发布

- 发布 `v0.1.11`，作为 `v0.1.12` 大量站点能力增强前的稳定节点。

## [0.1.9] - 2026-05-29

### 修复

- 固定 Playwright 版本。
- 增加 Docker 镜像构建期浏览器启动检查，降低运行时浏览器不匹配风险。

## [0.1.8] - 2026-05-29

### 修复

- 修复 Feng 站点 Cookie 凭据解析。

## [0.1.7] - 2026-05-29

### 安全

- 增加检查能力。
- 明确可信 HTML 渲染边界。

## [0.1.6] - 2026-05-29

### 安全

- 强化批量调度和面板安全。

## [0.1.5] - 2026-05-29

### 修复

- 动态解析 Chromium 可执行路径，提升不同环境下的浏览器兼容性。

[0.1.23]: https://github.com/HughRyu/SignMate/compare/v0.1.22...v0.1.23
[0.1.22]: https://github.com/HughRyu/SignMate/compare/v0.1.21...v0.1.22
[0.1.21]: https://github.com/HughRyu/SignMate/compare/v0.1.20...v0.1.21
[0.1.20]: https://github.com/HughRyu/SignMate/compare/v0.1.19...v0.1.20
[0.1.19]: https://github.com/HughRyu/SignMate/compare/v0.1.18...v0.1.19
[0.1.18]: https://github.com/HughRyu/SignMate/compare/v0.1.17...v0.1.18
[0.1.17]: https://github.com/HughRyu/SignMate/compare/v0.1.16...v0.1.17
[0.1.16]: https://github.com/HughRyu/SignMate/compare/v0.1.15...v0.1.16
[0.1.15]: https://github.com/HughRyu/SignMate/compare/v0.1.14...v0.1.15
[0.1.14]: https://github.com/HughRyu/SignMate/compare/v0.1.13...v0.1.14
[0.1.13]: https://github.com/HughRyu/SignMate/compare/v0.1.12...v0.1.13
[0.1.12]: https://github.com/HughRyu/SignMate/compare/v0.1.11...v0.1.12
[0.1.11]: https://github.com/HughRyu/SignMate/releases/tag/v0.1.11
[0.1.9]: https://github.com/HughRyu/SignMate/releases/tag/v0.1.9
[0.1.8]: https://github.com/HughRyu/SignMate/releases/tag/v0.1.8
[0.1.7]: https://github.com/HughRyu/SignMate/releases/tag/v0.1.7
[0.1.6]: https://github.com/HughRyu/SignMate/releases/tag/v0.1.6
[0.1.5]: https://github.com/HughRyu/SignMate/releases/tag/v0.1.5
