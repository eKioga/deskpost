/** Scan staged blobs on every commit, reporting metadata only. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'staged-secrets-'));
let code = 1;
try {
  const report = path.join(folder, 'report.json');
  const ran = spawnSync('gitleaks', ['git', '--staged', '--no-banner', '--no-color', '--redact', '--report-format', 'json', '--report-path', report], { encoding: 'utf8', windowsHide: true, timeout: 60_000 });
  if (ran.error && 'code' in ran.error && ran.error.code === 'ENOENT') {
    console.log('staged secrets: WARN gitleaks is not installed, so nothing scanned the staged blobs');
    code = 0;
  } else if (!ran.error && ran.status === 0) {
    const version = spawnSync('gitleaks', ['version'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    console.log(`staged secrets: no leaks found (gitleaks ${/^\d+\.\d+\.\d+/.exec(version.stdout ?? '')?.[0] ?? 'unknown'})`);
    code = 0;
  } else if (!ran.error && ran.status === 1 && fs.existsSync(report)) {
    const findings: unknown = JSON.parse(fs.readFileSync(report, 'utf8'));
    if (!Array.isArray(findings) || !findings.length) throw Error('invalid report');
    for (const finding of findings) {
      if (typeof finding.RuleID !== 'string' || typeof finding.File !== 'string' || !Number.isInteger(finding.StartLine)) throw Error('invalid finding');
    }
    for (const finding of findings) console.log(`staged secrets: ${finding.RuleID.replace(/[\r\n\x1b]/g, '')} in ${finding.File.replace(/[\r\n\x1b]/g, '')}:${finding.StartLine}`);
    console.log('staged secrets: remove a real secret from the commit; a value a test plants ends its line with // gitleaks:allow (a value this test plants)');
  } else console.error('staged secrets: scan could not finish; nothing proved the staged blobs clean');
} catch {
  console.error('staged secrets: scan report could not be read; nothing proved the staged blobs clean');
} finally {
  fs.rmSync(folder, { recursive: true, force: true });
}
process.exitCode = code;
