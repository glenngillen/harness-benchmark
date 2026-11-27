import { cpSync, mkdirSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export const BENCHMARK_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REFERENCES = join(BENCHMARK_ROOT, 'fixtures', 'references');
const SKIP = new Set(['node_modules', 'dist', 'data']);

export interface BrokenReference {
  id: string;
  behaviour: string;
  files: string[];
  fault: string;
}

export interface TamperReference {
  id: string;
  /** `correct` or a broken reference id that this tamper overlay is applied on top of. */
  base: string;
  files: string[];
  attempt: string;
  expect: { status: 'passed' | 'failed'; failing: string[]; note: string };
}

export interface PlannedFile {
  path: string;
  from: 'correct' | 'overlay';
}

/** Pure: which source supplies each file of a materialised reference. Overlays may only replace existing files. */
export function planReferenceFiles(correct: readonly string[], overlay: readonly string[]): PlannedFile[] {
  const known = new Set(correct);
  const unknown = overlay.filter((f) => !known.has(f));
  if (unknown.length > 0) throw new Error(`overlay files not in correct reference: ${unknown.join(', ')}`);
  const replaced = new Set(overlay);
  return correct.map((path) => ({ path, from: replaced.has(path) ? 'overlay' : 'correct' }));
}

/** Relative paths of every file under `root`, skipping installed/build/runtime directories. */
export function listFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (SKIP.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(relative(root, full).split('\\').join('/'));
    }
  };
  walk(root);
  return out.sort();
}

export function loadBrokenManifest(): BrokenReference[] {
  return JSON.parse(readFileSync(join(REFERENCES, 'broken', 'manifest.json'), 'utf8')) as BrokenReference[];
}

export function loadTamperManifest(): TamperReference[] {
  return JSON.parse(readFileSync(join(REFERENCES, 'tamper', 'manifest.json'), 'utf8')) as TamperReference[];
}

/** Overlay directories applied on top of `correct`, in order, for a reference name. */
export function overlayChain(name: string, broken: readonly { id: string }[], tamper: readonly { id: string; base: string }[]): string[] {
  if (name === 'correct') return [];
  if (broken.some((m) => m.id === name)) return [join('broken', name)];
  const t = tamper.find((m) => m.id === name);
  if (!t) throw new Error(`unknown reference: ${name}`);
  if (t.base !== 'correct' && !broken.some((m) => m.id === t.base)) throw new Error(`tamper ${name} has unknown base ${t.base}`);
  return [...(t.base === 'correct' ? [] : [join('broken', t.base)]), join('tamper', name)];
}

/** Copies `correct`, a broken reference, or a tamper reference (correct + overlays) into a new, empty directory. */
export function materialiseReference(name: string, dest: string): PlannedFile[] {
  if (existsSync(dest) && readdirSync(dest).length > 0) throw new Error(`destination not empty: ${dest}`);
  const correctRoot = join(REFERENCES, 'correct');
  const correctFiles = listFiles(correctRoot);
  const source = new Map(correctFiles.map((f) => [f, correctRoot]));
  for (const rel of overlayChain(name, loadBrokenManifest(), loadTamperManifest())) {
    const root = join(REFERENCES, rel);
    for (const p of planReferenceFiles(correctFiles, listFiles(root))) if (p.from === 'overlay') source.set(p.path, root);
  }
  const plan: PlannedFile[] = correctFiles.map((path) => ({ path, from: source.get(path) === correctRoot ? 'correct' : 'overlay' }));
  for (const file of plan) {
    const target = join(dest, file.path);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(join(source.get(file.path)!, file.path), target);
  }
  return plan;
}
