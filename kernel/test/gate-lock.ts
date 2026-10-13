/** c2: machine-wide exclusion for participating LIVE gates. Holder crashes may orphan work.
 * The production scan warns only; ownership and cleanup never depend on command-line matches.
 */
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import type { ProcessRow } from './run-parallel.ts';

const NAME = 'deskpost-gate-machine';
const HANDSHAKE = 5_000;
export class LockError extends Error { code: number; constructor(message: string, code = 2) { super(message); this.code = code; } }
interface Holder { seat: string; tier: string; pid: number; start: string; token: string }
export interface GateLock { inherited: boolean; release(): Promise<void> }
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
export function leftoverWarnings(rows: ProcessRow[], pid: number): string[] {
  const excluded = new Set<number>();
  let current: number | undefined = pid;
  while (current !== undefined && !excluded.has(current)) { excluded.add(current); current = rows.find((row) => row.pid === current)?.parentPid; }
  return rows.filter((row) => !excluded.has(row.pid) && /kernel[\\/]test[\\/](selftest|run-parallel)\.ts|tools[\\/]Invoke-LibraryChecks\.ps1/i.test(row.command))
    .map((row) => `warning: possible leftover gate work: ${row.pid} ${row.start} ${row.command}`);
}
async function warnLeftovers(say: (line: string) => void): Promise<void> {
  // Fixture namespaces must never scan their surrounding production workload.
  if (process.env['DESKPOST_GATE_LOCK_NAME']) return;
  try {
    const { processTable } = await import('./run-parallel.ts');
    for (const line of leftoverWarnings(await processTable(), process.pid)) say(line);
  } catch (error) { say(`warning: could not check possible leftover gate work: ${String(error)}`); }
}
export async function acquireGateLock(tier: string, noWait = false, say = (line: string) => process.stdout.write(line + '\n')): Promise<GateLock> {
  const address = lockAddress();
  const inherited = process.env['DESKPOST_GATE_LOCK'];
  if (inherited) {
    const holder = await readHolder(address).catch((error: unknown) => { throw new LockError(`inherited gate lock could not be validated: ${String(error)}`); });
    if (holder.token !== inherited) throw new LockError('inherited gate lock token does not match its holder');
    return { inherited: true, release: async () => {} };
  }
  const holder: Holder = { seat: process.env['LIBRARY_SEAT'] || 'unseated', tier, pid: process.pid, start: new Date().toISOString(), token: randomBytes(24).toString('hex') };
  let lastNotice = '';
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
      return { inherited: false, release };
    }
    let previous: Holder | null = null;
    try { previous = await readHolder(address); } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // The previous owner can end between bind and read. Only that race is retried.
      if (code !== 'ENOENT' && code !== 'ECONNREFUSED' && code !== 'ECONNRESET') throw error;
    }
    if (previous) {
      const notice = `waiting: ${previous.seat}'s ${previous.tier} gate, started ${previous.start} (pid ${previous.pid})`;
      if (notice !== lastNotice) { say(notice); lastNotice = notice; }
    }
    if (noWait) throw new LockError('gate lock is held; --no-wait refuses to wait', 3);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}
