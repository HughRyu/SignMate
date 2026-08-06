#!/usr/bin/env bash
set -euo pipefail

# Ensure bind-mounted writable directories are owned by the runtime user.
# This makes fresh deployments robust when ./config, ./data or ./logs were
# created by root or another host user before the container starts.
mkdir -p /app/config /app/data /app/logs /tmp/signmate-chrome-crashes /home/pwuser/.cache /home/pwuser/.config
chown -R pwuser:pwuser /app/config /app/data /app/logs /tmp/signmate-chrome-crashes /home/pwuser/.cache /home/pwuser/.config 2>/dev/null || true
chmod -R u+rwX,g+rwX /app/config /app/data /app/logs /tmp/signmate-chrome-crashes /home/pwuser/.cache /home/pwuser/.config 2>/dev/null || true
export HOME=/home/pwuser
export XDG_CACHE_HOME=/home/pwuser/.cache
export XDG_CONFIG_HOME=/home/pwuser/.config

# Optional virtual display for non-headless stealth browsing (e.g. cloak engine on
# heavy-Cloudflare sites). Enabled when SIGNMATE_XVFB=1. Starts Xvfb and exports DISPLAY
# so cloakbrowser can run headless:false and pass CF 'Just a moment' JS challenges.
if [ "${SIGNMATE_XVFB:-0}" = "1" ] && command -v Xvfb >/dev/null 2>&1; then
  XVFB_DISPLAY="${SIGNMATE_XVFB_DISPLAY:-:99}"
  XVFB_RES="${SIGNMATE_XVFB_RES:-1440x1000x24}"
  if [ ! -e "/tmp/.X11-unix/X${XVFB_DISPLAY#:}" ]; then
    Xvfb "$XVFB_DISPLAY" -screen 0 "$XVFB_RES" -nolisten tcp >/tmp/xvfb.log 2>&1 &
    # give Xvfb a moment to create the socket
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      [ -e "/tmp/.X11-unix/X${XVFB_DISPLAY#:}" ] && break
      sleep 0.3
    done
  fi
  export DISPLAY="$XVFB_DISPLAY"
  echo "[entrypoint] Xvfb started on DISPLAY=$DISPLAY ($XVFB_RES)"
fi

exec runuser -u pwuser --preserve-environment -- "$@"
