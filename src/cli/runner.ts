/**
 * Local helpers for the AWS runner scripts in runner/aws/bin/. Never calls AWS: the shell scripts
 * run the AWS CLI and call these subcommands for the parts that must be exact.
 *
 *   npm run runner -- manifest --revision <sha> --tree <sha> --archive <file> --files-from <file>
 *       Print the bundle manifest JSON for a `git archive` tarball (src/runner/bundle.ts).
 *   npm run runner -- s3-filters
 *       Print the `aws s3 sync` include/exclude arguments, one per line (src/runner/records.ts).
 *   npm run runner -- fetch-apply --staged <dir> [--report <file>] [--dry-run]
 *       Copy allowed records from a staged bucket download into records/, and report what changed.
 *
 * Exit 0 on success, 1 on invalid input, 2 on usage error.
 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { BENCHMARK_ROOT } from '../fixtures.ts';
import { buildBundleManifest, fileListText } from '../runner/bundle.ts';
import { planFetch, s3SyncFilterArgs, type StagedFile } from '../runner/records.ts';

const [command, ...rest] = process.argv.slice(2);
const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const usage = () => {
  console.error('usage: runner manifest --revision <sha> --tree <sha> --archive <file> --files-from <file> | runner s3-filters | runner fetch-apply --staged <dir> [--report <file>] [--dry-run]');
  process.exit(2);
};

/** Regular files under `dir`, relative, without following symlinks (a symlink is never a record). */
function walk(dir: string, base = dir, out: { rel: string; abs: string; symlink: boolean }[] = []) {
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    const st = lstatSync(abs);
    if (st.isDirectory()) walk(abs, base, out);
    else out.push({ rel: relative(base, abs).split(sep).join('/'), abs, symlink: !st.isFile() });
  }
  return out;
}

if (command === 'manifest') {
  const { values } = parseArgs({ args: rest, options: { revision: { type: 'string' }, tree: { type: 'string' }, archive: { type: 'string' }, 'files-from': { type: 'string' } } });
  if (!values.revision || !values.tree || !values.archive || !values['files-from']) usage();
  const archive = readFileSync(values.archive!);
  const files = readFileSync(values['files-from']!, 'utf8').split('\n').filter((l) => l !== '');
  try {
    const m = buildBundleManifest({
      revision: values.revision!,
      tree: values.tree!,
      createdAt: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
      archiveSha256: sha256(archive),
      archiveBytes: archive.length,
      files,
      fileListSha256: sha256(fileListText(files)),
    });
    process.stdout.write(`${JSON.stringify(m, null, 2)}\n`);
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
} else if (command === 's3-filters') {
  process.stdout.write(`${s3SyncFilterArgs().join('\n')}\n`);
} else if (command === 'fetch-apply') {
  const { values } = parseArgs({ args: rest, options: { staged: { type: 'string' }, report: { type: 'string' }, 'dry-run': { type: 'boolean', default: false } } });
  if (!values.staged) usage();
  const staged = resolve(values.staged!);
  if (!existsSync(staged)) {
    console.error(`${staged} does not exist`);
    process.exit(1);
  }
  const entries = walk(staged);
  const files: StagedFile[] = entries.filter((e) => !e.symlink).map((e) => ({ rel: e.rel, bytes: statSync(e.abs).size, sha256: sha256(readFileSync(e.abs)) }));
  const existing = new Map<string, string>();
  for (const f of files) {
    const dest = join(BENCHMARK_ROOT, 'records', f.rel);
    if (existsSync(dest) && lstatSync(dest).isFile()) existing.set(`records/${f.rel}`, sha256(readFileSync(dest)));
  }
  const plan = planFetch(files, existing);
  const symlinks = entries.filter((e) => e.symlink).map((e) => ({ rel: e.rel, reason: 'not-a-regular-file' as const }));
  if (!values['dry-run']) {
    for (const c of plan.copy) {
      const dest = join(BENCHMARK_ROOT, c.to);
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(join(staged, c.from), dest);
    }
  }
  const report = {
    schema: 'harness-benchmark/runner-fetch@1',
    fetchedAt: new Date().toISOString(),
    staged: relative(BENCHMARK_ROOT, staged),
    dryRun: values['dry-run'],
    new: plan.copy.filter((c) => c.change === 'new').map((c) => c.to),
    changed: plan.copy.filter((c) => c.change === 'changed').map((c) => c.to),
    unchanged: plan.unchanged.length,
    rejected: [...plan.rejected, ...symlinks],
  };
  const text = `${JSON.stringify(report, null, 2)}\n`;
  process.stdout.write(text);
  if (values.report) {
    mkdirSync(dirname(values.report), { recursive: true });
    writeFileSync(values.report, text);
  }
  if (report.rejected.length > 0) console.error(`${report.rejected.length} staged file(s) were not copied; see "rejected"`);
} else {
  usage();
}
