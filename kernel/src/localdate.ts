/**
 * THE LOCAL CALENDAR DATE, `yyyy-MM-dd` (S71 row 8; ADR-0048 settled local dates for capture notes). What
 * `(Get-Date).ToString('yyyy-MM-dd')` gives: the reader's own day, not UTC's, which is a different day for hours of
 * every day away from Greenwich. A leaf module, so the Shelf writers share one copy.
 */
export function localDate(now: Date = new Date()): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}
