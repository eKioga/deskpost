/** Summarize immutable gate records; classifications live in a separate append-only ledger. */
import fs from 'node:fs';
import path from 'node:path';

type Check = { check: string; seconds: number | null; status: string; detail?: string };
type Run = { schema: number; tier: string; total_seconds: number; exit: number; checks: Check[] };
type Entry = { file: string; run: Run };
const kinds = ['defect', 'flaky', 'bookkeeping', 'time-limit'] as const;
type Kind = typeof kinds[number];
const defaultRecords = path.resolve('.gate/runs');
const classifications = path.resolve('.gate/classifications.jsonl');

function main(args: string[]): void {
  const classify = args[0] === 'classify';
  const positionals = classify ? args.splice(0, 3).slice(1) : [];
  const folders: string[] = [];
  let since = '', json = false, note = '', kind = '';
  if (classify) kind = args.shift() ?? '';
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--json' && !classify) json = true;
    else if (['--records', '--since', '--note'].includes(arg!) && i + 1 < args.length) {
      const value = args[++i]!;
      if (arg === '--records') folders.push(path.resolve(value));
      else if (arg === '--since' && !classify) since = value;
      else if (arg === '--note' && classify) note = value;
      else throw Error('option does not apply to this command');
    } else throw Error(`unknown or incomplete argument: ${arg}`);
  }
  if (since && (!/^\d{4}-\d{2}-\d{2}$/.test(since) || Number.isNaN(Date.parse(since)) || new Date(since).toISOString().slice(0, 10) !== since)) throw Error('--since takes a calendar date YYYY-MM-DD');
  const sources = [...new Set((folders.length ? folders : [defaultRecords]).map(folder => fs.realpathSync(folder)))];
  const entries: Entry[] = [];
  for (const folder of sources) for (const file of fs.readdirSync(folder).filter(file => file.endsWith('.json')).sort()) {
    const date = /^(\d{4})(\d{2})(\d{2})T/.exec(file);
    if (since && (!date || `${date[1]}-${date[2]}-${date[3]}` < since)) continue;
    const run = JSON.parse(fs.readFileSync(path.join(folder, file), 'utf8')) as Run;
    if (run.schema !== 1 || typeof run.tier !== 'string' || !Number.isFinite(run.total_seconds) || typeof run.exit !== 'number' || !Array.isArray(run.checks) || run.checks.some(c => typeof c.check !== 'string' || typeof c.status !== 'string' || (c.seconds !== null && !Number.isFinite(c.seconds)))) throw Error(`invalid gate record: ${file}`);
    entries.push({ file, run });
  }
  if (classify) {
    const [record, check] = positionals;
    if (!record || record !== path.basename(record) || !check || !kinds.includes(kind as Kind) || !note.trim()) throw Error('Usage: classify <record file name> <check> <defect|flaky|bookkeeping|time-limit> --note <text>');
    const matches = entries.filter(entry => entry.file === record);
    if (matches.length !== 1) throw Error('unknown or ambiguous record');
    if (!matches[0]!.run.checks.some(c => c.check === check)) throw Error('unknown check in record');
    fs.mkdirSync(path.dirname(classifications), { recursive: true });
    fs.appendFileSync(classifications, JSON.stringify({ at: new Date().toISOString(), record, check, kind, note }) + '\n');
    console.log(`classified ${record}: ${check} as ${kind}`);
    return;
  }
  const assigned = new Map<string, string>();
  for (const file of new Set([...sources.map(folder => path.join(path.dirname(folder), 'classifications.jsonl')), classifications])) {
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean)) {
      const value = JSON.parse(line);
      if (typeof value.record !== 'string' || typeof value.check !== 'string' || !kinds.includes(value.kind)) throw Error(`invalid classification in ${file}`);
      assigned.set(value.record + '\0' + value.check, value.kind);
    }
  }
  const tiers = [...new Set(entries.map(entry => entry.run.tier))].sort().map(tier => {
    const runs = entries.filter(entry => entry.run.tier === tier).map(entry => entry.run);
    const seconds = runs.map(run => run.total_seconds).sort((a, b) => a - b);
    const middle = Math.floor(seconds.length / 2);
    const median = seconds.length % 2 ? seconds[middle]! : (seconds[middle - 1]! + seconds[middle]!) / 2;
    return { tier, runs: runs.length, median_seconds: median, longest_seconds: seconds.at(-1)!, total_hours: seconds.reduce((sum, n) => sum + n, 0) / 3600, failed_runs: runs.filter(run => run.exit !== 0).length };
  });
  const byCheck = new Map<string, { check: string; runs: number; total_seconds: number; untimed_runs: number; pass: number; fail: number; skip: number; warn: number; failure_kinds: Record<string, number> }>();
  const failures: { record: string; check: string; kind: string; detail: string }[] = [];
  for (const { file, run } of entries) for (const c of run.checks) {
    const row = byCheck.get(c.check) ?? { check: c.check, runs: 0, total_seconds: 0, untimed_runs: 0, pass: 0, fail: 0, skip: 0, warn: 0, failure_kinds: {} };
    row.runs++; row.total_seconds += c.seconds ?? 0; if (c.seconds === null) row.untimed_runs++;
    const status = c.status.toLowerCase();
    if (status === 'pass') row.pass++;
    else if (status === 'warn') row.warn++;
    else if (status === 'skip' || status === 'skipped') row.skip++;
    else if (status === 'fail') {
      row.fail++;
      const kind = /exceed[^\r\n]*limit/i.test(c.detail ?? '') ? 'time-limit' : assigned.get(file + '\0' + c.check) ?? 'unknown';
      row.failure_kinds[kind] = (row.failure_kinds[kind] ?? 0) + 1;
      failures.push({ record: file, check: c.check, kind, detail: String(c.detail ?? '').slice(0, 150) });
    } else throw Error(`unknown check status in ${file}: ${c.status}`);
    byCheck.set(c.check, row);
  }
  const checks = [...byCheck.values()].sort((a, b) => b.total_seconds - a.total_seconds || a.check.localeCompare(b.check));
  const result = { tiers, checks, failures };
  if (json) { console.log(JSON.stringify(result, null, 2)); return; }
  console.log('Tier | Runs | Median seconds | Longest seconds | Total hours | Failed runs');
  for (const row of tiers) console.log(`${row.tier} | ${row.runs} | ${row.median_seconds.toFixed(1)} | ${row.longest_seconds.toFixed(1)} | ${row.total_hours.toFixed(2)} | ${row.failed_runs}`);
  console.log('\nCheck | Runs | Known seconds | Untimed runs | PASS | FAIL | SKIP | WARN | Failure kinds');
  for (const row of checks) console.log(`${row.check} | ${row.runs} | ${row.total_seconds.toFixed(1)} | ${row.untimed_runs} | ${row.pass} | ${row.fail} | ${row.skip} | ${row.warn} | ${Object.entries(row.failure_kinds).map(([kind, count]) => `${kind}: ${count}`).join(', ') || 'none'}`);
  console.log('\nFailing check results');
  for (const failure of failures) console.log(`${failure.record} | ${failure.check} | ${failure.kind} | ${failure.detail.replace(/[\r\n]/g, ' ')}`);
}

try { main(process.argv.slice(2)); }
catch (error) { console.error(`gate ledger: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; }
