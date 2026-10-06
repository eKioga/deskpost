/**
 * COMPARING VERSIONS (PLAN-one-step-upgrade.md D0; ADR-0068). One helper for `deskpost upgrade`, the menu's update
 * line, the one-liners' found install and `upgradeLine`. The leading dotted integers are compared component by
 * component, a missing component counting as 0 (`1.3.6` equals `1.3.6.0`); equal integers with a different suffix (the
 * fixtures' `<v>+upgrade`) are "different, not newer"; a version with no leading integer is "could not tell".
 */

/** How `a` stands to `b`. */
export type VersionOrder = 'newer' | 'older' | 'equal' | 'different' | 'unknown';

function parse(version: string): { numbers: number[]; suffix: string } | null {
  const match = /^(\d+(?:\.\d+)*)(.*)$/.exec(version.trim());
  if (match === null) return null;
  return { numbers: match[1]!.split('.').map(Number), suffix: match[2]! };
}

export function compareVersions(a: string, b: string): VersionOrder {
  const left = parse(a);
  const right = parse(b);
  if (left === null || right === null) return 'unknown';
  const length = Math.max(left.numbers.length, right.numbers.length);
  for (let index = 0; index < length; index += 1) {
    const x = left.numbers[index] ?? 0;
    const y = right.numbers[index] ?? 0;
    if (x !== y) return x > y ? 'newer' : 'older';
  }
  return left.suffix === right.suffix ? 'equal' : 'different';
}

/**
 * THE LATEST VERSION A RELEASE NAMES: the version in its versioned `SHA256SUMS` line for the platform
 * (`deskpost-<v>-<platform>.zip`, as `chooseArchive` reads it). A `SHA256SUMS` with only the unversioned twin, or with
 * more than one versioned line, names none: null, which the caller says as "could not tell".
 */
export function latestVersionIn(sumsText: string, platform: string): string | null {
  const escaped = platform.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^[0-9a-f]{64}\\s+\\*?deskpost-([0-9A-Za-z.+-]+)-${escaped}\\.zip\\s*$`);
  const found = sumsText
    .split(/\r?\n/)
    .map((line) => pattern.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => match[1]!);
  return found.length === 1 ? found[0]! : null;
}
