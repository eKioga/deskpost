/**
 * WHERE A LIBRARY REQUEST MAY GO (kickoffs/s164 rows 1 and 2; backlog "Code audit 3", findings 2 and 3).
 *
 *   PLAIN HTTP STAYS INSIDE THE HOME NETWORK. Eric, 2026-10-23: "i don't care much about unencrypted messages
 *   within my LAN. I care about unencrypted messages that are exposed outside my lan." So an `http:` URL is used
 *   only when EVERY address its host resolves to is loopback, private, link-local or Tailscale's 100.64.0.0/10
 *   (encrypted by Tailscale itself); `https:` goes anywhere, as before. This Library's own Basic Memory is
 *   plain HTTP on a private address. It is checked before each request, not when the URL is saved, so a name that
 *   later resolves to a public address is refused then.
 *
 *   NO REDIRECT IS FOLLOWED. A 307 or 308 to another origin carried the POST body and the MCP session there
 *   (the planner's loopback probe, 2026-10-23). The requests ask fetch for `redirect: 'manual'` and refuse any
 *   3xx answer here, so the sentence is the same under Node and Bun, whose `redirect: 'error'` failures differ.
 *
 * The resolver is one seam (`setAddressResolver`) so a test can give a name a public answer without DNS.
 */

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export type AddressResolver = (host: string) => Promise<string[]>;

const systemResolver: AddressResolver = async (host) => (await lookup(host, { all: true, verbatim: true })).map((entry) => entry.address);
let resolver: AddressResolver = systemResolver;

/** The test seam: a resolver for host names, or null for the system's. A literal address never reaches it. */
export function setAddressResolver(next: AddressResolver | null): void {
  resolver = next ?? systemResolver;
}

/** IPv4 ranges as [first octets, prefix length]. */
const PRIVATE_V4: [number[], number][] = [
  [[127], 8],
  [[10], 8],
  [[172, 16], 12],
  [[192, 168], 16],
  [[169, 254], 16],
  [[100, 64], 10],
];

function v4Bytes(address: string): number[] | null {
  const parts = address.split('.');
  if (parts.length !== 4 || !parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)) return null;
  return parts.map(Number);
}

/** Sixteen bytes, or null. Takes `::` and a trailing dotted quad (`::ffff:10.20.30.40`). */
function v6Bytes(address: string): number[] | null {
  let text = address.replace(/%.*$/, '');
  let tail: number[] = [];
  const quad = /:(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (quad) {
    const bytes = v4Bytes(quad[1]!);
    if (!bytes) return null;
    tail = bytes;
    text = text.slice(0, quad.index + 1) + '0:0';
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const words = (half: string): string[] => (half === '' ? [] : half.split(':'));
  const head = words(halves[0]!);
  const rest = halves.length === 2 ? words(halves[1]!) : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 2 ? missing < 0 : missing !== 0) return null;
  const all = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...rest];
  if (!all.every((word) => /^[0-9a-f]{1,4}$/i.test(word))) return null;
  const bytes = all.flatMap((word) => [parseInt(word, 16) >> 8, parseInt(word, 16) & 255]);
  if (tail.length) bytes.splice(12, 4, ...tail);
  return bytes;
}

function inPrefix(bytes: number[], prefix: number[], length: number): boolean {
  for (let bit = 0; bit < length; bit++) {
    const index = bit >> 3, mask = 0x80 >> (bit & 7);
    if ((bytes[index]! & mask) !== ((prefix[index] ?? 0) & mask)) return false;
  }
  return true;
}

/** Loopback, private, link-local or Tailscale: the addresses plain HTTP may reach. Anything unparsable is not. */
export function isHomeNetworkAddress(address: string): boolean {
  const v4 = isIP(address) === 4 ? v4Bytes(address) : null;
  if (v4) return PRIVATE_V4.some(([prefix, length]) => inPrefix(v4, prefix, length));
  const v6 = isIP(address) === 6 || /%/.test(address) ? v6Bytes(address) : null;
  if (!v6) return false;
  // An IPv4-mapped address (::ffff:a.b.c.d) is judged as its IPv4 address.
  if (inPrefix(v6, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff], 96)) return isHomeNetworkAddress(v6.slice(12).join('.'));
  if (inPrefix(v6, [], 127) && v6[15] === 1) return true; // ::1
  return inPrefix(v6, [0xfc], 7) || inPrefix(v6, [0xfe, 0x80], 10);
}

/**
 * Refuses (throws) when `url` is plain HTTP and its host is, or resolves to, any address outside the home network.
 * `what` names the endpoint in the sentence ("The Basic Memory endpoint"). Nothing is sent before it returns.
 */
export async function assertPlainHttpAllowed(url: string, what: string): Promise<void> {
  await plainHttpRequestUrl(url, what);
}

/**
 * THE URL A REQUEST IS SENT TO, PINNED TO WHAT WAS CHECKED (kickoffs/s167 row 5; the audit's B3). `fetch` given a host
 * name resolves it again, and that second answer was never checked, so a name that answered a private address to the
 * check could answer a public one to the connection. For plain HTTP to `localhost` this returns the same URL with the
 * host replaced by the first address the check judged, so the connection goes to that address and no second lookup is
 * made; any other host name refuses (kickoffs/s168 row 6, below). HTTPS and a literal address come back unchanged.
 * Refuses (throws) as `assertPlainHttpAllowed` does.
 */
export async function plainHttpRequestUrl(url: string, what: string): Promise<string> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`${what} ${url} is not a URL, so nothing was sent.`);
  }
  if (parsed.protocol !== 'http:') return url;
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  let addresses: string[];
  if (isIP(host)) {
    checkedAddress(url, what, host, [host]);
    return url;
  }
  try {
    addresses = await resolver(host);
  } catch (error) {
    throw new Error(`${what} ${url} is plain HTTP and its host name '${host}' could not be resolved (${(error as Error).message}), so nothing was sent.`);
  }
  const address = checkedAddress(url, what, host, addresses);
  // A HOST NAME IS REFUSED, NOT PINNED (kickoffs/s168 row 6; the s167 second reader's finding 9): the request would go to
  // the checked address, and Node's fetch sends no caller's Host header (probed on Node 24), so the server would see the
  // address as its host, and one keeping several sites by name could answer, with this request's key, from another.
  // `localhost` alone is pinned as before: its names are loopback by definition (RFC 6761), and so is the server.
  if (host !== 'localhost' && !host.endsWith('.localhost')) {
    throw new Error(
      `${what} ${url} is plain HTTP to the host name '${host}', which Deskpost does not send: the request would go to ${address} ` +
        `with that address as its Host, and a server keeping several sites by name could answer from another. ` +
        `Use the address itself in the URL, or an https:// URL. Nothing was sent.`,
    );
  }
  parsed.hostname = isIP(address) === 6 ? `[${address}]` : address;
  return parsed.href;
}

/** The first of `addresses` when every one is inside the home network; a refusal otherwise. */
function checkedAddress(url: string, what: string, host: string, addresses: string[]): string {
  const outside = addresses.find((address) => !isHomeNetworkAddress(address));
  if (addresses.length === 0 || outside !== undefined) {
    throw new Error(
      `${what} ${url} is plain HTTP to ${outside ?? `'${host}'`}, which is outside the home network, so nothing was sent. ` +
        'Plain HTTP is used only for loopback, private and Tailscale addresses; use an https:// URL for this server.',
    );
  }
  return addresses[0]!;
}

/** A 3xx answer to a request made with `redirect: 'manual'` is refused here, naming where it pointed. */
export function assertNotRedirected(response: Response, url: string, what: string): void {
  if (response.type !== 'opaqueredirect' && (response.status < 300 || response.status > 399)) return;
  const location = response.headers.get('location');
  throw new Error(
    `${what} ${url} answered with a redirect (HTTP ${response.status}${location ? ` to ${location}` : ''}), which Deskpost does not follow, ` +
      'so nothing more was sent.',
  );
}
