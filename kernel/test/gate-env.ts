/** The pre-commit environment, shared by the tier gate and the section runner (c2). */
import fs from 'node:fs';
import path from 'node:path';
// Git's repository-local variables, as listed by git rev-parse --local-env-vars.
const GIT_LOCAL_ENV = new Set([
  'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_CONFIG', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT',
  'GIT_OBJECT_DIRECTORY', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_IMPLICIT_WORK_TREE', 'GIT_GRAFT_FILE',
  'GIT_INDEX_FILE', 'GIT_NO_REPLACE_OBJECTS', 'GIT_REPLACE_REF_BASE', 'GIT_PREFIX',
  'GIT_SHALLOW_FILE', 'GIT_COMMON_DIR',
]);

export function childEnv(): NodeJS.ProcessEnv {
  // DESKPOST_LAUNCHER_PID too (s135 row 2; Report "the gate's child environment keeps DESKPOST_LAUNCHER_PID").
  const env: NodeJS.ProcessEnv = { ...process.env, LIBRARY_WORKSPACE: '', LIBRARY_SEAT: '', DESKPOST_GATE_SEAT: '', LIBRARY_SEAT_CLAIM: '', DESKPOST_LAUNCHER_PID: '', ORCA_TERMINAL_HANDLE: '' };
  delete env['DESKPOST_UPDATE_CHECK'];
  for (const name of Object.keys(env)) {
    if (GIT_LOCAL_ENV.has(process.platform === 'win32' ? name.toUpperCase() : name)) delete env[name];
  }
  const key = Object.keys(env).find((name) => name.toUpperCase() === 'PATH') ?? 'PATH';
  const separator = process.platform === 'win32' ? ';' : ':';
  env[key] = (env[key] ?? '')
    .split(separator)
    .filter((entry) => entry && !fs.existsSync(path.join(entry, 'deskpost.cmd')) && !fs.existsSync(path.join(entry, 'deskpost')))
    .join(separator);
  if (!env[key].split(separator).some(entry => entry && fs.existsSync(path.join(entry, process.platform === 'win32' ? 'node.exe' : 'node')))) {
    const nodeDir = path.dirname(process.execPath);
    if (!fs.existsSync(path.join(nodeDir, 'deskpost')) && !fs.existsSync(path.join(nodeDir, 'deskpost.cmd'))) {
      env[key] = [env[key], nodeDir].filter(Boolean).join(separator);
    }
  }
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
