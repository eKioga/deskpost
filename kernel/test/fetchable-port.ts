/**
 * A TEST SERVER ON A PORT fetch WILL CONNECT TO (kickoffs/s156 row 5; c53's section 367 drew 5061, and "section 301
 * (port 1720)" before it). A server listening on port 0 takes whatever the system hands out, and this PC's dynamic range
 * starts at 1024, so it can be a port the Fetch standard blocks: Node's `fetch` then refuses it with cause `bad port`
 * before connecting. So: listen, and while the port is on the list, close and listen again, a bounded number of times.
 */
import type { AddressInfo } from 'node:net';

/** The Fetch standard's bad ports (https://fetch.spec.whatwg.org/#port-blocking). */
export const FETCH_BLOCKED_PORTS: ReadonlySet<number> = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103, 104, 109, 110, 111,
  113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548,
  554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665,
  6666, 6667, 6668, 6669, 6679, 6697, 10080,
]);

interface Listenable {
  listen(port: number, host: string, ready: () => void): unknown;
  close(done?: (error?: Error) => void): unknown;
  address(): AddressInfo | string | null;
  once(event: 'error', listener: (error: Error) => void): unknown;
  removeListener(event: 'error', listener: (error: Error) => void): unknown;
}

/**
 * Listen on `host` at a port fetch accepts, and return it. `port` says which port to ask for on each try (0, the
 * system's choice, unless a test injects a blocked one first).
 */
export async function listenFetchable(server: Listenable, host = '127.0.0.1', port: (attempt: number) => number = () => 0): Promise<number> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const got = await new Promise<number | null>((resolve) => {
      const failed = () => resolve(null);
      server.once('error', failed);
      server.listen(port(attempt), host, () => {
        server.removeListener('error', failed);
        const address = server.address();
        resolve(typeof address === 'object' && address !== null ? address.port : null);
      });
    });
    if (got !== null && !FETCH_BLOCKED_PORTS.has(got)) return got;
    if (got !== null) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  throw new Error('no port fetch accepts after 20 tries');
}
