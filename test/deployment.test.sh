#!/usr/bin/env bash
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
fixture=$(mktemp -d)
trap 'rm -rf "$fixture"' EXIT
mkdir -p "$fixture/bin" "$fixture/production/config" "$fixture/production/data"
export MOCK_LOG="$fixture/calls.log"
cat > "$fixture/bin/docker" <<'MOCK'
#!/usr/bin/env bash
set -e
echo "$*" >> "$MOCK_LOG"
case "$*" in
  *org.opencontainers.image.revision*) printf '%040d\n' 1;;
  *org.opencontainers.image.version*) echo 0.1.30;;
  *'ps -q'*) echo fixture;;
  *State.Health.Status*) echo healthy;;
  *'image inspect'*) echo sha256:fixture;;
  'inspect '*) echo sha256:fixture;;
  *'up -d'*)
    if [[ "${FAIL_START:-}" == true && ! -e "$MOCK_LOG.failed" ]]; then touch "$MOCK_LOG.failed"; exit 1; fi;;
  'exec -i '*) cat >/dev/null;;
  'exec '*) echo '{}';;
esac
MOCK
chmod +x "$fixture/bin/docker"
export PATH="$fixture/bin:$PATH"
cd "$fixture/production"
printf 'services:\n  signmate:\n    image: fixture\n' > docker-compose.yml
echo fixture > config/sites.yaml
echo '[]' > data/history.json
image="ghcr.io/hughryu/signmate@sha256:$(printf '%064d' 1)"
if bash "$root/scripts/deploy-production.sh" ghcr.io/hughryu/signmate:latest; then exit 1; fi
export SIGNMATE_BACKUP_DIR="$fixture/backup-success"
bash "$root/scripts/deploy-production.sh" "$image"
grep -q "$image" docker-compose.release.yml
test -f "$SIGNMATE_BACKUP_DIR/"*/runtime.tgz
test -f "$SIGNMATE_BACKUP_DIR/"*/source.tgz
export SIGNMATE_BACKUP_DIR="$fixture/backup-failure" FAIL_START=true
if bash "$root/scripts/deploy-production.sh" "$image"; then echo 'Failed startup was accepted'; exit 1; fi
test -f "$MOCK_LOG.failed"
test "$(grep -c 'up -d' "$MOCK_LOG")" -eq 3
grep -q "$image" docker-compose.release.yml
echo 'deployment tests passed (success, backup, failed startup recovery, mutable ref rejected)'
