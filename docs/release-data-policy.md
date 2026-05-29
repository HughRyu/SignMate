# SignMate 上传 / 镜像数据边界

| 类型 | 示例 | 上传 GitHub | 打进 Docker 镜像 | 运行时保存位置 | 说明 |
|---|---|---:|---:|---|---|
| 源码 | `src/**`, `package.json`, `Dockerfile`, `docker-compose.yml` | ✅ | ✅ | 镜像内 | 项目代码，可公开。 |
| 示例配置 | `.env.example`, `config/*.example` | ✅ | ✅ | 镜像内 | 只放占位符，不放真实 token/cookie。 |
| 环境变量 | `.env`, `.env.production` | ❌ | ❌ | 宿主机 `.env` / Compose `env_file` | 可能包含端口、token、密钥。 |
| Cookie / 登录凭据 | `config/secrets.yaml` | ❌ | ❌ | 宿主机挂载 `./config` | 高敏感，绝不提交。 |
| 通知配置 | `config/notify.yaml` | ❌ | ❌ | 宿主机挂载 `./config` | 含 Telegram Token、Chat ID、Bark Key。 |
| 站点/代理配置 | `config/sites.yaml` | ❌ | ❌ | 宿主机挂载 `./config` | 含代理地址、站点策略、缓存状态。 |
| 签到历史 | `data/history.json` | ❌ | ❌ | 宿主机挂载 `./data` | 个人使用记录。 |
| 运行日志 | `logs/**` | ❌ | ❌ | 宿主机挂载 `./logs` | 可能含站点、错误、隐私信息。 |
| 备份目录 | `backups/**` | ❌ | ❌ | 宿主机本地 | 自动修复备份，可能含敏感配置。 |

## 当前防护

- `.gitignore` 已排除 `.env`、`config/*.yaml`、`data/`、`logs/`、`backups/`。
- `.dockerignore` 已排除同类敏感文件，避免 `docker build` 时被 `COPY . .` 写入镜像。
- 需要发布默认配置时，只提交 `.example` 文件。
