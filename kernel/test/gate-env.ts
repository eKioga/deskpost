/** The pre-commit environment, shared by the tier gate and the section runner (c2). */
import fs from 'node:fs';
import path from 'node:path';
export function childEnv(): NodeJS.ProcessEnv {
  // DESKPOST_LAUNCHER_PID too (s135 row 2; Report "the gate's child environment keeps DESKPOST_LAUNCHER_PID").
  const env: NodeJS.ProcessEnv = { ...process.env, LIBRARY_WORKSPACE: '', LIBRARY_SEAT: '', DESKPOST_GATE_SEAT: '', LIBRARY_SEAT_CLAIM: '', DESKPOST_LAUNCHER_PID: '', ORCA_TERMINAL_HANDLE: '' };
  delete env['DESKPOST_UPDATE_CHECK'];
  const key = Object.keys(env).find((name) => name.toUpperCase() === 'PATH') ?? 'PATH';
  const separator = process.platform === 'win32' ? ';' : ':';
  env[key] = (env[key] ?? '')
    .split(separator)
    .filter((entry) => entry && !fs.existsSync(path.join(entry, 'deskpost.cmd')) && !fs.existsSync(path.join(entry, 'deskpost')))
    .join(separator);
  return env;
}

/** Attribute only the hook's own lock; restore before launching any check children. */
export async function withHookSeat<T>(fn: () => Promise<T>): Promise<T> {
  const seat = process.env['LIBRARY_SEAT'];
  if (!seat && process.env['DESKPOST_GATE_SEAT']) process.env['LIBRARY_SEAT'] = process.env['DESKPOST_GATE_SEAT'];
  try { return await fn(); }
  finally {
    if (seat === undefined) delete process.env['LIBRARY_SEAT']; else process.env['LIBRARY_SEAT'] = seat;
  }
}
