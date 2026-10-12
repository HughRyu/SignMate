#!/usr/bin/env bash
set -euo pipefail
umask 077
# Run inside the existing production compose directory. No source/config files
# are replaced. The override pins the registry digest and preserves mounts.
image=${1:-}
if [[ ! "$image" =~ ^ghcr\.io/hughryu/signmate@sha256:[a-f0-9]{64}$ ]]; then
  echo 'Usage: deploy-production.sh ghcr.io/hughryu/signmate@sha256:<64 hex>' >&2
  exit 2
fi
test -f docker-compose.yml
compose=(docker compose -f docker-compose.yml)
if [[ -f docker-compose.host-network.yml ]]; then compose+=(-f docker-compose.host-network.yml); fi
override=docker-compose.release.yml
backup_root=${SIGNMATE_BACKUP_DIR:-/opt/backups/signmate}
mkdir -p "$backup_root"
case "$(realpath "$backup_root")/" in "$(pwd -P)/"*) echo "Backup directory must be outside production" >&2; exit 2;; esac
chmod 700 "$backup_root"
exec 9>"$backup_root/deploy.lock"
flock -n 9 || { echo 'Another deployment is active' >&2; exit 1; }
docker pull "$image"
revision=$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image")
version=$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.version"}}' "$image")
[[ "$revision" =~ ^[a-f0-9]{40}$ ]]
[[ "$version" =~ ^v?[0-9]+\.[0-9]+\.[0-9]+$ ]]
container=$("${compose[@]}" ps -q signmate)
test -n "$container"
docker exec -i "$container" node --input-type=module < "$(dirname "$0")/assert-production-idle.js"
previous=$(docker inspect --format '{{.Image}}' "$container")
backup="$backup_root/$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -m 700 "$backup"
[[ ! -f "$override" ]] || cp "$override" "$backup/$override"
files=(config data docker-compose.yml)
for item in .env docker-compose.host-network.yml "$override"; do
  [[ ! -e "$item" ]] || files+=("$item")
done
# Stop before archiving so config/history form a consistent snapshot.
"${compose[@]}" stop signmate
recover() {
  echo 'Deployment failed; restoring previous image (runtime data retained)' >&2
  if [[ -f "$backup/$override" ]]; then cp "$backup/$override" "$override"; else
  printf 'services:\n  signmate:\n    image: %s\n' "$previous" > "$override"
  fi
  "${compose[@]}" -f "$override" up -d --no-build --pull never signmate
}
trap recover ERR
tar -czf "$backup/runtime.tgz" "${files[@]}"
tar -tzf "$backup/runtime.tgz" > /dev/null
tar -czf "$backup/source.tgz" --exclude='./node_modules' --exclude='./config' --exclude='./data' --exclude='./logs' --exclude='./.env' --exclude='./.git' .
tar -tzf "$backup/source.tgz" > /dev/null
sha256sum "$backup/runtime.tgz" > "$backup/runtime.sha256"
printf '{"previousImage":"%s","targetImage":"%s","createdAt":"%s"}\n' "$previous" "$image" "$(date -u +%FT%TZ)" > "$backup/deployment.json"
printf 'services:\n  signmate:\n    image: %s\n    environment:\n      SIGNMATE_GIT_COMMIT: %s\n      SIGNMATE_VERSION: %s\n' "$image" "$revision" "${version#v}" > "$override"
"${compose[@]}" -f "$override" up -d --no-build --pull never signmate
container=$("${compose[@]}" -f "$override" ps -q signmate)
healthy=false
for attempt in $(seq 1 40); do
  status=$(docker inspect --format '{{.State.Health.Status}}' "$container")
  if [[ "$status" == healthy ]]; then healthy=true; break; fi
  sleep 3
done
test "$healthy" = true
actual=$(docker inspect --format '{{.Image}}' "$container")
expected=$(docker image inspect --format '{{.Id}}' "$image")
test "$actual" = "$expected"
docker exec -e EXPECTED_REVISION="$revision" -e EXPECTED_VERSION="${version#v}" "$container" node -e 'fetch("http://127.0.0.1:"+(process.env.WEB_PORT||9999)+"/api/health").then(r=>r.json()).then(h=>process.exit(h.ok&&h.commit===process.env.EXPECTED_REVISION&&h.version===process.env.EXPECTED_VERSION?0:1)).catch(()=>process.exit(1))'
docker exec "$container" node scripts/production-manifest.js > "$backup/running-manifest.json"
trap - ERR
echo "Deployment healthy; backup: $backup; image: $image"
