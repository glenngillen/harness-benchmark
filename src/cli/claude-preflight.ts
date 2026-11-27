/**
 * Checks the pinned Claude Code CLI, managed policy, and the isolated subscription token without
 * calling a model:
 *
 *   npm run claude:preflight [-- --home <fresh tool home>] [--auth-home <dir>]
 *
 * Defaults: tool home `.runs/preflight/claude-<timestamp>`, auth home `.runs/auth/claude`. To create
 * the token (a human step, once): run `npx claude setup-token`, then paste the printed token into
 * `npm run claude:store-token`. Prints the preflight result as JSON (never credentials). Exit 0 when
 * ready, 1 otherwise.
 */
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { DEFAULT_CLAUDE_AUTH_HOME, DEFAULT_CLAUDE_BIN, preflightClaude } from '../adapters/claude.ts';
import models from '../../config/models.json' with { type: 'json' };

const root = resolve(import.meta.dirname, '../..');
const { values } = parseArgs({ options: { home: { type: 'string' }, 'auth-home': { type: 'string' } } });
const toolHome = resolve(values.home ?? join(root, '.runs', 'preflight', `claude-${new Date().toISOString().replace(/[:.]/g, '-')}`));
const authHome = resolve(values['auth-home'] ?? DEFAULT_CLAUDE_AUTH_HOME(root));
const pin = models.roles.AC.toolVersion;

const { token: _token, ...result } = await preflightClaude({ bin: DEFAULT_CLAUDE_BIN(root), toolVersion: pin, authHome, path: process.env.PATH ?? '/usr/bin:/bin' }, toolHome);
process.stdout.write(`${JSON.stringify({ toolHome, authHome, pin, ...result }, null, 2)}\n`);
process.exit(result.ok ? 0 : 1);
