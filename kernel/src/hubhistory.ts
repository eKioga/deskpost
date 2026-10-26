/** A Desk-scoped, read-only view of a Hub page's recorded writes (c36 row 5). */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseArguments } from './argv.ts';
import { argumentTable } from './verbs.ts';
import { hubSlug } from './hubslug.ts';
import { deskEntriesForSeat, requireSeat } from './seatdesk.ts';
import { answerReaderTool, readerContext } from './reader.ts';
import type { PsJsonValue } from './psjson.ts';

export async function hubHistory(argv: string[], workspace: string): Promise<{ value: PsJsonValue; text: string }> {
  const parsed = parseArguments(argv, argumentTable('hub', 'history'));
  const { slug, problem } = hubSlug(parsed.positional[0] ?? '');
  if (problem !== null) throw new Error(problem);
  let page = (parsed.positional[1] ?? '').trim().replace(/\\/g, '/');
  if (/\.md$/i.test(page)) page = page.slice(0, -3);
  if (!/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._ -]+)*$/.test(page) || /(^|\/)\.\.?($|\/)/.test(page)) {
    throw new Error('Page must be a canonical path below the Project root, such as _project or notes/topic/Article.');
  }
  const stateDirectory = path.join(workspace, '.claude');
  const seat = requireSeat({ seat: parsed.options.get('seat'), stateDirectory });
  const projects = deskEntriesForSeat(stateDirectory, seat, 'projects');
  if (!projects.includes(`projects/${slug}`)) throw new Error(`Project '${slug}' is not open. Open it first: deskpost desk open project ${slug}`);
  // The validated reader supplies the same existence and canonical-path checks on both backends.
  const context = readerContext(workspace, stateDirectory, seat);
  for (const asked of new Set(['_project', page])) {
    await answerReaderTool(context, 'read_open_project_page', {
      required: name => name === 'slug' ? slug : asked,
      optional: () => undefined,
    });
  }
  const pagePath = `projects/${slug}/${page}.md`;
  const directory = path.join(workspace, 'internal', 'publication-journals');
  const entries: { timestamp_utc: string | null; sequence: number | null; operation: string | null; mode: string | null; state: string | null; sha256: string | null }[] = [];
  const unreadable: string[] = [];
  if (fs.existsSync(directory)) {
    for (const name of fs.readdirSync(directory).filter(name => name.endsWith('.json')).sort()) {
      let record: Record<string, unknown>;
      try {
        const value: unknown = JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8').replace(/^\uFEFF/, ''));
        if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object');
        record = value as Record<string, unknown>;
      } catch { unreadable.push(name); continue; }
      if (record['page_path'] !== pagePath) continue;
      const field = (key: string): string | null => typeof record[key] === 'string' ? record[key] as string : null;
      const sequence = Number.isSafeInteger(record['sequence']) ? record['sequence'] as number : null;
      entries.push({ timestamp_utc: field('timestamp_utc'), sequence, operation: field('operation'), mode: field('mode'), state: field('state'), sha256: field('written_sha256') ?? field('proposed_sha256') });
    }
  }
  // WRITE ORDER, NOT CLOCK ORDER (kickoffs/s160 row 6): `hub edit`'s journals carry the Hub's sequence number, in their
  // own order; the rest (new-page, tidy, older journals) are merged in by time, so no step back can make a cycle.
  const byTime = (left: { timestamp_utc: string | null }, right: { timestamp_utc: string | null }) => (left.timestamp_utc ?? '').localeCompare(right.timestamp_utc ?? '');
  const sequenced = entries.filter((entry) => entry.sequence !== null).sort((left, right) => left.sequence! - right.sequence!);
  const timed = entries.filter((entry) => entry.sequence === null).sort(byTime);
  entries.length = 0;
  while (sequenced.length || timed.length) {
    entries.push((!timed.length || (sequenced.length && byTime(sequenced[0]!, timed[0]!) <= 0) ? sequenced : timed).shift()!);
  }
  const lines = entries.length
    ? [`Write history for ${pagePath}:`, ...entries.map(entry => `${entry.timestamp_utc ?? '(time unrecorded)'} | ${entry.operation ?? '(operation unrecorded)'}${entry.mode ? ` / ${entry.mode}` : ''} | ${entry.state ?? '(state unrecorded)'} | ${entry.sha256 ?? '(hash unrecorded)'}`)]
    : [`${pagePath} has no history in this Library's publication journals.`];
  if (unreadable.length) lines.push(`Could not read ${unreadable.length} journal(s): ${unreadable.join(', ')}. History may be incomplete.`);
  return {
    value: { schema: 1, operation: 'Project Hub page history', project_slug: slug, page_path: pagePath, entries, unreadable_journals: unreadable, shared_library_write: false },
    text: lines.join('\n'),
  };
}
