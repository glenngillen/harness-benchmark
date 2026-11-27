#!/usr/bin/env bash
# Evaluator discrimination check, run by hand (there is no CI).
# Runs the benchmark's integration project (evaluator vs correct, 8 broken and 2 tampering
# references) under bubblewrap with Chromium, in a throwaway Linux container. Needs Docker.
# The benchmark is copied into the container; nothing in your checkout is modified.
# Works from the site repository (examples/harness-benchmark) or a standalone clone.
# Output: .runs/discrimination/<UTC timestamp>/{meta.txt,run.log,vitest.json,verdicts/}
# under the benchmark directory.
set -euo pipefail

BENCH="$(cd "$(dirname "$0")/.." && pwd)"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$BENCH/.runs/discrimination/$STAMP"
NODE_VERSION="$(tr -d '[:space:]' < "$BENCH/.node-version")"
G=(git -c safe.directory='*' -C "$BENCH")

docker info >/dev/null 2>&1 || { echo "Docker isn't running; start Docker Desktop and retry." >&2; exit 2; }
mkdir -p "$OUT"
{
  echo "head=$("${G[@]}" rev-parse HEAD 2>/dev/null || echo unknown)"
  echo "dirty_benchmark_files=$("${G[@]}" status --porcelain -- . 2>/dev/null | wc -l | tr -d ' ')"
  echo "node=$NODE_VERSION"
  echo "started=$STAMP"
} > "$OUT/meta.txt"

set +e
docker run --rm --privileged \
  -v "$BENCH:/src:ro" -v "$OUT:/out" \
  -e HARNESS_EVAL_ISOLATION=required -e CI=1 \
  "node:${NODE_VERSION}-bookworm" bash -euo pipefail -c '
    # Nest the copy a few levels deep: the evaluator refuses to hide the filesystem root, and its
    # path scrubbing treats the directory two levels above the benchmark as the checkout.
    W=/work/repo/examples/harness-benchmark
    asnode() { runuser -u node -- env HOME=/home/node HARNESS_EVAL_ISOLATION=required CI=1 bash -euo pipefail -c "cd $W && $1"; }
    trap '\''rc=$?; grep -q "^exit=" /out/meta.txt || echo "exit=$rc (setup failed before tests)" >> /out/meta.txt'\'' EXIT
    echo "arch=$(uname -m)" >> /out/meta.txt
    df -h / | tail -1 | sed "s/^/container_disk=/" >> /out/meta.txt
    apt-get update -qq
    apt-get install -y -qq bubblewrap >/dev/null
    mkdir -p "$W"
    tar -C /src --exclude=node_modules --exclude=.runs --exclude=.git -cf - . | tar -C "$W" -xf -
    chown -R node:node /work
    asnode "npm ci --no-audit --no-fund && npm run fixtures:install"
    (cd "$W" && npx playwright install-deps chromium)
    asnode "npx playwright install chromium"
    asnode "bwrap --ro-bind / / --dev /dev --proc /proc true && echo bwrap-ok"
    set +e
    asnode "npx vitest run --project integration --reporter=default --reporter=json --outputFile.json=$W/vitest.json"
    status=$?
    set -e
    cp "$W/vitest.json" /out/ 2>/dev/null || true
    (cd "$W" && find .runs/integration -name verdict.json 2>/dev/null | while read -r f; do
      mkdir -p "/out/verdicts/$(dirname "$f")"; cp "$f" "/out/verdicts/$f"; done)
    echo "exit=$status" >> /out/meta.txt
    exit $status
  ' 2>&1 | tee "$OUT/run.log"
status=${PIPESTATUS[0]}
set -e

echo
echo "Results: $OUT (exit $status)"
exit "$status"
