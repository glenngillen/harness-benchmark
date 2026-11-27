#!/bin/bash
# Runs one campaign invocation on the runner, inside tmux, as the unprivileged `bench` user. Started
# by `harness-bootstrap launch` (runner/aws/remote/bootstrap.sh), never directly by the scripts on
# your machine. Also usable on your own Linux host from examples/harness-benchmark/.
#
#   bash runner/aws/remote/campaign.sh --pilots [--retry-unexercised]
#   bash runner/aws/remote/campaign.sh --block N
#
# 1. Records host evidence (both subscription preflights, the bubblewrap probe, OS, kernel, tool
#    versions, timestamp) before the campaign, then runs `npm run shell-preflight` (one short real
#    stage per client inside the stage sandbox) and refuses to start (exit 78) if a shell is broken.
# 2. Runs `npm run campaign -- <args> --isolation required`. Exit 75 means paused (quota, access or
#    replacements exhausted): rerun the same command later; finished slots are skipped.
# 3. Records host evidence again after the campaign, and for pilots writes a freeze readiness
#    report from that recorded evidence, so both come back with the fetched records.
# 4. Writes .runs/runner/last-exit.json. The records sync timer uploads records/ within 5 minutes.
set -uo pipefail
cd "$(dirname "$0")/../../.." || exit 1
# shellcheck source=/dev/null
[ -r /etc/harness/label ] && . /etc/harness/label
export HARNESS_RUNNER_LABEL="${HARNESS_RUNNER_LABEL:-}"

pilots=false
for a in "$@"; do [ "$a" = "--pilots" ] && pilots=true; done
cohort="$(node -p "require('./config/matrix.json').cohort")" || exit 1
pilots_dir="records/$cohort-pilots"
if $pilots; then
  evidence_dir="$pilots_dir/host-evidence"
else
  evidence_dir="records/$cohort/host-evidence"
fi
mkdir -p .runs/runner "$evidence_dir"
stamp() { date -u +%Y-%m-%dT%H-%M-%SZ; }

echo "== host evidence (before campaign)"
npm run --silent host-evidence -- --phase before-campaign --out "$evidence_dir/host-$(stamp).json" > /dev/null

# A real one-command stage per client, inside the stage sandbox: refuse to run a campaign whose
# models cannot use their shell.
echo "== shell preflight (one short model turn per client)"
mkdir -p .runs/runner
if npm run --silent shell-preflight -- --isolation required > .runs/runner/shell-preflight.json; then
  echo "shell preflight ok"
  echo "== npm run campaign -- $* --isolation required"
  npm run --silent campaign -- "$@" --isolation required
  code=$?
else
  code=$?
  echo "== shell preflight FAILED (exit $code); not starting the campaign. Details:"
  cat .runs/runner/shell-preflight.json
  echo "If a login expired, rerun runner/aws/bin/login. Otherwise the stage sandbox or a client's shell is broken: tell the operator before rerunning."
  code=78
fi

echo "== host evidence (after campaign)"
npm run --silent host-evidence -- --phase after-campaign --out "$evidence_dir/host-$(stamp).json" > /dev/null

if $pilots; then
  report="$pilots_dir/readiness-$(stamp).json"
  echo "== freeze readiness report: $report"
  npm run --silent freeze -- --report "$report" > /dev/null
  echo "freeze gate exit $? (0 ready, 3 not ready)"
fi

finished="$(date -u +%FT%TZ)"
printf '{"args":"%s","exit":%d,"finishedAt":"%s"}\n' "$*" "$code" "$finished" > .runs/runner/last-exit.json
case "$code" in
  0) echo "== campaign complete ($finished)" ;;
  75) echo "== campaign paused ($finished): read the reason above, then rerun runner/aws/bin/start with the same arguments" ;;
  78) echo "== campaign not started ($finished): the shell preflight failed (see above)" ;;
  *) echo "== campaign exited $code ($finished)" ;;
esac
exit "$code"
