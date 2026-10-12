# 生产版本基线

生产使用 GHCR 固定 digest；镜像由已通过质量门禁的 main 提交构建。版本读取镜像内 package.json，完整提交 SHA 同时记录在镜像 OCI label 与运行环境中；部署脚本核对 Docker 镜像 ID 和 `/api/health` 来源。

旧生产源码目录可以作为归档保留，但不能再用于未经验证的现场构建。部署不覆盖用户配置，不重置现场改动。使用 `docker-compose.release.yml` 固定镜像；具体步骤及备份、回滚见 [运维手册](operations-runbook.md)。
