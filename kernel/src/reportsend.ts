/** Outgoing Reports: one recorded payload and the same idempotent stages at capture and recovery (c47 row 3). */
import fs from 'node:fs';
import path from 'node:path';
import {createOutboxEntry, readOutbox, sendAfterCapture, sendControlNotice, finishReportControlMove, postboxCache, newDeliveryId, inboxPath, payloadDigest, type PostboxFiling, type OutboxEntry} from './postbox.ts';
import {noteAtReservedPath, createRecord, completeStage, recover, readRecords, listOutstanding, blocksReportAllocation, pendingControlMoves, type IntentBook, type IntentRecord, type IntentStage, type StageRunner} from './intent.ts';
import type {PsJsonValue} from './psjson.ts';
import {enterBookLock, exitBookLock, type BookLock} from './locks.ts';
import {sha256OfText} from './sha.ts';
import {resolveSeatName} from './seatdesk.ts';
import {seatIncarnation} from './seatincarnation.ts';
import {getShelfBook, listFilesRecursive, readUtf8, type ShelfBook} from './shelfbook.ts';
import {noteFrontmatter, setNoteField, parseShelfNote, type ShelfNoteRow} from './shelfnote.ts';
import {enterBookMutation, completeBookMutation, undoBookMutation} from './mutation.ts';
import {writeBookJournal, restoreBookJournal} from './journal.ts';
import {captureOutcomeLetter, captureGeneratedReport, applyOutcomeEffect, outcomeLetterPage, updateShelfNoteIndex} from './capture.ts';
import {writeAtomicText} from './fsx.ts';
import {readMap} from './maplines.ts';
import {localDate} from './localdate.ts';
import {strayControlRefusal,controlCharacterInLine} from './controlchars.ts';
import {fillTimePlaceholders,hasTimePlaceholders,TIME_PLACEHOLDER_NOTE} from './hubedit.ts';

/** Delivery identity survives shelf tidy: the search covers both notes/ and reviewed/. */
export function deliveryNote(book: ShelfBook, id: string, sent: boolean): ShelfNoteRow | null {
  for (const folder of ['notes', 'reviewed']) {
    const directory = path.join(book.wikiPath, folder);
    if (!fs.existsSync(directory)) continue;
    const files = folder === 'reviewed' ? listFilesRecursive(directory) : fs.readdirSync(directory, {withFileTypes:true})
      .filter(entry=>entry.isFile()).map(entry=>path.join(directory,entry.name)).sort();
    for (const file of files.filter(file=>file.endsWith('.md'))) {
      const name = path.basename(file);
      const content = readUtf8(file);
      if (noteFrontmatter(content).get('delivery_id') !== id) continue;
      const note = parseShelfNote(name, file, content);
      const foreign = !!note.fromLibraryId && note.fromLibraryId !== note.localLibraryId;
      if (foreign === sent) continue;
      return {...note, page: path.relative(book.wikiPath,file).replace(/\\/g,'/').replace(/\.md$/, '')};
    }
  }
  return null;
}

export function reportStageRunner(workspace: string): StageRunner {
  return (record, stage, locks) => {
    if (record.kind === 'report-control-applied') return incomingControlStage(workspace,record,stage,locks);
    if (record.kind === 'report-control') return controlSendStage(workspace,record,stage,locks);
    if (record.kind === 'report-outcome-applied') return incomingOutcomeStage(workspace,record,stage,locks);
    if (record.kind === 'report-outcome') return outcomeStage(workspace, record, stage, locks);
    if (record.kind !== 'report-delivery' || record.direction !== 'outgoing') throw new Error(`Unsupported intent ${record.kind} (${record.delivery_id}); nothing changed.`);
    if (stage.name === 'entry') {
      if (!readOutbox(workspace).some(entry => entry.delivery_id === record.delivery_id)) createOutboxEntry(workspace, record.payload['entry'] as OutboxEntry);
      return `outbox entry ${record.delivery_id}`;
    }
    if (stage.name !== 'sent-copy') throw new Error(`Unsupported Report stage ${stage.name}.`);
    const book = getShelfBook(workspace, 'reports');
    if (!book.isCapture) throw new Error("Shelf Book 'reports' must remain a capture Book for delivery recovery.");
    const lock = locks.get('reports');
    if (!lock) throw new Error('The Report sent-copy stage needs the held reports lock.');
    const reserved = record.identities.pages.find(page => page.book === 'reports')?.page;
    if (!reserved || !/^notes\/[a-z0-9][a-z0-9.-]*$/.test(reserved)) throw new Error('The Report intent has no safe reserved page.');
    const found = deliveryNote(book, record.delivery_id, true);
    const file = found?.fullPath ?? path.join(book.wikiPath, reserved + '.md');
    const existingBefore = record.payload['existing_before'];
    const existing = typeof existingBefore === 'string' && fs.existsSync(file) && readUtf8(file) === existingBefore;
    const ours = existing ? 'existing' : noteAtReservedPath(file, found?.page ?? reserved, record.delivery_id);
    const supersession=record.payload['supersession'] as {file:string;before:string;after:string} | null;
    if (supersession) {
      const relative=path.relative(book.notesPath,supersession.file);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('The superseded Report is outside this Book.');
      const current=readUtf8(supersession.file);
      if(current!==supersession.before && current!==supersession.after) throw new Error(`The superseded Report changed while delivery ${record.delivery_id} waited; it was not overwritten.`);
    }
    const mutation = enterBookMutation({workspace,slug:'reports',bookRoot:book.bookRoot,reason:`Report sent copy ${record.delivery_id}`,lock});
    const journal = writeBookJournal({workspace,bookRoot:book.bookRoot,operation:`Report sent copy ${record.delivery_id}`,paths:[file,path.join(book.wikiPath,'_index.md'),...(supersession?[supersession.file]:[])]}).journalPath;
    try {
      if (ours === 'absent' || ours === 'existing') {
        fs.mkdirSync(path.dirname(file),{recursive:true});
        const text = record.payload['page_text'];
        if (typeof text !== 'string') throw new Error('The Report intent has no page text.');
        if (ours === 'existing') writeAtomicText(file,text);
        else fs.writeFileSync(file,text,{encoding:'utf8',flag:'wx'});
        if (readUtf8(file) !== text) throw new Error('The Report sent copy did not read back identically.');
      }
      if(supersession) writeAtomicText(supersession.file,supersession.after);
      updateShelfNoteIndex(book);
      const completed=completeBookMutation(mutation);
      return `sent copy ${found?.page ?? reserved}, delivery_id ${record.delivery_id}; ${completed.summary}`;
    } catch (error) {
      restoreBookJournal(journal);
      undoBookMutation(mutation);
      throw error;
    }
  };
}

/** Filer-side control allocation follows recovery and a fresh listing under the reports lock (c50 row 1). */
export function changeSentReport(workspace:string, page:string, action:'amend'|'withdraw', readBody:()=>string, authorised:()=>ShelfNoteRow): Record<string,PsJsonValue> {
  for(let pass=0;pass<3;pass++) {
    const body=readBody();
    const outstanding=listOutstanding(workspace).filter(r=>r.kind==='report-control' && r.payload['page']===page && r.payload['action']===action && r.payload['body']===body);
    const recovery=recover(workspace,`reports ${action}`,reportStageRunner(workspace));
    const pending=pendingControlMoves(workspace);
    const aside=recovery.controls_set_aside;
    if(outstanding.length) return {status:action==='amend'?'amended':'withdrawn',recovered:true,report_seq:Number(noteFrontmatter(String(outstanding[0]!.payload['report_after'])).get('report_seq')),delivery_id:outstanding[0]!.delivery_id,postbox:sendAfterCapture(workspace,outstanding[0]!.delivery_id),...(pending.length?{controls_move_pending:pending}:{}),...(aside?{controls_set_aside:aside}:{}),...(action==='amend'&&hasTimePlaceholders(body)?{time_placeholders:TIME_PLACEHOLDER_NOTE}:{})};
    const book=getShelfBook(workspace,'reports');
    const lock=enterBookLock(workspace,book.bookRoot,20);
    let record:IntentRecord|null=null;
    try {
      // A writer may have persisted an intent while we waited. Release and recover before allocating.
      const target=noteFrontmatter(readUtf8(path.join(book.wikiPath,page+'.md'))).get('delivery_id');
      if(listOutstanding(workspace).some(r=>blocksReportAllocation(r,target)))continue;
      const note=authorised();
      const body=readBody();
      const before=readUtf8(note.fullPath); const fields=noteFrontmatter(before);
      const state=postboxCache(workspace).state;
      const parent=fields.get('delivery_id')??''; const library=fields.get('for_library_id')??'';
      const seat=fields.get('for_seat')??''; const seatId=fields.get('for_seat_id')??'';
      if(!state || !/^[a-z0-9][a-z0-9-]*$/.test(parent) || !/^[0-9a-f-]{36}$/.test(library) || !/^[a-z0-9][a-z0-9-]*$/.test(seat) || !/^[0-9a-f]{32}$/.test(seatId))throw Error('The sent Report has no complete recorded destination; nothing was changed.');
      const seq=Number(fields.get('report_seq')??'0')+1;
      let ids:string[];try {ids=JSON.parse(fields.get('report_seq_ids')??'[]') as string[];}catch{throw Error('The sent Report has invalid report_seq_ids.');}
      if(!Number.isSafeInteger(seq)||seq<1||!Array.isArray(ids)||ids.length!==seq-1||ids.some(id=>typeof id!=='string'||!/^[a-z0-9][a-z0-9-]*$/.test(id)))throw Error('The sent Report sequence and delivery identities disagree.');
      const id=newDeliveryId(String(state['library_id'])); const now=new Date().toISOString().replace(/\.\d{3}Z$/,'Z');
      const title=`Report ${action}: ${parent} (${seq})`;
      // The carrier merges a leading YAML block into metadata. A marked preamble keeps an update's text intact.
      const wrapped=action==='amend'&&/^---(?:\n|$)/.test(body);
      const wireBody=wrapped?'### Report amendment\n\n'+body:body;
      const metadata:Record<string,string>={book:'reports',delivery_id:id,from_library_id:String(state['library_id']),from_library_card:String(state['library_card']),origin_library_id:String(state['library_id']),origin_seat:fields.get('origin_seat')??note.fromSeat!,origin_seat_id:fields.get('origin_seat_id')??note.fromSeatId??'',for_library_id:library,for_seat:seat,for_seat_id:seatId,report_seq:String(seq),[action==='amend'?'amends_delivery_id':'withdraws_delivery_id']:parent,payload_digest:payloadDigest(wireBody)};
      if(wrapped)metadata['control_body_format']='update-text-v1';
      if(!/^[0-9a-f]{32}$/.test(metadata['origin_seat_id']!))throw Error('The sent Report has no complete recorded origin seat id.');
      const entry:OutboxEntry={schema:1,book:'reports',delivery_id:id,created_utc:now,letter_page:page,recipient_library_id:library,recipient_library_card:'',for_seat:seat,for_seat_id:seatId,path:inboxPath(library,id),digest:payloadDigest(wireBody),title,body:wireBody,metadata,state:'unsent',attempts:0,sent_utc:null,sent_path:null,refusal:null,last_error:null};
      let after=reportChange(before,action,body,now);
      after=setNoteField(setNoteField(after,'report_seq',String(seq)),'report_seq_ids',JSON.stringify([...ids,id]));
      record=createRecord(workspace,{kind:'report-control',direction:'outgoing',book:'reports',delivery_id:id,identities:{delivery_ids:[id],pages:[]},payload:{entry,page,action,body,report_id:parent,report_before:before,report_after:after},stages:[{name:'control-entry',book:null},{name:'control-local',book:'reports'}]});
      const run=reportStageRunner(workspace);
      for(const stage of record.stages.filter(s=>s.name!=='send'))completeStage(workspace,record,stage.name,run(record,stage,new Map([['reports',lock]])));
    }finally{exitBookLock(lock);}
    // Like report-delivery, the durable outbox owns transport retries after the local record completes.
    if(record)return {status:action==='amend'?'amended':'withdrawn',delivery_id:record.delivery_id,report_seq:Number(noteFrontmatter(String(record.payload['report_after'])).get('report_seq')),postbox:sendAfterCapture(workspace,record.delivery_id),...(pending.length?{controls_move_pending:pending}:{}),...(aside?{controls_set_aside:aside}:{}),...(action==='amend'&&hasTimePlaceholders(String(record.payload['body']))?{time_placeholders:TIME_PLACEHOLDER_NOTE}:{})};
  }
  throw Error('The Report control could not finish recovery before allocating a sequence; retry it.');
}

/** Control update/withdraw bytes; sequence fields are added separately. */
function reportChange(before:string,action:'amend'|'withdraw',body:string,stamp:string):string {
  if(action==='withdraw'){
    const after=setNoteField(setNoteField(before.replace(/^review:\s*[^\n]*/m,'review: done'),'reviewed',stamp),'closed_note',body);
    if(!/^review: done/m.test(after))throw Error('The Report has no review field to close.');
    return after;
  }
  const eol=before.includes('\r\n')?'\r\n':'\n';
  body=fillTimePlaceholders(body,new Date(stamp));
  const fields=setNoteField(setNoteField(before,'updated',stamp),'update_count',String(Number(noteFrontmatter(before).get('update_count')??'0')+1));
  return fields+(/\n$/.test(fields)?'':eol)+eol+`## Update ${stamp}`+eol+eol+body.split('\n').join(eol)+eol;
}

function controlSendStage(workspace:string,record:IntentRecord,stage:IntentStage,locks:ReadonlyMap<IntentBook,BookLock>):string {
  if(stage.name==='control-entry'){
    if(!readOutbox(workspace).some(e=>e.delivery_id===record.delivery_id))createOutboxEntry(workspace,record.payload['entry'] as OutboxEntry);
    const pause=Number(process.env['LIBRARY_POSTBOX_PAUSE_AFTER_ENTRY_MS']??'0');
    if(process.env['LIBRARY_POSTBOX_FAULT']==='after:control-entry'&&Number.isFinite(pause)&&pause>0)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,Math.min(2000,pause));
    return `outbox entry ${record.delivery_id}`;
  }
  if(stage.name==='control-local')return writeControlReport(workspace,record,locks,true);
  throw Error('Unknown outgoing control stage '+stage.name);
}

function writeControlReport(workspace:string,record:IntentRecord,locks:ReadonlyMap<IntentBook,BookLock>,sent:boolean):string {
  const book=getShelfBook(workspace,'reports');const lock=locks.get('reports');if(!lock)throw Error('The control needs the held reports lock.');
  const note=deliveryNote(book,String(record.payload['report_id']),sent);if(!note)throw Error('The parent Report is gone.');
  const before=String(record.payload['report_before']);const after=String(record.payload['report_after']);const current=readUtf8(note.fullPath);
  if(current!==before&&current!==after)throw Error('The Report changed while its control waited; nothing was overwritten.');
  const mutation=enterBookMutation({workspace,slug:'reports',bookRoot:book.bookRoot,reason:'Report control '+record.delivery_id,lock});
  const journal=writeBookJournal({workspace,bookRoot:book.bookRoot,operation:'Report control',paths:[note.fullPath,path.join(book.wikiPath,'_index.md')]}).journalPath;
  try{if(current!==after)writeAtomicText(note.fullPath,after);updateShelfNoteIndex(book);return `${note.page}; ${completeBookMutation(mutation).summary}`;}
  catch(error){restoreBookJournal(journal);undoBookMutation(mutation);throw error;}
}

/** A verdict returns to the address recorded on the received Report, without a directory lookup. */
export function closeReportOutcome(workspace: string, page: string, outcome: string, outcomeNote: string, expectedHash: string): Record<string, PsJsonValue> {
  for (let pass = 0; pass < 3; pass++) {
    const recovery=recover(workspace, 'triage batch close', reportStageRunner(workspace));
    const reports = getShelfBook(workspace, 'reports');
    const letters = getShelfBook(workspace, 'letters');
    const locks = new Map<IntentBook, BookLock>();
    let record: IntentRecord | null = null;
    try {
      locks.set('reports', enterBookLock(workspace, reports.bookRoot));
      locks.set('letters', enterBookLock(workspace, letters.bookRoot));
      // The listing under the final locks owns allocation. A new intent requires recovery before a new generation.
      const file = path.join(workspace, page);
      const before = readUtf8(file);
      if (sha256OfText(before) !== expectedHash) throw new Error('The approved Report changed after the approval; rebuild the plan.');
      const fields = noteFrontmatter(before);
      const reportId = fields.get('delivery_id') ?? '';
      if (listOutstanding(workspace).some(r => blocksReportAllocation(r,reportId))) continue;
      const fromLibrary = fields.get('from_library_id') ?? '';
      const forSeat = fields.get('origin_seat') ?? '';
      const forSeatId = fields.get('origin_seat_id') ?? '';
      if (!/^[a-z0-9][a-z0-9-]*$/.test(reportId) || !/^[0-9a-f-]{36}$/.test(fromLibrary) || !/^[a-z0-9][a-z0-9-]*$/.test(forSeat) || !/^[0-9a-f]{32}$/.test(forSeatId)) throw new Error('The received Report has no complete recorded return address; nothing was closed.');
      if (fields.get('review') === 'done') return {status:'unchanged', note_page:page,...(recovery.controls_set_aside?{controls_set_aside:recovery.controls_set_aside}:{})};
      const state = postboxCache(workspace).state;
      if (!state) throw new Error('The outcome needs this Library\'s Postbox.');
      const generation = Number(fields.get('outcome_gen') ?? '0') + 1;
      if (!Number.isSafeInteger(generation) || generation < 1) throw new Error('The Report has no valid outcome generation.');
      const id = newDeliveryId(String(state['library_id']));
      const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
      const title = `Report outcome: ${outcome} (generation ${generation})`;
      const letterPage = outcomeLetterPage(workspace,title,locks.get('letters'));
      const body = `# ${title}\n\nOutcome: ${outcome}\n\n${outcomeNote}\n\nReport: ${page.replace(/\.md$/, '')}\n`;
      const author = resolveSeatName({stateDirectory:path.join(workspace,'.claude')});
      if (author.status !== 'named') throw new Error('An outcome close needs a seat to send its letter.');
      const authorId = seatIncarnation(path.join(workspace,'.claude'),author.seat!).seatId;
      const metadata: Record<string,string> = {book:'letters', delivery_id:id, from_library_id:String(state['library_id']), from_library_card:String(state['library_card']), for_library_id:fromLibrary, for_seat:forSeat, for_seat_id:forSeatId, from_seat:author.seat!, origin_seat:author.seat!, origin_seat_id:authorId, closes_delivery_id:reportId, outcome, outcome_gen:String(generation), payload_digest:payloadDigest(body)};
      if (fields.get('sent_for')) metadata['sent_for'] = fields.get('sent_for')!;
      const entry: OutboxEntry = {schema:1, book:'letters', delivery_id:id, created_utc:now, letter_page:letterPage, recipient_library_id:fromLibrary, recipient_library_card:fields.get('from_library_card') ?? '', for_seat:forSeat, for_seat_id:forSeatId, path:inboxPath(fromLibrary,id), digest:payloadDigest(body), title, body, metadata, state:'unsent',attempts:0,sent_utc:null,sent_path:null,refusal:null,last_error:null};
      let text = `---\ncaptured: ${now}\nreview: pending\nfrom_seat: ${author.seat}\nfrom_seat_id: ${authorId}\nfor_seat: ${forSeat}\nfor_seat_id: ${forSeatId}\n`;
      for (const [key,value] of Object.entries(metadata).filter(([key])=>!['book','from_seat','for_seat','for_seat_id','payload_digest'].includes(key))) text += `${key}: ${value}\n`;
      text += `postbox_path: ${entry.path}\n---\n\n${body}`;
      let after = setNoteField(before,'review','done');
      for (const [key,value] of Object.entries({reviewed:now,outcome,outcome_gen:String(generation),outcome_letter:letterPage})) after = setNoteField(after,key,value);
      record = createRecord(workspace,{kind:'report-outcome',direction:'outgoing',book:'letters',delivery_id:id,identities:{delivery_ids:[id],pages:[{book:'letters',page:letterPage}]},payload:{entry,page_text:text,report_id:reportId,report_before:before,report_after:after},stages:[{name:'entry',book:null},{name:'letter-note',book:'letters'},{name:'report-close',book:'reports'},{name:'send',book:null}]});
      const run = reportStageRunner(workspace);
      for (const stage of record.stages.filter(s=>s.name!=='send')) completeStage(workspace,record,stage.name,run(record,stage,locks));
    } finally {
      for (const lock of [...locks.values()].reverse()) exitBookLock(lock);
    }
    if (record) {
      const stage = record.stages.find(s=>s.name==='send')!;
      completeStage(workspace,record,'send',reportStageRunner(workspace)(record,stage,new Map()));
      return {status:'updated', new_review:'done', outcome, outcome_gen:Number(noteFrontmatter(String(record.payload['report_after'])).get('outcome_gen')), outcome_letter:record.identities.pages[0]!.page, delivery_id:record.delivery_id,...(recovery.controls_set_aside?{controls_set_aside:recovery.controls_set_aside}:{})};
    }
  }
  throw new Error('The outcome close could not finish recovery before allocating a generation; retry it.');
}

function outcomeStage(workspace: string, record: IntentRecord, stage: IntentStage, locks: ReadonlyMap<IntentBook, BookLock>): string {
  if (stage.name === 'entry') {
    if (!readOutbox(workspace).some(e=>e.delivery_id===record.delivery_id)) createOutboxEntry(workspace,record.payload['entry'] as OutboxEntry);
    // SELF-TEST ONLY: hold this persisted intent briefly so another entry point really waits on its locks.
    const pause = Number(process.env['LIBRARY_POSTBOX_PAUSE_AFTER_ENTRY_MS'] ?? '0');
    if (process.env['LIBRARY_POSTBOX_FAULT'] === 'after:entry' && Number.isFinite(pause) && pause > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,Math.min(2000,pause));
    return `outbox entry ${record.delivery_id}`;
  }
  if (stage.name === 'letter-note') return captureOutcomeLetter(workspace,record,locks.get('letters'));
  if (stage.name === 'report-close') {
    const book = getShelfBook(workspace,'reports');
    const note = deliveryNote(book,String(record.payload['report_id']),false);
    if (!note) throw new Error('The received Report for '+record.delivery_id+' is gone.');
    const before = String(record.payload['report_before']);
    const after = String(record.payload['report_after']);
    const current = readUtf8(note.fullPath);
    if (current !== before && current !== after) throw new Error('The received Report changed while its outcome waited; nothing was overwritten.');
    const lock = locks.get('reports'); if(!lock) throw new Error('The Report close needs the held reports lock.');
    const mutation=enterBookMutation({workspace,slug:'reports',bookRoot:book.bookRoot,reason:'Report outcome '+record.delivery_id,lock});
    const journal=writeBookJournal({workspace,bookRoot:book.bookRoot,operation:'Report outcome',paths:[note.fullPath,path.join(book.wikiPath,'_index.md')]}).journalPath;
    try {
      if(current!==after) writeAtomicText(note.fullPath,after);
      updateShelfNoteIndex(book);
      return `${note.page}; ${completeBookMutation(mutation).summary}`;
    } catch(error) {restoreBookJournal(journal);undoBookMutation(mutation);throw error;}
  }
  if (stage.name === 'send') {
    if(locks.size) throw new Error('The outcome send must hold no Book lock.');
    const result=sendAfterCapture(workspace,record.delivery_id);
    return JSON.stringify(result);
  }
  throw new Error('Unknown outcome stage '+stage.name);
}

/** File an outcome and apply its effect through the same incoming intent on every retry. */
export function receiveReportOutcome(workspace: string, filing: PostboxFiling): {page: string; already: boolean; effect: string} {
  const reports=getShelfBook(workspace,'reports'); const letters=getShelfBook(workspace,'letters');
  if (!reports.isCapture || !letters.isCapture || !letters.takesLetters) throw new Error('Filing an outcome needs the reports capture Book and a letters capture Book that accepts letters.');
  const fields=new Map(filing.fields);
  const gen=Number(fields.get('outcome_gen'));
  if(!fields.get('closes_delivery_id') || !fields.get('outcome') || !Number.isSafeInteger(gen) || gen<1 || !filing.forSeat || !filing.forSeatId) throw new Error('The outcome has no complete verdict, generation or recipient address; left in the inbox.');
  const held=new Map<IntentBook,BookLock>();
  try {
    held.set('reports',enterBookLock(workspace,reports.bookRoot));
    held.set('letters',enterBookLock(workspace,letters.bookRoot));
    const prior=deliveryNote(letters,filing.deliveryId,false);
    let record=readRecords(workspace).find(r=>r.direction==='incoming'&&r.delivery_id===filing.deliveryId);
    if(!record) {
      const now=new Date().toISOString().replace(/\.\d{3}Z$/,'Z');
      const page=prior?.page ?? outcomeLetterPage(workspace,/^#[ \t]+([^\r\n]+)/.exec(filing.body)?.[1]?.trim() || filing.deliveryId,held.get('letters'));
      const lines=['---',`captured: ${now}`,'review: pending',...(filing.fromSeat?[`from_seat: ${filing.fromSeat}`,'from_seat_source: postbox']:[]),`for_seat: ${filing.forSeat}`,`for_seat_id: ${filing.forSeatId}`,...(filing.originSeat?[`origin_seat: ${filing.originSeat}`]:[]),...(filing.originSeatId?[`origin_seat_id: ${filing.originSeatId}`]:[]),...filing.fields.map(([key,value])=>`${key}: ${value}`),'---','',filing.body];
      record=createRecord(workspace,{kind:'report-outcome-applied',direction:'incoming',book:'letters',delivery_id:filing.deliveryId,identities:{delivery_ids:[filing.deliveryId],pages:[{book:'letters',page}]},payload:{filing:filing as unknown as Record<string,unknown>,page_text:lines.join('\n')+'\n'},stages:[{name:'filed',book:'letters'},{name:'effect',book:'reports'}]});
    }
    const run=reportStageRunner(workspace);
    for(const stage of record.stages) if(stage.state==='pending') completeStage(workspace,record,stage.name,run(record,stage,held));
    return {page:deliveryNote(letters,filing.deliveryId,false)?.page ?? record.identities.pages[0]!.page,already:prior!==null,effect:record.stages.find(s=>s.name==='effect')?.proof ?? ''};
  } finally {for(const lock of [...held.values()].reverse())exitBookLock(lock);}
}


function incomingOutcomeStage(workspace: string, record: IntentRecord, stage: IntentStage, locks: ReadonlyMap<IntentBook,BookLock>): string {
  if(stage.name==='filed')return captureOutcomeLetter(workspace,record,locks.get('letters'));
  if(stage.name==='effect')return applyOutcomeEffect(workspace,record,locks);
  throw new Error('Unknown incoming outcome stage '+stage.name);
}

/** Incoming controls are applied under reports then letters, by parent provenance and sequence. */
type ControlResult={status:'applied'|'duplicate'|'deferred'|'conflict';parent:string;why?:string;effect?:string};
export function receiveReportControl(workspace:string,filing:PostboxFiling):ControlResult {
  for(let pass=0;pass<3;pass++){
    recover(workspace,'postbox check',reportStageRunner(workspace));
    const result=controlAttempt(workspace,filing);if(result)return result;
  }
  throw Error('The control could not finish recovery under its final lock set; retry the check.');
}
function controlAttempt(workspace:string,filing:PostboxFiling):ControlResult|null {
  const fields=new Map(filing.fields);
  const amend=fields.get('amends_delivery_id');const withdraw=fields.get('withdraws_delivery_id');
  const parent=amend??withdraw??'';const seq=Number(fields.get('report_seq_applied'));
  if(filing.book!=='reports'||!!amend===!!withdraw||!Number.isSafeInteger(seq)||seq<1||!filing.originSeat||!filing.originSeatId||!filing.forSeat||!filing.forSeatId||fields.has('postbox_damaged'))throw Error('The control has no intact parent, sequence or origin; left in the inbox.');
  const invalid=filing.body.trim()?strayControlRefusal(filing.body,'Report control'):'The control body is empty.';
  if(invalid)throw Error(invalid+' Left in the inbox.');
  if(amend){
    const reading=readMap('\n'+filing.body);
    if(Buffer.byteLength(filing.body,'utf8')>16384||reading.unclosedFence||reading.text.split('\n').some(line=>/^[ \t]{0,3}#{1,2}(?:[ \t]|$)/.test(line)))throw Error('The amendment is not a valid bounded Report update; left in the inbox.');
  }else if(controlCharacterInLine(filing.body))throw Error('A withdrawal reason must be one line without control characters; left in the inbox.');
  const reports=getShelfBook(workspace,'reports');const letters=getShelfBook(workspace,'letters');
  if(!reports.isCapture||!letters.isCapture||!letters.takesLetters)throw Error('Controls need reports and letters capture Books.');
  const held=new Map<IntentBook,BookLock>();let record:IntentRecord|undefined;let status:'applied'|'duplicate'|'deferred'|'conflict'='applied';
  try {
    held.set('reports',enterBookLock(workspace,reports.bookRoot));held.set('letters',enterBookLock(workspace,letters.bookRoot));
    const report=deliveryNote(reports,parent,false);
    if(!report)return {status:'deferred',parent,why:'parent Report has not arrived'};
    const before=readUtf8(report.fullPath);const reportFields=noteFrontmatter(before);
    if(report.malformed.length)throw Error('The parent Report has malformed frontmatter; left in the inbox.');
    if(!report.fromSeat||reportFields.get('sent_for')==='seatless')throw Error('The parent Report has no filing author; a return address grants no control authority.');
    if(fields.get('origin_library_id')!==reportFields.get('from_library_id')||filing.originSeatId!==reportFields.get('origin_seat_id'))throw Error('The control origin Library and seat incarnation do not match its parent; left in the inbox.');
    record=readRecords(workspace).find(r=>r.direction==='incoming'&&r.delivery_id===filing.deliveryId);
    // Another entry point could have persisted work while this check waited. Recover outside these locks first.
    if(listOutstanding(workspace).some(r=>r.delivery_id!==filing.deliveryId&&blocksReportAllocation(r,parent)))return null;
    if(!record){
      const applied=Number(reportFields.get('report_seq_applied')??'0');
      let ids:string[];try{ids=JSON.parse(reportFields.get('report_seq_ids')??'[]') as string[];}catch{throw Error('The parent Report has invalid sequence bindings.');}
      if(!Number.isSafeInteger(applied)||applied<0||!Array.isArray(ids)||ids.length!==applied||ids.some(id=>typeof id!=='string'||!/^[a-z0-9][a-z0-9-]*$/.test(id)))throw Error('The parent Report sequence and identities disagree.');
      if(ids.includes(filing.deliveryId))return {status:'duplicate',parent};
      let conflicts:string[];try{conflicts=JSON.parse(reportFields.get('control_conflict')??'[]') as string[];}catch{throw Error('The parent Report has invalid conflict identities.');}
      if(!Array.isArray(conflicts)||conflicts.some(id=>typeof id!=='string'||!/^[a-z0-9][a-z0-9-]*$/.test(id)))throw Error('The parent Report has invalid conflict identities.');
      if(conflicts.includes(filing.deliveryId))return {status:'duplicate',parent};
      if(seq>applied+1)return {status:'deferred',parent,why:'an earlier sequence has not arrived'};
      const conflict=seq<=applied;
      const frozen=report.review==='done'||!!report.filedTo||!!report.supersededBy||!!report.answeredBy||!!report.routedTo;
      const now=new Date().toISOString().replace(/\.\d{3}Z$/,'Z');
      let after:string;
      let generatedPage:string|null=null;let generatedText:string|null=null;let frozenAfter:string|null=null;
      let notice:{entry:OutboxEntry;page:string;text:string}|null=null;
      if(conflict){
        status='conflict';after=setNoteField(before,'control_conflict',JSON.stringify([...conflicts,filing.deliveryId]));
        after+='\n## Control conflict '+now+'\n\nSequence '+seq+' already belongs to '+ids[seq-1]+'; refused '+filing.deliveryId+'.\n';
        notice=controlNotice(workspace,filing,held,`Report control conflict: ${filing.deliveryId}`,`Control ${filing.deliveryId} for Report ${parent} was refused: sequence ${seq} already belongs to ${ids[seq-1]}.`);
      }else if(frozen){
        if(amend){
          generatedPage='notes/'+localDate()+'-amendment-of-'+path.basename(report.page)+'-'+sha256OfText(filing.deliveryId).slice(0,8);
          const metadata:Record<string,string>={captured:now,review:'pending',book:'reports',from_seat:filing.originSeat,from_seat_source:'postbox',from_library_id:fields.get('origin_library_id')!,from_library_card:fields.get('from_library_card')??'',for_library_id:String(postboxCache(workspace).state?.['library_id']),for_seat:filing.forSeat,for_seat_id:filing.forSeatId,origin_library_id:fields.get('origin_library_id')!,origin_seat:filing.originSeat,origin_seat_id:filing.originSeatId,origin_delivery_id:filing.deliveryId,delivery_id:filing.deliveryId,postbox_path:fields.get('postbox_path')!,report_seq_applied:'0',outcome_gen:'0'};
          generatedText=['---',...Object.entries(metadata).filter(([,v])=>!!v).map(([k,v])=>k+': '+v),'---','','# Amendment of '+path.basename(report.page),'',filing.body,'','Original Report: [['+report.page+']]','Control delivery: '+filing.deliveryId,''].join('\n');
        }else{
          const eol=before.includes('\r\n')?'\r\n':'\n';
          frozenAfter=before+['','## Withdrawal asked '+now,'',filing.body,'','Control delivery: '+filing.deliveryId,''].join(eol);
        }
        after=setNoteField(setNoteField(frozenAfter??before,'report_seq_applied',String(seq)),'report_seq_ids',JSON.stringify([...ids,filing.deliveryId]));
        notice=controlNotice(workspace,filing,held,'Frozen Report control: '+filing.deliveryId,'Control '+filing.deliveryId+' for Report '+parent+' arrived after triage touched it. '+(generatedPage?'Its amendment was filed as '+generatedPage+'.':'Its withdrawal request was appended to '+report.page+'. The triage disposition is unchanged.'));
      }else{
        after=reportChange(before,amend?'amend':'withdraw',filing.body,now);
        // send-pending carries earlier updates in the body, without their local counter.
        if(amend&&!reportFields.get('update_count'))after=setNoteField(after,'update_count',String((before.match(/^## Update /gm)??[]).length+1));
        after=setNoteField(setNoteField(after,'report_seq_applied',String(seq)),'report_seq_ids',JSON.stringify([...ids,filing.deliveryId]));
      }
      record=createRecord(workspace,{kind:'report-control-applied',direction:'incoming',book:'reports',delivery_id:filing.deliveryId,identities:{delivery_ids:[filing.deliveryId,...(notice?[notice.entry.delivery_id]:[])],pages:[...(generatedPage?[{book:'reports' as const,page:generatedPage}]:[]),...(notice?[{book:'letters' as const,page:notice.page}]:[])]},payload:{report_id:parent,report_before:frozenAfter??before,report_after:after,conflict,notice,generated_text:generatedText,frozen_before:before,frozen_after:frozenAfter,wire_digest:filing.wireDigest??payloadDigest(filing.body)},stages:[...(!conflict&&frozen?[{name:'frozen-write',book:'reports' as const}]:[]),{name:'control-apply',book:'reports'},...(notice?[{name:'notice-entry',book:null},{name:'notice-note',book:'letters' as const},{name:'send',book:null}]:[]),{name:'server-move',book:null}]});
    }
    if(record.kind!=='report-control-applied')throw Error('A different incoming intent already owns this control identity.');
    status=record.payload['conflict']?'conflict':'applied';
    const run=reportStageRunner(workspace);
    for(const stage of record.stages)if(stage.state==='pending'&&!['send','server-move'].includes(stage.name))completeStage(workspace,record,stage.name,run(record,stage,held));
  }finally{for(const lock of [...held.values()].reverse())exitBookLock(lock);}
  const send=record?.stages.find(s=>s.name==='send'&&s.state==='pending');
  if(record&&send)completeStage(workspace,record,send.name,reportStageRunner(workspace)(record,send,new Map()));
  return {status,parent,effect:record?.payload['generated_text']?'amendment-filed':record?.payload['frozen_after']?'withdrawal-requested':status==='conflict'?'conflict':amend?'amended':'withdrawn'};
}

function controlNotice(workspace:string,filing:PostboxFiling,locks:ReadonlyMap<IntentBook,BookLock>,title:string,body:string):{entry:OutboxEntry;page:string;text:string} {
  const fields=new Map(filing.fields);const state=postboxCache(workspace).state;
  if(!state)throw Error('The control answer needs this Library\'s Postbox.');
  const id=filing.deliveryId.replace(/[^-]+$/,sha256OfText(filing.deliveryId).slice(0,8));
  const library=fields.get('origin_library_id')!;const now=new Date().toISOString().replace(/\.\d{3}Z$/,'Z');
  const page=outcomeLetterPage(workspace,title,locks.get('letters'));
  const textBody=`# ${title}\n\n${body}\n`;
  const metadata:Record<string,string>={book:'letters',delivery_id:id,from_library_id:String(state['library_id']),from_library_card:String(state['library_card']),for_library_id:library,for_seat:filing.originSeat,for_seat_id:filing.originSeatId,from_seat:filing.forSeat,origin_seat:filing.forSeat,origin_seat_id:filing.forSeatId,payload_digest:payloadDigest(textBody)};
  const entry:OutboxEntry={schema:1,book:'letters',delivery_id:id,created_utc:now,letter_page:page,recipient_library_id:library,recipient_library_card:fields.get('from_library_card')??'',for_seat:filing.originSeat,for_seat_id:filing.originSeatId,path:inboxPath(library,id),digest:payloadDigest(textBody),title,body:textBody,metadata,state:'unsent',attempts:0,sent_utc:null,sent_path:null,refusal:null,last_error:null};
  const text=['---',`captured: ${now}`,'review: pending',...Object.entries(metadata).filter(([key])=>key!=='payload_digest').map(([key,value])=>`${key}: ${value}`),`postbox_path: ${entry.path}`,'---','',textBody].join('\n');
  return {entry,page,text};
}

function incomingControlStage(workspace:string,record:IntentRecord,stage:IntentStage,locks:ReadonlyMap<IntentBook,BookLock>):string {
  if(stage.name==='frozen-write'){
    if(record.payload['generated_text'])return captureGeneratedReport(workspace,record,locks.get('reports'));
    return writeControlReport(workspace,{...record,payload:{...record.payload,report_before:record.payload['frozen_before'],report_after:record.payload['frozen_after']}},locks,false);
  }
  if(stage.name==='control-apply')return writeControlReport(workspace,record,locks,false);
  if(stage.name==='server-move'){if(locks.size)throw Error('A control server move must hold no Book locks.');return finishReportControlMove(workspace,record.delivery_id);}
  const notice=record.payload['notice'] as {entry:OutboxEntry;page:string;text:string}|null;
  if(!notice)throw Error('The control record has no letter payload for '+stage.name);
  if(stage.name==='notice-entry'){
    if(!readOutbox(workspace).some(e=>e.delivery_id===notice.entry.delivery_id))createOutboxEntry(workspace,notice.entry);
    return 'outbox entry '+notice.entry.delivery_id;
  }
  if(stage.name==='notice-note')return captureOutcomeLetter(workspace,{...record,direction:'outgoing',delivery_id:notice.entry.delivery_id,payload:{page_text:notice.text}},locks.get('letters'));
  if(stage.name==='send'){
    if(locks.size)throw Error('A control answer must send without Book locks.');
    return JSON.stringify(sendControlNotice(workspace,notice.entry.delivery_id));
  }
  throw Error('Unknown control receipt stage '+stage.name);
}
