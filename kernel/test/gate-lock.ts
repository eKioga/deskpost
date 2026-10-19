/** c32: machine-wide exclusion is off by default after c30 measured drop.
 * DESKPOST_GATE_SERIAL=1 (only 1) or a DESKPOST_GATE_LOCK_NAME enables exclusion.
 * Holder crashes may orphan work.
 * The production scan warns only; ownership and cleanup never depend on command-line matches.
 */
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import type { ProcessRow } from './run-parallel.ts';

const NAME = 'deskpost-gate-machine';
const HANDSHAKE = 5_000;
export class LockError extends Error { code: number; constructor(message: string, code = 2) { super(message); this.code = code; } }
interface Holder { seat: string; tier: string; pid: number; start: string; token: string }
export interface GateWait { seconds: number; seat: string; tier: string; started: string; ended: string }
export interface GateLock { inherited: boolean; wait: GateWait | null; release(): Promise<void> }
/** The caller announces a disabled outer lock once; inherited calls stay quiet. */
export function gateLockOffNotice(lock: GateLock): string | null {
  return !lock.inherited && process.env['DESKPOST_GATE_LOCK'] === 'off'
    ? 'gate lock: off (DESKPOST_GATE_SERIAL=1 takes turns)' : null;
}
export function lockAddress(): string {
  const name = process.env['DESKPOST_GATE_LOCK_NAME'] || NAME;
  if (!/^[a-zA-Z0-9._-]+$/.test(name)) throw new LockError('DESKPOST_GATE_LOCK_NAME must be a simple pipe name');
  if (process.platform === 'win32') return `\\\\.\\pipe\\${name}`;
  if (process.platform === 'linux') return `\0${name}`;
  throw new LockError('the gate lock supports Windows and Linux only');
}
async function readHolder(address: string): Promise<Holder> {
  return new Promise((resolve, reject) => {
    const client = net.connect(address);
    let text = '', finished = false;
    const finish = (error?: Error, holder?: Holder) => {
      if (finished) return; finished = true; clearTimeout(timer); client.destroy();
      if (error) reject(error); else resolve(holder!);
    };
    const timer = setTimeout(() => finish(new LockError('gate lock handshake exceeded 5 seconds')), HANDSHAKE);
    client.on('error', (error) => finish(error));
    // A contender may connect just as the holder releases or crashes. Re-enter bind arbitration,
    // rather than turning that ordinary handoff into a failed gate. Inherited tokens still fail closed.
    client.on('end', () => finish(Object.assign(new Error('gate lock holder ended without a complete reply'), { code: 'ECONNRESET' })));
    client.on('data', (chunk) => {
      text += String(chunk);
      if (text.length > 8192) return finish(new LockError('oversized gate lock reply'));
      if (!text.includes('\n')) return;
      try {
        const holder = JSON.parse(text.split('\n')[0]!) as Holder;
        if (typeof holder.token !== 'string' || !holder.token || typeof holder.seat !== 'string' || typeof holder.tier !== 'string' || !Number.isInteger(holder.pid) || typeof holder.start !== 'string') throw new Error('malformed gate lock holder');
        finish(undefined, holder);
      } catch (error) { finish(new LockError(String(error))); }
    });
  });
}
/** A command line's arguments, split at whitespace outside double quotes; null for an unbalanced quote or nothing. */
export function commandWords(command: string): string[] | null {
  const words: string[] = [];
  let word = '', quoted = false, started = false;
  for (const char of command) {
    if (char === '"') { quoted = !quoted; started = true; }
    else if (!quoted && /\s/.test(char)) { if (started) words.push(word); word = ''; started = false; }
    else { word += char; started = true; }
  }
  if (quoted) return null;
  if (started) words.push(word);
  return words.length ? words : null;
}
const NODE_VALUE_OPTIONS = new Set(['-r', '--require', '--import', '--loader', '--experimental-loader', '-C', '--conditions', '--input-type', '--env-file', '--title']);
/** s126 row 1: gate work is the program a gate runs, never a shell or an eval that merely names its file. */
export function isGateWork(command: string): boolean {
  const words = commandWords(command);
  if (!words) return false;
  const program = words[0]!.split(/[\\/]/).at(-1)!.toLowerCase().replace(/\.exe$/, '');
  if (program === 'node') {
    for (let i = 1; i < words.length; i++) {
      const word = words[i]!;
      if (word === '--') return /(^|[\\/])kernel[\\/]test[\\/](selftest|run-parallel)\.ts$/i.test(words[i + 1] ?? '');
      if (/^(-e|-p|--eval|--print)(=|$)/.test(word)) return false;
      if (!word.startsWith('-')) return /(^|[\\/])kernel[\\/]test[\\/](selftest|run-parallel)\.ts$/i.test(word);
      if (NODE_VALUE_OPTIONS.has(word)) i++;
    }
    return false;
  }
  if (program === 'powershell' || program === 'pwsh') {
    for (let i = 1; i < words.length; i++) {
      const word = words[i]!.toLowerCase();
      if (word === '-file' || word === '-f') return /(^|[\\/])tools[\\/]Invoke-LibraryChecks\.ps1$/i.test(words[i + 1] ?? '');
      // Option values (-ExecutionPolicy Bypass) are passed over; a command's text is never a script path.
      if (/^-(c|command|e|ec|encodedcommand)$/.test(word)) return false;
    }
  }
  return false;
}
export function leftoverWarnings(rows: ProcessRow[], pid: number): string[] {
  const excluded = new Set<number>();
  let current: number | undefined = pid;
  while (current !== undefined && !excluded.has(current)) { excluded.add(current); current = rows.find((row) => row.pid === current)?.parentPid; }
  return rows.filter((row) => !excluded.has(row.pid) && isGateWork(row.command))
    .map((row) => `warning: another gate's work is running outside the lock (it may be live, or left over): ${row.pid} ${row.start} ${row.command}`);
}
async function warnLeftovers(say: (line: string) => void): Promise<void> {
  // Fixture namespaces must never scan their surrounding production workload.
  if (process.env['DESKPOST_GATE_LOCK_NAME']) return;
  try {
    const { processTable } = await import('./run-parallel.ts');
    for (const line of leftoverWarnings(await processTable(), process.pid)) say(line);
  } catch (error) { say(`warning: could not check work running outside the gate lock: ${String(error)}`); }
}
export async function acquireGateLock(tier: string, noWait = false, say = (line: string) => process.stdout.write(line + '\n')): Promise<GateLock> {
  const inherited = process.env['DESKPOST_GATE_LOCK'];
  const enabled = process.env['DESKPOST_GATE_SERIAL'] === '1' || Boolean(process.env['DESKPOST_GATE_LOCK_NAME']);
  if (!enabled && (!inherited || inherited === 'off')) {
    process.env['DESKPOST_GATE_LOCK'] = 'off';
    return { inherited: inherited === 'off', wait: null, release: async () => {} };
  }
  const address = lockAddress();
  if (inherited) {
    const holder = await readHolder(address).catch((error: unknown) => { throw new LockError(`inherited gate lock could not be validated: ${String(error)}`); });
    if (holder.token !== inherited) throw new LockError('inherited gate lock token does not match its holder');
    return { inherited: true, wait: null, release: async () => {} };
  }
  const holder: Holder = { seat: process.env['LIBRARY_SEAT'] || 'unseated', tier, pid: process.pid, start: new Date().toISOString(), token: randomBytes(24).toString('hex') };
  let lastNotice = '';
  let waitStarted = 0;
  let waitedFor: Holder | null = null;
  for (;;) {
    const clients = new Set<net.Socket>();
    const server = net.createServer((client) => {
      clients.add(client); client.on('error', () => {}); client.on('close', () => clients.delete(client));
      client.end(JSON.stringify(holder) + '\n');
    });
    const listened = await new Promise<boolean>((resolve, reject) => {
      server.once('error', (error: NodeJS.ErrnoException) => { if (error.code === 'EADDRINUSE') resolve(false); else reject(new LockError(`cannot take gate lock: ${error.message}`)); });
      server.listen(address, () => resolve(true));
    });
    if (listened) {
      const acquired = Date.now();
      const wait: GateWait | null = waitedFor ? {
        seconds: (acquired - waitStarted) / 1000, seat: waitedFor.seat, tier: waitedFor.tier,
        started: new Date(waitStarted).toISOString(), ended: new Date(acquired).toISOString(),
      } : null;
      process.env['DESKPOST_GATE_LOCK'] = holder.token;
      // Establish release BEFORE scanning, so any failure also leaves the OS-held pipe cleanly.
      const release = async () => {
        delete process.env['DESKPOST_GATE_LOCK'];
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new LockError('gate lock release exceeded 5 seconds')), HANDSHAKE);
          for (const client of clients) client.destroy();
          server.close(() => { clearTimeout(timer); resolve(); });
        });
      };
      await warnLeftovers(say);
      if (wait) say(`gate lock wait: ${JSON.stringify(wait)}`);
      return { inherited: false, release, wait };
    }
    let previous: Holder | null = null;
    try { previous = await readHolder(address); } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // The previous owner can end between bind and read. Only that race is retried.
      if (code !== 'ENOENT' && code !== 'ECONNREFUSED' && code !== 'ECONNRESET') throw error;
    }
    if (previous) {
      if (!waitStarted) waitStarted = Date.now();
      waitedFor = previous;
      const notice = `waiting: ${previous.seat}'s ${previous.tier} gate, started ${previous.start} (pid ${previous.pid})`;
      if (notice !== lastNotice) { say(notice); lastNotice = notice; }
    }
    if (noWait) throw new LockError('gate lock is held; --no-wait refuses to wait', 3);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

/** Hold one machine lock around a whole command, including synchronous work in its descendants. */
export async function holdAndRun(tier: string, command: string, args: string[]): Promise<number> {
  if (!command) throw new LockError('hold-and-run needs a command after --');
  // The hook blanks the seat for its checks, but preserves attribution for this lock alone.
  const seat = process.env['LIBRARY_SEAT'];
  if (!seat && process.env['DESKPOST_GATE_SEAT']) process.env['LIBRARY_SEAT'] = process.env['DESKPOST_GATE_SEAT'];
  let lock: GateLock;
  try { lock = await acquireGateLock(tier); }
  finally {
    if (seat === undefined) delete process.env['LIBRARY_SEAT']; else process.env['LIBRARY_SEAT'] = seat;
  }
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.on('SIGINT', cancel); process.on('SIGTERM', cancel);
  try {
    const [{ runBounded }, { default: fs }, { default: os }, { default: path }] = await Promise.all([
      import('./run-parallel.ts'), import('node:fs'), import('node:os'), import('node:path'),
    ]);
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'deskpost-gate-command-'));
    if (!lock.inherited) process.stdout.write((gateLockOffNotice(lock) ?? `gate lock held: ${tier} (pid ${process.pid})`) + '\n');
    const result = await runBounded({ label: tier, command, args, env: { ...process.env }, cwd: process.cwd(),
      limit: 2_700_000, folder: path.join(folder, 'command'), onOutput: chunk => process.stdout.write(chunk) }, controller.signal);
    if (result.problem) process.stderr.write(`${result.problem}; evidence: ${folder}\n`);
    if (!result.problem && result.status === 0) fs.rmSync(folder, { recursive: true, force: true });
    return result.problem ? 2 : result.status ?? 2;
  } finally {
    process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel);
    await lock.release();
  }
}

if (process.argv[1] && import.meta.url === (await import('node:url')).pathToFileURL((await import('node:path')).resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const separator = args.indexOf('--');
  const tier = separator === 2 && args[0] === '--tier' ? args[1] : undefined;
  (tier && args[separator + 1]
    ? holdAndRun(tier, args[separator + 1]!, args.slice(separator + 2))
    : Promise.reject(new LockError('usage: node gate-lock.ts --tier <name> -- <command> [args]')))
    .then(code => { process.exitCode = code; }, (error: unknown) => {
      process.stderr.write(`gate lock: ${String(error)}\n`); process.exitCode = error instanceof LockError ? error.code : 2;
    });
}
