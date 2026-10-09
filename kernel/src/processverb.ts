/**
 * `library process` (kickoffs/s83 row 1, PLAN-no-powershell-runtime.md D7): what the kernel reads about a process,
 * through the same calls a seat and a lifecycle switch make. Internal: it is the front door self-test section 115
 * judges a compiled kernel through, so the start time, the ancestry walk, the agent-exit wait and the process list are
 * each proved in the binary a reader runs, not in an import of the source. It writes nothing.
 */

import { parseArguments } from './argv.ts';
import { verbTable } from './verbs.ts';
import type { PsJsonValue } from './psjson.ts';
import { agentProcessIdentity, readProcessAncestry } from './procstart.ts';
import { waitForAgentExit } from './seat.ts';
import { windowsProcesses } from './lifecycle.ts';
import { nativeProcessCalls } from './win32proc.ts';

export interface ProcessVerbResult {
  refusal: string | null;
  value: PsJsonValue | null;
}

/** Which spelling answered: kernel32 through `bun:ffi`, the PowerShell fallback under Node, or the POSIX reads. */
function route(): string {
  if (process.platform !== 'win32') return 'posix';
  return nativeProcessCalls() !== null ? 'bun-ffi' : 'powershell';
}

function pidArgument(value: string | undefined): number | null {
  return value !== undefined && /^\d+$/.test(value) && Number(value) > 0 ? Number(value) : null;
}

export async function runProcessVerb(argv: string[]): Promise<ProcessVerbResult> {
  const parsed = parseArguments(argv, verbTable('process'));
  const [action, pidText] = parsed.positional;
  const usage = 'library process <start|ancestry|wait> <pid> [--start-utc <s>] [--poll-ms <n>]; library process list [--name <image>]';
  if (action === 'list') {
    if (process.platform !== 'win32') return { refusal: 'library process list reads the Windows process table; it is not used elsewhere.', value: null };
    const name = (parsed.options.get('name') ?? '').toLowerCase();
    const rows = windowsProcesses().filter((row) => !name || (row.ExecutablePath ?? '').toLowerCase().endsWith('\\' + name));
    return {
      refusal: null,
      value: { route: route(), processes: rows.map((row) => ({ pid: row.ProcessId, parent_pid: row.ParentProcessId, path: row.ExecutablePath })) },
    };
  }
  const pid = pidArgument(pidText);
  if (!['start', 'ancestry', 'wait'].includes(action ?? '') || pid === null) return { refusal: `library process takes: ${usage}`, value: null };
  if (action === 'start') return { refusal: null, value: { route: route(), pid, start_utc: agentProcessIdentity(pid, { fresh: true }) } };
  if (action === 'ancestry') {
    return {
      refusal: null,
      value: { route: route(), records: readProcessAncestry(pid).map((record) => ({ pid: record.pid, parent_pid: record.parentPid, name: record.name, created_utc: record.createdUtc })) },
    };
  }
  const began = Date.now();
  await waitForAgentExit(pid, parsed.options.get('start-utc') ?? '', Number(parsed.options.get('poll-ms') ?? '250'));
  return { refusal: null, value: { route: route(), pid, waited_ms: Date.now() - began } };
}
