/** Record real capture output for the letters-ring eval. No model or messaging session is started.
 * node tools/seat-rules-check/record-letters.mts [--out <fixtures>] [--scratch <temporary-parent>]
 * Re-run after the program changes, retaining the same cases and rules for before/after comparison.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { sessionEnv } from '../seat-rules-check.mts';
import type { LetterFixture } from './count.mts';

const here = path.dirname(fileURLToPath(import.meta.url));
const checkout = path.resolve(here, '../..');
const option = (name: string) => { const at = process.argv.indexOf(name); return at < 0 ? undefined : process.argv[at + 1]; };
const output = path.resolve(option('--out') ?? path.join(here, 'fixtures'));
const scratch = path.resolve(option('--scratch') ?? os.tmpdir());
fs.mkdirSync(scratch, { recursive: true });
const root = fs.realpathSync(fs.mkdtempSync(path.join(scratch, 'record-letters-')));
const workspace = path.join(root, 'library'), registry = path.join(root, 'registry'), home = path.join(root, 'home');
fs.mkdirSync(home);
const env = { ...sessionEnv(), HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'appdata'), LOCALAPPDATA: path.join(home, 'local'), LIBRARY_WORKSPACE: '', LIBRARY_WORKSPACES: registry, LIBRARY_SEAT: '', LIBRARY_SEAT_CLAIM: '', AI_LIBRARY_MCP_URL: '', AI_LIBRARY_PROJECT_ID: '', LIBRARY_SHARED_COLLECTION_ROOT: '' };
const agents: ChildProcess[] = [];
let supportsWants = false;
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
function cli(args: string[], agent = process.pid, assistant = 'claude') {
  const ran = spawnSync(process.execPath, [path.join(checkout, 'kernel/src/cli.ts'), ...args], { cwd: root, env: { ...env, CLAUDE_PID: String(agent), DESKPOST_ASSISTANT: assistant }, encoding: 'utf8', windowsHide: true, timeout: 30000 });
  if (ran.error) throw ran.error;
  return { status: ran.status, stdout: ran.stdout, stderr: ran.stderr };
}
function required(args: string[], agent = process.pid) {
  const ran = cli(args, agent);
  if (ran.status !== 0) throw new Error(JSON.stringify(args) + '\n' + ran.stdout + ran.stderr);
  return json(ran.stdout);
}
function hold(seat: string, project: string) {
  const agent = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
  if (!agent.pid) throw new Error('dummy agent did not start');
  agents.push(agent);
  const args = ['seat', 'enter', seat, '--create', '--project', project, '--agent-pid', String(agent.pid), '--workspace', workspace, '--deadline-seconds', '10'];
  const preflight = required([...args, '--preflight'], agent.pid);
  if (typeof preflight.plan_id !== 'string') throw new Error('seat enter preflight returned no plan_id: ' + JSON.stringify(preflight));
  required([...args, '--plan-id', preflight.plan_id], agent.pid);
  return agent.pid;
}
function json(text: string): Record<string, unknown> { try { return JSON.parse(text); } catch { return {}; } }
function page(text: string): string {
  const record = json(text);
  return String(record['page'] ?? record['note_page'] ?? '').replace(/^.*\/wiki\//, '').replace(/\.md$/, '');
}
function capture(agent: number, assistant: string, args: string[], mayRefuse = false): string {
  if (supportsWants && args.includes('--for') && !args.includes('--wants')) args = [...args, '--wants', 'info'];
  const command = ['capture', 'letters', ...args, '--why', 'for-seat', '--title', 'Recorded eval letter', '--body', 'Please read this fixture letter.', '--workspace', workspace, '--json'];
  const ran = cli(command, agent, assistant);
  if (ran.status !== 0) {
    process.stdout.write('recorded refusal: ' + JSON.stringify(command) + '\n' + ran.stdout + ran.stderr);
    if (!mayRefuse) throw new Error('capture failed');
  }
  // The refused CLI prints its reason to stderr; keep both streams exactly as printed.
  return ran.stdout + ran.stderr;
}
try {
  required(['init', workspace, '--registry-root', registry]);
  for (const project of ['writer-project', 'recipient-project', 'absent-project']) required(['hub', 'new', project, '--title', project, '--workspace', workspace]);
  fs.mkdirSync(path.join(workspace, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(workspace, '.claude/.library-project'), '33333333-3333-3333-3333-333333333333');
  const writer = hold('writer', 'writer-project'), recipient = hold('recipient', 'recipient-project');
  required(['desk', 'open', 'book', 'letters', '--location', 'shelf', '--workspace', workspace], writer);
  required(['seat', 'start', 'absent', '--project', 'absent-project', '--no-launch', '--workspace', workspace]);
  const activity = path.join(workspace, '.claude/seats/recipient/activity.json');
  const session = '20500000-0000-4000-8000-000000000001';
  const nameRecipient = (named: boolean) => fs.writeFileSync(activity, JSON.stringify({ seat: 'recipient', last_seen_utc: '2999-01-01T00:00:00Z', note: 'fixture', session_id: session, conversation_recorded_utc: '2999-01-01T00:00:00Z', ...(named ? { message_name: 'recipient-peer', message_session_id: session } : {}) }));
  nameRecipient(true);
  supportsWants = json(capture(writer, 'claude', ['--for', 'recipient', '--wants', 'answer'], true))['status'] === 'captured';
  const situations: [string, string][] = [
    ['ring-live', 'Write an information letter to recipient, a running Claude seat named recipient-peer.'],
    ['ring-not-yet-named', 'Write an information letter to recipient; its running Claude session has not yet recorded its message name.'],
    ['wants-answer', 'Write a letter to recipient asking for an answer about whether the fixture is ready.'],
    ['reply-to-closed', 'Reply once more to the indicated incoming letter, which you have already answered and closed.'],
    ['several-to-one', 'Write three separate information letters to recipient, about the build, its checks and its handback, in this turn.'],
    ['recipient-not-running', 'Write an information letter to absent, a seat that is not running.'],
  ];
  for (const [id, situation] of situations) {
    nameRecipient(id !== 'ring-not-yet-named');
    const target = id === 'recipient-not-running' ? 'absent' : 'recipient';
    const outputs: Record<string, LetterFixture['outputs']> = {};
    const incoming = capture(recipient, 'claude', ['--for', 'writer']);
    const answeredPage = page(incoming);
    if (!answeredPage) throw new Error('incoming page missing: ' + incoming);
    capture(writer, 'claude', ['--answers', answeredPage]);
    for (const harness of ['claude', 'codex']) {
      const plain = Array.from({ length: id === 'several-to-one' ? 3 : 1 }, () => capture(writer, harness, ['--for', target]));
      const first = json(plain[0]!);
      if (id === 'ring-not-yet-named' && first['recipient_message_name_reason'] !== 'not yet named') throw new Error('unnamed seat not reproduced: ' + plain[0]);
      if (id === 'ring-live' && first['recipient_message_name'] !== 'recipient-peer') throw new Error('named seat not reproduced: ' + plain[0]);
      const wants = capture(writer, harness, ['--for', target, '--wants', 'answer'], true);
      const answers = capture(writer, harness, ['--answers', answeredPage], true);
      outputs[harness] = { plain, wants, answers };
    }
    const selected = (harness: string) => id === 'wants-answer' && page(outputs[harness]!.wants) ? [outputs[harness]!.wants] : outputs[harness]!.plain;
    const claudePages = selected('claude').map(page), codexPages = selected('codex').map(page);
    const ring = claudePages.length > 1 ? `From writer: ${claudePages.length} letters for you, letters ${claudePages.join(', ')}` : `From writer: a letter for you, letters ${claudePages[0]}`;
    const relay = codexPages.length > 1 ? `Tell ${target}: ${codexPages.length} letters for you, letters ${codexPages.join(', ')}` : `Tell ${target}: a letter for you, letters ${codexPages[0]}`;
    const fixture: LetterFixture = { agents: target === 'absent' ? [] : [{ name: 'recipient-peer', seat: 'recipient', status: 'idle' }], expected_ring_target: 'recipient-peer', ring_line: ring, ...(claudePages.length > 1 ? { combined_ring_line: ring } : {}), relay_line: relay, answered_page: answeredPage, outputs: outputs['claude']!, outputs_by_harness: outputs };
    const folder = path.join(output, id); fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'letters-ring.json'), JSON.stringify(fixture, null, 2) + '\n');
    fs.writeFileSync(path.join(folder, 'README.md'), `# ${id}\n\n${situation}\n\nYou are writer. Use capture_letter to write letters and list_agents to find running recipients.\n${id === 'reply-to-closed' ? 'The incoming page is ' + answeredPage + '. It was already answered and is closed.\n' : ''}\nProgram replies are recorded from the real CLI; expectations are not exposed to the session.\n`);
    process.stdout.write('recorded: ' + id + ' (Claude and Codex writer copies)\n');
  }
} finally {
  for (const agent of agents) { try { agent.kill(); } catch { /* already ended */ } }
  const deadline = Date.now() + 10000;
  while (agents.some(agent => agent.exitCode === null && agent.signalCode === null) && Date.now() < deadline) await pause(50);
  process.stdout.write('cleanup: removing only the temporary fixture Library, registry and fake home at ' + root + '\n');
  let removed = false;
  while (Date.now() < deadline) {
    try { fs.rmSync(root, { recursive: true, force: true }); removed = true; break; } catch { await pause(200); }
  }
  if (!removed) throw new Error('temporary fixture cleanup failed: ' + root);
}
