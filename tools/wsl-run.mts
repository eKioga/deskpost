/**
 * ONE WAY TO RUN A WSL STEP (kickoffs/s153 row 1; s152's retro item 3):
 *
 *   node tools/wsl-run.mts [--tier <name>] [--distro <name>] [--log <file>] <script file> [args...]
 *
 * The script is a bash file on the Windows side. It is copied into the WSL clone's evidence folder
 * (`~/dev/deskpost-linux-gates/evidence/<name>`) with LF line endings and run there by `bash`, in the clone's `app/`, with
 * a PATH of the clone's own Node and the distro's own folders only (LINUX_PATH), as the child of the Windows gate lock (`kernel/test/gate-lock.ts --tier <name>`,
 * default `wsl`) with DESKPOST_GATE_SERIAL=1 set for that child only. Copy and run are one WSL command, so the lock
 * covers both.
 *
 * NO COMMAND LINE IS QUOTED: `wsl.exe -e` runs a program with no Linux shell between, and passes each argument as it
 * was given (brackets, quotes, `$` and spaces arrive unchanged), where `wsl.exe -- bash -lc "<line>"` re-parsed the line
 * and expanded `$?` in the outer shell (s152). The script itself travels as one base64 argument; the bash preamble
 * below is a constant. The one thing `wsl.exe -e` cannot pass is an empty argument (E_INVALIDARG), so it is refused
 * here by position before anything runs.
 *
 * The exit is the script's own (the lock's 2 when the run passed its 45-minute limit), and one line
 * `<UTC> <script> [args] exit <n>` is appended to the log (default: `wsl-runs.txt` beside the script).
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const USAGE = 'usage: node tools/wsl-run.mts [--tier <name>] [--distro <name>] [--log <file>] <script file> [args...]';
/** Under $HOME in the distro: the clone, its Node, and where scripts are copied. */
export const CLONE = 'dev/deskpost-linux-gates';
/** Windows' command line is 32,767 characters; the script travels base64 inside it. */
const SCRIPT_LIMIT = 16_000;

/**
 * A WSL RUN SEES ONLY LINUX (kickoffs/s154 row 5). WSL appends Windows' PATH to a distro's (`appendWindowsPath`), so a
 * script that kept it found the real Windows install (section 53: "Deskpost is already installed at /mnt/d/dev/Deskpost"),
 * the npm `codex` shim (78) and `powershell.exe` (21's stale-hook doctor): a Linux test that is not testing Linux. Nothing
 * is inherited: the clone's Node, then the distro's own folders.
 */
export const LINUX_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

/**
 * The constant bash program `wsl.exe -e bash -c` runs. $0 is the script's file name, $1 its base64 text, the rest
 * its arguments. 125 is this preamble's own failure, before the script starts.
 */
export const PREAMBLE = [
  'export COLUMNS=4096 LINES=50',
  'cd "$HOME" || exit 125',
  `d="$HOME/${CLONE}/evidence"`,
  'mkdir -p "$d" || exit 125',
  'printf %s "$1" | base64 -d > "$d/$0" || exit 125',
  'shift',
  `export PATH="$HOME/${CLONE}/node/bin:${LINUX_PATH}"`,
  `cd "$HOME/${CLONE}/app" || exit 125`,
  'exec bash "$d/$0" "$@"',
].join('\n');

export interface Plan { tier: string; distro: string; log: string; script: string; name: string; args: string[] }

export function parseArgs(argv: string[]): Plan {
  let tier = 'wsl', distro = 'Ubuntu', log: string | null = null;
  let i = 0;
  for (; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (!arg.startsWith('--')) break;
    const value = argv[i + 1];
    if (value === undefined) throw new Error(`${arg} needs a value. ${USAGE}`);
    if (arg === '--tier') tier = value;
    else if (arg === '--distro') distro = value;
    else if (arg === '--log') log = value;
    else throw new Error(`unknown option '${arg}'. ${USAGE}`);
    i += 1;
  }
  const script = argv[i];
  if (script === undefined) throw new Error(`name a script. ${USAGE}`);
  const args = argv.slice(i + 1);
  const empty = args.findIndex((arg) => arg === '');
  if (empty >= 0) throw new Error(`argument ${empty + 1} is empty, and wsl.exe -e cannot pass an empty argument; nothing was run`);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(tier)) throw new Error(`--tier takes letters, digits, '.', '_' and '-'; got '${tier}'`);
  const resolved = path.resolve(script);
  const name = path.basename(resolved);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) throw new Error(`the script's file name must be letters, digits, '.', '_' and '-'; got '${name}'`);
  return { tier, distro, log: path.resolve(log ?? path.join(path.dirname(resolved), 'wsl-runs.txt')), script: resolved, name, args };
}

/** The script as LF text, base64. */
export function encodeScript(text: string): string {
  return Buffer.from(text.replace(/^﻿/, '').replace(/\r\n?/g, '\n'), 'utf8').toString('base64');
}

/** The gate lock's command line: node gate-lock.ts --tier <tier> -- wsl.exe -d <distro> -e bash -c <preamble> <name> <b64> [args]. */
export function lockArgs(plan: Plan, encoded: string): string[] {
  return [path.join(ROOT, 'kernel', 'test', 'gate-lock.ts'), '--tier', plan.tier, '--',
    'wsl.exe', '-d', plan.distro, '-e', 'bash', '-c', PREAMBLE, plan.name, encoded, ...plan.args];
}

/** The log line, from the real exit. */
export function logLine(plan: Plan, code: number, now = new Date()): string {
  return `${now.toISOString().replace(/\.\d+Z$/, 'Z')} ${[plan.name, ...plan.args].join(' ')} exit ${code}\n`;
}

async function main(argv: string[]): Promise<number> {
  const plan = parseArgs(argv);
  const text = fs.readFileSync(plan.script, 'utf8');
  const encoded = encodeScript(text);
  if (encoded.length > SCRIPT_LIMIT) throw new Error(`${plan.name} is ${encoded.length} characters as base64, over this tool's ${SCRIPT_LIMIT}; split it`);
  const code = await new Promise<number>((resolve, reject) => {
    const child = spawn(process.execPath, lockArgs(plan, encoded), {
      cwd: ROOT, env: { ...process.env, DESKPOST_GATE_SERIAL: '1' }, stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true,
    });
    child.on('error', reject);
    child.on('close', (status) => resolve(status ?? 2));
  });
  fs.appendFileSync(plan.log, logLine(plan, code));
  return code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (error: unknown) => { process.stderr.write(`wsl-run: ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 2; },
  );
}
