# SignMate 发布流程

SignMate 使用两个 Docker 发布通道：

- `edge`：`main` 分支最新构建。用于验证刚合入的修复/功能，不承诺稳定。
- `latest`：最新正式稳定版。只在 `v*` 版本标签构建成功后更新。
- `v0.1.x`：固定正式版本，适合生产部署锁定。
- `sha-xxxxxxx`：按提交生成的不可变镜像标签，便于回溯。

## 什么时候发正式版

正式版发布以维护者明确确认（例如“打正式版 / 上 latest / 发 v0.1.x”）为准。助手可以建议是否适合发版，但不应自行把普通 main 提交提升为正式版。

建议满足以下条件后再发正式版：

1. 代码已合入 `main`，且工作区干净。
2. 本地发布检查通过：`npm run release:check`。
3. GitHub Actions 的 main Docker Image 构建成功。
4. 没有提交运行数据或敏感信息：Cookie、token、TOTP、通知密钥、真实 `config/secrets.yaml`、日志备份等。
5. 关键行为已验证：
   - 站点修复：尽量在真实生产/实验环境做单站点验证。
   - 前端变更：必要时 bump `src/web/index.html` 中静态资源版本，并确认页面文案/行为。
   - Docker/依赖变更：确认镜像构建、浏览器检查和容器启动。
6. 不存在已知 false-positive：无法确认实际签到成功时，不得报告“签到成功”。
7. README、版本号、Docker tag 文案与实际行为一致。

## 发布前检查

```bash
npm run release:check
```

该命令会执行：

- `npm run check`
- `npm audit --omit=dev --audit-level=moderate`
- `git diff --check`
- `git status --short`
- 敏感/运行文件检测

`release:check` 输出的 `git status` 需要人工确认；如果有无关文件或运行文件，不要发布。

## 版本发布步骤

以 `v0.1.13` 为例：

```bash
# 1. 确认 main 干净并已包含待发布内容
git status -sb
git log --oneline -5

# 2. 更新版本号
npm version 0.1.13 --no-git-tag-version

# 3. 如果 README 固定版本示例有旧版本号，同步更新
# 例如 ghcr.io/hughryu/signmate:v0.1.13

# 4. 发布检查
npm run release:check

# 5. 提交版本号变更
git add package.json package-lock.json README.md
git commit -m "Release v0.1.13"

# 6. 打 tag 并推送
git tag -a v0.1.13 -m "Release v0.1.13"
git push origin main
git push origin v0.1.13
```

## 发布后验证

1. 等待 GitHub Actions：
   - `main` 构建成功：更新 `edge`。
   - `v0.1.x` 构建成功：更新 `latest` 和固定版本 tag。
2. 验证 GHCR manifest：

```bash
docker buildx imagetools inspect ghcr.io/hughryu/signmate:latest
docker buildx imagetools inspect ghcr.io/hughryu/signmate:v0.1.13
```

确认：

- `latest` 和 `v0.1.13` digest 一致。
- 包含 `linux/amd64` 和 `linux/arm64`。

## 生产部署建议

- 稳定生产：使用 `ghcr.io/hughryu/signmate:latest` 或固定 `v0.1.x`。
- 验证 main 最新功能：使用 `ghcr.io/hughryu/signmate:edge`。
- 对外发布前，不要让普通用户依赖 `edge`。

## 安全注意事项

- 不要提交：
  - `.env`
  - `config/secrets.yaml`
  - `config/sites.yaml`（如果包含用户运行配置）
  - `config/notify.yaml`
  - `config/branding.json`
  - `data/`
  - `logs/`
  - `backups/`
  - CookieCloud/WebDAV 真实配置
  - probe 脚本里打印的敏感请求内容
- 诊断 Cookie 时只输出元数据：字段名、数量、长度、是否存在关键字段；不要输出值。
- 对 HDSky / OurBits 等验证码站点，除非真实验证成功，否则保持保活或明确失败，禁止用规则文本当成功依据。
