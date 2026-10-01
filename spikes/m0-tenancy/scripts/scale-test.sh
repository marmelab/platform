#!/usr/bin/env bash
# Provisions N extra throwaway apps (load01..loadNN), loads every app (signup, login,
# concurrent REST calls) and records memory/connections at idle, under load and after.
# Usage: scripts/scale-test.sh [N=18] [--keep]
source "$(dirname "$0")/lib.sh"
N="${1:-18}"
OUT="$M0_DIR/results/scale-$(date +%Y%m%d-%H%M%S).txt"
mkdir -p "$M0_DIR/results"
apps=(app1 app2)
for i in $(seq -w 1 "$N"); do apps+=("load$i"); done

{
  echo "# scale test: ${#apps[@]} apps"
  start=$(date +%s)
  for app in "${apps[@]:2}"; do "$M0_DIR/scripts/create-app.sh" "$app" >/dev/null; done
  echo "provisioned $N apps in $(( $(date +%s) - start ))s"
  sleep 20
  echo; echo "### IDLE after provisioning"; "$M0_DIR/scripts/measure.sh"

  load_app() {
    local app="$1" anon
    anon="$(grep ^ANON_KEY= "$M0_DIR/apps/$app/.env" | cut -d= -f2)"
    local url="http://${app}.localhost:8080"
    local email="u$RANDOM$RANDOM@$app.test"
    curl -fsS "$url/auth/v1/signup" -H "apikey: $anon" -H 'content-type: application/json' \
      -d "{\"email\":\"$email\",\"password\":\"password-123\"}" >/dev/null
    for _ in 1 2 3; do
      curl -fsS "$url/auth/v1/token?grant_type=password" -H "apikey: $anon" -H 'content-type: application/json' \
        -d "{\"email\":\"$email\",\"password\":\"password-123\"}" >/dev/null &
    done
    seq 1 200 | xargs -P 8 -I{} curl -fsS -o /dev/null "$url/rest/v1/" -H "apikey: $anon"
    wait
  }
  for app in "${apps[@]}"; do load_app "$app" & done
  sleep 4
  echo; echo "### UNDER LOAD (all apps hit concurrently)"; "$M0_DIR/scripts/measure.sh"
  wait
  echo; echo "### right after load"; "$M0_DIR/scripts/measure.sh"
  sleep 45
  echo; echo "### 45s after load"; "$M0_DIR/scripts/measure.sh"
} 2>&1 | tee "$OUT"

if [ "${2:-}" != "--keep" ]; then
  for app in "${apps[@]:2}"; do "$M0_DIR/scripts/delete-app.sh" "$app" >/dev/null; done
fi
echo "results: $OUT"
