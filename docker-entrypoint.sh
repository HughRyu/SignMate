#!/usr/bin/env bash
set -euo pipefail

# Ensure bind-mounted writable directories are owned by the runtime user.
# This makes fresh deployments robust when ./config, ./data or ./logs were
# created by root or another host user before the container starts.
mkdir -p /app/config /app/data /app/logs
chown -R pwuser:pwuser /app/config /app/data /app/logs 2>/dev/null || true
chmod -R u+rwX,g+rwX /app/config /app/data /app/logs 2>/dev/null || true

exec runuser -u pwuser -- "$@"
