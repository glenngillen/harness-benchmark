/**
 * Checks the pinned Codex CLI and the isolated subscription login without calling a model:
 *
 *   npm run codex:preflight [-- --home <fresh tool home>] [--auth-home <dir>]
 *
 * Defaults: tool home `.runs/preflight/codex-<timestamp>`, auth home `.runs/auth/codex`. To create
 * the login (a human step, once): `CODEX_HOME="$PWD/.runs/auth/codex" npx codex login`.
 * Prints the preflight result as JSON (never credentials). Exit 0 when ready, 1 otherwise.
 */
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { DEFAULT_AUTH_HOME, DEFAULT_CODEX_BIN, preflightCodex, removeAuth } from '../adapters/codex.ts';
import models from '../../config/models.json' with { type: 'json' };

const root = resolve(import.meta.dirname, '../..');
const { values } = parseArgs({ options: { home: { type: 'string' }, 'auth-home': { type: 'string' } } });
const toolHome = resolve(values.home ?? join(root, '.runs', 'preflight', `codex-${new Date().toISOString().replace(/[:.]/g, '-')}`));
const authHome = resolve(values['auth-home'] ?? DEFAULT_AUTH_HOME(root));
const pin = models.roles.CC.toolVersion;

const result = await preflightCodex({ bin: DEFAULT_CODEX_BIN(root), toolVersion: pin, authHome, path: process.env.PATH ?? '/usr/bin:/bin' }, toolHome);
removeAuth(toolHome);
process.stdout.write(`${JSON.stringify({ toolHome, authHome, pin, ...result }, null, 2)}\n`);
process.exit(result.ok ? 0 : 1);
