#!/usr/bin/env bash
set -euo pipefail
IMAGE_REF="${1:-}"
if [[ -z "$IMAGE_REF" || "$IMAGE_REF" == *":latest" ]]; then
  echo 'Usage: ./scripts/rollback-production.sh ghcr.io/hughryu/signmate:v0.1.27' >&2
  exit 2
fi
docker pull "$IMAGE_REF"
echo "Pulled immutable image $IMAGE_REF. Set the compose image to this reference and verify /api/health before resuming schedules."
