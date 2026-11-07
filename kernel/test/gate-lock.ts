/** Machine gates take the legacy door or weighted slots by default.
 * DESKPOST_GATE_SERIAL=0 switches off one run and its descendants.
 * Holder crashes may orphan work.
 * The production scan warns only; ownership and cleanup never depend on command-line matches.
 */
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { ProcessRow } from './run-parallel.ts';

const NAME = 'deskpost-gate-machine';
const HANDSHAKE = 5_000;
export class LockError extends Error { code: number; constructor(message: string, code = 2) { super(message); this.code = code; } }
interface Holder { seat: string; tier: string; pid: number; processStart: string; start: string; token: string }
/** `seat` and `tier` are the last holder's, as before; `holders` names each one waited on, in order (kickoffs/s169 row 5). */
export interface GateWait { seconds: number; seat: string; tier: string; pid?: number; processStart?: string; started: string; ended: string; holders: { seat: string; tier: string; pid?: number; processStart?: string; seconds: number }[] }
export interface GateLock { inherited: boolean; wait: GateWait | null; release(): Promise<void> }
/** The caller announces a disabled outer lock once; inherited calls stay quiet. */
export function gateLockOffNotice(lock: GateLock): string | null {
  return !lock.inherited && process.env['DESKPOST_GATE_LOCK'] === 'off'
    ? 'gate lock: off for this run (DESKPOST_GATE_SERIAL=0)' : null;
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
export function leftoverWarnings(rows: ProcessRow[], pid: number, holders: {pid: number; processStart: string}[] = []): string[] {
  const excluded = new Set<number>();
  let current: number | undefined = pid;
  while (current !== undefined && !excluded.has(current)) { excluded.add(current); current = rows.find((row) => row.pid === current)?.parentPid; }
  for (const holder of holders) {
    if (!rows.some(row => row.pid === holder.pid && row.start === holder.processStart)) continue;
    const descendants = new Set([holder.pid]);
    let changed = true;
    while (changed) { changed = false; for (const row of rows) if (descendants.has(row.parentPid) && !descendants.has(row.pid)) { descendants.add(row.pid); changed = true; } }
    for (const pid of descendants) excluded.add(pid);
  }
  return rows.filter((row) => !excluded.has(row.pid) && isGateWork(row.command))
    .map((row) => `warning: another gate's work is running outside the lock (it may be live, or left over): ${row.pid} ${row.start} ${row.command}`);
}
async function warnLeftovers(say: (line: string) => void): Promise<void> {
  // Fixture namespaces must never scan their surrounding production workload.
  if (process.env['DESKPOST_GATE_LOCK_NAME']) return;
  try {
    const { processTable, startIdentity } = await import('./run-parallel.ts');
    const rows = await processTable(), holders: Holder[] = [];
    const config = readSlots(() => {});
    if (config) for (let index = 1; index <= config.slots; index++) {
      const holder = await contender(lockAddress() + '-' + index);
      if (holder && await startIdentity(holder.pid) === holder.processStart) {
        // processTable's Linux start is ps lstart; verify the stable /proc identity before mapping it.
        holders.push({...holder, processStart: rows.find(row => row.pid === holder.pid)?.start ?? ''});
      }
    }
    for (const line of leftoverWarnings(rows, process.pid, holders)) say(line);
  } catch (error) { say(`warning: could not check work running outside the gate lock: ${String(error)}`); }
}
interface PipeLease { release(): Promise<void> }
const pause = () => new Promise<void>(resolve => setTimeout(resolve, 500));
/** A fixture name alone never opens machine files. */
export function gateDirectory(): string | null {
  if (process.env['DESKPOST_GATE_DIR']) return path.resolve(process.env['DESKPOST_GATE_DIR']!);
  if (process.env['DESKPOST_GATE_LOCK_NAME']) return null;
  return process.platform === 'win32' ? path.join(process.env['LOCALAPPDATA'] || path.join(os.homedir(), 'AppData', 'Local'), 'deskpost', 'gate')
    : path.join(os.homedir(), '.local', 'state', 'deskpost', 'gate');
}
interface SlotSetting { slots: number; u2Tip: string }
export function readSlots(say: (line: string) => void): SlotSetting | null {
  const folder = gateDirectory();
  if (!folder) return null;
  const file = path.join(folder, 'slots');
  try {
    const value: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!value || typeof value !== 'object' || !('slots' in value) || !Number.isSafeInteger(value.slots) || Number(value.slots) < 1
      || !('u2Tip' in value) || typeof value.u2Tip !== 'string' || !/^[a-f0-9]{40}$/.test(value.u2Tip)) throw Error('expected {slots: positive integer, u2Tip: 40 lowercase hex characters}');
    return value as SlotSetting;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') say(`warning: invalid gate slot file ${file}: ${String(error)}; using legacy lock`);
    return null;
  }
}
async function tryPipe(address: string, holder: Holder): Promise<PipeLease | null> {
  const clients = new Set<net.Socket>();
  const server = net.createServer(client => {
    clients.add(client); client.on('error', () => {}); client.on('close', () => clients.delete(client));
    client.end(JSON.stringify(holder) + '\n');
  });
  const listened = await new Promise<boolean>((resolve, reject) => {
    server.once('error', (error: NodeJS.ErrnoException) => error.code === 'EADDRINUSE' ? resolve(false) : reject(new LockError(`cannot take gate lock: ${error.message}`)));
    server.listen(address, () => resolve(true));
  });
  if (!listened) return null;
  return { release: () => new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new LockError('gate lock release exceeded 5 seconds')), HANDSHAKE);
    for (const client of clients) client.destroy();
    server.close(() => { clearTimeout(timer); resolve(); });
  }) };
}
async function contender(address: string): Promise<Holder | null> {
  try { return await readHolder(address); }
  catch (error) {
    if (['ENOENT', 'ECONNREFUSED', 'ECONNRESET'].includes((error as NodeJS.ErrnoException).code ?? '')) return null;
    throw error;
  }
}
async function holderIdentity(): Promise<string> {
  // SELF-TEST ONLY: force an unreadable OS start in an isolated fixture namespace.
  if (process.env['DESKPOST_GATE_LOCK_NAME'] && process.env['DESKPOST_GATE_TEST_START_UNREADABLE'] === '1') return 'unreadable: forced self-test case';
  try { return await (await import('./run-parallel.ts')).startIdentity(process.pid) ?? 'unreadable: operating system returned no start time'; }
  catch (error) { return `unreadable: ${String(error)}`; }
}
interface Waiter { id: string; seat: string; tier: string; pid: number; processStart: string; arrived: string }
const WAITS_LIMIT = 1024 * 1024;
function publicHolder(holder: Holder): Omit<Holder, 'token'> {
  return {seat:holder.seat,tier:holder.tier,pid:holder.pid,start:holder.start,
    processStart:holder.processStart ?? 'unreadable: legacy holder did not report process start'};
}
async function currentHolders(previous: Holder | null, self: Holder): Promise<Holder[]> {
  const holders = previous ? [previous] : [];
  const config = readSlots(() => {}); // Display only. Admission still reads exclusively under the door.
  if (config) for (let index = 1; index <= config.slots; index++) {
    const holder = await contender(lockAddress() + '-' + index);
    if (holder && holder.pid !== self.pid && !holders.some(old => old.token === holder.token)) holders.push(holder);
  }
  return holders;
}
async function liveWaiters(folder: string): Promise<Waiter[]> {
  const {processTable,startIdentity} = await import('./run-parallel.ts');
  const rows = process.platform === 'win32' ? await processTable() : [];
  const live: Waiter[] = [];
  for (const name of fs.readdirSync(folder)) {
    if (!name.endsWith('.json')) continue;
    try {
      const entry = JSON.parse(fs.readFileSync(path.join(folder,name),'utf8')) as Waiter;
      if (typeof entry.id !== 'string' || typeof entry.seat !== 'string' || typeof entry.tier !== 'string'
        || !Number.isSafeInteger(entry.pid) || entry.pid < 1 || typeof entry.processStart !== 'string' || typeof entry.arrived !== 'string' || !Number.isFinite(Date.parse(entry.arrived))) continue;
      const start = process.platform === 'win32' ? rows.find(row => row.pid === entry.pid)?.start : await startIdentity(entry.pid);
      if (start && start === entry.processStart) live.push({id:entry.id,seat:entry.seat,tier:entry.tier,pid:entry.pid,processStart:entry.processStart,arrived:entry.arrived});
    } catch { /* A partial or crashed registration is not proof of a live waiter; never delete it by guess. */ }
  }
  return live.sort((a,b) => a.arrived.localeCompare(b.arrived) || a.id.localeCompare(b.id));
}
/** A bounded append under its own short pipe hold avoids concurrent append/trim losing another wait. */
async function writeWait(holder: Holder, wait: GateWait, slotsAsked: number, queuePosition: number | null, say: (line:string)=>void): Promise<void> {
  const folder = gateDirectory();
  if (!folder) return;
  let lease: PipeLease | null = null;
  try {
    const until = Date.now() + HANDSHAKE;
    while (!(lease = await tryPipe(lockAddress() + '-waits-file',holder))) {
      if (Date.now() > until) throw Error('waits-file writer exceeded 5 seconds');
      await new Promise(resolve => setTimeout(resolve,25));
    }
    fs.mkdirSync(folder,{recursive:true});
    const file = path.join(folder,'waits.jsonl');
    const line = JSON.stringify({seat:holder.seat,tier:holder.tier,pid:holder.pid,processStart:holder.processStart,
      slotsAsked,seconds:wait.seconds,holders:wait.holders,queuePosition,started:wait.started,ended:wait.ended}) + '\n';
    if (Buffer.byteLength(line) > WAITS_LIMIT) throw Error('one wait record exceeds the 1 MiB bound');
    fs.appendFileSync(file,line,{flush:true});
    if (fs.statSync(file).size > WAITS_LIMIT) {
      const lines=fs.readFileSync(file,'utf8').split('\n');
      let size=Buffer.byteLength(lines.join('\n')), first=0;
      while (size>WAITS_LIMIT && first<lines.length-1) { size-=Buffer.byteLength(lines[first++]!)+1; }
      fs.writeFileSync(file,lines.slice(first).join('\n'),{flush:true});
    }
  } catch (error) { say(`warning: gate waits file not written: ${String(error)}`); }
  finally { if (lease) await lease.release().catch(error => say(`warning: gate waits file release: ${String(error)}`)); }
}

export async function acquireGateLock(tier: string, noWait = false, say = (line: string) => process.stdout.write(line + '\n')): Promise<GateLock> {
  const inherited = process.env['DESKPOST_GATE_LOCK'];
  const enabled = process.env['DESKPOST_GATE_SERIAL'] !== '0' && !(inherited === 'off' && !process.env['DESKPOST_GATE_LOCK_NAME']);
  if (!enabled && (!inherited || inherited === 'off')) {
    process.env['DESKPOST_GATE_LOCK'] = 'off';
    return { inherited: inherited === 'off', wait: null, release: async () => {} };
  }
  const address = lockAddress(), flagAddress = address + '-push-waiting';
  if (inherited) {
    const slot = /^slot:(\d+):/.exec(inherited)?.[1];
    const holder = await readHolder(slot ? address + '-' + slot : address).catch((error: unknown) => { throw new LockError(`inherited gate lock could not be validated: ${String(error)}`); });
    if (holder.token !== inherited) throw new LockError('inherited gate lock token does not match its holder');
    // A one-slot holder's token cannot carry a push or release: those tiers need the door and every slot (s186).
    if (slot && (tier === 'push' || tier === 'release')) throw new LockError(`a ${tier} gate cannot inherit this gate lock: its holder (${holder.seat}'s ${holder.tier} gate) holds one slot, and a ${tier} needs every slot`);
    return { inherited: true, wait: null, release: async () => {} };
  }
  const holder: Holder = { seat: process.env['LIBRARY_SEAT'] || 'unseated', tier, pid: process.pid,
    processStart: await holderIdentity(), start: new Date().toISOString(), token: randomBytes(24).toString('hex') };
  const exclusive = tier === 'push' || tier === 'release';
  const token = holder.token;
  let flag: PipeLease | null = null, door: PipeLease | null = null;
  const slots: PipeLease[] = [];
  let lastNotice = '', warningSaid = false, waitStarted = 0, testPaused = false;
  const seen: {holder: Holder; seconds: number}[] = [];
  const setting = () => readSlots(line => { if (!warningSaid) { say(line); warningSaid = true; } });
  let registration: string | null = null, request: Waiter | null = null, queuePosition: number | null = null, slotsAsked = 1;
  let lastObserved = 0;
  let blockers: Holder[] = [];
  const charge = (now: number) => {
    if (lastObserved && blockers.length) for (const holder of blockers) {
      const entry=seen.find(entry=>entry.holder.token===holder.token)!;
      entry.seconds+=(now-lastObserved)/1000/blockers.length;
    }
    lastObserved=now;
  };
  const unregister = () => {
    if (!registration) return;
    try { fs.rmSync(registration,{force:true}); }
    catch(error) { say(`warning: gate queue registration not removed: ${String(error)}`); }
    registration=null;
  };
  const blocked = async (previous: Holder | null) => {
    {
      const now=Date.now();
      if (!waitStarted) waitStarted=now;
      charge(now); blockers=await currentHolders(previous,holder);
      for (const current of blockers) if (!seen.some(entry=>entry.holder.token===current.token)) seen.push({holder:current,seconds:0});
      let waiters: Waiter[] = [], queueKnown = false;
      const folder=gateDirectory();
      const firstRequest=!request;
      if (!request) {
        request={id:randomBytes(12).toString('hex'),seat:holder.seat,tier:holder.tier,pid:holder.pid,processStart:holder.processStart,arrived:new Date(waitStarted).toISOString()};
        if (folder) try {
          const directory=path.join(folder,'waiters'); fs.mkdirSync(directory,{recursive:true});
          registration=path.join(directory,request.id+'.json'); fs.writeFileSync(registration,JSON.stringify(request),{flag:'wx'});
        } catch(error) { registration=null; say(`warning: gate queue not registered: ${String(error)}`); }
      }
      if (folder && registration) try { waiters=await liveWaiters(path.join(folder,'waiters')); queueKnown=true; }
      catch(error) { if (firstRequest) say(`warning: gate queue not read: ${String(error)}`); }
      if (!waiters.some(entry=>entry.id===request!.id)) waiters.push(request);
      waiters.sort((a,b)=>a.arrived.localeCompare(b.arrived)||a.id.localeCompare(b.id));
      const position=queueKnown ? waiters.findIndex(entry=>entry.id===request!.id)+1 : null;
      if (firstRequest) queuePosition=position;
      const notice=previous ? `waiting: ${previous.seat}'s ${previous.tier} gate, started ${previous.start} (pid ${previous.pid}, process start ${publicHolder(previous).processStart})`
        : "waiting: unobserved holder's unobserved gate (holder ended before a reply)";
      const queue='gate queue: '+JSON.stringify({position,holders:blockers.map(publicHolder),waiters});
      if (notice+'\n'+queue!==lastNotice) { say(notice); say(queue); lastNotice=notice+'\n'+queue; }
    }
    if (noWait) throw new LockError('gate lock is held; --no-wait refuses to wait',3);
    await pause();
  };
  const releasePipes = async () => {
    unregister();
    for (const slot of slots.splice(0).reverse()) await slot.release();
    if (door) { const old = door; door = null; await old.release(); }
    if (flag) { const old = flag; flag = null; await old.release(); }
  };
  try {
    if (exclusive) {
      while (!(flag = await tryPipe(flagAddress, holder))) await blocked(await contender(flagAddress));
    }
    for (;;) {
      holder.token = token;
      door = await tryPipe(address, holder);
      if (!door) { await blocked(await contender(address)); continue; }
      // Every retry reads the setting UNDER the legacy door (R9). Never cache admission mode.
      const config = setting();
      slotsAsked=exclusive ? config?.slots ?? 1 : 1;
      // SELF-TEST ONLY: yield the door across a setting change, then retry the read under it (R9).
      const testPause = process.env['DESKPOST_GATE_LOCK_NAME'] && process.env['DESKPOST_GATE_TEST_PAUSE'];
      if (testPause && !testPaused) {
        testPaused = true; await door.release(); door = null;
        say('SELF-TEST admission paused: ' + (config?.slots ?? 'legacy'));
        const until = Date.now() + 30000;
        while (fs.existsSync(testPause)) { if (Date.now() > until) throw new LockError('self-test admission pause exceeded 30 seconds'); await new Promise(resolve => setTimeout(resolve,25)); }
        continue;
      }
      if (!exclusive) {
        const push = await contender(flagAddress);
        if (push) { await door.release(); door = null; await blocked(push); continue; }
      }
      if (!config) break; // No slot file: today's pipe held for the complete run, including older checkouts.
      let previous: Holder | null = null;
      for (let index = 1; index <= config.slots; index++) {
        if (!exclusive) holder.token = `slot:${index}:${holder.token.split(':').at(-1)}`;
        const slotAddress = address + '-' + index;
        let slot = await tryPipe(slotAddress, holder);
        if (exclusive) {
          while (!slot) { await blocked(await contender(slotAddress)); slot = await tryPipe(slotAddress, holder); }
        }
        if (slot) { slots.push(slot); if (!exclusive) break; }
        else previous ??= await contender(slotAddress);
      }
      if (slots.length) { if (!exclusive) { await door.release(); door = null; } break; }
      await door.release(); door = null; await blocked(previous);
    }
    if (flag) { await flag.release(); flag = null; }
    const acquired = Date.now(); charge(acquired);
    const waitedFor=blockers[0] ?? seen.at(-1)?.holder;
    const wait: GateWait | null = waitStarted ? {seconds:(acquired-waitStarted)/1000,seat:waitedFor?.seat ?? 'unobserved holder',tier:waitedFor?.tier ?? 'unobserved',
      ...(waitedFor ? {pid:waitedFor.pid,processStart:publicHolder(waitedFor).processStart} : {}),
      started:new Date(waitStarted).toISOString(),ended:new Date(acquired).toISOString(),
      holders:seen.map(entry=>({...publicHolder(entry.holder),seconds:entry.seconds}))} : null;
    unregister();
    if (wait) await writeWait(holder,wait,slotsAsked,queuePosition,say);
    process.env['DESKPOST_GATE_LOCK'] = holder.token;
    const release = async () => { delete process.env['DESKPOST_GATE_LOCK']; await releasePipes(); };
    await warnLeftovers(say);
    if (wait) say(`gate lock wait: ${JSON.stringify(wait)}`);
    return {inherited:false,wait,release};
  } catch (error) { await releasePipes(); throw error; }
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

/** The only configuration writer: drain the current mode under the push flag and door first. */
export async function setSlots(args: string[], say = (line: string) => process.stdout.write(line + '\n')): Promise<number> {
  const value = args[0], off = value === 'off';
  if (!(off ? args.length === 1 : args.length === 3 && args[1] === '--u2-tip' && /^[1-9]\d*$/.test(value ?? '')
    && Number.isSafeInteger(Number(value)) && /^[a-f0-9]{40}$/.test(args[2] ?? ''))) throw new LockError('usage: --set-slots <N> --u2-tip <sha40> | --set-slots off');
  if (process.env['DESKPOST_GATE_LOCK'] || process.env['DESKPOST_GATE_SERIAL'] === '0') throw new LockError('--set-slots requires a separate outer gate with locking on');
  const folder = gateDirectory();
  if (!folder) throw new LockError('--set-slots in a fixture needs DESKPOST_GATE_DIR');
  const lock = await acquireGateLock('push', false, say);
  try {
    const previous = readSlots(() => {});
    const file = path.join(folder, 'slots');
    if (off) fs.rmSync(file, {force:true});
    else { fs.mkdirSync(folder, {recursive:true}); fs.writeFileSync(file, JSON.stringify({slots:Number(value),u2Tip:args[2]}) + '\n', {flush:true}); }
    say(`gate slots: ${off ? 'deleted' : 'wrote ' + value + ' (U2 ' + args[2] + ')'} ${file}; previous ${previous?.slots ?? 'legacy'}`);
    return 0;
  } finally { await lock.release(); }
}

if (process.argv[1] && import.meta.url === (await import('node:url')).pathToFileURL((await import('node:path')).resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const separator = args.indexOf('--');
  const tier = separator === 2 && args[0] === '--tier' ? args[1] : undefined;
  (args[0] === '--set-slots' ? setSlots(args.slice(1)) : tier && args[separator + 1]
    ? holdAndRun(tier, args[separator + 1]!, args.slice(separator + 2))
    : Promise.reject(new LockError('usage: node gate-lock.ts --tier <name> -- <command> [args]')))
    .then(code => { process.exitCode = code; }, (error: unknown) => {
      process.stderr.write(`gate lock: ${String(error)}\n`); process.exitCode = error instanceof LockError ? error.code : 2;
    });
}
