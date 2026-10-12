#!/usr/bin/env bash
set -euo pipefail
# Rollback uses the identical backup, idle, health and recovery gates.
exec bash "$(dirname "$0")/deploy-production.sh" "${1:-}"
