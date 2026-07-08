<p align="center">
  <img src="src/web/logo.png" alt="SignMate Logo" width="120" height="120">
</p>

# SignMate （签伴）

基于 Node.js 的 Docker 化多论坛自动签到系统，插件式 Driver 架构，支持不同签到方式的论坛扩展。

## 快速开始

### 方式 A：直接使用 GHCR Docker 镜像（推荐）

镜像地址：

```text
ghcr.io/hughryu/signmate:latest   # 最新稳定版（随 v* 正式版本标签更新）
ghcr.io/hughryu/signmate:edge     # main 分支最新构建，包含尚未发版的新功能/修复
ghcr.io/hughryu/signmate:v0.1.22  # 固定正式版本
```

创建目录与配置文件：

```bash
mkdir -p /opt/docker/signmate/{config,data,logs}
cd /opt/docker/signmate

ADMIN_PASSWORD="$(openssl rand -base64 24)"
cat > .env <<EOF
TZ=Asia/Shanghai
LOG_LEVEL=info
RUN_ON_START=false
HTTP_TIMEOUT=30000
SIGNMATE_AUTH_USERNAME=admin
SIGNMATE_AUTH_PASSWORD=${ADMIN_PASSWORD}
SIGNMATE_AUTH_DISABLED=false
EOF
echo "SignMate 初始管理员密码：${ADMIN_PASSWORD}"

```

创建 `docker-compose.yml`：

```yaml
services:
  signmate:
    image: ghcr.io/hughryu/signmate:latest
    container_name: signmate
    restart: unless-stopped
    ports:
      - "9999:6668"
    env_file:
      - .env
    environment:
      - TZ=Asia/Shanghai
      - WEB_PORT=6668
      - SIGNMATE_AUTH_USERNAME=${SIGNMATE_AUTH_USERNAME:-admin}
      - SIGNMATE_AUTH_PASSWORD=${SIGNMATE_AUTH_PASSWORD:-}
      - SIGNMATE_AUTH_DISABLED=${SIGNMATE_AUTH_DISABLED:-false}
    volumes:
      - ./config:/app/config
      - ./data:/app/data
      - ./logs:/app/logs
```

启动：

```bash
docker compose pull
docker compose up -d
docker compose logs -f
```

首次启动如果还没有 `config/sites.yaml`，面板会以空站点列表正常打开；后续在网页里手动添加站点、维护 Cookie、代理和通知配置即可。默认 `RUN_ON_START=false`，避免全新部署尚未维护 Cookie 时自动执行签到。请保存上面输出的初始管理员密码，不要使用示例固定密码公开部署。

更新稳定版：

```bash
cd /opt/docker/signmate
docker compose pull
docker compose up -d
```

如果需要立即体验 main 分支最新构建，可将 compose 镜像 tag 改为 `ghcr.io/hughryu/signmate:edge`。

> 如果 GHCR 包被设为私有，需要先执行 `docker login ghcr.io`。公开包无需登录即可拉取。

### 方式 B：从源码构建部署

```bash
git clone https://github.com/HughRyu/SignMate.git /opt/docker/signmate
cd /opt/docker/signmate

# 配置环境变量
cp .env.example .env
vim .env        # 填入 Telegram Bot Token（可选）

# 构建并启动
docker compose up -d --build

# 查看日志
docker compose logs -f
```

### 2. 在 Web 面板添加站点

浏览器打开 SignMate 面板，登录后在“站点配置”中从已适配列表添加站点，并在面板内维护 Cookie / 2FA / 代理等信息。

### 3. 配置 Telegram 通知（可选）

1. 在 Telegram 中 @BotFather 创建 Bot，获取 Token
2. @userinfobot 获取你的 Chat ID
3. 填入 `.env`:

```
TELEGRAM_BOT_TOKEN=123456:ABC-DEF...
TELEGRAM_CHAT_ID=123456789
```


## 支持站点

SignMate 内置以下站点 Driver / 站点模板。站点凭据请在 Web 面板中维护，公开镜像不包含任何 Cookie、Token 或账号信息。

### 论坛 / 社区

| 站点 | Key | Driver | 类型 | 方式 |
|------|-----|--------|------|------|
| 威锋论坛 | `feng-com` | `feng` | 签到 | API |
| NodeSeek | `nodeseek` | `nodeseek` | 签到 | API-first（浏览器兜底） |
| V2EX | `v2ex` | `v2ex` | 签到 | API-first（浏览器兜底） |
| 奶昔论坛 | `naixi` | `naixi` | 签到 | API-first（浏览器兜底） |
| 吾爱破解 | `pojie52` | `pojie52` | 签到 | API-first（浏览器兜底） |
| NodeLoc | `nodeloc` | `nodeloc` | 签到 | API-first（浏览器兜底） |
| PCEVA | `pceva` | `pceva` | 签到 | API-first（浏览器兜底） |
| Chiphell | `chiphell-com` | `chiphell` | 保活 | API-first（浏览器兜底） |
| 恩山无线论坛 | `right` | `right` | 签到 | API-first（浏览器兜底） |
| 卡饭论坛 | `kafan` | `kafan` | 签到 | API-first（浏览器兜底） |
| 阡陌居 | `qianmoju` | `qianmoju` | 签到 | API-first（浏览器兜底） |
| PCBeta | `pcbeta` | `pcbeta` | 签到 | API |
| 百度贴吧 | `baidu-tieba` | `tieba` | 签到 | API |

### PT / NexusPHP

以下站点使用通用 `nexusphp` Driver，并按站点配置区分“签到”或“保活”。

| 站点 | Key | 类型 | 方式 |
|------|-----|------|------|
| Audiences | `audiences-me` | 保活 | API-first（浏览器兜底） |
| M-Team | `mteam` | 保活 | API Token（存取令牌） |
| BTSCHOOL | `pt-btschool-club` | 保活 | API-first（浏览器兜底） |
| CarPT | `carpt-net` | 签到 | API-first（浏览器兜底） |
| FARMM / 0ff | `pt-0ff-cc` | 签到 | API-first（浏览器兜底） |
| HHanClub | `hhanclub-net` | 签到 | API-first（浏览器兜底） |
| HDDolby | `hddolby-com` | 签到 | API-first（浏览器兜底） |
| HDFans | `hdfans-org` | 签到 | API-first（浏览器兜底） |
| HDHome | `hdhome-org` | 签到 | API-first（浏览器兜底） |
| HDSky | `hdsky-me` | 保活 | API-first（浏览器兜底） |
| OpenCD | `open-cd` | 保活 | API-first（浏览器兜底） |
| OurBits | `ourbits-club` | 保活 | API-first（浏览器兜底） |
| Piggo | `piggo-me` | 保活 | API-first（浏览器兜底） |
| PTTime | `pttime-org` | 保活 | API-first（浏览器兜底） |
| PterClub | `pterclub-net` | 签到 | API-first（浏览器兜底） |

## 添加新论坛

### 简单方式：使用模板

1. 复制 `src/drivers/template.js` 为 `src/drivers/<forum>.js`
2. 实现 `signIn()` 方法
3. 在内置站点模板或 Web 面板配置中补充站点信息
4. 在 `src/index.js` 中注册 Driver:

```js
import ForumDriver from "./drivers/<forum>.js";
registerDriver("<forum>", ForumDriver);
```

### 支持的签到模式

| 模式 | 适用场景 | 依赖 |
|------|----------|------|
| API POST + Cookie | REST API 直接签到 | 内置 fetch |
| API POST + Token | 带 Bearer JWT 的接口 | 内置 fetch |
| 表单提交 | 传统 PHP 论坛 | cheerio（需安装） |
| 无头浏览器 | 需要渲染 JS 的页面 | playwright（可选） |

## 项目结构

```
├── Dockerfile
├── docker-compose.yml
├── .env.example         # 环境变量模板
├── config/
│   └── sites.yaml        # Web 面板维护的站点配置（敏感信息不提交）
├── src/
│   ├── index.js          # 入口：加载配置、注册任务
│   ├── scheduler.js      # Cron 调度器
│   ├── runner.js         # 签到执行引擎
│   ├── notify.js         # 通知系统
│   └── drivers/
│       ├── base.js       # Driver 抽象基类
│       ├── nodeseek.js   # NodeSeek 签到
│       └── template.js   # 新 Driver 模板
└── data/                 # 运行时数据
```

## 日志

日志自动按日期分文件，位于 `logs/` 目录：

```
logs/signmate-2026-05-19.log
```

## 维护命令

```bash
# 查看实时日志
docker compose logs -f

# 重启容器
docker compose restart

# 更新源码后重新构建
docker compose up -d --build

# 手动执行一次签到（测试配置）
docker compose exec signmate node src/index.js
```
