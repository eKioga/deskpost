/** Git pre-push policy; records are local gate evidence, not release authorization. */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const refuse = (reason: string): never => { throw new Error(reason); };
const git = (...args: string[]) => spawnSync('git', args, { encoding: 'utf8', windowsHide: true, timeout: 60_000, maxBuffer: 1024 * 1024 });

function greenRecord(sha: string): void {
  const top = git('rev-parse', '--show-toplevel');
  if (top.status !== 0) refuse('Cannot find this checkout. Run the push from the source checkout.');
  const folder = path.join(top.stdout.trim(), '.gate', 'runs');
  let record: { exit?: unknown; head?: unknown; clean?: unknown } | undefined;
  try {
    const names = fs.readdirSync(folder).filter(name => name.endsWith('-push.json')).sort().reverse();
    for (const name of names) {
      const value: unknown = JSON.parse(fs.readFileSync(path.join(folder, name), 'utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('invalid record');
      const candidate = value as NonNullable<typeof record>;
      if (candidate.exit === 0) { record = candidate; break; }
    }
  } catch {
    refuse('Cannot read the push gate records. Repair the missing or unreadable .gate/runs records, then run `node tools/gate.ts --tier push` at this commit first.');
  }
  if (!record || record.head !== sha || record.clean !== true)
    refuse('The newest green push gate record does not judge this commit with a clean tree. Please run `node tools/gate.ts --tier push` at this commit first.');
}

try {
  const remote = process.argv[3];
  if (!remote) refuse('The remote URL is missing. Invoke this guard through git push.');
  const release = process.env['DESKPOST_RELEASE_PUSH'] === '1';
  if (/(?:^|[\/@:])github\.com(?:[\/:]|$)|(?:^|[\/:])Kioga\/deskpost(?:\.git)?(?:\/|$)/i.test(remote!) && !release)
    refuse('A public push needs a separately approved release. Set DESKPOST_RELEASE_PUSH=1 for that approved release push only.');
  const input = fs.readFileSync(0, 'utf8').trim();
  for (const line of input ? input.split(/\r?\n/) : []) {
    const fields = line.split(/\s+/);
    if (fields.length !== 4 || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(fields[1]!) || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(fields[3]!))
      refuse('Cannot read the proposed ref update. Invoke this guard through git push with valid object IDs.');
    const [, sha, ref, previous] = fields as [string, string, string, string];
    const deletion = /^0+$/.test(sha);
    if ((ref.startsWith('refs/tags/') || deletion) && !release)
      refuse('A tag push or deletion needs a separately approved release. Set DESKPOST_RELEASE_PUSH=1 for that approved release push only.');
    // An approved deletion has no local commit whose ancestry could be checked.
    if (!deletion && !/^0+$/.test(previous) && git('merge-base', '--is-ancestor', previous, sha).status !== 0)
      refuse('The remote base is not an ancestor of the proposed commit, or its ancestry cannot be read. Fetch and reconcile the moved base under a new charter; do not force the push.');
    if (ref === 'refs/heads/master') greenRecord(sha);
  }
  process.stdout.write('push guard: passed; every proposed ref meets the push rules.\n');
} catch (error) {
  process.stderr.write(`push guard: refused. ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
