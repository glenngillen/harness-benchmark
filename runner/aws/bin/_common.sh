# Shared helpers for runner/aws/bin/* (sourced, not executed). Runs on your machine with your own
# AWS credentials; bash 3.2 compatible (macOS). Needs: aws (v2), git, node/npm (this package).
#
# Target selection, first match wins:
#   HARNESS_INSTANCE_ID / HARNESS_BUCKET / HARNESS_REGION environment variables, else
#   `terraform output` from runner/aws/terraform (the state you created with `terraform apply`).
set -euo pipefail

AWS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BENCH_ROOT="$(cd "$AWS_DIR/../.." && pwd)"
TF_DIR="$AWS_DIR/terraform"

die() { echo "error: $*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "$1 is required on PATH"; }

tf_out() { terraform -chdir="$TF_DIR" output -raw "$1" 2>/dev/null || true; }

load_target() {
  need aws
  HARNESS_REGION="${HARNESS_REGION:-$(tf_out region)}"
  HARNESS_BUCKET="${HARNESS_BUCKET:-$(tf_out bucket_name)}"
  HARNESS_INSTANCE_ID="${HARNESS_INSTANCE_ID:-$(tf_out instance_id)}"
  [ -n "$HARNESS_REGION" ] || die "set HARNESS_REGION or apply the Terraform in $TF_DIR"
  [ -n "$HARNESS_BUCKET" ] || die "set HARNESS_BUCKET or apply the Terraform in $TF_DIR"
  export AWS_DEFAULT_REGION="$HARNESS_REGION"
}

require_instance() {
  [ -n "$HARNESS_INSTANCE_ID" ] || die "set HARNESS_INSTANCE_ID or apply the Terraform in $TF_DIR"
}

# Runs a shell command on the runner as root through SSM Run Command, waits, prints its output and
# returns its exit status. Usage: ssm_run <timeout-seconds> <command>
ssm_run() {
  local timeout="$1" command="$2" params id status code
  require_instance
  params="$(node -e 'process.stdout.write(JSON.stringify({commands:[process.argv[1]],executionTimeout:[process.argv[2]]}))' "$command" "$timeout")"
  id="$(aws ssm send-command --instance-ids "$HARNESS_INSTANCE_ID" --document-name AWS-RunShellScript \
    --comment "harness-benchmark runner" --parameters "$params" --query Command.CommandId --output text)"
  echo "ssm command $id: $command" >&2
  while :; do
    sleep 5
    status="$(aws ssm get-command-invocation --command-id "$id" --instance-id "$HARNESS_INSTANCE_ID" --query Status --output text 2>/dev/null || echo Pending)"
    case "$status" in Pending|InProgress|Delayed) ;; *) break ;; esac
  done
  aws ssm get-command-invocation --command-id "$id" --instance-id "$HARNESS_INSTANCE_ID" --query StandardOutputContent --output text
  aws ssm get-command-invocation --command-id "$id" --instance-id "$HARNESS_INSTANCE_ID" --query StandardErrorContent --output text >&2
  code="$(aws ssm get-command-invocation --command-id "$id" --instance-id "$HARNESS_INSTANCE_ID" --query ResponseCode --output text)"
  echo "ssm status $status, exit $code (output is truncated by SSM after 24,000 characters)" >&2
  [ "$status" = Success ]
}

# Prints the s3 sync filter arguments from the package's allow-list, one per line.
s3_filters() { (cd "$BENCH_ROOT" && npm run --silent runner -- s3-filters); }
