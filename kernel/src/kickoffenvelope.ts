/**
 * THE KICKOFF ENVELOPE (kickoffs/s159 row 1; PLAN-cross-office-build-loop.md step 2.1): the one byte form `kickoff send`
 * writes into a letter and `kickoff receive` reads out of it, so a Kickoff reaches another office byte for byte.
 *
 *   # Kickoff: <id>
 *   kickoff-envelope: 1
 *   sha256 <hex>
 *   bytes <n>
 *
 *   <payload>
 *
 * ONE CANONICAL FORM, MADE THE SAME WAY ON BOTH SIDES. Every CRLF and lone CR becomes LF first (the page renderer keeps
 * an interior CRLF, and is not changed for this transport), then the renderer's own rule runs (`renderPageBody`:
 * trailing whitespace becomes one LF, the payload's own leading H1 is kept). The hash and the byte count are over those
 * canonical bytes, and receive writes exactly them. The Postbox folds CRLF and drops trailing whitespace (`keptBody`),
 * which the canonical form already did, so the hash survives transit by construction; anything else that changes on
 * the way (a filled `{now}`, a dropped line) fails it.
 */

import { renderPageBody } from './pagepath.ts';
import { sha256OfText } from './sha.ts';

export class KickoffEnvelopeRefusal extends Error {}

function refuse(message: string): never {
  throw new KickoffEnvelopeRefusal(message);
}

/** A Kickoff's id is one new-page segment: `s159`, `c57`, `s158-r2`, `w1`. */
export const KICKOFF_ID = /^[a-z0-9][a-z0-9-]*$/;

export interface Envelope {
  id: string;
  sha256: string;
  bytes: number;
  /** The payload's canonical bytes, as text. */
  payload: string;
}

/** The payload's canonical bytes. The title is used only by a payload with no H1 of its own, the same on both sides. */
export function canonicalPayload(text: string, id: string): string {
  return renderPageBody(text.replace(/^﻿/, '').replace(/\r\n?/g, '\n'), `Kickoff ${id}`).body;
}

function measured(id: string, payload: string): Envelope {
  return { id, sha256: sha256OfText(payload), bytes: Buffer.byteLength(payload, 'utf8'), payload };
}

/** The envelope around a Kickoff page's text, and what it says. */
export function buildEnvelope(id: string, pageText: string): Envelope & { text: string } {
  if (!KICKOFF_ID.test(id)) refuse(`A Kickoff id is lowercase letters, digits and hyphens, such as s159 or s158-r2; '${id}' is not one.`);
  const envelope = measured(id, canonicalPayload(pageText, id));
  return { ...envelope, text: `# Kickoff: ${id}\nkickoff-envelope: 1\nsha256 ${envelope.sha256}\nbytes ${envelope.bytes}\n\n${envelope.payload}` };
}

/**
 * A letter body read back as an envelope. Refused when it is not one, and when its payload's canonical bytes are not
 * the ones its header names: the refusal gives both hashes and both byte counts.
 */
export function parseEnvelope(body: string): Envelope {
  const text = body.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const header = /^# Kickoff: (\S+)\nkickoff-envelope: (\S+)\nsha256 ([0-9a-f]{64})\nbytes (\d+)\n\n/.exec(text);
  if (header === null) {
    refuse('The letter is not a Kickoff envelope: it must open with "# Kickoff: <id>", "kickoff-envelope: 1", "sha256 <hex>", "bytes <n>" and a blank line.');
  }
  const [, id, version, sha256, bytes] = header;
  if (version !== '1') refuse(`The letter's envelope is version ${version}; this Deskpost reads version 1 only.`);
  if (!KICKOFF_ID.test(id!)) refuse(`The envelope names the Kickoff '${id}', which is not a Kickoff id (lowercase letters, digits and hyphens).`);
  const received = measured(id!, canonicalPayload(text.substring(header[0].length), id!));
  if (received.sha256 !== sha256 || received.bytes !== Number(bytes)) {
    refuse(
      `The Kickoff ${id} did not arrive as it was sent: the envelope says sha256 ${sha256}, ${bytes} bytes; the payload received is ` +
        `sha256 ${received.sha256}, ${received.bytes} bytes. Nothing was written.`,
    );
  }
  return received;
}
