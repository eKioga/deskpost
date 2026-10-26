// doctor's hook-hash rule in doctor.ts was checked against Codex rust-v0.163.0.
export const CODEX_HOOK_HASH_CHECKED = '0.163.0';

/** The numeric version Codex prints, without any prerelease or other trailing text. */
export function parseCodexVersion(stdout: string): string | null {
  return /^\s*codex-cli\s+(\d+\.\d+\.\d+)(?=[^\d.]|$)/m.exec(stdout)?.[1] ?? null;
}

/** Compare dotted numeric versions, treating an omitted final component as zero. */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const left = a.split('.').map(Number), right = b.split('.').map(Number);
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference < 0 ? -1 : 1;
  }
  return 0;
}

/** Only the two quoted settings this check reports; tables never supply top-level settings. */
export function codexSandboxSettings(configText: string): { sandbox_mode: string | null; windows_sandbox: string | null } {
  let topLevel = true, windows = false;
  let sandbox_mode: string | null = null, windows_sandbox: string | null = null;
  for (const raw of configText.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('[')) {
      topLevel = false;
      windows = /^\[windows\]\s*(?:#.*)?$/.test(line);
      continue;
    }
    const setting = /^(sandbox_mode|sandbox)\s*=\s*(?:"([^"\\]*)"|'([^']*)')\s*(?:#.*)?$/.exec(line);
    if (!setting) continue;
    const value = setting[2] ?? setting[3]!;
    if (topLevel && setting[1] === 'sandbox_mode') sandbox_mode = value;
    if (windows && setting[1] === 'sandbox') windows_sandbox = value;
  }
  return { sandbox_mode, windows_sandbox };
}
