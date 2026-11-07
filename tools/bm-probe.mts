/**
 * bm-probe: record what a live Basic Memory 1.0 server answers to a list of calls, in a throwaway project, and judge
 * nothing (kickoffs/s187; PLAN-ship-features.md r4, car [2]).
 *
 *   node tools/bm-probe.mts --url <mcp-url> --calls <file.json> --out <folder>
 *
 * The calls file is a JSON array of `{ "tool": "<bm_ tool>", "args": { ... }, "pause_ms": <n, optional> }`.
 *
 * BEFORE ANYTHING IS SENT the whole file is checked, and one unsafe or malformed call refuses it with one line naming the
 * call and the reason, connecting to nothing: a call that is not an object of that shape, a tool that is not a `bm_` name,
 * `bm_project` or `bm_project_delete`, or arguments that name `project` (or its alias `project_id`) themselves. After
 * connecting, and before the project is made, a tool the server does not list is refused the same way.
 *
 * Then it creates ONE project `deskpost-probe-<utc-stamp>` as tools/bm-proof.mts does (refusing a name that exists), adds
 * `project` to every call's arguments, runs the calls in order, and writes:
 *   - `<out>/calls.jsonl`: one line per call, with its index, tool, arguments as sent, the answer (or the error) whole,
 *     start and end times, and `sha256`, the SHA-256 of `JSON.stringify` of that answer or error, so a reader can recompute
 *     it from the line;
 *   - `<out>/summary.txt`, naming the project for the reader to remove;
 *   - `<out>/SHA256SUMS` over those two files.
 * A server refusal or a transport error is recorded, not a failure: it exits 0 once every call was sent. It never
 * removes the project. Exit 2 is a refusal before the project was made; exit 1, a failure to make it.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { field, McpSession, structuredRecord } from '../kernel/src/basicmemory.ts';
import type { Json } from '../kernel/src/basicmemory.ts';
import { listServerProjects } from '../kernel/src/bmconnection.ts';

class Refusal extends Error {}
const USAGE = 'usage: node tools/bm-probe.mts --url <mcp-url> --calls <file.json> --out <folder>';
const FORBIDDEN_TOOLS = new Set(['bm_project', 'bm_project_delete']);
const FORBIDDEN_ARGS = ['project', 'project_id'];

type Call = { tool: string; args: Record<string, Json>; pause_ms: number };

function parse(argv: string[]): { url: string; calls: string; out: string } {
  const values: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (!['--url', '--calls', '--out'].includes(arg)) throw new Refusal(`unknown argument ${arg}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Refusal(`${arg} needs a value`);
    values[arg.slice(2)] = value;
    i += 1;
  }
  if (!values['url'] || !values['calls'] || !values['out']) throw new Refusal('--url, --calls and --out are required');
  return { url: values['url'], calls: path.resolve(values['calls']), out: path.resolve(values['out']) };
}

const isPlainObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The calls file, checked whole: the first unsafe or malformed call refuses it. */
function checkCalls(text: string): Call[] {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch (error) { throw new Refusal(`the calls file is not JSON: ${(error as Error).message}`); }
  if (!Array.isArray(parsed) || parsed.length === 0) throw new Refusal('the calls file is not a non-empty JSON array');
  return parsed.map((item, index) => {
    const name = `call ${index + 1}${isPlainObject(item) && typeof item['tool'] === 'string' ? ` (${item['tool']})` : ''}`;
    if (!isPlainObject(item)) throw new Refusal(`${name}: not an object of the shape {tool, args, pause_ms?}`);
    const extra = Object.keys(item).filter((key) => !['tool', 'args', 'pause_ms'].includes(key));
    if (extra.length) throw new Refusal(`${name}: unexpected field ${extra.join(', ')}; a call holds only tool, args and pause_ms`);
    if (typeof item['tool'] !== 'string' || !/^bm_[a-z_]+$/.test(item['tool'])) throw new Refusal(`${name}: tool must be a bm_ tool name`);
    if (FORBIDDEN_TOOLS.has(item['tool'])) throw new Refusal(`${name}: ${item['tool']} is refused; the probe makes its own project and never names another`);
    if (!isPlainObject(item['args'])) throw new Refusal(`${name}: args must be an object`);
    const named = FORBIDDEN_ARGS.filter((key) => Object.hasOwn(item['args'] as object, key));
    if (named.length) throw new Refusal(`${name}: args name ${named.join(' and ')}; the probe adds its own project to every call`);
    const pause = item['pause_ms'] ?? 0;
    if (!Number.isInteger(pause) || (pause as number) < 0) throw new Refusal(`${name}: pause_ms must be a whole number of at least 0`);
    return { tool: item['tool'], args: item['args'] as Record<string, Json>, pause_ms: pause as number };
  });
}

const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const say = (line: string) => process.stdout.write(line + '\n');

async function main(argv: string[]): Promise<number> {
  const options = parse(argv);
  if (!fs.existsSync(options.calls)) throw new Refusal(`the calls file ${options.calls} does not exist`);
  const calls = checkCalls(fs.readFileSync(options.calls, 'utf8'));
  if (fs.existsSync(path.join(options.out, 'calls.jsonl'))) throw new Refusal(`${options.out} already holds a calls.jsonl; name a new folder`);

  // Connect, and refuse a tool the server does not list, before anything is made.
  const session = new McpSession(options.url, 'deskpost-bm-probe');
  await session.initialize();
  if (session.tools === null) throw new Refusal(`the server at ${options.url} answered no tool list; nothing was created`);
  if (!session.tools.includes('bm_project')) throw new Refusal(`the server at ${options.url} does not list bm_project; nothing was created`);
  for (const [index, call] of calls.entries()) {
    if (!session.tools.includes(call.tool)) throw new Refusal(`call ${index + 1} (${call.tool}): the server does not list ${call.tool}; nothing was created`);
  }

  // The throwaway project, made as tools/bm-proof.mts makes it.
  const stamp = new Date().toISOString().replace(/\.\d+Z$/, 'Z').replace(/[-:]/g, '').replace('T', '-').replace('Z', '').toLowerCase();
  const project = `deskpost-probe-${stamp}`;
  if ((await listServerProjects(session)).some((item) => item.name === project)) throw new Refusal(`a project named ${project} already exists; nothing was created`);
  const made = await session.callTool('bm_project', { command: 'create', name: project, path: project, output_format: 'json' });
  const record = structuredRecord(made);
  if (field(field(made, 'result'), 'isError') === true || field(made, 'error') !== undefined || field(record, 'already_exists') === true) {
    throw new Error(`the project ${project} was not created: ${JSON.stringify(made).slice(0, 400)}`);
  }
  if (!(await listServerProjects(session)).some((item) => item.name === project)) throw new Error(`the project ${project} does not appear in the server's list after it was created`);
  say(`project: ${project}`);

  // The calls, in order, each recorded whole.
  fs.mkdirSync(options.out, { recursive: true });
  const callsPath = path.join(options.out, 'calls.jsonl');
  fs.writeFileSync(callsPath, '');
  let errors = 0;
  for (const [index, call] of calls.entries()) {
    const args: Record<string, Json> = { ...call.args, project };
    const started = new Date().toISOString();
    let line: Record<string, unknown>;
    try {
      const answer = await session.callTool(call.tool, args);
      line = { index: index + 1, tool: call.tool, args, started_utc: started, ended_utc: new Date().toISOString(), answer, sha256: sha256(JSON.stringify(answer)) };
    } catch (error) {
      errors += 1;
      const recorded = { name: (error as Error).name, message: (error as Error).message };
      line = { index: index + 1, tool: call.tool, args, started_utc: started, ended_utc: new Date().toISOString(), error: recorded, sha256: sha256(JSON.stringify(recorded)) };
    }
    fs.appendFileSync(callsPath, JSON.stringify(line) + '\n');
    if (call.pause_ms > 0) await new Promise((done) => setTimeout(done, call.pause_ms));
  }

  const summary = [
    `bm-probe ${new Date().toISOString()} against ${options.url}`,
    `calls file: ${options.calls}`,
    `calls sent: ${calls.length} (${calls.length - errors} answered, ${errors} transport errors; answers are recorded, not judged)`,
    `project left for the reader to remove: ${project}`,
  ];
  fs.writeFileSync(path.join(options.out, 'summary.txt'), summary.join('\n') + '\n');
  const sums = ['calls.jsonl', 'summary.txt'].map((name) => `${createHash('sha256').update(fs.readFileSync(path.join(options.out, name))).digest('hex')}  ${name}`);
  fs.writeFileSync(path.join(options.out, 'SHA256SUMS'), sums.join('\n') + '\n');
  say(summary[2]!);
  say(summary[3]!);
  return 0;
}

// exitCode, not process.exit: exiting while fetch's closed sockets are still being torn down trips a libuv assertion
// on Windows (`!(handle->flags & UV_HANDLE_CLOSING)`), and every request already sends `Connection: close`.
main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error: unknown) => {
  process.stderr.write(error instanceof Refusal ? `bm-probe refused: ${(error as Error).message}\n${USAGE}\n` : `bm-probe failed: ${(error as Error).message}\n`);
  process.exitCode = error instanceof Refusal ? 2 : 1;
});
