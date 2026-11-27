#!/bin/bash
# Create the isolated Codex and Claude subscription logins on the runner. Runs as `bench`, sent
# inline by runner/aws/bin/login (so it works without publishing a new revision). Skips any login
# whose preflight already passes. Never echoes the Claude token.
set -uo pipefail
export PATH="/usr/local/bin:/usr/bin:/bin"
WORK=/opt/harness/work

cd "$WORK" 2>/dev/null && [ -f .runner-release.json ] || {
  echo "No release is installed on the runner yet. Run runner/aws/bin/start --pilots first."; exit 1; }
install -d -m 0700 .runs/auth .runs/auth/codex .runs/auth/claude

preflight() { npm run --silent "$1:preflight" >/dev/null 2>&1; }

echo
echo "=== 1/2 Codex (ChatGPT login) ==="
if preflight codex; then
  echo "Codex login already works; skipping."
else
  echo "A sign-in URL appears below. Cmd-click it to open it in your browser and sign in."
  echo "The callback reaches the runner through the tunnel runner/aws/bin/login opened."
  echo
  CODEX_HOME="$WORK/.runs/auth/codex" npx codex login
fi

echo
echo "=== 2/2 Claude (subscription token) ==="
if preflight claude; then
  echo "Claude login already works; skipping."
else
  echo "A sign-in URL appears below. Cmd-click it, approve, and if it shows a code, type it here."
  echo "The token is captured automatically; you do not need to copy it."
  echo
  log="$(mktemp)"; chmod 600 "$log"
  saved_cols="$(stty size 2>/dev/null | cut -d' ' -f2)"
  stty cols 1000 2>/dev/null   # so the TUI never wraps the token across lines
  script -q -e -c "npx claude setup-token" "$log"
  [ -n "$saved_cols" ] && stty cols "$saved_cols" 2>/dev/null
  token="$(sed 's/\x1b\[[0-9;?]*[A-Za-z]//g' "$log" | tr -d '\r' | grep -o 'sk-ant-oat[A-Za-z0-9_-]*' | tail -n 1)"
  rm -f "$log"
  if [ -z "$token" ]; then
    echo
    echo "Could not find the token in the output. Paste it here instead, then press Enter:"
    IFS= read -r -s token; echo
  fi
  printf '%s' "$token" | npm run --silent claude:store-token
  unset token
fi

echo
echo "=== Checking both logins ==="
ok=0
if npm run --silent codex:preflight; then echo "Codex: ok"; else echo "Codex: FAILED"; ok=1; fi
if npm run --silent claude:preflight; then echo "Claude: ok"; else echo "Claude: FAILED"; ok=1; fi
[ "$ok" = 0 ] && echo "Both logins work." || echo "Run runner/aws/bin/login again to retry the failed one."
exit "$ok"
