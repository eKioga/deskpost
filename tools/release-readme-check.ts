/**
 * DOES THE RELEASE'S README NAME IT? (kickoffs/s141 row 3; the triage of 2026-10-18 9:22 PM, item 3.) `docs/releasing.md`
 * asks that the public README say "The current release is **<version>**", and nothing checked it before READY. The
 * release runs `node tools/release-readme-check.ts <public tree folder> <version>` on the staged public tree:
 *
 *   exit 0  PASS: a line of <folder>/README.md starts with exactly `The current release is **<version>**`;
 *   exit 1  FAIL: no line does, and the line found that starts `The current release is` is named (or that none does);
 *   exit 2  refused: no folder, no README.md in it, or no version.
 *
 * LF and CRLF read alike. It reads one file; it never writes and never reaches the network.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const USAGE = 'node tools/release-readme-check.ts <public tree folder> <version>';
const CHECK = 'release.readme-current';
const LEAD = 'The current release is ';

/** The verdict for a README's text: `found` is the first line that starts `The current release is`, or null. */
export function readmeNamesRelease(text: string, version: string): { pass: boolean; expected: string; found: string | null } {
  const expected = `${LEAD}**${version}**`;
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  return { pass: lines.some((line) => line.startsWith(expected)), expected, found: lines.find((line) => line.startsWith(LEAD)) ?? null };
}

export function main(argv: string[]): number {
  const [folder, version] = argv;
  if (argv.length !== 2 || !folder || !version || !version.trim()) {
    process.stderr.write(`usage: ${USAGE}\n`);
    return 2;
  }
  if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) {
    process.stderr.write(`release-readme-check: no such folder: ${folder}\n`);
    return 2;
  }
  const readme = path.join(folder, 'README.md');
  if (!fs.existsSync(readme) || !fs.statSync(readme).isFile()) {
    process.stderr.write(`release-readme-check: no README.md in ${folder}\n`);
    return 2;
  }
  const verdict = readmeNamesRelease(fs.readFileSync(readme, 'utf8'), version.trim());
  if (verdict.pass) {
    process.stdout.write(`PASS ${CHECK}: README.md says ${verdict.expected}\n`);
    return 0;
  }
  const found = verdict.found === null ? `no line starts '${LEAD.trim()}'` : `its line is '${verdict.found.slice(0, 200)}'`;
  process.stdout.write(`FAIL ${CHECK}: README.md does not say ${verdict.expected}: ${found}\n`);
  return 1;
}

const invoked = process.argv[1] ?? '';
if (/release-readme-check\.ts$/.test(invoked.replace(/\\/g, '/'))) process.exit(main(process.argv.slice(2)));
