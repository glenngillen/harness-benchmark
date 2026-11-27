/**
 * Local host probes shared by `npm run host-evidence` (records them) and `npm run freeze --
 * --evidence local` (uses them directly): both pinned-CLI subscription preflights against the
 * isolated auth homes, and whether an OS sandbox can actually be applied here. No model is invoked
 * and no credential is returned.
 */
import { join } from 'node:path';
import { DEFAULT_AUTH_HOME, DEFAULT_CODEX_BIN, preflightCodex, removeAuth, type PreflightResult } from '../adapters/codex.ts';
import { DEFAULT_CLAUDE_AUTH_HOME, DEFAULT_CLAUDE_BIN, preflightClaude, type ClaudePreflightResult } from '../adapters/claude.ts';
import { usableSandboxTool } from '../evaluator/sandbox.ts';

export interface LocalProbe {
  codex: PreflightResult;
  claude: Omit<ClaudePreflightResult, 'token'>;
  sandboxTool: string | null;
}

export async function probeLocalHost(root: string, pins: { codex: string; claude: string }, stamp: string): Promise<LocalProbe> {
  const path = process.env.PATH ?? '/usr/bin:/bin';
  const codexHome = join(root, '.runs', 'preflight', `codex-${stamp}`);
  const codex = await preflightCodex({ bin: DEFAULT_CODEX_BIN(root), toolVersion: pins.codex, authHome: DEFAULT_AUTH_HOME(root), path }, codexHome);
  removeAuth(codexHome);
  const { token: _token, ...claude } = await preflightClaude({ bin: DEFAULT_CLAUDE_BIN(root), toolVersion: pins.claude, authHome: DEFAULT_CLAUDE_AUTH_HOME(root), path }, join(root, '.runs', 'preflight', `claude-${stamp}`));
  const sandboxTool = (process.platform === 'darwin' ? usableSandboxTool('sandbox-exec') : usableSandboxTool('bwrap')) ?? null;
  return { codex, claude, sandboxTool };
}
