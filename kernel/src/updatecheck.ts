/**
 * `DESKPOST_UPDATE_CHECK`: `0` turns the check and its line off; `1` forces the check whenever the menu opens, for a
 * fixture that cannot be a terminal (ADR-0068); anything else is the default, once a day from an interactive menu.
 *
 * Its own module (kickoffs/s102 K3) so the install screen's Updates row reads it without a cycle: `upgrade.ts` imports
 * `setup.ts`, and re-exports this for its callers.
 */
export function updateCheckSetting(): 'off' | 'forced' | 'daily' {
  const value = (process.env['DESKPOST_UPDATE_CHECK'] ?? '').trim();
  return value === '0' ? 'off' : value === '1' ? 'forced' : 'daily';
}
