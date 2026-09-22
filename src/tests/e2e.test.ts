import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer, Server } from 'node:http';
import { Context } from '../core/context.js';
import { Agent } from '../agent/agent.js';
import { OpenAiCompatibleProvider } from '../agent/llm.js';
import { DEFAULT_CONFIG } from '../types.js';
import { exportSessionTrajectory } from '../core/session.js';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

function startFakeServer(): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    let callCount = 0;
    const server = createServer((req, res) => {
      const auth = req.headers.authorization ?? '';
      if (req.url?.endsWith('/models')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'fake-e2e-model' }] }));
        return;
      }
      if (req.url?.endsWith('/chat/completions')) {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          const payload = JSON.parse(body);
          if (!payload.stream) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ choices: [{ message: { content: 'pong' } }] }));
            return;
          }

          callCount += 1;
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });

          const text =
            callCount === 1
              ? 'Mengecek sistem.\n```tool\n{"tool":"exec","command":"echo halo-e2e-ruko"}\n```\nSelesai cek.'
              : 'Semua tuntas dengan hasil: `halo-e2e-ruko`.';

          const chunks = text.match(/[\s\S]{1,6}/g) ?? [text];
          let i = 0;
          const tick = () => {
            if (i < chunks.length) {
              const evt = { choices: [{ delta: { content: chunks[i] } }] };
              res.write(`data: ${JSON.stringify(evt)}\n\n`);
              i += 1;
              setTimeout(tick, 5);
            } else {
              res.write('data: [DONE]\n\n');
              res.end();
            }
          };
          tick();
        });
        return;
      }
      res.writeHead(404).end();
    });

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 8932;
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

test('E2E: Fake LLM server probe, streaming tool loop, and trajectory export', async () => {
  const { server, url } = await startFakeServer();
  const tmpWs = mkdtempSync(join(tmpdir(), 'ruko-e2e-ws-'));

  try {
    const config = {
      ...DEFAULT_CONFIG,
      apiKey: 'test-fake-key',
      baseUrl: url,
      model: 'fake-e2e-model',
      approvalEnabled: false, // auto-execute tool in test
    };

    const provider = new OpenAiCompatibleProvider(config);

    // 1. Connection probe
    const probe = await provider.testConnection();
    assert.equal(probe.ok, true, 'probe must succeed');
    assert.equal(probe.message, 'fake-e2e-model');

    // 2. Models list
    const models = await provider.listModels();
    assert.deepEqual(models, ['fake-e2e-model']);

    // 3. Tool execution loop in Agent
    const ctx = new Context(config);
    const agent = new Agent(ctx, provider, config);

    ctx.add('user', 'Jalankan pemeriksaan');
    const reply = await agent.handleInstruction('Jalankan pemeriksaan');
    ctx.add('assistant', reply);

    assert.ok(reply.includes('Semua tuntas dengan hasil: `halo-e2e-ruko`.'));
    assert.equal(ctx.size, 4, 'Context records user, tool call, tool result, and final assistant response');

    // 4. Trajectory export
    const exportDir = join(tmpWs, 'exports');
    const exp = exportSessionTrajectory(ctx.toJSON(), 'jsonl', exportDir, 'e2e-session');
    assert.equal(exp.entryCount, ctx.size);
    const savedLines = readFileSync(exp.filePath, 'utf8').trim().split('\n');
    assert.equal(savedLines.length, ctx.size);
    assert.ok(savedLines.some((l) => l.includes('halo-e2e-ruko')));
  } finally {
    server.close();
    rmSync(tmpWs, { recursive: true, force: true });
  }
});
