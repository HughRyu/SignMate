# 运维发布与回滚

发布前运行 `npm run release:check && npm test && npm run production:manifest`，确认运行配置和数据未被提交。

发布后运行 `curl http://127.0.0.1:9999/api/health`，核对 `ok`、`version` 和 `commit`，并检查 Docker health 状态。

回滚使用 `./scripts/rollback-production.sh ghcr.io/hughryu/signmate:v0.1.27`，只允许固定版本或 digest，禁止使用 `latest`。回滚不会覆盖运行配置、Cookie、历史记录或日志。
