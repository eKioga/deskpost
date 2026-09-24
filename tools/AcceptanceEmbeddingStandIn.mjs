// A deterministic embedding service for the acceptance matrix (S41, the reader's ruling): the row that
// needs one is judged against THIS, never against a reader's inference server, whose address and key are
// theirs. Both arms of the row call the same process, so what is compared is what each implementation
// does with the answers -- the excerpts it sends, the cosine, the threshold, the rounding, the order.
//
// THE VECTORS ARE INTEGERS, ON PURPOSE. Each input is lowercased and split on anything that is not a
// letter or a digit; each word is hashed (FNV-1a, 32-bit) into one of DIMENSIONS buckets and counted. A
// count is exact in every JSON parser and in every number type a parser might choose -- Windows
// PowerShell's deserializer, .NET's decimal-to-double, JavaScript's double -- so a difference in the
// similarities is a difference in the arithmetic, never in how "0.1" was read.
//
// It speaks the OpenAI-shaped embeddings answer both implementations read (`data[].embedding`), refuses
// a request without `Authorization: Bearer <key>` (so a caller that drops the key is seen), and prints
// `listening <url>` once, on stdout, when it is ready. It exits when its stdin closes, so a harness that
// dies cannot leave it running.
//
//   node tools/AcceptanceEmbeddingStandIn.mjs <api-key>

import http from 'node:http';

const DIMENSIONS = 16;
const key = process.argv[2] ?? '';
if (!key) {
  process.stderr.write('usage: node tools/AcceptanceEmbeddingStandIn.mjs <api-key>\n');
  process.exit(2);
}

function embed(text) {
  const vector = new Array(DIMENSIONS).fill(0);
  for (const word of String(text).toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (!word) continue;
    let hash = 0x811c9dc5;
    for (const unit of Buffer.from(word, 'utf8')) {
      hash ^= unit;
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    vector[hash % DIMENSIONS] += 1;
  }
  return vector;
}

const server = http.createServer((request, response) => {
  const chunks = [];
  request.on('data', (chunk) => chunks.push(chunk));
  request.on('end', () => {
    const reply = (status, body) => {
      response.writeHead(status, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(body));
    };
    if (request.method !== 'POST') return reply(405, { error: 'POST only' });
    if (request.headers['authorization'] !== `Bearer ${key}`) return reply(401, { error: 'missing or wrong bearer key' });
    let body;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      return reply(400, { error: 'the body is not JSON' });
    }
    const inputs = Array.isArray(body?.input) ? body.input : [body?.input];
    reply(200, { object: 'list', model: String(body?.model ?? ''), data: inputs.map((input, index) => ({ object: 'embedding', index, embedding: embed(input) })) });
  });
});

server.listen(0, '127.0.0.1', () => {
  process.stdout.write(`listening http://127.0.0.1:${server.address().port}/v1/embeddings\n`);
});
process.stdin.on('end', () => process.exit(0));
process.stdin.on('close', () => process.exit(0));
process.stdin.resume();
