# Production version policy

生产容器必须从 GitHub/Gitea 已发布的版本标签构建，并把版本号和提交写入镜像环境变量：

```bash
export SIGNMATE_VERSION=0.1.27
export SIGNMATE_GIT_COMMIT=$(git rev-parse HEAD)
docker compose build --build-arg SIGNMATE_VERSION --build-arg SIGNMATE_GIT_COMMIT signmate
docker compose up -d signmate
curl http://127.0.0.1:9999/api/health
```

发布后通过 `/api/health` 核对 `version`、`commit`、`batchActive` 和代理摘要。生产源码目录出现未提交修改时，停止发布并先保存差异；禁止使用 `git reset --hard` 覆盖运行配置。
