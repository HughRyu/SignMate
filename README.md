# signmate — 签伴 SignMate

基于 Node.js 的 Docker 化多论坛自动签到系统，插件式 Driver 架构，支持不同签到方式的论坛扩展。

## 快速开始

### 1. 部署到服务器

```bash
# 进入项目目录
cd /opt/docker/signmate

# 配置环境变量
cp .env.example .env
vim .env        # 填入 Telegram Bot Token（可选）

# 配置站点凭据
cp config/secrets.yaml.example config/secrets.yaml
chmod 600 config/secrets.yaml
vim config/secrets.yaml   # 填入 Cookie 等敏感信息

# 构建并启动
docker compose up -d

# 查看日志
docker compose logs -f
```

### 2. 配置 NodeSeek 签到

1. 浏览器打开 https://www.nodeseek.com 并登录
2. F12 → Application → Cookies → 找到 `session` 的值
3. 填入 `config/secrets.yaml`:

```yaml
nodeseek:
  session_only: "your-session-value-here"
```

### 3. 配置 Telegram 通知（可选）

1. 在 Telegram 中 @BotFather 创建 Bot，获取 Token
2. @userinfobot 获取你的 Chat ID
3. 填入 `.env`:

```
TELEGRAM_BOT_TOKEN=123456:ABC-DEF...
TELEGRAM_CHAT_ID=123456789
```

## 添加新论坛

### 简单方式：使用模板

1. 复制 `src/drivers/template.js` 为 `src/drivers/<forum>.js`
2. 实现 `signIn()` 方法
3. 在 `config/sites.yaml` 中添加配置
4. 在 `config/secrets.yaml` 中添加凭据
5. 在 `src/index.js` 中注册 Driver:

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
│   ├── sites.yaml        # 站点签到配置
│   └── secrets.yaml      # 凭据（敏感信息，不提交）
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

# 更新后重新构建
docker compose build --no-cache && docker compose up -d

# 手动执行一次签到（测试配置）
docker compose exec signmate node src/index.js
```
