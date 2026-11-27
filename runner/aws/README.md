# AWS Linux runner

Pilots and scored blocks run on one EC2 Linux instance in `ap-southeast-2`. Each model stage and each evaluation is isolated there with `bwrap`. You reach the instance through SSM Session Manager, so there is no SSH key and no inbound port. Records come back through a private, versioned S3 bucket. Scored runs need Linux, because the evaluator and the stage sandbox use `bwrap`.

You apply the kit, log in, start campaigns, fetch the records and destroy it, using your own AWS credentials. Every command below runs from the benchmark's root directory: the repository root in a standalone clone.

## What gets created

| Resource | Configuration |
| --- | --- |
| VPC, one public subnet, internet gateway | `10.80.0.0/24`. No NAT gateway. |
| Security group | No ingress rules. Egress is TCP 443 (model APIs, npm, Node.js, SSM, S3) and TCP 80 (Ubuntu mirrors; apt checks package signatures). |
| EC2 instance | Ubuntu 24.04 LTS x86_64 (Canonical's SSM-published AMI), `t3.medium`, 40 GiB encrypted gp3 root volume, IMDSv2 only. The AMI is fixed at creation (`ignore_changes`), so a newer image never replaces a runner mid-campaign. |
| Instance role | `AmazonSSMManagedInstanceCore`, plus list/read on `bundles/*` and read/write on `records/*` in the one bucket. Nothing else. |
| S3 bucket | `harness-benchmark-records-<suffix>`. Public access blocked, owner-enforced, SSE-S3, versioned, TLS-only policy. Overwritten versions expire after 30 days. |

At first boot the user data installs `/usr/local/sbin/harness-bootstrap` (`remote/bootstrap.sh`) and runs `harness-bootstrap system`. That step:

- installs `bubblewrap`, `tmux`, `rsync`, `jq` and the AWS CLI;
- installs Node.js from nodejs.org after checking it against `SHASUMS256.txt`;
- creates the unprivileged `bench` user that runs everything.

It also makes three host-level changes:

- **bwrap user namespaces.** Ubuntu 24.04 only lets AppArmor-profiled programs create unprivileged user namespaces. The script loads a profile that grants this to `/usr/bin/bwrap` alone, rather than lifting the restriction for the whole system.
- **Metadata guard.** An `iptables` rule blocks the instance metadata service for every non-root user. The coding CLIs and the app under test run as `bench`, so they cannot obtain the role's bucket credentials.
- **Records sync.** A systemd timer uploads `records/` every 5 minutes. It runs as root and never follows symlinks.

The script then checks that `bench` can create a bubblewrap sandbox, using the same probe as `src/evaluator/sandbox.ts`. It also checks that `bench` cannot reach the metadata service. If either check fails, setup stops. Its log is `/var/log/harness-bootstrap.log`.

Cost: you pay for the instance, its volume, the public IPv4 address and S3 storage while they exist. The kit doesn't estimate that cost. `t3` instances default to unlimited CPU credits. That keeps measured elapsed times from being throttled, but sustained load above the baseline is billed.

## Prerequisites (your machine)

- Terraform ≥ 1.6, AWS CLI v2 and the [Session Manager plugin](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html) (needed for interactive sessions and port forwarding).
- AWS credentials for the account you want to use (for example `export AWS_PROFILE=…`).
- `git`, Node.js and `npm ci` already run in this package (the scripts call `npm run runner`).
- A ChatGPT plan with Codex access and a Claude subscription. Neither account may be able to buy paid overflow (see "Safeguard evidence" in `records/cohort-03-pilots/README.md`).

## 1. Create the runner

```sh
terraform -chdir=runner/aws/terraform init
terraform -chdir=runner/aws/terraform apply
terraform -chdir=runner/aws/terraform output
```

Wait for first-boot setup to finish: about 5 to 10 minutes, but that is an estimate, not a measurement. `runner/aws/bin/status` reports `userns check: ok` once it is done. If setup failed, read the log:

```sh
aws ssm start-session --region ap-southeast-2 --target "$(terraform -chdir=runner/aws/terraform output -raw instance_id)"
sudo tail -n 50 /var/log/harness-bootstrap.log
```

The scripts find the instance, bucket and region from `terraform output`. Alternatively, set `HARNESS_INSTANCE_ID`, `HARNESS_BUCKET` and `HARNESS_REGION`.

## 2. Publish a revision

```sh
runner/aws/bin/publish            # HEAD; or: runner/aws/bin/publish <commit>
```

`publish` makes a `git archive` of the benchmark directory at that commit (the whole commit in a standalone clone). Uncommitted changes are never included. It writes a manifest with the revision, tree, archive SHA-256 and file-list digest (`src/runner/bundle.ts`). Both files go to `s3://<bucket>/bundles/<sha>.{tar.gz,json}`, and `bundles/latest.json` is pointed at the new bundle.

On the instance, `harness-bootstrap release <sha>` does the following:

1. Downloads the bundle and refuses it unless the archive digest and file list match the manifest.
2. Unpacks it into `/opt/harness/work`. Like a checkout, this replaces tracked files but keeps `.runs/` (logins, campaign checkpoints), `node_modules` and the records produced on the host.
3. Saves the manifest as `.runner-release.json`. Attempt records and host evidence take the revision from that file, because the instance has no Git checkout.
4. Runs `npm ci`, which installs the pinned Codex and Claude Code CLIs from the lockfile, then installs the fixtures and Chromium.

`start` runs this release step for you.

## 3. Create the isolated subscription logins (once per instance)

**Quick way:** run `runner/aws/bin/login`. On a fresh runner it first publishes and installs this branch's HEAD; if the runner is still booting, it says so and you rerun it in a few minutes. Then it opens the Codex callback tunnel, then a session on the runner that walks through both logins as `bench`. It captures the Claude token for you, checks both logins with their preflights, and offers to restart the pilots. It skips any login that already works, so it is safe to rerun. The manual steps below do the same thing.

The logins live in `/opt/harness/work/.runs/auth/`. That directory belongs to `bench`, survives later releases, and is hidden from every model stage and evaluation sandbox. Do this after the first `start` has installed a release, or run `harness-bootstrap release <sha>` yourself as root first.

Open a shell on the runner as `bench`:

```sh
aws ssm start-session --region ap-southeast-2 --target <instance_id>
sudo -iu bench
cd /opt/harness/work
```

**Codex (ChatGPT login).**

1. In a **second terminal on your machine**, forward the login callback port: run the `codex_login_forward_command` from `terraform output`.
2. In the runner shell, start the login:

   ```sh
   CODEX_HOME="$PWD/.runs/auth/codex" npx codex login
   ```

3. Open the URL it prints in your local browser. The callback reaches the runner through the forwarded port.

Port 1455 is an assumption. If the printed URL's `redirect_uri` uses a different port, forward that port instead.

**Claude (subscription token).**

1. Run `npx claude setup-token` and complete its browser step.
2. Run `npm run claude:store-token`, paste the token it printed, then press Ctrl-D.

The token is read from stdin, so it never appears in argv or shell history. `setup-token` prints other text around the token, so copy just the token rather than piping its whole output.

Check both logins, then leave the shell:

```sh
npm run codex:preflight && npm run claude:preflight
exit
```

## 4. Start, follow and resume a campaign

```sh
runner/aws/bin/start --pilots                       # unscored pilots, all 24 configurations
runner/aws/bin/status                               # state, last result, attempt counts, log tail
runner/aws/bin/start --pilots --retry-unexercised   # after reading why a pilot failed early
runner/aws/bin/start --block 1                      # scored; only at a frozen revision
```

`start` installs the last published revision if it is not already installed. Then it runs `remote/campaign.sh` in a tmux session called `harness`, as `bench`. Before every campaign, `campaign.sh` runs `npm run shell-preflight`: one short real stage per client, inside the stage sandbox, that must run `node --version` successfully. If either shell is broken (Claude Code's Bash tool, for example, refuses to start without `socat`), the campaign is not started, the result is exit 78, and the details are in the log and `.runs/runner/shell-preflight.json`. `bin/status` also prints `npm run shell-health`: per provider, how many implement stages ran a command successfully. A `WARNING` line there means stop (`bin/blocks stop`) and look. To use a specific revision, pass `--revision <sha>`. On the runner, isolation is always `--isolation required`. `start` refuses to install or launch anything while a campaign is running. It also refuses `--block` unless `records/freeze/` holds a freeze manifest.

To watch a campaign live, attach to the tmux session and detach again with Ctrl-b d:

```sh
aws ssm start-session --target <instance_id>
sudo -iu bench tmux attach -t harness
```

`campaign.sh` runs these steps:

1. It records host evidence before the campaign (`npm run host-evidence`). The evidence covers both subscription preflights and the bubblewrap probe, with OS, kernel, Node.js, CLI and bwrap versions, the user-namespace kernel settings, a SHA-256 of `/etc/machine-id` and a timestamp. Every attempt records the same machine-id hash in its environment, and `npm run freeze` refuses recorded evidence unless each pilot's hash matches it, so evidence from another instance built from the same image cannot stand in for this one.
2. It runs `npm run campaign -- <args> --isolation required`.
3. It records host evidence again after the campaign. For pilots, it then writes `records/<cohort>-pilots/readiness-<timestamp>.json` with `npm run freeze`, judged from that recorded evidence.
4. It writes `.runs/runner/last-exit.json`.

**Quota pauses.** The campaign exits `75` when it pauses: quota, access, or operational replacements used up. `status` shows the reason in the log tail. Wait until the quota recovers, then run the same `start` command again. Finished slots are skipped, interrupted attempts are replaced, and the installed revision is reused.

**Whole scored campaign, unattended:** `runner/aws/bin/blocks start` publishes and installs the frozen revision (the last commit that changed `records/freeze/<cohort>.json`, where the cohort comes from `config/matrix.json`; never `HEAD`). It then starts a driver on the instance that runs blocks 1 to 10 in order, so your machine can sleep. A quota or provider-outage pause waits 30 minutes and relaunches the same block, up to 48 times. Any other pause stops the driver. `bin/blocks status` shows its log and the runner status, and `bin/blocks stop` stops it before the next block. Rerunning `bin/blocks start` is always safe, because finished blocks complete immediately.

**Disk.** Every attempt keeps a runtime workspace of about 0.12 GiB, so 10 blocks need about 30 GiB beyond the pilots. Grow a live runner with `runner/aws/bin/grow-disk 80`. It works online, while a campaign runs. Do not use `terraform apply` on a live runner just to resize the disk.

## 5. Fetch the records

```sh
runner/aws/bin/fetch              # add --dry-run to see what would change
git status records/
```

`fetch` runs three steps:

1. It asks the runner to sync now.
2. It downloads `s3://<bucket>/records/` into `.runs/fetch/<timestamp>/` (gitignored).
3. It copies only allowed record files into `records/`.

Allowed records are `.json`, `.jsonl`, `.md` and `.txt` files under `records/`. Hidden paths, `.runs`, `auth`, `node_modules` and `workspace` directories, credential-like names and symlinks are rejected (`src/runner/records.ts`). The same allow-list filters both S3 syncs.

The fetch report, `.runs/fetch/<timestamp>/report.json`, lists new, changed and rejected files. Rejected files are never copied. Read the report before committing. Then run `npm run freeze` locally: by default it judges the runner's recorded evidence instead of probing your machine.

## 6. Destroy everything

Do this only after the records are fetched **and committed**, and the block audits need no reruns.

```sh
runner/aws/bin/teardown
```

It refuses while a campaign or the blocks driver is running. It runs a final fetch and refuses if that brings anything uncommitted into `records/`. Then it asks you to type `destroy`, allows deleting the versioned bucket (`apply -target=aws_s3_bucket.records -var force_destroy_bucket=true`, which touches nothing else), and runs `terraform destroy`.

The destroy removes the instance and its volume, along with the logins on it. It also removes the bucket with every object version, the role, and the network.

The subscription credentials stay valid until you revoke them. To revoke them, sign out the Codex device in your ChatGPT account settings and revoke the Claude token in your Claude account settings.

Keep `runner/aws/terraform/terraform.tfstate` until `destroy` has finished. It is gitignored.

## Script reference

| Script | Runs where | What it does |
| --- | --- | --- |
| `bin/publish [rev]` | your machine | `git archive` + manifest → `s3://<bucket>/bundles/` |
| `bin/start (--pilots [--retry-unexercised] \| --block N) [--revision sha]` | your machine → SSM | `harness-bootstrap release <sha>` then `launch` |
| `bin/status` | your machine → SSM | `harness-bootstrap status` |
| `bin/blocks start\|status\|stop` | your machine → SSM | frozen revision, then an on-instance driver running blocks 1–10 with quota waits |
| `bin/grow-disk [GiB]` | your machine → EC2 + SSM | online root-volume and filesystem resize |
| `npm run shell-preflight` / `npm run shell-health` | runner (from `campaign.sh` / `status`) | real one-command stage per client before a campaign / live shell health of implement stages |
| `bin/teardown` | your machine → SSM + Terraform | running check, final fetch, then destroy everything |
| `bin/login` | your machine → SSM session | tunnel + `remote/login.sh` as `bench`: Codex and Claude logins, preflights |
| `bin/fetch [--no-sync] [--dry-run]` | your machine (+ SSM sync) | S3 → staging → allowed files into `records/` |
| `remote/bootstrap.sh` | instance, root | `system`, `release`, `launch`, `status`, `sync`, `check-userns` |
| `remote/campaign.sh` | instance, `bench`, in tmux | host evidence → campaign → host evidence → readiness report |

## What has been checked

The kit ran the cohort-03 pilots and all ten scored blocks (`records/cohort-03-pilots/`, `records/cohort-03/`) on a `t3.medium` in `ap-southeast-2`.

- **Isolation.** The host evidence (`records/cohort-03-pilots/host-evidence/`) records `bubblewrap 0.9.0` with `kernel.apparmor_restrict_unprivileged_userns=1` still set. The bwrap-only AppArmor profile was enough: the system-wide restriction never had to be lifted.
- **Logins.** Both subscription logins were created with `bin/login`. All 24 host-evidence records made after the logins show both preflights passing. The two made before them show `auth-missing`, from a start attempted before the logins existed.
- **Records.** `bin/fetch` brought back every record in this repository. Each block's quota audit is in `records/cohort-03/block-NN/audit.json`.

Terraform validation and `shellcheck` aren't automated. Run them yourself before applying changes to the kit:

```sh
terraform -chdir=runner/aws/terraform init -backend=false && terraform -chdir=runner/aws/terraform validate
shellcheck runner/aws/bin/* runner/aws/remote/*.sh
```

If a step fails on a new instance, the log and `status` output say where.
