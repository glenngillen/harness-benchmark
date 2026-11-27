/**
 * Stores a Claude subscription token produced by `npx claude setup-token` in the isolated auth home
 * (`.runs/auth/claude/oauth-token`, mode 0600, gitignored). Reads the token from stdin so it never
 * appears in argv or shell history:
 *
 *   npm run claude:store-token            # then paste the token and press Ctrl-D
 *
 * Refuses anything that looks like an API key (`sk-ant-api…`): the benchmark uses subscription
 * access only.
 */
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { DEFAULT_CLAUDE_AUTH_HOME, storeOAuthToken } from '../adapters/claude.ts';

const root = resolve(import.meta.dirname, '../..');
const { values } = parseArgs({ options: { 'auth-home': { type: 'string' } } });
const authHome = resolve(values['auth-home'] ?? DEFAULT_CLAUDE_AUTH_HOME(root));

let input = '';
for await (const chunk of process.stdin) input += chunk;
const token = input.trim();
if (token === '' || /\s/.test(token)) {
  process.stderr.write('expected exactly one token on stdin\n');
  process.exit(1);
}
if (/^sk-ant-api/.test(token)) {
  process.stderr.write('refused: that is an API key; the benchmark requires a subscription token from `claude setup-token`\n');
  process.exit(1);
}
storeOAuthToken(authHome, token);
process.stdout.write(`stored in ${authHome}/oauth-token (mode 0600)\n`);
