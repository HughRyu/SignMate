# 生产运维与回滚

## 发布门禁

`npm test` 只运行离线测试，不读取生产凭据，不访问真实站点。`npm run release:check` 检查语法、生产依赖审计、Git 空白错误和禁止提交的运行文件。浏览器启动测试使用 `npm run check:browser`，需要安装对应 Playwright Chromium（正式镜像已包含）。真实站点测试使用显式 `smoke:sites` / `smoke:nodeseek`，不会作为 CI 默认步骤。

Docker 发布依赖 Quality Gate，通过后才构建 amd64/arm64 镜像、SBOM 和 provenance。标签版本必须与 package.json 一致且提交属于 main；验证双架构 manifest 后才更新 latest。生产只使用已验证 digest。

## 部署

在生产 Compose 目录执行发布源码中的脚本：

```bash
bash /path/to/release/scripts/deploy-production.sh ghcr.io/hughryu/signmate@sha256:<镜像摘要>
```

脚本拉取固定镜像，验证标签中的版本/完整提交，确认任务空闲，停止旧容器，备份 config/data/.env/Compose 和原目录源码，验证归档，写入 `docker-compose.release.yml` 后以 `--no-build` 启动。备份默认在 `/opt/backups/signmate/<UTC时间>`，权限 0700/0600，包含运行数据 SHA256、前后镜像和运行清单。`SIGNMATE_BACKUP_DIR` 可指定生产目录之外的位置。

如果启动、health 或镜像来源核验失败，自动恢复上一个 Compose 镜像；新镜像产生的数据保留。旧源码不覆盖、不 reset。后续人工启动必须带上 release override：

```bash
docker compose -f docker-compose.yml -f docker-compose.host-network.yml -f docker-compose.release.yml up -d --no-build
```

非 host-network 部署省略对应文件。不要在生产目录执行不带 override 的 `up --build`。

## 回滚与数据恢复

```bash
bash /path/to/release/scripts/rollback-production.sh ghcr.io/hughryu/signmate@sha256:<旧镜像摘要>
```

回滚执行相同的空闲检查、备份、健康核验流程；目标版本需提供 `/api/health` 和 `scripts/production-manifest.js`（本轮运维改造前的旧镜像须按其原始恢复方式处理）。只接受镜像摘要，不接受浮动标签。回滚不自动覆盖 Cookie 或历史；需要数据恢复时先停容器，再校验 `runtime.sha256` 并将归档恢复到隔离目录检查后替换。不要直接覆盖仍在运行的数据目录。

## 可观察性

- `/api/health` 公开返回版本、提交、配置/磁盘/浏览器状态与活动数量，不返回站点或凭据。浏览器实际启动结果缓存 5 分钟（失败 30 秒）。磁盘剩余低于 50 MiB 判为未就绪。正常任务或超过 30 分钟的任务不会使 Docker health 失败；面板会显示任务超时警告。
- 每次站点执行记录运行 ID、manual/schedule/manual-batch 来源、开始/结束/耗时/重试数。面板显示连续失败（3 次起）和最近通知发送失败；历史详情保留元数据，API 另有最近成功/失败时间。
- `data/runtime-state.json` 保存代理池、站点路由、凭据验证和运行统计。缓存过期（3 小时）后自动探测。旧 YAML 缓存仍可读取，新探测不再写回 YAML。HTTP 可达不等于登录有效；DNS/超时/HTTP 拒绝单独诊断。
- CookieCloud 手动与自动同步共用异步验证队列。贴吧及两个 SB 站点可执行只读登录验证，不触发签到、回帖或领奖。其他驱动明确显示无只读检查，后续任务成功显示“最近任务成功”，不冒充独立登录验证。新凭据不会被旧检查结果覆盖；重启恢复待检查队列。
- 验证遇到网络故障或安全挑战不会直接宣告 Cookie 失效。需人工验证的站点仍由用户在相同出口完成验证。

## 自动暂停与离线禁用（v0.1.39）

- 面板的连续失败数是跨天累计任务失败数，不是单次重试次数。每次任务内部尝试数仍记录在执行详情。自动和批量任务每个站点每天最多三次，统计按服务 TZ 的自然日切换，重启不会重置。同站并发跳过，不新增失败记录。
- 同一凭据连续三次有明确未登录证据才暂停自动任务。网络错误、验证码、接口结构异常和凭据未配置不能冒充 Cookie 过期。更新凭据后自动恢复；单站手动任务允许验证修复结果，成功后解除暂停。批量手动执行也遵守保护策略。
- 非登录失效的任务失败触发只读离线核验，每站每日最多一组。使用新鲜的代理健康检查，执行三轮直连与同一健康代理探测；每轮后重新确认代理可用。任一 HTTP 响应（包括 403/429/5xx）即视为站点可达。代理不健康、探测异常、缺少代理、检查中断均不累计离线天数。
- 只有连续三个自然日均完成三轮双路径不可达，才自动禁用。漏检日或成功访问会打断连续天数；不根据旧失败次数追溯判离线。停用状态单独保存在 data/runtime-state.json，不覆写用户配置；loadConfig 和所有执行入口统一生效，重启后仍保留。在站点管理中手动启用可清除自动离线停用；更新 Cookie 不会误解除离线禁用。
- 新策略从部署后的任务开始累计凭据失效和离线证据；历史 18/36 次失败保留为历史统计，不能当作已经验证的离线天数。
- 状态行保持统一高度，详细原因、每日次数和离线天数可在执行过程查看。

独立定时任务为所有已配置站点注册（包括启动时禁用的站点），执行前校验最新启用状态；自动禁用后重启再手动启用也可恢复。动态批量与晚间补跑重新读取当前启用列表。新增或修改独立 Cron 表达式仍需重启以重新注册。
