/**
 * `deskpost doctor --report [--warnings]` (kickoffs/s104 row 3; PLAN-correct-and-find.md D6): doctor files each FAIL,
 * and each WARN with `--warnings`, as one Report in the Report Inbox, through `captureVerb` like any other capture.
 *
 * NEVER THE SAME FINDING TWICE. Each Report carries `doctor_check` and `doctor_digest` (the SHA-256 of the check id and
 * its text, LF-normalised) in its frontmatter, through capture's internal extra-frontmatter option, which no CLI flag
 * reaches. A finding whose digest any Report already carries -- pending or done, under `wiki/notes/` or tidied into
 * `wiki/reviewed/<yyyy-mm>/` -- is skipped, naming that page. A finding that changes its text is a new finding.
 *
 * NEVER FATAL. A finding that cannot be filed is listed under `not_filed` with why; doctor's own exit code is the one
 * its checks give, with or without `--report`. A seatless run files seatless Reports, which the Inbox takes
 * (`Closed by: any`).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PsJsonValue } from './psjson.ts';
import { captureVerb } from './capture.ts';
import { getShelfBook, readUtf8 } from './shelfbook.ts';
import { localDate } from './localdate.ts';
import { sha256OfText } from './sha.ts';

/** The Report Inbox's slug, a standard Shelf Book (`shelfbook.ts`). */
const REPORT_INBOX = 'reports';

export interface DoctorFinding {
  check: string;
  status: string;
  detail: string;
}

/** The digest a Report carries: the check id and its text, LF-normalised. */
export function doctorDigest(finding: DoctorFinding): string {
  return sha256OfText(`${finding.check}\n${finding.detail}`.replace(/\r\n/g, '\n'));
}

/** Every `doctor_digest` the Inbox's notes carry, pending or done, tidied or not, with the page that carries it. */
function filedDigests(wikiPath: string): Map<string, string> {
  const found = new Map<string, string>();
  const folders: string[] = [path.join(wikiPath, 'notes')];
  const reviewed = path.join(wikiPath, 'reviewed');
  if (fs.existsSync(reviewed)) {
    for (const month of fs.readdirSync(reviewed, { withFileTypes: true })) if (month.isDirectory()) folders.push(path.join(reviewed, month.name));
  }
  for (const folder of folders) {
    if (!fs.existsSync(folder)) continue;
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) continue;
      const file = path.join(folder, entry.name);
      let text: string;
      try {
        text = readUtf8(file);
      } catch {
        continue;
      }
      const head = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
      const digest = head ? /^doctor_digest:[ \t]*([0-9a-f]{64})[ \t]*$/m.exec(head[1]!) : null;
      if (digest && !found.has(digest[1]!)) {
        found.set(digest[1]!, path.relative(wikiPath, file).replace(/\\/g, '/').replace(/\.md$/i, ''));
      }
    }
  }
  return found;
}

/** The Report's body: the check's text, which carries its repair, then where and when it was found. */
function reportBody(finding: DoctorFinding, version: string, workspace: string): string {
  const word = finding.status === 'fail' ? 'failed' : 'warned';
  return [
    `# doctor: ${finding.check} ${word}`,
    '',
    finding.detail,
    '',
    `- **Check:** \`${finding.check}\``,
    `- **Status:** ${finding.status === 'fail' ? 'FAIL' : 'WARN'}`,
    `- **Deskpost:** ${version || 'unknown'}`,
    `- **Library:** ${workspace}`,
    `- **Date:** ${localDate()}`,
    '',
    'Filed by `deskpost doctor --report`. The check\'s text above says how to repair it; doctor files it again only if that text changes.',
    '',
  ].join('\n');
}

/**
 * File the findings: each FAIL, and each WARN when `warnings` is set. Returns `filed[]`, `skipped[]` and `not_filed[]`;
 * never throws for a finding it could not file.
 */
export function fileDoctorFindings(workspace: string, findings: DoctorFinding[], warnings: boolean, version: string): Record<string, PsJsonValue> {
  const wanted = findings.filter((row) => row.status === 'fail' || (warnings && row.status === 'warn'));
  const filed: PsJsonValue[] = [];
  const skipped: PsJsonValue[] = [];
  const notFiled: PsJsonValue[] = [];
  const summary = (): Record<string, PsJsonValue> => ({ inbox: `shelf/${REPORT_INBOX}`, warnings, filed, skipped, not_filed: notFiled });
  if (!wanted.length) return summary();
  if (!workspace) {
    for (const row of wanted) notFiled.push({ check: row.check, status: row.status, reason: 'no Library here, so there is no Report Inbox to file into' });
    return summary();
  }
  let known: Map<string, string>;
  try {
    known = filedDigests(getShelfBook(workspace, REPORT_INBOX).wikiPath);
  } catch (error) {
    for (const row of wanted) notFiled.push({ check: row.check, status: row.status, reason: `the Report Inbox could not be read: ${(error as Error).message}` });
    return summary();
  }
  for (const row of wanted) {
    const digest = doctorDigest(row);
    const page = known.get(digest);
    if (page !== undefined) {
      skipped.push({ check: row.check, status: row.status, doctor_digest: digest, page: `shelf/${REPORT_INBOX}/wiki/${page}` });
      continue;
    }
    const title = `doctor: ${row.check} ${row.status === 'fail' ? 'failed' : 'warned'}`;
    const result = captureVerb([REPORT_INBOX, '--title', title, '--body', reportBody(row, version, workspace)], workspace, {
      extraFrontmatter: [
        ['doctor_check', row.check],
        ['doctor_digest', digest],
      ],
    });
    if (result.refusal !== null || result.value === null) {
      notFiled.push({ check: row.check, status: row.status, doctor_digest: digest, reason: result.refusal ?? 'the capture returned nothing' });
      continue;
    }
    const notePage = String((result.value as Record<string, PsJsonValue>)['note_page'] ?? '');
    filed.push({ check: row.check, status: row.status, doctor_digest: digest, page: notePage });
    known.set(digest, notePage.replace(new RegExp(`^shelf/${REPORT_INBOX}/wiki/`), '').replace(/\.md$/i, ''));
  }
  return summary();
}
