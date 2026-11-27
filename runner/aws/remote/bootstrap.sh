#!/bin/bash
# Harness benchmark runner bootstrap. Installed at /usr/local/sbin/harness-bootstrap by the
# instance user data (runner/aws/terraform/user-data.sh.tftpl) and run as root, either at first
# boot or through SSM Run Command from runner/aws/bin/*. Never handles subscription credentials.
#
#   harness-bootstrap system            first boot: packages, Node.js, bench user, sandbox checks,
#                                       metadata guard, records sync timer
#   harness-bootstrap release <sha>     download, verify and install the source bundle <sha>
#   harness-bootstrap launch <args...>  start runner/aws/remote/campaign.sh in tmux as `bench`
#   harness-bootstrap status            what is running, the installed revision, the last result
#   harness-bootstrap sync              upload records/ to s3://<bucket>/records/
#   harness-bootstrap check-userns      verify bench can create a bubblewrap sandbox
set -euo pipefail

ENV_FILE=/etc/harness/runner.env
# shellcheck source=/dev/null
[ -r "$ENV_FILE" ] && . "$ENV_FILE"
: "${HARNESS_BUCKET:?HARNESS_BUCKET missing from $ENV_FILE}"
: "${HARNESS_REGION:?HARNESS_REGION missing from $ENV_FILE}"
: "${HARNESS_NODE_VERSION:?HARNESS_NODE_VERSION missing from $ENV_FILE}"

BENCH_USER=bench
HARNESS_HOME=/opt/harness
WORK="$HARNESS_HOME/work"
STAGING="$HARNESS_HOME/staging"
STATE=/var/lib/harness
SESSION=harness
export AWS_DEFAULT_REGION="$HARNESS_REGION"
export PATH="/usr/local/bin:/snap/bin:/usr/sbin:/usr/bin:/sbin:/bin"

log() { printf '[harness-bootstrap %s] %s\n' "$(date -u +%FT%TZ)" "$*"; }
die() { log "ERROR: $*"; exit 1; }
as_bench() { sudo -u "$BENCH_USER" -H env PATH="$PATH" HOME="/home/$BENCH_USER" "$@"; }
session_alive() { as_bench tmux has-session -t "$SESSION" 2>/dev/null; }

check_userns() {
  if as_bench bwrap --ro-bind / / --dev /dev --proc /proc true; then
    log "bubblewrap sandbox works for $BENCH_USER (unprivileged user namespaces available)"
    echo ok > "$STATE/userns-check"
  else
    echo failed > "$STATE/userns-check"
    die "bubblewrap cannot create a sandbox for $BENCH_USER; see /proc/sys/kernel/apparmor_restrict_unprivileged_userns and /etc/apparmor.d/harness-bwrap"
  fi
}

install_node() {
  local v="$HARNESS_NODE_VERSION" dir="/opt/node-v$HARNESS_NODE_VERSION"
  if [ -x "$dir/bin/node" ] && [ "$("$dir/bin/node" --version)" = "v$v" ]; then return; fi
  local tmp; tmp="$(mktemp -d)"
  local base="https://nodejs.org/dist/v$v" file="node-v$v-linux-x64.tar.xz"
  curl -fsSL --retry 3 -o "$tmp/$file" "$base/$file"
  curl -fsSL --retry 3 -o "$tmp/SHASUMS256.txt" "$base/SHASUMS256.txt"
  (cd "$tmp" && grep " $file\$" SHASUMS256.txt | sha256sum -c -) || die "Node.js $v checksum mismatch"
  mkdir -p "$dir"
  tar -xJf "$tmp/$file" -C "$dir" --strip-components=1 --no-same-owner
  for b in node npm npx; do ln -sfn "$dir/bin/$b" "/usr/local/bin/$b"; done
  rm -rf "$tmp"
  log "installed Node.js $("$dir/bin/node" --version)"
}

cmd_system() {
  log "system setup starting"
  install -d -m 0755 "$HARNESS_HOME" "$STATE"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -q
  # socat: Claude Code's own Bash sandbox needs it on Linux (with bwrap). Without it every Claude
  # Bash call fails; npm run shell-preflight checks it before each campaign.
  apt-get install -y -q --no-install-recommends bubblewrap socat tmux rsync jq xz-utils ca-certificates curl iptables apparmor-utils
  command -v aws >/dev/null || snap install aws-cli --classic
  install_node

  id "$BENCH_USER" >/dev/null 2>&1 || useradd --create-home --shell /bin/bash "$BENCH_USER"
  install -d -o "$BENCH_USER" -g "$BENCH_USER" -m 0750 "$WORK" "$STAGING"

  # Ubuntu 24.04 restricts unprivileged user namespaces to AppArmor profiles that allow them.
  # Grant that to bwrap alone instead of lifting the restriction system-wide.
  if [ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null || echo 0)" = "1" ]; then
    cat > /etc/apparmor.d/harness-bwrap <<'PROFILE'
abi <abi/4.0>,
include <tunables/global>

profile harness-bwrap /usr/bin/bwrap flags=(unconfined) {
  userns,
  include if exists <local/harness-bwrap>
}
PROFILE
    apparmor_parser -r /etc/apparmor.d/harness-bwrap
    log "loaded AppArmor profile allowing user namespaces for /usr/bin/bwrap"
  fi

  # Only root may reach the instance metadata service, so nothing running as bench (the coding
  # CLIs, the app under test) can obtain the instance role's bucket credentials.
  cat > /etc/systemd/system/harness-imds-guard.service <<'UNIT'
[Unit]
Description=Block instance metadata for non-root users (harness benchmark)
After=network-pre.target
Wants=network-pre.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/bin/sh -c 'iptables -C OUTPUT -d 169.254.169.254 -m owner ! --uid-owner 0 -j REJECT 2>/dev/null || iptables -I OUTPUT -d 169.254.169.254 -m owner ! --uid-owner 0 -j REJECT'

[Install]
WantedBy=multi-user.target
UNIT

  cat > /etc/systemd/system/harness-records-sync.service <<'UNIT'
[Unit]
Description=Upload harness benchmark records to S3

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/harness-bootstrap sync
UNIT
  cat > /etc/systemd/system/harness-records-sync.timer <<'UNIT'
[Unit]
Description=Upload harness benchmark records every 5 minutes

[Timer]
OnBootSec=5min
OnUnitActiveSec=5min

[Install]
WantedBy=timers.target
UNIT
  systemctl daemon-reload
  systemctl enable --now harness-imds-guard.service harness-records-sync.timer

  # Label recorded with host evidence (no account or instance identifiers).
  local token type
  token="$(curl -fsS -X PUT -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' http://169.254.169.254/latest/api/token)"
  type="$(curl -fsS -H "X-aws-ec2-metadata-token: $token" http://169.254.169.254/latest/meta-data/instance-type)"
  echo "HARNESS_RUNNER_LABEL=aws-ec2/$HARNESS_REGION/$type" > /etc/harness/label
  chmod 0644 /etc/harness/label

  check_userns
  if as_bench curl -fsS -m 3 -o /dev/null http://169.254.169.254/latest/api/token -X PUT -H 'X-aws-ec2-metadata-token-ttl-seconds: 60'; then
    die "metadata guard failed: $BENCH_USER can reach the instance metadata service"
  fi
  log "metadata service blocked for $BENCH_USER"
  date -u +%FT%TZ > "$STATE/system-ready"
  log "system setup complete"
}

cmd_release() {
  local sha="${1:-}"
  [[ "$sha" =~ ^[0-9a-f]{40}$ ]] || die "release needs a full 40-character revision"
  [ -f "$STATE/system-ready" ] || die "system setup has not completed; see /var/log/harness-bootstrap.log"
  if [ "$(cat "$STATE/current-revision" 2>/dev/null || true)" = "$sha" ] && [ -f "$STATE/release-ready" ]; then
    log "revision $sha already installed"
    return
  fi
  session_alive && die "a campaign is running in tmux session '$SESSION'; wait for it (or stop it) before installing another revision"

  local dir="$STAGING/$sha"
  rm -rf "$dir"
  install -d -m 0750 "$dir"
  aws s3 cp --only-show-errors "s3://$HARNESS_BUCKET/bundles/$sha.json" "$dir/manifest.json"
  aws s3 cp --only-show-errors "s3://$HARNESS_BUCKET/bundles/$sha.tar.gz" "$dir/bundle.tar.gz"

  [ "$(jq -r .schema "$dir/manifest.json")" = "harness-benchmark/runner-bundle@1" ] || die "unexpected manifest schema"
  [ "$(jq -r .revision "$dir/manifest.json")" = "$sha" ] || die "manifest names another revision"
  local want got
  want="$(jq -r .archive.sha256 "$dir/manifest.json")"
  got="$(sha256sum "$dir/bundle.tar.gz" | cut -d' ' -f1)"
  [ "$want" = "$got" ] || die "bundle digest $got does not match manifest $want"
  want="$(jq -r .fileListSha256 "$dir/manifest.json")"
  got="$(tar -tzf "$dir/bundle.tar.gz" | grep -v '/$' | sed -n 's#^harness-benchmark/##p' | LC_ALL=C sort -u | sha256sum | cut -d' ' -f1)"
  [ "$want" = "$got" ] || die "bundle file list does not match the manifest"
  log "verified bundle $sha"

  install -d -m 0750 "$dir/tree"
  tar -xzf "$dir/bundle.tar.gz" -C "$dir/tree" --strip-components=1 --no-same-owner --no-same-permissions
  [ "$(cat "$dir/tree/.node-version")" = "$HARNESS_NODE_VERSION" ] || die ".node-version in the bundle ($(cat "$dir/tree/.node-version")) differs from the installed Node.js $HARNESS_NODE_VERSION; change the node_version Terraform variable"
  chown -R "$BENCH_USER:$BENCH_USER" "$dir"

  # Replace tracked source like a checkout would, keeping runtime state (.runs: logins, campaign
  # checkpoints), dependencies and records produced on this host.
  as_bench rsync -a --delete --exclude=/.runs/ --exclude=/records/ --exclude=node_modules/ --exclude=/.runner-release.json "$dir/tree/" "$WORK/"
  as_bench rsync -a --ignore-existing "$dir/tree/records/" "$WORK/records/"
  # Quota audits (records/<label>/block-NN/audit.json) are decided in the worktree and only travel
  # this way: always take the bundle's copy so a recorded reclassification reaches the campaign.
  as_bench rsync -a --prune-empty-dirs --include='*/' --include='audit.json' --exclude='*' "$dir/tree/records/" "$WORK/records/"
  as_bench cp "$dir/manifest.json" "$WORK/.runner-release.json"
  rm -f "$STATE/release-ready"
  echo "$sha" > "$STATE/current-revision"

  (cd "$WORK" && as_bench npm ci --no-audit --no-fund)
  (cd "$WORK" && as_bench npm run fixtures:install)
  (cd "$WORK" && ./node_modules/.bin/playwright install-deps chromium)
  (cd "$WORK" && as_bench ./node_modules/.bin/playwright install chromium)
  as_bench install -d -m 0700 "$WORK/.runs" "$WORK/.runs/auth" "$WORK/.runs/runner"
  check_userns
  date -u +%FT%TZ > "$STATE/release-ready"
  log "installed revision $sha in $WORK"
}

cmd_launch() {
  [ -f "$STATE/release-ready" ] || die "no installed release; run 'harness-bootstrap release <sha>' first"
  session_alive && die "a campaign is already running in tmux session '$SESSION'"
  local mode="" args=()
  while [ $# -gt 0 ]; do
    case "$1" in
      --pilots) mode=pilots; args+=(--pilots) ;;
      --block) [[ "${2:-}" =~ ^([1-9]|10)$ ]] || die "--block needs 1-10"; mode=block; args+=(--block "$2"); shift ;;
      --retry-unexercised) args+=(--retry-unexercised) ;;
      *) die "unsupported campaign argument: $1 (isolation is always required on the runner)" ;;
    esac
    shift
  done
  [ -n "$mode" ] || die "choose --pilots or --block N"
  if [ "$mode" = block ] && ! ls "$WORK"/records/freeze/*.json >/dev/null 2>&1; then
    die "no freeze manifest in records/freeze/; scored blocks run only at a frozen revision"
  fi
  local stamp; stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  as_bench tmux new-session -d -s "$SESSION" -c "$WORK" \
    "bash runner/aws/remote/campaign.sh ${args[*]} 2>&1 | tee -a .runs/runner/campaign-$stamp.log"
  log "started campaign (${args[*]}) in tmux session '$SESSION'; log .runs/runner/campaign-$stamp.log"
}

cmd_status() {
  echo "revision installed: $(cat "$STATE/current-revision" 2>/dev/null || echo none)"
  echo "release ready:      $(cat "$STATE/release-ready" 2>/dev/null || echo no)"
  echo "userns check:       $(cat "$STATE/userns-check" 2>/dev/null || echo not-run)"
  if session_alive; then echo "campaign:           running (tmux session '$SESSION')"; else echo "campaign:           not running"; fi
  if [ -f "$WORK/.runs/runner/last-exit.json" ]; then echo "last result:        $(cat "$WORK/.runs/runner/last-exit.json")"; fi
  local cohort pilots
  cohort="$(jq -r '.cohort // empty' "$WORK/config/matrix.json" 2>/dev/null || true)"
  pilots="$cohort-pilots"
  echo "cohort:             ${cohort:-unknown}"
  echo "pilot attempts:     $(find "$WORK/records/$pilots" -name attempt.json 2>/dev/null | wc -l)"
  echo "scored attempts:    $(find "$WORK/records/$cohort" -path '*/block-*' -name attempt.json 2>/dev/null | wc -l)"
  if [ -n "$cohort" ] && [ -f "$WORK/.runner-release.json" ]; then
    as_bench bash -c "cd '$WORK' && npm run --silent shell-health" 2>/dev/null || echo "shell health:       not available"
  fi
  echo "last sync:          $(cat "$STATE/last-sync" 2>/dev/null || echo never)"
  df -h / | tail -1 | awk '{print "disk:               " $3 " used, " $4 " free"}'
  local latest; latest="$(ls -1t "$WORK"/.runs/runner/campaign-*.log 2>/dev/null | head -1 || true)"
  if [ -n "$latest" ]; then echo "--- tail of $(basename "$latest")"; tail -n 25 "$latest"; fi
}

cmd_sync() {
  [ -d "$WORK/records" ] || { log "no records yet"; return; }
  [ -f "$WORK/package.json" ] || { log "no release installed"; return; }
  # Filters come from the bundle's allow-list (src/runner/records.ts), computed as bench; root only
  # passes the resulting strings to the AWS CLI. Symlinks are never followed.
  local filters=()
  while IFS= read -r line; do [ -n "$line" ] && filters+=("$line"); done < <(cd "$WORK" && as_bench node --disable-warning=ExperimentalWarning --experimental-strip-types src/cli/runner.ts s3-filters)
  [ "${#filters[@]}" -gt 2 ] || die "could not compute sync filters"
  aws s3 sync --only-show-errors --no-follow-symlinks "${filters[@]}" "$WORK/records/" "s3://$HARNESS_BUCKET/records/"
  date -u +%FT%TZ > "$STATE/last-sync"
  log "records synced to s3://$HARNESS_BUCKET/records/"
}

case "${1:-}" in
  system) cmd_system ;;
  release) shift; cmd_release "$@" ;;
  launch) shift; cmd_launch "$@" ;;
  status) cmd_status ;;
  sync) cmd_sync ;;
  check-userns) check_userns ;;
  *) echo "usage: harness-bootstrap system|release <sha>|launch (--pilots [--retry-unexercised] | --block N)|status|sync|check-userns" >&2; exit 2 ;;
esac
