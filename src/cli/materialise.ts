import { materialiseReference } from '../fixtures.ts';

const [name, dest] = process.argv.slice(2);
if (!name || !dest) {
  console.error('usage: npm run reference:materialise -- <correct|broken-id> <empty-destination>');
  process.exit(2);
}
const plan = materialiseReference(name, dest);
console.log(`materialised ${name} into ${dest} (${plan.filter((p) => p.from === 'overlay').length} overlay file(s))`);
