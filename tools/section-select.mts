/**
 * WHICH KERNEL SELF-TEST SECTIONS A COMMIT RUNS (PLAN-powershell-free-development.md, Session 1 item 3; kickoffs/s113
 * ruling 15). Pure: `tools/gate.ts` feeds it what git says changed, and self-test section 215 judges it on fixtures.
 *
 * THE CLAIM MAP is `kernel/test/section-covers.json`: each section names the `kernel/src` files it covers. It was
 * seeded in S113 from each section's own imports, the verbs it runs through the CLI and the modules those verbs call,
 * and every file no section reached that way is claimed by the sections that claim a file importing it. The rules:
 *   (a) a `kernel/src` file no section claims is refused, so the map cannot go stale quietly (`unclaimedFiles`);
 *   (b) every section claiming a changed `kernel/src` file runs;
 *   (c) a changed file on the shared list (below), or the map itself, runs every section;
 *   (d) a changed `kernel/test/selftest.ts` maps each changed hunk to the section whose `if (selected(N))` block holds
 *       it, read from the file at the new revision; a hunk outside every section block (imports, shared helpers, the
 *       runner, the verdict) runs every section.
 * The cut tier always runs every section, so a wrong claim costs at most one cut.
 */

export const COVERS_PATH = 'kernel/test/section-covers.json';
export const SELFTEST_PATH = 'kernel/test/selftest.ts';

/** Files every section depends on: a change to one runs the whole self-test (rule c). */
export const SHARED_FILES: ReadonlySet<string> = new Set([
  'kernel/src/cli.ts',
  'kernel/src/verbs.ts',
  'kernel/package.json',
  'kernel/package-lock.json',
  'kernel/tsconfig.json',
  COVERS_PATH,
  'tools/section-select.mts',
]);

/** One section's block in selftest.ts: 1-based lines, inclusive, its leading comment lines included. */
export interface SectionRange {
  section: number;
  start: number;
  end: number;
}

/**
 * Every `if (selected(N)...) {` block at column 0, to the first `}` at column 0 after it, with the run of `//` comment
 * lines directly above it. A section opened twice (208) has two ranges.
 */
export function sectionRanges(selftestText: string): SectionRange[] {
  const lines = selftestText.split(/\r?\n/);
  const ranges: SectionRange[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const open = /^if \(selected\((\d+)\)/.exec(lines[i]!);
    if (!open) continue;
    let start = i;
    while (start > 0 && /^\/\/( |$)/.test(lines[start - 1]!)) start -= 1;
    let end = i + 1;
    while (end < lines.length && lines[end] !== '}') end += 1;
    if (end >= lines.length) throw new Error(`section ${open[1]} opened at line ${i + 1} has no closing '}' at column 0`);
    ranges.push({ section: Number(open[1]), start: start + 1, end: end + 1 });
    i = end;
  }
  return ranges;
}

export interface Covers {
  schema: 1;
  /** How the claims were made, for a reader of the file. */
  about: string;
  /** Section number to the kernel/src files it claims. */
  sections: Record<string, string[]>;
}

/** The claim map, checked for shape; a malformed map is an error, never an empty selection. */
export function parseCovers(text: string): Covers {
  const parsed = JSON.parse(text.replace(/^﻿/, '')) as Partial<Covers>;
  if (parsed.schema !== 1 || typeof parsed.sections !== 'object' || parsed.sections === null) throw new Error(`${COVERS_PATH} is not a schema-1 claim map`);
  for (const [section, files] of Object.entries(parsed.sections)) {
    if (!/^[1-9][0-9]*$/.test(section)) throw new Error(`${COVERS_PATH}: '${section}' is not a section number`);
    if (!Array.isArray(files) || files.some((file) => typeof file !== 'string' || !/^kernel\/src\/[^/]+\.ts$/.test(file))) {
      throw new Error(`${COVERS_PATH}: section ${section} must list kernel/src/<file>.ts paths`);
    }
  }
  return parsed as Covers;
}

/** Rule (a): the kernel/src files no section claims, sorted. */
export function unclaimedFiles(covers: Covers, kernelSrcFiles: readonly string[]): string[] {
  const claimed = new Set(Object.values(covers.sections).flat());
  return kernelSrcFiles.filter((file) => !claimed.has(file)).sort();
}

/** A hunk of the new revision, as `git diff -U0`'s `+start,count` gives it. */
export interface Hunk {
  start: number;
  count: number;
}

/** `@@ -a,b +c,d @@` headers of a `git diff -U0` of one file, as new-side hunks. */
export function parseHunks(diffText: string): Hunk[] {
  const hunks: Hunk[] = [];
  for (const match of diffText.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
    hunks.push({ start: Number(match[1]), count: match[2] === undefined ? 1 : Number(match[2]) });
  }
  return hunks;
}

export interface Selection {
  /** Every section runs. */
  all: boolean;
  /** The sections chosen, sorted (empty when `all`, or when nothing a section covers changed). */
  sections: number[];
  /** Why, one line each: `sections 12, 88: claim lifecycle.ts`. */
  reasons: string[];
}

function listed(sections: Iterable<number>): string {
  const sorted = [...new Set(sections)].sort((a, b) => a - b);
  return `${sorted.length === 1 ? 'section' : 'sections'} ${sorted.join(', ')}`;
}

/** Rules (b)-(d) over one commit's changed paths (repository-relative, forward slashes). */
export function selectSections(input: { changed: readonly string[]; selftestHunks: readonly Hunk[]; selftestText: string; covers: Covers }): Selection {
  const reasons: string[] = [];
  const chosen = new Set<number>();
  let all = false;
  const claimants = new Map<string, number[]>();
  for (const [section, files] of Object.entries(input.covers.sections)) {
    for (const file of files) claimants.set(file, [...(claimants.get(file) ?? []), Number(section)]);
  }
  for (const file of [...input.changed].sort()) {
    if (SHARED_FILES.has(file)) {
      all = true;
      reasons.push(file === COVERS_PATH ? `every section: the claim map ${file} changed` : `every section: ${file} is on the shared list`);
    } else if (file.startsWith('kernel/test/') && file !== SELFTEST_PATH) {
      all = true;
      reasons.push(`every section: ${file} is a self-test helper`);
    } else if (/^kernel\/src\/[^/]+\.ts$/.test(file)) {
      const sections = claimants.get(file) ?? [];
      if (sections.length === 0) {
        all = true;
        reasons.push(`every section: no section claims ${file}`);
      } else {
        sections.forEach((section) => chosen.add(section));
        reasons.push(`${listed(sections)}: claim ${file.slice('kernel/src/'.length)}`);
      }
    } else if (!file.startsWith('kernel/')) {
      reasons.push(`no section: ${file} is outside kernel/src and no section claims it`);
    }
  }
  if (input.changed.includes(SELFTEST_PATH)) {
    const ranges = sectionRanges(input.selftestText);
    const lines = input.selftestText.split(/\r?\n/);
    const blank = (line: number) => (lines[line - 1] ?? '').trim() === '';
    const inside = (line: number) => ranges.find((range) => line >= range.start && line <= range.end);
    for (const hunk of input.selftestHunks) {
      // Blank lines at either end of a hunk belong to no section and change nothing: a new section arrives with one.
      let first = Math.max(hunk.start, 1);
      let last = hunk.count === 0 ? first : hunk.start + hunk.count - 1;
      if (hunk.count > 0) {
        while (first <= last && blank(first)) first += 1;
        while (last >= first && blank(last)) last -= 1;
        if (first > last) {
          reasons.push(`no section: ${SELFTEST_PATH} lines ${hunk.start}-${hunk.start + hunk.count - 1} are blank`);
          continue;
        }
      }
      const home = inside(first);
      const span = hunk.count === 0 ? `after line ${hunk.start}` : first === last ? `line ${first}` : `lines ${first}-${last}`;
      if (home && last <= home.end) {
        chosen.add(home.section);
        reasons.push(`section ${home.section}: ${SELFTEST_PATH} ${span} is inside it`);
      } else {
        all = true;
        reasons.push(`every section: ${SELFTEST_PATH} ${span} is outside every section`);
      }
    }
  }
  return { all, sections: all ? [] : [...chosen].sort((a, b) => a - b), reasons };
}
