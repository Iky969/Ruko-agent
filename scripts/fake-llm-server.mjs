// Fake OpenAI-compatible SSE server for smoke-testing streaming + tool loop.
import { createServer } from 'node:http';

const PORT = 8931;
let turn = 0;

const server = createServer((req, res) => {
  const auth = req.headers.authorization ?? '';
  if (req.url.endsWith('/models')) {
    if (auth.includes('bad')) {
      res.writeHead(401, { 'Content-Type': 'application/json' }).end('{"error":"invalid key"}');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(
      JSON.stringify({ data: [{ id: 'fake-big' }, { id: 'fake-fast' }, { id: 'qwen3.8-flash' }] }),
    );
    return;
  }
  if (!req.url.endsWith('/chat/completions')) {
    res.writeHead(404).end();
    return;
  }
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const payload = JSON.parse(body);
    if (auth.includes('bad')) {
      res.writeHead(401, { 'Content-Type': 'application/json' }).end('{"error":"invalid_api_key"}');
      return;
    }
    if (payload.model === 'ghost-model') {
      res.writeHead(404, { 'Content-Type': 'application/json' }).end('{"error":"model not found"}');
      return;
    }
    if (!payload.stream) {
      // Connection probe (`/login` test).
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(
        JSON.stringify({ choices: [{ message: { content: 'pong' } }] }),
      );
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    turn += 1;
    const text =
      turn === 1
        ? 'Aku cek dulu.\n```tool\n{"tool":"exec","command":"echo halo-dari-tool"}\n```\nSelesai cek.'
        : 'Semua baik. Ringkasan: `ok`.';
    // Send in 5-char chunks to force fence markers to split across events.
    const chunks = text.match(/[\s\S]{1,5}/g) ?? [];
    let i = 0;
    const tick = () => {
      if (i < chunks.length) {
        const evt = { choices: [{ delta: { content: chunks[i] } }] };
        res.write(`data: ${JSON.stringify(evt)}\n\n`);
        i += 1;
        setTimeout(tick, 2);
      } else {
        res.write('data: [DONE]\n\n');
        res.end();
      }
    };
    tick();
  });
});

server.listen(PORT, () => console.log(`fake-llm listening on ${PORT}`));
