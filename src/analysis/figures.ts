/**
 * Static, accessible SVG figures with CSV text equivalents, one set per workflow (never pooled):
 *
 *   <wf>-acceptance   accepted / scored with 95% Wilson intervals
 *   <wf>-cost         cost per accepted workflow with the bootstrap interval; undefined, unavailable
 *                     and lower-bound figures are drawn as words, never as a finite mark
 *   <wf>-tokens       mean tokens per scored workflow by billing category (exact counts only)
 *   <wf>-elapsed      every active-time observation, median and IQR, against the 30-minute ceiling
 *
 * Collaboration figures repeat the solo conditions in a separate, labelled "solo controls" group
 * (the same observations, not new ones). Check conditions are told apart by marker shape and a
 * legend as well as colour; every mark carries a <title> tooltip; light and dark palettes are
 * selected separately (dataviz reference palette, slots 1–4). Pure string builders.
 */
import type { Analysis, ConditionSummary } from './aggregate.ts';
import { toCsv } from './tables.ts';

export interface FigureContext {
  /** Price snapshot date shown on every figure, e.g. `2026-11-13`. */
  snapshotDate: string;
  /** Minutes; drawn as a dashed reference line on the elapsed figure. */
  ceilingMinutes: number;
}

export interface Figure {
  name: string;
  svg: string;
  csv: string;
}

export const LABEL_W = 272;
export const RIGHT_W = 124;
export const W = 760;
const PLOT_X0 = LABEL_W;
const PLOT_X1 = W - RIGHT_W;
const FONT = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";

const STYLE = `
  .bg { fill: #fcfcfb; }
  .t1 { fill: #0b0b0b; } .t2 { fill: #52514e; } .t3 { fill: #6f6e69; }
  .grid { stroke: #e4e3de; stroke-width: 1; } .axis { stroke: #b9b8b2; stroke-width: 1; }
  .ref { stroke: #6f6e69; stroke-width: 1.5; stroke-dasharray: 4 3; }
  .off { fill: #2a78d6; stroke: #2a78d6; } .on { fill: #eb6834; stroke: #eb6834; }
  .hollow { fill: #fcfcfb; stroke-width: 2; }
  .ci { stroke-width: 2; fill: none; stroke-linecap: round; }
  .med { stroke: #0b0b0b; stroke-width: 2; }
  .k1 { fill: #2a78d6; } .k2 { fill: #eb6834; } .k3 { fill: #1baf7a; } .k4 { fill: #eda100; }
  .seg { stroke: #fcfcfb; stroke-width: 2; }
  .band { fill: #f3f2ee; }
  @media (prefers-color-scheme: dark) {
    .bg { fill: #1a1a19; } .hollow { fill: #1a1a19; } .seg { stroke: #1a1a19; }
    .t1 { fill: #f0efec; } .t2 { fill: #c3c2b7; } .t3 { fill: #9d9c94; }
    .grid { stroke: #33332f; } .axis { stroke: #5a5953; } .ref { stroke: #9d9c94; }
    .off { fill: #3987e5; stroke: #3987e5; } .on { fill: #d95926; stroke: #d95926; }
    .med { stroke: #f0efec; } .band { fill: #232321; }
    .k1 { fill: #3987e5; } .k2 { fill: #d95926; } .k3 { fill: #199e70; } .k4 { fill: #c98500; }
  }`;

export const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function statusLine(a: Analysis, ctx: FigureContext): string {
  const d = a.dataset === 'synthetic' ? 'SYNTHETIC FIXTURE, not an observation' : a.dataset === 'pilot' ? 'PILOT, unscored' : a.completeness.complete ? `${a.completeness.scoredSlots} scored workflows` : `INCOMPLETE: ${a.completeness.scoredSlots} of ${a.completeness.scheduledSlots} scored, methodology only`;
  return `${a.cohort} · ${d} · cost.dev prices ${ctx.snapshotDate}`;
}

export function niceTicks(max: number, target = 5): number[] {
  if (!(max > 0) || !Number.isFinite(max)) return [0, 1];
  const raw = max / target;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw)!;
  const n = Math.max(1, Math.ceil(max / step - 1e-12));
  return Array.from({ length: n + 1 }, (_, i) => Number((i * step).toPrecision(12)));
}

interface Row {
  label: string;
  sub?: string;
  height: number;
  draw: (yMid: number) => string;
}
interface Group {
  heading: string;
  rows: Row[];
}

/** Short row label (model names); the long role labels go in tooltips and CSVs. */
const assignmentText = (c: ConditionSummary) => c.assignmentModels.join(' → ');
const roleText = (c: ConditionSummary) => c.assignmentLabels.join(' → ');
const effortText = (c: ConditionSummary) => `effort ${c.assignmentEfforts.join(' → ')}`;

/** Group the workflow's own conditions, and for collaborations the solo controls. */
function groups(a: Analysis, wf: string): Array<{ heading: string; conditions: ConditionSummary[] }> {
  const w = a.workflows[wf]!;
  const out = [{ heading: `${w.label}`, conditions: w.conditions }];
  if (w.controls.length) out.push({ heading: 'Solo controls (same observations as the solo figure)', conditions: w.controls.map((id) => a.workflows.solo!.conditions.find((c) => c.conditionId === id)!).filter(Boolean) });
  return out;
}

/** Assignments in order, each with its off and on condition. */
function byAssignment(cs: ConditionSummary[]): Array<{ label: string; sub: string; off?: ConditionSummary; on?: ConditionSummary }> {
  const m = new Map<string, { label: string; sub: string; off?: ConditionSummary; on?: ConditionSummary }>();
  for (const c of cs) {
    const k = c.assignment.join('-');
    const e = m.get(k) ?? { label: assignmentText(c), sub: effortText(c) };
    e[c.checks as 'off' | 'on'] = c;
    m.set(k, e);
  }
  return [...m.values()];
}

function marker(checks: string, x: number, y: number, tip: string, hollow = false): string {
  const cls = `${checks}${hollow ? ' hollow' : ''}`;
  const body = checks === 'on' ? `<path class="${cls}" d="M${x} ${y - 6}L${x + 6} ${y}L${x} ${y + 6}L${x - 6} ${y}Z"/>` : `<circle class="${cls}" cx="${x}" cy="${y}" r="5"/>`;
  return `<g><title>${esc(tip)}</title><rect x="${x - 9}" y="${y - 9}" width="18" height="18" fill="transparent"/>${body}</g>`;
}

function legendChecks(y: number): string {
  return `${marker('off', PLOT_X0 + 6, y, 'Checks off: native loop only')}<text class="t2" x="${PLOT_X0 + 16}" y="${y + 4}">checks off</text>${marker('on', PLOT_X0 + 104, y, 'Checks on: added deterministic build-time checks')}<text class="t2" x="${PLOT_X0 + 114}" y="${y + 4}">checks on</text>`;
}

function frame(o: { name: string; title: string; subtitle: string; desc: string; legend: string; groups: Group[]; xTicks: number[]; xScale: (v: number) => number; xFormat: (v: number) => string; xTitle: string; extra?: (top: number, bottom: number) => string }): string {
  const top = 92;
  let y = top;
  const parts: string[] = [];
  const bands: string[] = [];
  for (const g of o.groups) {
    parts.push(`<text class="t1" x="16" y="${y + 15}" font-weight="600">${esc(g.heading)}</text>`);
    y += 24;
    g.rows.forEach((r, i) => {
      const mid = y + r.height / 2;
      if (i % 2 === 0) bands.push(`<rect class="band" x="8" y="${y}" width="${W - 16}" height="${r.height}" rx="3"/>`);
      parts.push(`<text class="t1" x="16" y="${r.sub ? mid - 2 : mid + 4}">${esc(r.label)}</text>`);
      if (r.sub) parts.push(`<text class="t3" x="16" y="${mid + 12}" font-size="11">${esc(r.sub)}</text>`);
      parts.push(r.draw(mid));
      y += r.height;
    });
    y += 10;
  }
  const bottom = y;
  const grid = o.xTicks.map((t) => `<line class="grid" x1="${o.xScale(t)}" x2="${o.xScale(t)}" y1="${top}" y2="${bottom}"/><text class="t2" x="${o.xScale(t)}" y="${bottom + 16}" text-anchor="middle">${esc(o.xFormat(t))}</text>`).join('');
  const h = bottom + 48;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${h}" width="${W}" height="${h}" role="img" aria-labelledby="${o.name}-title ${o.name}-desc" font-family="${FONT}" font-size="12">
<title id="${o.name}-title">${esc(o.title)}</title>
<desc id="${o.name}-desc">${esc(o.desc)}</desc>
<style>${STYLE}</style>
<rect class="bg" width="${W}" height="${h}"/>
<text class="t1" x="16" y="26" font-size="16" font-weight="600">${esc(o.title)}</text>
<text class="t2" x="16" y="46">${esc(o.subtitle)}</text>
<g transform="translate(0 0)">${o.legend}</g>
${bands.join('')}
${grid}<line class="axis" x1="${PLOT_X0}" x2="${PLOT_X0}" y1="${top}" y2="${bottom}"/>
${o.extra ? o.extra(top, bottom) : ''}
${parts.join('\n')}
<text class="t2" x="${(PLOT_X0 + PLOT_X1) / 2}" y="${bottom + 36}" text-anchor="middle">${esc(o.xTitle)}</text>
</svg>
`;
}

const scale = (max: number) => (v: number) => Number((PLOT_X0 + (Math.min(v, max) / max) * (PLOT_X1 - PLOT_X0)).toFixed(2));
const legendY = 70;

// ---------------------------------------------------------------- acceptance

export function acceptanceFigure(a: Analysis, wf: string, ctx: FigureContext): Figure {
  const name = `${wf}-acceptance`;
  const x = scale(1);
  const gs: Group[] = groups(a, wf).map((g) => ({
    heading: g.heading,
    rows: byAssignment(g.conditions).map((asg) => ({
      label: asg.label,
      sub: asg.sub,
      height: 40,
      draw: (mid) =>
        (['off', 'on'] as const)
          .map((k, i) => {
            const c = asg[k];
            const y = mid + (i === 0 ? -8 : 8);
            if (!c) return '';
            if (c.scored === 0) return `<text class="t3" x="${PLOT_X0 + 8}" y="${y + 4}">${k}: no scored workflows</text>`;
            const p = c.acceptance;
            const tip = `${roleText(c)} (${asg.sub}), checks ${k}: ${c.accepted} of ${c.scored} accepted (${(p.estimate! * 100).toFixed(0)}%; 95% Wilson ${(p.lower! * 100).toFixed(0)}–${(p.upper! * 100).toFixed(0)}%)`;
            return `<line class="ci ${k}" x1="${x(p.lower!)}" x2="${x(p.upper!)}" y1="${y}" y2="${y}"/>${marker(k, x(p.estimate!), y, tip)}<text class="t1" x="${PLOT_X1 + 12}" y="${y + 4}">${c.accepted}/${c.scored}</text>`;
          })
          .join(''),
    })),
  }));
  const svg = frame({
    name,
    title: `${a.workflows[wf]!.label}: accepted workflows`,
    subtitle: statusLine(a, ctx),
    desc: `Share of scored workflows accepted by the independent evaluator, per assignment and check condition, with 95% Wilson intervals. Labels give accepted over scored. Data table: ${name}.csv.`,
    legend: `${legendChecks(legendY)}<text class="t2" x="${PLOT_X1 + 12}" y="${legendY + 4}">accepted/scored</text>`,
    groups: gs,
    xTicks: [0, 0.25, 0.5, 0.75, 1],
    xScale: x,
    xFormat: (v) => `${v * 100}%`,
    xTitle: 'Accepted share (dot) with 95% Wilson interval (line)',
  });
  const rows = groups(a, wf).flatMap((g, gi) => g.conditions.map((c) => [a.cohort, a.dataset, gi === 0 ? 'condition' : 'solo-control', c.conditionId, roleText(c), c.checks, c.scored, c.expected, c.accepted, c.acceptance.estimate, c.acceptance.lower, c.acceptance.upper]));
  return { name, svg, csv: toCsv(['cohort', 'dataset', 'group', 'condition', 'assignment', 'checks', 'scored', 'expected', 'accepted', 'acceptance', 'wilson95_lower', 'wilson95_upper'], rows) };
}

// ---------------------------------------------------------------- cost per accepted

function costMax(cs: ConditionSummary[]): number {
  const v: number[] = [];
  for (const c of cs) {
    const p = c.costPerAccepted;
    for (const x of [p.usd, p.lowerUsd, p.upperUsd]) if (x !== null) v.push(x);
    for (const b of [c.bootstrap.exact, c.bootstrap.lowerCosts, c.bootstrap.upperCosts]) if (b) for (const x of [b.lower, b.upper]) if (x !== null) v.push(x);
  }
  return v.length ? Math.max(...v) : 1;
}

export function money(v: number, max: number): string {
  if (v === 0) return '$0';
  return `$${v.toFixed(max < 0.1 ? 4 : max < 10 ? 2 : 0)}`;
}

export function costFigure(a: Analysis, wf: string, ctx: FigureContext): Figure {
  const name = `${wf}-cost`;
  const all = groups(a, wf).flatMap((g) => g.conditions);
  const ticks = niceTicks(costMax(all));
  const max = ticks[ticks.length - 1]!;
  const x = scale(max);
  const fmt = (v: number) => money(v, max);
  const drawOne = (c: ConditionSummary, k: string, y: number): string => {
    const p = c.costPerAccepted;
    const right = (s: string) => `<text class="t1" x="${PLOT_X1 + 12}" y="${y + 4}">${esc(s)}</text>`;
    const base = `${roleText(c)} (${effortText(c)}), checks ${k}: ${c.accepted} of ${c.scored} accepted`;
    if (c.scored === 0) return `<text class="t3" x="${PLOT_X0 + 8}" y="${y + 4}">${k}: no scored workflows</text>`;
    if (p.status === 'undefined') return `<g><title>${esc(`${base}; no finite cost per accepted workflow`)}</title><text class="t2" x="${PLOT_X0 + 8}" y="${y + 4}">${k}: undefined, 0 of ${c.scored} accepted</text></g>${right('undefined')}`;
    if (p.status === 'unavailable') return `<g><title>${esc(`${base}; cost unavailable: ${c.totalCost.reasons[0] ?? ''}`)}</title><text class="t2" x="${PLOT_X0 + 8}" y="${y + 4}">${k}: cost unavailable (missing price or stage record)</text></g>${right('unavailable')}`;
    if (p.status === 'lower-bound') {
      const x0 = x(p.lowerUsd!);
      return `<line class="ci ${k}" x1="${x0}" x2="${PLOT_X1}" y1="${y}" y2="${y}" stroke-dasharray="2 3"/>${marker(k, x0, y, `${base}; at least ${fmt(p.lowerUsd!)} per accepted workflow (some usage category unknown)`, true)}${right(`≥ ${fmt(p.lowerUsd!)}`)}`;
    }
    if (p.status === 'bounded') {
      const x0 = x(p.lowerUsd!);
      const x1 = x(p.upperUsd!);
      return `<g><title>${esc(`${base}; between ${fmt(p.lowerUsd!)} and ${fmt(p.upperUsd!)} per accepted workflow (bounds, not an interval); ${c.bootstrap.status === 'bounds' ? 'bootstrap reported in the table' : c.bootstrap.reason ?? ''}`)}</title><rect class="${k}" x="${x0}" y="${y - 4}" width="${Math.max(2, x1 - x0)}" height="8" rx="2" opacity="0.55"/></g>${right(`${fmt(p.lowerUsd!)}–${fmt(p.upperUsd!)}`)}`;
    }
    const b = c.bootstrap.exact;
    let ci = '';
    let ciText = 'interval suppressed';
    if (b) {
      const lo = b.lower === null ? PLOT_X0 : x(b.lower);
      const hi = b.upper === null ? PLOT_X1 : x(b.upper);
      ci = `<line class="ci ${k}" x1="${lo}" x2="${hi}" y1="${y}" y2="${y}"/>${b.upper === null ? `<path class="${k}" d="M${PLOT_X1} ${y - 4}L${PLOT_X1 + 6} ${y}L${PLOT_X1} ${y + 4}Z"/>` : ''}`;
      ciText = `bootstrap 95% ${b.lower === null ? 'unbounded' : fmt(b.lower)} to ${b.upper === null ? 'unbounded' : fmt(b.upper)}; ${(b.undefinedFraction * 100).toFixed(1)}% of resamples had no accepted workflow`;
    }
    return `${ci}${marker(k, x(p.usd!), y, `${base}; ${fmt(p.usd!)} per accepted workflow; ${ciText}`)}${right(`${fmt(p.usd!)}${b && b.upper === null ? ' (open)' : ''}`)}`;
  };
  const gs: Group[] = groups(a, wf).map((g) => ({
    heading: g.heading,
    rows: byAssignment(g.conditions).map((asg) => ({
      label: asg.label,
      sub: asg.sub,
      height: 40,
      draw: (mid) => (['off', 'on'] as const).map((k, i) => (asg[k] ? drawOne(asg[k]!, k, mid + (i === 0 ? -9 : 9)) : '')).join(''),
    })),
  }));
  const svg = frame({
    name,
    title: `${a.workflows[wf]!.label}: estimated cost per accepted workflow`,
    subtitle: statusLine(a, ctx),
    desc: `Total API-equivalent estimated cost of all scored workflows, including failures, divided by accepted workflows, with a within-condition percentile bootstrap. Undefined (zero accepted), unavailable and lower-bound figures are written out rather than plotted as values. Not subscription charges. Data table: ${name}.csv.`,
    legend: `${legendChecks(legendY)}<text class="t2" x="${PLOT_X1 + 12}" y="${legendY + 4}">per accepted</text>`,
    groups: gs,
    xTicks: ticks,
    xScale: x,
    xFormat: fmt,
    xTitle: 'USD per accepted workflow (dot) with bootstrap 95% interval (line; arrow = unbounded)',
  });
  const rows = groups(a, wf).flatMap((g, gi) =>
    g.conditions.map((c) => {
      const b = c.bootstrap.exact;
      return [a.cohort, a.dataset, gi === 0 ? 'condition' : 'solo-control', c.conditionId, roleText(c), c.checks, c.scored, c.accepted, c.costPerAccepted.status, c.costPerAccepted.usd, c.costPerAccepted.lowerUsd, c.costPerAccepted.upperUsd, c.bootstrap.status, b ? (b.lower ?? 'unbounded') : null, b ? (b.upper ?? 'unbounded') : null, b ? b.undefinedFraction : null, c.totalCost.status, c.totalCost.usd, c.totalCost.lowerUsd, c.totalCost.upperUsd];
    }),
  );
  return { name, svg, csv: toCsv(['cohort', 'dataset', 'group', 'condition', 'assignment', 'checks', 'scored', 'accepted', 'cost_per_accepted_status', 'cost_per_accepted_usd', 'lower_usd', 'upper_usd', 'bootstrap_status', 'bootstrap95_lower_usd', 'bootstrap95_upper_usd', 'bootstrap_undefined_fraction', 'total_cost_status', 'total_cost_usd', 'total_cost_lower_usd', 'total_cost_upper_usd'], rows) };
}

// ---------------------------------------------------------------- tokens

const TOKEN_GROUPS = [
  { key: 'input', label: 'uncached input', cls: 'k1', cats: ['input_tokens'] },
  { key: 'cached', label: 'cached input', cls: 'k2', cats: ['cached_input_tokens'] },
  { key: 'cacheWrite', label: 'cache writes', cls: 'k3', cats: ['cache_write_5m_tokens', 'cache_write_1h_tokens', 'cache_write_unsplit_tokens'] },
  { key: 'output', label: 'output (incl. reasoning)', cls: 'k4', cats: ['output_tokens'] },
] as const;

/** Mean tokens per scored workflow by display group, over workflows whose every category is exact. */
export function tokenMeans(c: ConditionSummary): { n: number; means: Record<string, number> | null } {
  const exact = c.workflows.filter((w) => Object.values(w.tokens).every((v) => v !== null));
  if (!exact.length) return { n: 0, means: null };
  const means = Object.fromEntries(TOKEN_GROUPS.map((g) => [g.key, exact.reduce((s, w) => s + g.cats.reduce((t, k) => t + (w.tokens[k] as number), 0), 0) / exact.length]));
  return { n: exact.length, means };
}

const kTok = (v: number) => (v >= 1e6 ? `${(v / 1e6).toFixed(v >= 1e7 ? 0 : 1)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(v >= 1e4 ? 0 : 1)}k` : `${Math.round(v)}`);

export function tokensFigure(a: Analysis, wf: string, ctx: FigureContext): Figure {
  const name = `${wf}-tokens`;
  const gsRaw = groups(a, wf);
  const totals = gsRaw.flatMap((g) => g.conditions.map((c) => tokenMeans(c))).flatMap((t) => (t.means ? [Object.values(t.means).reduce((s, v) => s + v, 0)] : []));
  const ticks = niceTicks(totals.length ? Math.max(...totals) : 1);
  const max = ticks[ticks.length - 1]!;
  const x = scale(max);
  const gs: Group[] = gsRaw.map((g) => ({
    heading: g.heading,
    rows: g.conditions.map((c) => ({
      label: assignmentText(c),
      sub: `checks ${c.checks}`,
      height: 34,
      draw: (mid) => {
        const t = tokenMeans(c);
        if (!t.means) return `<text class="t2" x="${PLOT_X0 + 8}" y="${mid + 4}">${c.scored ? `token counts not exact in all ${c.scored} workflows` : 'no scored workflows'}</text>`;
        let acc = 0;
        const segs = TOKEN_GROUPS.map((gr) => {
          const v = t.means![gr.key]!;
          if (v <= 0) return '';
          const x0 = x(acc);
          acc += v;
          const w = Math.max(1, x(acc) - x0);
          return `<g><title>${esc(`${roleText(c)}, checks ${c.checks}: ${gr.label} ${Math.round(v).toLocaleString('en-US')} tokens per scored workflow (mean of ${t.n})`)}</title><rect class="${gr.cls} seg" x="${x0}" y="${mid - 7}" width="${w}" height="14" rx="2"/></g>`;
        }).join('');
        return `${segs}<text class="t1" x="${PLOT_X1 + 12}" y="${mid + 4}">${kTok(acc)} · n=${t.n === c.scored ? t.n : `${t.n}/${c.scored}`}</text>`;
      },
    })),
  }));
  let lx = 16;
  const legend = TOKEN_GROUPS.map((g) => {
    const s = `<rect class="${g.cls}" x="${lx}" y="${legendY - 6}" width="12" height="12" rx="2"/><text class="t2" x="${lx + 16}" y="${legendY + 4}">${esc(g.label)}</text>`;
    lx += 26 + g.label.length * 6.4;
    return s;
  }).join('');
  const svg = frame({
    name,
    title: `${a.workflows[wf]!.label}: tokens per scored workflow`,
    subtitle: statusLine(a, ctx),
    desc: `Mean tokens per scored workflow by billing category, across all roles, over workflows whose counts are exact; n is shown and inexact workflows are counted separately. Token counts are per vendor and not comparable across tokenisers. Data table: ${name}.csv.`,
    legend,
    groups: gs,
    xTicks: ticks,
    xScale: x,
    xFormat: kTok,
    xTitle: 'Mean tokens per scored workflow, stacked by billing category',
  });
  const rows = gsRaw.flatMap((g, gi) =>
    g.conditions.map((c) => {
      const t = tokenMeans(c);
      return [a.cohort, a.dataset, gi === 0 ? 'condition' : 'solo-control', c.conditionId, roleText(c), c.checks, c.scored, t.n, ...TOKEN_GROUPS.map((gr) => (t.means ? Number(t.means[gr.key]!.toFixed(3)) : 'not exact'))];
    }),
  );
  return { name, svg, csv: toCsv(['cohort', 'dataset', 'group', 'condition', 'assignment', 'checks', 'scored', 'n_exact', ...TOKEN_GROUPS.map((g) => `mean_${g.key}_tokens`)], rows) };
}

// ---------------------------------------------------------------- elapsed

export function elapsedFigure(a: Analysis, wf: string, ctx: FigureContext): Figure {
  const name = `${wf}-elapsed`;
  const gsRaw = groups(a, wf);
  const obsMax = Math.max(ctx.ceilingMinutes, ...gsRaw.flatMap((g) => g.conditions.flatMap((c) => c.elapsedMs.observations.map((v) => v / 60_000))));
  const ticks = niceTicks(obsMax, 6);
  const max = ticks[ticks.length - 1]!;
  const x = scale(max);
  const m = (ms: number) => ms / 60_000;
  const gs: Group[] = gsRaw.map((g) => ({
    heading: g.heading,
    rows: g.conditions.map((c) => ({
      label: assignmentText(c),
      sub: `checks ${c.checks}`,
      height: 34,
      draw: (mid) => {
        const e = c.elapsedMs;
        if (!e.n) return `<text class="t2" x="${PLOT_X0 + 8}" y="${mid + 4}">no elapsed observations</text>`;
        const iqr = `<line class="ci ${c.checks}" x1="${x(m(e.q1!))}" x2="${x(m(e.q3!))}" y1="${mid}" y2="${mid}" opacity="0.5" stroke-width="6"/>`;
        const pts = c.workflows
          .flatMap((w) => (w.activeMs === null ? [] : [w]))
          .map((w, i) => {
            const cy = mid + ((i % 3) - 1) * 5;
            return `<g><title>${esc(`${roleText(c)}, checks ${c.checks}, block ${w.block}: ${m(w.activeMs!).toFixed(1)} min, ${w.termination}${w.accepted ? ', accepted' : ', not accepted'}`)}</title><circle class="${c.checks} hollow" cx="${x(m(w.activeMs!))}" cy="${cy}" r="3.5"/></g>`;
          })
          .join('');
        const med = `<g><title>${esc(`median ${m(e.median!).toFixed(1)} min; IQR ${m(e.q1!).toFixed(1)}–${m(e.q3!).toFixed(1)}; range ${m(e.min!).toFixed(1)}–${m(e.max!).toFixed(1)}`)}</title><line class="med" x1="${x(m(e.median!))}" x2="${x(m(e.median!))}" y1="${mid - 9}" y2="${mid + 9}"/></g>`;
        return `${iqr}${pts}${med}<text class="t1" x="${PLOT_X1 + 12}" y="${mid + 4}">${m(e.median!).toFixed(1)} min · n=${e.n === c.scored ? e.n : `${e.n}/${c.scored}`}</text>`;
      },
    })),
  }));
  const legend = `${legendChecks(legendY).replace(/<path class="on"/, '<path class="on hollow"').replace(/<circle class="off"/, '<circle class="off hollow"')}<line class="med" x1="${PLOT_X0 + 206}" x2="${PLOT_X0 + 206}" y1="${legendY - 7}" y2="${legendY + 7}"/><text class="t2" x="${PLOT_X0 + 214}" y="${legendY + 4}">median</text><line class="ref" x1="${PLOT_X0 + 274}" x2="${PLOT_X0 + 294}" y1="${legendY}" y2="${legendY}"/><text class="t2" x="${PLOT_X0 + 300}" y="${legendY + 4}">${ctx.ceilingMinutes}-min ceiling</text>`;
  const svg = frame({
    name,
    title: `${a.workflows[wf]!.label}: active elapsed time`,
    subtitle: statusLine(a, ctx),
    desc: `Every scored workflow's active elapsed time in minutes (circles), with median (tick) and interquartile range (band), against the ${ctx.ceilingMinutes}-minute workflow ceiling. Excludes independent evaluation and quota waits. Data table: ${name}.csv.`,
    legend,
    groups: gs,
    xTicks: ticks,
    xScale: x,
    xFormat: (v) => `${v}`,
    xTitle: 'Active elapsed minutes per scored workflow',
    extra: (top, bottom) => `<line class="ref" x1="${x(ctx.ceilingMinutes)}" x2="${x(ctx.ceilingMinutes)}" y1="${top}" y2="${bottom}"/>`,
  });
  const rows = gsRaw.flatMap((g, gi) =>
    g.conditions.map((c) => {
      const e = c.elapsedMs;
      const f = (v: number | null) => (v === null ? null : Number(m(v).toFixed(3)));
      return [a.cohort, a.dataset, gi === 0 ? 'condition' : 'solo-control', c.conditionId, roleText(c), c.checks, c.scored, e.n, c.elapsedMissing, f(e.median), f(e.q1), f(e.q3), f(e.min), f(e.max), c.workflows.map((w) => (w.activeMs === null ? 'missing' : f(w.activeMs))).join('; ')];
    }),
  );
  return { name, svg, csv: toCsv(['cohort', 'dataset', 'group', 'condition', 'assignment', 'checks', 'scored', 'n', 'missing', 'median_min', 'q1_min', 'q3_min', 'min_min', 'max_min', 'observations_min_in_block_order'], rows) };
}

export function allFigures(a: Analysis, ctx: FigureContext): Figure[] {
  return Object.keys(a.workflows).flatMap((wf) => [acceptanceFigure(a, wf, ctx), costFigure(a, wf, ctx), tokensFigure(a, wf, ctx), elapsedFigure(a, wf, ctx)]);
}
