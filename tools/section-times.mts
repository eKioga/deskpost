/** Runner results supply commit estimates; no measurement run is needed to seed them. */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const DEFAULT_SECTION_SECONDS = 5;
export interface SectionTimes { schema: 1; from: string[]; sections: Record<string, number> }
export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return sorted.length ? (sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2) : DEFAULT_SECTION_SECONDS;
}
const seconds = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
export function parseTimes(text: string): SectionTimes {
  const data = JSON.parse(text) as SectionTimes;
  if (!data || data.schema !== 1 || !Array.isArray(data.from) || data.from.some(value => typeof value !== 'string')
    || !data.sections || typeof data.sections !== 'object' || Array.isArray(data.sections)
    || Object.entries(data.sections).some(([key, value]) => !/^[1-9]\d*$/.test(key) || !seconds(value))) throw Error('invalid section-times.json');
  return data;
}
export function estimateSeconds(sections: readonly number[], times: SectionTimes, workers: number): number {
  const fallback = median(Object.values(times.sections));
  const values = sections.map(section => times.sections[String(section)] ?? fallback);
  return Math.max(0, ...values, values.reduce((sum, value) => sum + value, 0) / workers);
}
export function writeTimes(files: string[], output = path.resolve('kernel/test/section-times.json')): SectionTimes {
  if (!files.length) throw Error('write needs at least one runner result.json');
  const samples = new Map<number, number[]>();
  for (const file of files) {
    const data = JSON.parse(fs.readFileSync(file, 'utf8')) as { results?: { section: unknown; verdict: unknown; seconds: unknown }[] };
    if (!data || !Array.isArray(data.results) || !data.results.length) throw Error(`${file}: empty or malformed runner results`);
    let usable = 0;
    for (const row of data.results) {
      if (!row || !(row.section === 'whole' || Number.isSafeInteger(row.section) && Number(row.section) > 0)
        || !['PASS', 'FAIL', 'SKIP'].includes(String(row.verdict)) || !seconds(row.seconds)) throw Error(`${file}: malformed section result`);
      if (row.verdict === 'PASS' && typeof row.section === 'number') {
        samples.set(row.section, [...(samples.get(row.section) ?? []), row.seconds]); usable++;
      }
    }
    if (!usable) throw Error(`${file}: no usable PASS section rows; section times unchanged`);
  }
  const result: SectionTimes = { schema: 1, from: files, sections: Object.fromEntries([...samples].sort(([a], [b]) => a - b).map(([section, values]) => [String(section), median(values)])) };
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
  return result;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    if (process.argv[2] !== 'write') throw Error('usage: node tools/section-times.mts write <result.json>...');
    const result = writeTimes(process.argv.slice(3));
    console.log(`section times: wrote ${Object.keys(result.sections).length} medians to kernel/test/section-times.json`);
  } catch (error) { console.error(String(error)); process.exitCode = 2; }
}
