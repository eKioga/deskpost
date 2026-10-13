/** The pre-commit environment, shared by the tier gate and the section runner (c2). */
import fs from 'node:fs';
import path from 'node:path';
export function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, LIBRARY_WORKSPACE: '', LIBRARY_SEAT: '', LIBRARY_SEAT_CLAIM: '', ORCA_TERMINAL_HANDLE: '' };
  delete env['DESKPOST_UPDATE_CHECK'];
  const key = Object.keys(env).find((name) => name.toUpperCase() === 'PATH') ?? 'PATH';
  const separator = process.platform === 'win32' ? ';' : ':';
  env[key] = (env[key] ?? '')
    .split(separator)
    .filter((entry) => entry && !fs.existsSync(path.join(entry, 'deskpost.cmd')) && !fs.existsSync(path.join(entry, 'deskpost')))
    .join(separator);
  return env;
}
