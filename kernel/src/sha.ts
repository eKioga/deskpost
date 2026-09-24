/**
 * Digests, in the two spellings the PowerShell tools produce.
 *
 * LOWERCASE HEX, ALWAYS, and every caller here wants the same one. `tools/BookWriteGuard.ps1`
 * spells it `-join ($sha.ComputeHash(...) | ForEach-Object { $_.ToString('x2') })`, and the gated
 * helpers spell it `[BitConverter]::ToString(...) -replace '-','' | ToLowerInvariant()`. Those are
 * the same bytes in the same case; one function is enough and two would be one chance to differ.
 *
 * A PLAN ID IS A DIGEST OVER TEXT THE HELPER COMPOSED, so the text has to be composed the same way
 * or the two arms issue different approvals for the same operation. Every digest source in this
 * kernel is built line for line against the helper it replaces, and the matrix compares the
 * `plan_id` only as `<volatile>` -- which means a wrong one is invisible to the return value and
 * visible only where it matters: the confirming step refuses, and the row's effect is empty.
 */

import * as crypto from 'node:crypto';

export function sha256OfBytes(bytes: Uint8Array): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

/** A digest over UTF-8 text with no BOM, which is what `[Text.UTF8Encoding]::new($false)` gives. */
export function sha256OfText(text: string): string {
  return crypto.createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
}
