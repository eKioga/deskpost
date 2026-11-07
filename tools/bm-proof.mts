/**
 * bm-proof: prove a Basic Memory 1.0 server's write guard in a throwaway project (kickoffs/s178-r2 row 9;
 * PLAN-basic-memory-1-0.md Unit B).
 *
 *   node tools/bm-proof.mts --url <mcp-url> --out <folder> [--trials <n>] [--record --workspace <library>]
 *
 * It connects, keeps the server's tool-list fingerprint, creates ONE project named `deskpost-proof-<utc-stamp>` and names
 * no other, and runs four proofs through the write primitives of kernel/src/bmwrite.ts, never a raw change call:
 *   - the create race: --trials trials (default 200) of two sessions creating one path at once; a trial passes when exactly
 *     one is `written`, the other `refused` ALREADY_EXISTS, and a listed read holds the winner's text;
 *   - the conditional race: --trials trials of two sessions replacing one note with the same base checksum; a trial passes
 *     when exactly one is `written`, the other `refused` REVISION_CONFLICT carrying the winner's checksum, and a listed
 *     read holds the winner's text;
 *   - S5: what the server does to a page sent as is (an observation only), then the companion-body encoding, one line
 *     `deskpost-page-base64 v1 sha256=<hex> bytes=<n>` and the page's exact bytes in base64, 76 characters a line: ten
 *     pages written, read back by their listing and decoded, each equal to its SHA-256 and length, and each stored file's
 *     checksum the SHA-256 of the whole file `bm_read` returns;
 *   - S6: ten times (kickoffs/s181-r2 row 3.1), a note moved, a new note created at its old path two seconds after every
 *     move that was not refused, as Deskpost's writers will (Eric's Decision of 2026-11-05: the writers pause about two
 *     seconds after a move before creating at the old path), and both paths read by their listings. A repetition passes when
 *     the create is (a) `written` and the old path's listed read holds the new note, or (b) `refused` ALREADY_EXISTS and
 *     the old path's folder lists no file there; in both, the destination's listed read holds the moved note. A plain
 *     path read of the old path is an observation. The summary counts each outcome.
 * The project is removed only when the server lists `bm_project_delete`; otherwise the result names it for the reader to
 * remove. It writes <out>/result.json and <out>/summary.txt and exits 0 only when all four pass. With --record and every
 * proof passing, it writes the measured fingerprint as proven into that Library's Postbox cache (four fields, through
 * postbox.ts); with a failing proof it records nothing and says so.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { field, listFolderNodes, McpSession, noteBody, readExactOrNull, readListedRecord, structuredRecord, text } from '../kernel/src/basicmemory.ts';
import { createNote, moveNote, replaceNote } from '../kernel/src/bmwrite.ts';
import type { BmVerdict } from '../kernel/src/basicmemory.ts';
import { listServerProjects } from '../kernel/src/bmconnection.ts';
import { recordProvenFingerprint } from '../kernel/src/postbox.ts';

class UsageError extends Error {}
const USAGE = 'usage: node tools/bm-proof.mts --url <mcp-url> --out <folder> [--trials <n>] [--record --workspace <library>]';

function parse(argv: string[]): { url: string; out: string; trials: number; record: boolean; workspace: string } {
  const values: Record<string, string> = {};
  let record = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === '--record') { record = true; continue; }
    if (!['--url', '--out', '--trials', '--workspace'].includes(arg)) throw new UsageError(`unknown argument ${arg}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new UsageError(`${arg} needs a value`);
    values[arg.slice(2)] = value;
    i += 1;
  }
  if (!values['url'] || !values['out']) throw new UsageError('--url and --out are required');
  const trials = Number(values['trials'] ?? 200);
  if (!Number.isInteger(trials) || trials < 1) throw new UsageError('--trials must be a whole number of at least 1');
  if (record && !values['workspace']) throw new UsageError('--record needs --workspace <library>');
  if (!record && values['workspace']) throw new UsageError('--workspace is read only with --record');
  return { url: values['url'], out: path.resolve(values['out']), trials, record, workspace: values['workspace'] ? path.resolve(values['workspace']) : '' };
}

const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const sameText = (listed: string, proposed: string) =>
  noteBody({ file_path: '', title: '', content: listed }).replace(/\r\n/g, '\n').trim() === proposed.replace(/\r\n/g, '\n').trim();
const describe = (verdict: BmVerdict) => (verdict.form === 'refused' ? `refused ${verdict.code}` : verdict.form);

/** The text of the one file at exactly `notePath`, read by its folder's listing, or null when the folder lists none there. */
async function listedRead(session: McpSession, project: string, notePath: string): Promise<{ text: string; checksum: string } | null> {
  const folder = notePath.slice(0, notePath.lastIndexOf('/'));
  const nodes = await listFolderNodes(session, project, folder, `The folder ${folder}`, `The folder ${folder} is too large to list.`);
  const node = nodes.find((item) => field(item, 'type') === 'file' && text(field(item, 'file_path')) === notePath);
  if (node === undefined) return null;
  return readListedRecord(session, { id: project, name: project }, notePath, text(field(node, 'permalink')));
}

/** The companion-body encoding (r11; PLAN-basic-memory-1-0.md Unit B, S5). */
function encodePage(page: Buffer): string {
  const lines = page.toString('base64').match(/.{1,76}/g) ?? [];
  return [`deskpost-page-base64 v1 sha256=${sha256(page)} bytes=${page.length}`, ...lines].join('\n');
}

function decodePage(stored: string): { bytes: Buffer; sha256: string; length: number } | null {
  const lines = stored.replace(/\r\n/g, '\n').split('\n');
  const at = lines.findIndex((line) => /^deskpost-page-base64 v1 sha256=[0-9a-f]{64} bytes=\d+$/.test(line.trim()));
  if (at < 0) return null;
  const head = /sha256=([0-9a-f]{64}) bytes=(\d+)/.exec(lines[at]!)!;
  const body: string[] = [];
  for (const line of lines.slice(at + 1)) {
    if (!/^[A-Za-z0-9+/=]*$/.test(line.trim())) break;
    body.push(line.trim());
  }
  return { bytes: Buffer.from(body.join(''), 'base64'), sha256: head[1]!, length: Number(head[2]) };
}

const S5_PAGES: [string, Buffer][] = [
  ['plain, LF, trailing newline', Buffer.from('# A page\n\nOne paragraph.\n', 'utf8')],
  ['plain, LF, no trailing newline', Buffer.from('# A page\n\nOne paragraph.', 'utf8')],
  ['plain, CRLF, trailing newline', Buffer.from('# A page\r\n\r\nOne paragraph.\r\n', 'utf8')],
  ['plain, CRLF, no trailing newline', Buffer.from('# A page\r\n\r\nOne paragraph.', 'utf8')],
  ['own frontmatter, LF', Buffer.from('---\ntitle: Its Own Title\nupdated: 2026-11-03T09:00:00Z\n---\n\n# Body\n\nText.\n', 'utf8')],
  ['own frontmatter, CRLF', Buffer.from('---\r\ntitle: Its Own Title\r\ntags: [a, b]\r\n---\r\n\r\n# Body\r\n\r\nText.\r\n', 'utf8')],
  ['non-ASCII, LF', Buffer.from('# Caf\u00e9\n\nNa\u00efve \u6f22\u5b57 \u2014 \u{1F600}.\n', 'utf8')],
  ['non-ASCII, own frontmatter, CRLF, no trailing newline', Buffer.from('---\r\ntitle: \u00c9t\u00e9\r\n---\r\n\r\n\u00dcber \u00e5 \u00f8.', 'utf8')],
  ['empty', Buffer.alloc(0)],
  ['long, mixed', Buffer.from(Array.from({ length: 120 }, (_, n) => `Line ${n}: ${n % 2 ? 'odd' : 'even'} \u00b7 ${'x'.repeat(n % 50)}${n % 3 ? '\n' : '\r\n'}`).join(''), 'utf8')],
];

type Run = { name: string; pass: boolean; passed?: number; trials?: number; failures: string[]; observations?: unknown };

async function main(argv: string[]): Promise<number> {
  const options = parse(argv);
  const started = Date.now();
  const stamp = new Date().toISOString().replace(/\.\d+Z$/, 'Z').replace(/[-:]/g, '').replace('T', '-').replace('Z', '').toLowerCase();
  const project = `deskpost-proof-${stamp}`;
  fs.mkdirSync(options.out, { recursive: true });
  const result: Record<string, unknown> = { url: options.url, project, trials: options.trials, started_utc: new Date(started).toISOString() };
  const runs: Run[] = [];
  const say = (line: string) => process.stdout.write(line + '\n');

  // 1. Connect, the fingerprint, and what bm_project offers.
  const session = new McpSession(options.url, 'deskpost-bm-proof');
  await session.initialize();
  if (session.surface !== 'bm') throw new Error(`the server at ${options.url} does not offer the 1.0 tools (surface ${session.surface}); nothing was created`);
  const listed = await session.request('tools/list', {});
  const tools = field(field(listed, 'result'), 'tools');
  const projectTool = Array.isArray(tools) ? tools.find((tool) => field(tool, 'name') === 'bm_project') : undefined;
  const schema = JSON.stringify(field(projectTool, 'inputSchema') ?? null);
  result['fingerprint'] = session.toolsFingerprint;
  result['tools'] = session.tools;
  result['bm_project_input_schema'] = JSON.parse(schema) as unknown;
  result['bm_project_offers_remove_command'] = /"(remove|delete)"/.test(schema);
  const canDelete = (session.tools ?? []).includes('bm_project_delete');
  result['bm_project_delete_listed'] = canDelete;
  say(`fingerprint: ${String(session.toolsFingerprint)}`);

  // 2. The throwaway project: created, never one that already exists.
  if ((await listServerProjects(session)).some((item) => item.name === project)) throw new Error(`a project named ${project} already exists; nothing was created`);
  const made = await session.callTool('bm_project', { command: 'create', name: project, path: project, output_format: 'json' });
  const record = structuredRecord(made);
  if (field(field(made, 'result'), 'isError') === true || field(made, 'error') !== undefined || field(record, 'already_exists') === true) {
    throw new Error(`the project ${project} was not created: ${JSON.stringify(made).slice(0, 400)}`);
  }
  if (!(await listServerProjects(session)).some((item) => item.name === project)) throw new Error(`the project ${project} does not appear in the server's list after it was created`);
  result['project_created'] = true;
  say(`project: ${project}`);
  const a = new McpSession(options.url, 'deskpost-bm-proof-a');
  const b = new McpSession(options.url, 'deskpost-bm-proof-b');
  await a.initialize();
  await b.initialize();

  // 3. The create race.
  {
    const run: Run = { name: 'create race', pass: false, passed: 0, trials: options.trials, failures: [] };
    try {
      for (let n = 1; n <= options.trials; n += 1) {
        const note = `create-race/t${n}/note.md`;
        const bodies = [`Create race ${n}: writer A.`, `Create race ${n}: writer B.`];
        const verdicts = await Promise.all([createNote(a, project, note, bodies[0]!), createNote(b, project, note, bodies[1]!)]);
        const winners = verdicts.flatMap((verdict, at) => (verdict.form === 'written' ? [at] : []));
        const loser = verdicts.find((verdict) => verdict.form !== 'written');
        const read = winners.length === 1 ? await listedRead(a, project, note) : null;
        if (winners.length === 1 && loser?.form === 'refused' && loser.code === 'ALREADY_EXISTS' && read !== null && sameText(read.text, bodies[winners[0]!]!)) run.passed! += 1;
        else run.failures.push(`trial ${n}: ${verdicts.map(describe).join(' / ')}${read === null ? '' : `; listed text ${JSON.stringify(read.text.slice(-80))}`}`);
      }
    } catch (error) {
      run.failures.push(`stopped: ${(error as Error).message}`);
    }
    run.pass = run.passed === options.trials;
    runs.push(run);
    say(`create race: ${run.passed}/${options.trials}`);
  }

  // 4. The conditional race.
  {
    const run: Run = { name: 'conditional race', pass: false, passed: 0, trials: options.trials, failures: [] };
    try {
      for (let n = 1; n <= options.trials; n += 1) {
        const note = `conditional-race/t${n}/note.md`;
        const made = await createNote(a, project, note, `Conditional race ${n}: the base.`);
        const base = made.form === 'written' ? await readExactOrNull(a, project, note) : null;
        if (base === null || !base.checksum) { run.failures.push(`trial ${n}: the base was not written and read (${describe(made)})`); continue; }
        const bodies = [`Conditional race ${n}: writer A.`, `Conditional race ${n}: writer B.`];
        const verdicts = await Promise.all([replaceNote(a, project, note, bodies[0]!, base.checksum), replaceNote(b, project, note, bodies[1]!, base.checksum)]);
        const winners = verdicts.flatMap((verdict, at) => (verdict.form === 'written' ? [at] : []));
        const won = winners.length === 1 ? verdicts[winners[0]!] : undefined;
        const loser = verdicts.find((verdict) => verdict.form !== 'written');
        const read = winners.length === 1 ? await listedRead(a, project, note) : null;
        if (won?.form === 'written' && loser?.form === 'refused' && loser.code === 'REVISION_CONFLICT' && loser.currentChecksum === won.checksum && read !== null && sameText(read.text, bodies[winners[0]!]!)) run.passed! += 1;
        else run.failures.push(`trial ${n}: ${verdicts.map((verdict) => describe(verdict) + (verdict.form === 'refused' && verdict.currentChecksum ? ` (current ${verdict.currentChecksum.slice(0, 12)})` : verdict.form === 'written' ? ` (${verdict.checksum.slice(0, 12)})` : '')).join(' / ')}`);
      }
    } catch (error) {
      run.failures.push(`stopped: ${(error as Error).message}`);
    }
    run.pass = run.passed === options.trials;
    runs.push(run);
    say(`conditional race: ${run.passed}/${options.trials}`);
  }

  // 5. S5: a page sent as is (observed), then the companion-body encoding (proved).
  {
    const run: Run = { name: 'S5', pass: false, failures: [] };
    const observations: Record<string, unknown> = {};
    try {
      const asIs = '---\r\ntitle: Another Title\r\nupdated: 2026-11-03T09:00:00Z\r\nkind: sample\r\n---\r\n\r\n# Sent as is\r\n\r\nBody line.\r\n';
      const sent = await createNote(a, project, 's5-as-is/page.md', asIs);
      observations['verdict'] = sent;
      const nodes = await listFolderNodes(a, project, 's5-as-is', 'The folder s5-as-is', 'too large');
      const node = nodes.find((item) => field(item, 'type') === 'file');
      const stored = node === undefined ? null : await readListedRecord(a, { id: project, name: project }, text(field(node, 'file_path')), text(field(node, 'permalink')));
      observations['stored_path'] = node === undefined ? null : text(field(node, 'file_path'));
      if (stored !== null) {
        const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(stored.text)?.[1] ?? '';
        observations['stored_text'] = stored.text;
        observations['frontmatter_merged'] = /^kind: sample$/m.test(front);
        observations['title_line'] = /^title:.*$/m.exec(front)?.[0] ?? null;
        observations['updated_line'] = /^updated:.*$/m.exec(front)?.[0] ?? null;
        observations['crlf_kept'] = stored.text.includes('\r\n');
        observations['trailing_newline_kept'] = /\n$/.test(stored.text);
        observations['checksum_is_sha256_of_text'] = stored.checksum === sha256(Buffer.from(stored.text, 'utf8'));
      }
      const pages: Record<string, unknown>[] = [];
      for (const [k, [label, page]] of S5_PAGES.entries()) {
        const note = `s5-encoding/page-${k + 1}.md`;
        const verdict = await createNote(a, project, note, encodePage(page));
        const read = verdict.form === 'written' ? await listedRead(a, project, note) : null;
        const decoded = read === null ? null : decodePage(noteBody({ file_path: '', title: '', content: read.text }));
        const ok = decoded !== null && decoded.length === page.length && decoded.sha256 === sha256(page) && decoded.bytes.equals(page) && read !== null && read.checksum === sha256(Buffer.from(read.text, 'utf8'));
        pages.push({ label, verdict: describe(verdict), bytes: page.length, decoded_bytes: decoded?.bytes.length ?? null, sha256_matches: decoded !== null && sha256(decoded.bytes) === sha256(page), checksum_is_whole_file: read !== null && read.checksum === sha256(Buffer.from(read.text, 'utf8')), pass: ok });
        if (!ok) run.failures.push(`page ${k + 1} (${label}): ${describe(verdict)}, ${decoded === null ? 'not decoded' : `decoded ${decoded.bytes.length} bytes`}`);
      }
      observations['pages'] = pages;
    } catch (error) {
      run.failures.push(`stopped: ${(error as Error).message}`);
    }
    run.observations = observations;
    run.pass = run.failures.length === 0;
    runs.push(run);
    say(`S5: ${run.pass ? 'pass' : 'fail'}`);
  }

  // 6. S6: identities after a move and a new note at the old path, ten times (kickoffs/s181-r2 row 3.1).
  let s6Line = '';
  {
    const run: Run = { name: 'S6', pass: false, failures: [] };
    const repetitions: Record<string, unknown>[] = [];
    const counted = { written: 0, refused: 0 };
    for (let i = 1; i <= 10; i += 1) {
      const from = `s6-${i}-from/note.md`;
      const to = `s6-${i}-to/note.md`;
      const seen: Record<string, unknown> = { repetition: i, pause_seconds: 2 };
      const failures: string[] = [];
      try {
        const moving = `S6 ${i}: the note that moves.`;
        const fresh = `S6 ${i}: the new note at the old path.`;
        const first = await createNote(a, project, from, moving);
        const moved = first.form === 'written' ? await moveNote(a, project, from, `s6-${i}-to/`) : first;
        if (moved.form !== 'refused') await new Promise((done) => setTimeout(done, 2000));
        const second = moved.form === 'refused' ? moved : await createNote(a, project, from, fresh);
        seen['verdicts'] = { create: first, move: moved, create_at_old_path: second };
        const atOld = await listedRead(a, project, from);
        const atNew = await listedRead(a, project, to);
        seen['listed_old_path'] = atOld === null ? 'no file listed' : sameText(atOld.text, fresh) ? 'the new note' : sameText(atOld.text, moving) ? 'the moved note' : 'other text';
        seen['listed_new_path_holds_moved_text'] = atNew !== null && sameText(atNew.text, moving);
        const plain = await a.callTool('bm_read', { identifier: from, include_frontmatter: true, output_format: 'json', project });
        const plainRecord = structuredRecord(plain);
        seen['plain_path_read_answered'] = { file_path: text(field(plainRecord, 'file_path')), holds: text(field(plainRecord, 'content')).includes(fresh) ? 'new note' : text(field(plainRecord, 'content')).includes(moving) ? 'moved note' : 'other' };
        if (first.form !== 'written') failures.push(`the first note was ${describe(first)}`);
        else if (moved.form === 'refused') failures.push(`the move was ${describe(moved)}`);
        else if (second.form === 'written') {
          counted.written += 1;
          if (seen['listed_old_path'] !== 'the new note') failures.push(`the new note was written, but the old path, read by its listing, holds ${String(seen['listed_old_path'])}`);
        } else if (second.form === 'refused' && second.code === 'ALREADY_EXISTS') {
          counted.refused += 1;
          if (atOld !== null) failures.push('the new note was refused ALREADY_EXISTS, but the old path\'s folder lists a file there');
        } else failures.push(`the new note at the old path was ${describe(second)}`);
        if (!seen['listed_new_path_holds_moved_text']) failures.push('the destination, read by its listing, does not hold the moved note');
      } catch (error) {
        failures.push(`stopped: ${(error as Error).message}`);
      }
      seen['pass'] = failures.length === 0;
      repetitions.push(seen);
      run.failures.push(...failures.map((failure) => `repetition ${i}: ${failure}`));
    }
    s6Line = `S6 create at the old path (two-second pause after each move): ${counted.written} written, ${counted.refused} refused ALREADY_EXISTS`;
    run.observations = { repetitions, counted, summary_line: s6Line };
    run.pass = run.failures.length === 0;
    runs.push(run);
    say(`S6: ${run.pass ? 'pass' : 'fail'}`);
    say(s6Line);
  }

  // 7. Removal, only where the server offers it.
  let removed = false;
  if (canDelete) {
    try {
      await session.callTool('bm_project_delete', { name: project, output_format: 'json' });
      removed = !(await listServerProjects(session)).some((item) => item.name === project);
    } catch (error) {
      result['removal_error'] = (error as Error).message;
    }
  }
  result['project_removed'] = removed;
  say(removed ? `project removed: ${project}` : `project left for the reader to remove: ${project}${canDelete ? ' (removal failed)' : ' (the server offers no bm_project_delete)'}`);

  // 8. The result.
  const allPass = runs.every((run) => run.pass);
  result['runs'] = runs;
  result['pass'] = allPass;
  result['elapsed_seconds'] = Math.round((Date.now() - started) / 100) / 10;
  result['finished_utc'] = new Date().toISOString();
  const resultPath = path.join(options.out, 'result.json');

  // 9. --record, only when every proof passed.
  let recorded = 'not asked (no --record)';
  if (options.record) {
    if (!allPass) recorded = 'nothing recorded: a proof failed';
    else if (!session.toolsFingerprint) recorded = 'nothing recorded: the session has no fingerprint';
    else {
      const wrote = recordProvenFingerprint(options.workspace, { fingerprint: session.toolsFingerprint, utc: new Date().toISOString().replace(/\.\d+Z$/, 'Z'), result: resultPath });
      recorded = wrote ? `recorded in ${options.workspace}: server_tools_fingerprint, server_tools_proven_fingerprint, server_tools_proven_utc, server_tools_proven_result` : `nothing recorded: ${options.workspace} has no Postbox cache`;
    }
  }
  result['record'] = recorded;
  fs.writeFileSync(resultPath, JSON.stringify(result, null, 2) + '\n');
  const summary = [
    `bm-proof ${result['finished_utc']} against ${options.url}`,
    `fingerprint: ${String(session.toolsFingerprint)}`,
    `project: ${project} (${removed ? 'removed' : 'left for the reader to remove'})`,
    ...runs.map((run) => (run.trials ? `${run.name}: ${run.passed}/${run.trials}` : `${run.name}: ${run.pass ? 'pass' : 'fail'}`)),
    s6Line,
    ...runs.flatMap((run) => run.failures.slice(0, 5).map((failure) => `  ${run.name}: ${failure}`)),
    `elapsed: ${String(result['elapsed_seconds'])} s`,
    `record: ${recorded}`,
    `result: ${allPass ? 'pass' : 'fail'} (${resultPath})`,
  ];
  fs.writeFileSync(path.join(options.out, 'summary.txt'), summary.join('\n') + '\n');
  say(`record: ${recorded}`);
  say(`result: ${allPass ? 'pass' : 'fail'}`);
  return allPass ? 0 : 1;
}

// exitCode, not process.exit: exiting while fetch's closed sockets are still being torn down trips a libuv assertion
// on Windows (`!(handle->flags & UV_HANDLE_CLOSING)`, seen in bm-probe); let the event loop drain instead.
main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error: unknown) => {
  process.stderr.write(error instanceof UsageError ? `${(error as Error).message}\n${USAGE}\n` : `bm-proof failed: ${(error as Error).message}\n`);
  process.exitCode = error instanceof UsageError ? 2 : 1;
});
