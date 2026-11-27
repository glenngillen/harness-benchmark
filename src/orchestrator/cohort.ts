/**
 * Where a cohort's pilot records live. Each cohort keeps its own pilots, host evidence and safeguard
 * file at `records/<cohort>-pilots/`, so a new cohort's freeze gate never judges another cohort's
 * pilots (methodology section 14).
 */
const COHORT = /^cohort-\d{2}$/;

/** Pure: the campaign label (directory under records/) of a cohort's pilots. */
export function pilotsLabel(cohort: string): string {
  if (!COHORT.test(cohort)) throw new Error(`invalid cohort label ${JSON.stringify(cohort)} (expected cohort-NN)`);
  return `${cohort}-pilots`;
}

/** Pure: a cohort's pilot record paths, relative to the benchmark root. */
export function pilotPaths(cohort: string) {
  const base = `records/${pilotsLabel(cohort)}`;
  return { base, attempts: `${base}/pilot`, hostEvidence: `${base}/host-evidence`, safeguards: `${base}/safeguards.json` };
}
