/**
 * `Sort-Object`'s order, measured (S35), in a module of its own so every writer can sort as the oracle
 * sorts without importing the Notebook.
 */

/**
 * The order `Sort-Object` gives a string under en-US on Windows PowerShell 5.1, MEASURED (S35) rather
 * than assumed, over every ASCII punctuation character, hyphenated slugs and whole file paths:
 *
 * - `'` and `-` are IGNORED at the first level. Of two strings equal without them, the one with fewer
 *   sorts first; then their positions are compared left to right and the LATER position sorts first,
 *   `'` before `-` at the same one. So `abc`, `ab-c`, `a-bc`, `a-b-c`, in that order.
 * - Everything else compares case-insensitively, as `` !"#$%&()*,./:;?@[\]^_`{|}~+<=>``, then digits,
 *   then letters. A non-ASCII letter compares as its base letter (`é` between `B` and `s`, measured).
 *
 * Until S35 this compared the hyphen-stripped strings and broke a tie ORDINALLY, which put `a-bc`
 * before `ab-c` and `ab-c` before `abc` -- the reverse of the oracle in both. No fixture held two slugs
 * equal but for a hyphen, so no row saw it. What is still not carried: case-only ties, which
 * `Sort-Object` leaves in no stable order (measured: `ab, Ab, aB, AB` came back `AB, ab, Ab, aB`), are
 * broken ordinally; and a non-ASCII symbol sorts after `>` by code point, unmeasured.
 */
const PS_SYMBOL_ORDER = ' !"#$%&()*,./:;?@[\\]^_`{|}~+<=>';

function psPrimaryWeight(ch: string): number {
  const symbol = PS_SYMBOL_ORDER.indexOf(ch);
  if (symbol >= 0) return symbol;
  const code = ch.charCodeAt(0);
  if (code >= 0x30 && code <= 0x39) return 1000 + code;
  const base = ch.normalize('NFD').charAt(0).toLowerCase();
  const baseCode = base.charCodeAt(0);
  if (baseCode >= 0x61 && baseCode <= 0x7a) return 2000 + baseCode;
  if (code < 0x80) return 500 + code;
  return 3000 + code;
}

export function psSortCompare(left: string, right: string): number {
  const split = (value: string): { primary: number[]; ignored: [number, number][] } => {
    const primary: number[] = [];
    const ignored: [number, number][] = [];
    for (let i = 0; i < value.length; i++) {
      const ch = value.charAt(i);
      if (ch === "'" || ch === '-') ignored.push([i, ch === "'" ? 0 : 1]);
      else primary.push(psPrimaryWeight(ch));
    }
    return { primary, ignored };
  };
  const a = split(left);
  const b = split(right);
  for (let i = 0; i < Math.min(a.primary.length, b.primary.length); i++) {
    if (a.primary[i] !== b.primary[i]) return a.primary[i]! - b.primary[i]!;
  }
  if (a.primary.length !== b.primary.length) return a.primary.length - b.primary.length;
  for (let i = 0; i < Math.min(a.ignored.length, b.ignored.length); i++) {
    const [positionA, kindA] = a.ignored[i]!;
    const [positionB, kindB] = b.ignored[i]!;
    if (positionA !== positionB) return positionB - positionA;
    if (kindA !== kindB) return kindA - kindB;
  }
  if (a.ignored.length !== b.ignored.length) return a.ignored.length - b.ignored.length;
  return left < right ? -1 : left > right ? 1 : 0;
}

/** `Sort-Object -Unique`: the measured order, and a case-insensitive duplicate kept once. */
export function psSortUnique(values: string[]): string[] {
  const kept: string[] = [];
  for (const value of [...values].sort(psSortCompare)) {
    if (!kept.some((existing) => existing.toLowerCase() === value.toLowerCase())) kept.push(value);
  }
  return kept;
}
