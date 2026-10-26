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
 *
 * THE LINUX SELECTION (kickoffs/s153 row 6), below, is the one platform policy every caller applies after these rules.
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
 * Every declared `async function sectionN(` and inline `if (selected(N)...) {` block at column 0, to its closing `}`
 * at column 0, with the comment lines above it. A one-line run guard owns just its line. Section 208 has two blocks.
 */
export function sectionRanges(selftestText: string): SectionRange[] {
  const lines = selftestText.split(/\r?\n/);
  const ranges: SectionRange[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const declaration = /^async function section(\d+)\(/.exec(lines[i]!);
    const open = declaration ?? /^if \(selected\((\d+)\)/.exec(lines[i]!);
    if (!open) continue;
    let start = i;
    while (start > 0 && /^\/\/( |$)/.test(lines[start - 1]!)) start -= 1;
    if (!declaration && !/\{\s*$/.test(lines[i]!)) {
      ranges.push({ section: Number(open[1]), start: start + 1, end: i + 1 });
      continue;
    }
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

/**
 * THE LINUX SELECTION (PLAN-cross-office-build-loop.md step 1.2; kickoffs/s153 row 6). `kernel/test/linux-skip.json`
 * lists the sections that judge a Windows-only rule by design, `{ "<n>": "<reason>" }`; on Linux they leave every
 * selection (the commit tier's, the parallel runner's and so the cut and push tiers', an all-sections run), the run says
 * so in one line, and a required one is refused by name rather than dropped. Anywhere else the policy is the identity.
 * A section that fails on Linux for a reason that could be fixed is never listed here: it is a defect, not a skip.
 */
export const LINUX_SKIP_PATH = 'kernel/test/linux-skip.json';

/** The list, checked for shape; a malformed list is an error, never an empty one. */
export function parseLinuxSkip(text: string): Map<number, string> {
  const parsed = JSON.parse(text.replace(/^﻿/, '')) as unknown;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error(`${LINUX_SKIP_PATH} is not an object of section numbers to reasons`);
  const skips = new Map<number, string>();
  for (const [section, reason] of Object.entries(parsed)) {
    if (!/^[1-9][0-9]*$/.test(section)) throw new Error(`${LINUX_SKIP_PATH}: '${section}' is not a section number`);
    if (typeof reason !== 'string' || !reason.trim()) throw new Error(`${LINUX_SKIP_PATH}: section ${section} needs its reason`);
    skips.set(Number(section), reason.trim());
  }
  return skips;
}

/** The sections this platform skips by the list: the list on Linux, nothing elsewhere. */
export function platformSkips(platform: string, linuxSkip: ReadonlyMap<number, string>): Map<number, string> {
  return platform === 'linux' ? new Map(linuxSkip) : new Map();
}

/** A selection with the platform's skips taken out, and the one line that says so (null when none was taken). */
export function applyPlatformSkips(sections: readonly number[], skips: ReadonlyMap<number, string>): { sections: number[]; skipped: number[]; line: string | null } {
  const skipped = sections.filter((section) => skips.has(section));
  return {
    sections: sections.filter((section) => !skips.has(section)),
    skipped,
    line: skipped.length ? `linux: ${skipped.length} sections skipped by linux-skip.json (${skipped.join(', ')})` : null,
  };
}

/**
 * SECTIONS STAY IN ASCENDING ORDER, CHECKED (kickoffs/s156 row 4; a clean merge put c51's sections after s154's). The
 * inventory sorts and dedups (`sectionNumbers`), and JSON keys that look like numbers read back sorted, so neither shows
 * disorder: this reads both files as text. Each top-level guard (`if (selected(N)` or `if (prerequisite(N,`) and each
 * claim-map key must be greater than the one before; 208 is the one section opened twice.
 */
export const OPENED_TWICE: ReadonlySet<number> = new Set([208]);
export function sectionOrderProblems(selftestText: string, coversText: string): string[] {
  const problems: string[] = [];
  const inOrder = (where: string, numbers: number[]) => {
    for (let i = 1; i < numbers.length; i += 1) {
      const before = numbers[i - 1]!, after = numbers[i]!;
      if (after < before || (after === before && !OPENED_TWICE.has(after))) problems.push(`${where}: ${after} ${after === before ? 'repeats' : 'comes after'} ${before}`);
    }
  };
  inOrder(`${SELFTEST_PATH}'s top-level guards`, [...selftestText.matchAll(/^if \((?:selected\((\d+)\)|prerequisite\((\d+),)/gm)].map((m) => Number(m[1] ?? m[2])));
  inOrder(`${COVERS_PATH}'s keys`, [...coversText.matchAll(/^\s*"(\d+)"\s*:/gm)].map((m) => Number(m[1])));
  // A GUARD THE RUNNER'S INVENTORY CANNOT LIST never runs when every section runs (kickoffs/s157 row 9: section 400 since
  // s155): the inventory reads `if (selected(N)` only, so a top-level guard opens with it.
  for (const m of selftestText.matchAll(/^if \(prerequisite\((\d+),/gm)) problems.push(`${SELFTEST_PATH}'s top-level guard for ${m[1]} has no selected(${m[1]}), so a run of every section leaves it out`);
  return problems;
}

/** Each required section the platform skips, in the plan's words. */
export function platformRefusals(required: readonly string[], skips: ReadonlyMap<number, string>): string[] {
  return required.flatMap((section) => {
    const reason = skips.get(Number(section));
    return reason === undefined ? [] : [`section ${section} is Linux-skipped: ${reason}; it cannot be required here`];
  });
}
