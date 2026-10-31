/** The planner's ordered train record (c69-r3). Only explicit mutations write it; page is derived text. */
import fs from 'node:fs';
import path from 'node:path';
import { ensureDirectory, writeAtomicText } from './fsx.ts';
import { enterBookLock, exitBookLock } from './locks.ts';

type Item = { id: string; title: string; place: string; first_asked: string; source: string; status: 'open' | 'done' | 'dropped'; note: string };
export type TrainRecord = { schema: 1; changed_at: string; changed_by: string; items: Item[] };
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PLACE = /^(?:foundation|running|bucket:[12]|(?:car|lane):[a-z0-9][a-z0-9.-]*)$/;
const line = (value: unknown): value is string => typeof value === 'string' && !/[\r\n\x00-\x1f\x7f]/.test(value);
const date = (value: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const recordFile = (workspace: string): string => path.join(workspace, 'internal', 'train', 'register.json');

/** Missing is distinct from malformed: a damaged register must never be silently replaced. */
export function readTrain(workspace: string): TrainRecord | null {
  let text: string;
  try { text = fs.readFileSync(recordFile(workspace), 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  const r = JSON.parse(text) as TrainRecord;
  const ids = new Set<string>();
  if (!r || r.schema !== 1 || !line(r.changed_by) || !r.changed_by.trim() || !line(r.changed_at) || !/^\d{4}-\d{2}-\d{2}T.*Z$/.test(r.changed_at) || !Number.isFinite(Date.parse(r.changed_at)) || !Array.isArray(r.items)) throw new Error('The train register is not a valid schema-1 record.');
  for (const i of r.items) {
    if (!i || !line(i.id) || !SLUG.test(i.id) || ids.has(i.id) || !line(i.title) || !i.title.trim() || !line(i.place) || !PLACE.test(i.place) || !line(i.first_asked) || !date(i.first_asked) || !line(i.source) || !['open', 'done', 'dropped'].includes(i.status) || !line(i.note)) throw new Error('The train register contains an invalid or duplicate item.');
    ids.add(i.id);
  }
  return r;
}

/** Open items retain array order, grouped by the first occurrence of their place. */
export function trainText(record: TrainRecord | null, markdown = false): string {
  if (record === null) return 'No train register yet.';
  const groups = new Map<string, Item[]>();
  for (const item of record.items.filter(i => i.status === 'open')) {
    if (!groups.has(item.place)) groups.set(item.place, []);
    groups.get(item.place)!.push(item);
  }
  return [...groups].map(([place, items]) => `${markdown ? '## ' : ''}${place}\n${items.map(i => `${markdown ? '- ' : '  '}${i.id}: ${i.title} (${i.first_asked})`).join('\n')}`).concat(`Changed ${record.changed_at} by ${record.changed_by}`).join('\n\n');
}

/** Every argument and the prior record are checked before either file changes. */
export function changeTrain(workspace: string, action: string, id: string, options: Map<string, string>, flags: Set<string>): TrainRecord {
  const by = process.env['LIBRARY_SEAT'] ?? '';
  if (!line(by) || !by.trim()) throw new Error('A named seat is required to change the train.');
  if (!SLUG.test(id)) throw new Error('The train id must be a short lowercase slug.');
  const lock = enterBookLock(workspace, 'train/register');
  try {
    const at = new Date().toISOString();
    const prior = readTrain(workspace);
    const record: TrainRecord = prior ?? { schema: 1, changed_at: at, changed_by: by, items: [] };
    let item = record.items.find(i => i.id === id);
    const from = item?.place ?? null;
    if (action === 'add' && item) throw new Error(`The train already has id '${id}'.`);
    if (action !== 'add' && !item) throw new Error(`The train has no id '${id}'.`);
    if (action === 'add' || action === 'move') {
      const place = options.get('place') ?? '';
      if (!PLACE.test(place)) throw new Error(`Unknown train place '${place}'.`);
      const after = options.get('after');
      const before = options.get('before'), first = flags.has('first');
      if (Number(first) + Number(before !== undefined) + Number(after !== undefined) > 1) throw new Error('Use only one of --first, --before or --after.');
      const anchor = before ?? after;
      if (anchor !== undefined) {
        const target = record.items.find(i => i.id === anchor);
        if (anchor === id || !target) throw new Error(`--${before !== undefined ? 'before' : 'after'} names no other train item: '${anchor}'.`);
        if (target.place !== place) throw new Error(`${anchor} is in ${target.place}, not ${place}`);
      }
      if (action === 'add') {
        const title = options.get('title') ?? '';
        const first = options.get('first-asked') ?? at.slice(0, 10);
        const source = options.get('source') ?? '';
        if (!line(title) || !title.trim() || !line(source) || !date(first)) throw new Error('Train add needs a one-line title, source and a valid YYYY-MM-DD first-asked date.');
        item = { id, title, place, first_asked: first, source, status: 'open', note: '' };
      }
      item!.place = place;
      if (action === 'add' || first || anchor !== undefined) {
        record.items = record.items.filter(i => i.id !== id);
        const index = first ? record.items.findIndex(i => i.place === place)
          : anchor !== undefined ? record.items.findIndex(i => i.id === anchor) + Number(after !== undefined) : -1;
        record.items.splice(index < 0 ? record.items.length : index, 0, item!);
      }
    } else if (action === 'close') {
      const note = options.get('note') ?? '';
      if (flags.has('done') === flags.has('dropped') || !line(note) || !note.trim()) throw new Error('Train close needs exactly one of --done or --dropped and a one-line --note.');
      item!.status = flags.has('done') ? 'done' : 'dropped';
      item!.note = note;
    } else throw new Error(`Unknown train action '${action}'.`);
    record.changed_at = at;
    record.changed_by = by;
    const file = recordFile(workspace), history = path.join(path.dirname(file), 'history.jsonl');
    ensureDirectory(path.dirname(file));
    const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
    const historySize = fs.existsSync(history) ? fs.statSync(history).size : null;
    try {
      writeAtomicText(file, JSON.stringify(record, null, 2) + '\n');
      fs.appendFileSync(history, JSON.stringify({ at, by, action, id, from, to: action === 'close' ? item!.status : item!.place }) + '\n');
    } catch (error) {
      if (before === null) fs.rmSync(file, { force: true }); else writeAtomicText(file, before);
      if (historySize === null) fs.rmSync(history, { force: true }); else fs.truncateSync(history, historySize);
      throw error;
    }
    return record;
  } finally {
    exitBookLock(lock);
  }
}
