import test from 'node:test';
import { Readable, Writable } from 'node:stream';
import assert from 'node:assert/strict';
import { readConfig } from '../server/config.mjs';
import { createApp } from '../server/app.mjs';
import { Limiter } from '../server/llm.mjs';
import { COFFEE_GOAL } from './fixtures.mjs';

test('runtime parallel mode starts all five specialists before any finishes; settings locked during execution', async () => {
  const config = readConfig({ OPENAI_BASE_URL: 'http://localhost:11434/v1', CEO_SUMMARY: 'false' });
  const limiter = new Limiter(1);
  let started = 0;
  let release;
  let allStarted;
  const barrier = new Promise(resolve => { release = resolve; });
  const ready = new Promise(resolve => { allStarted = resolve; });
  const callModel = async (messages, opts) => {
    await limiter.acquire(opts.signal, 2000);
    try {
      opts.onStart?.();
      started++;
      if (started === 5) allStarted();
      await barrier;
      return { text: `Готово: ${opts.label}` };
    } finally { limiter.release(); }
  };
  const server = createApp({ config, callModel, limiter });
  // Dispatch real HTTP handlers in-process: no listening socket is needed.
  const request = (path, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
    const req = Readable.from(body ? [body] : []);
    req.method = method; req.url = path;
    req.headers = { host: 'localhost', ...(body ? { 'content-length': Buffer.byteLength(body) } : {}), ...headers };
    let output = '';
    const res = new Writable({ write(chunk, encoding, callback) { output += chunk.toString(); callback(); } });
    res.statusCode = 200;
    res.writeHead = status => { res.statusCode = status; };
    res.setHeader = () => {};
    res.on('error', reject);
    res.on('finish', () => resolve({ status: res.statusCode, json: async () => JSON.parse(output), text: async () => output }));
    server.emit('request', req, res);
  });
  const post = (path, body) => request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try {
    for (const concurrency of [0, 6, 1.5, '3']) {
      assert.equal((await post('/api/settings', { concurrency, mode: 'parallel' })).status, 400);
    }
    assert.equal((await post('/api/settings', { concurrency: 5, mode: 'invalid' })).status, 400);
    const foreign = await request('/api/settings', { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/json' }, body: JSON.stringify({ concurrency: 5, mode: 'parallel' }) });
    assert.equal(foreign.status, 403);
    assert.equal((await post('/api/settings', { concurrency: 5, mode: 'parallel' })).status, 200);
    const health = await (await request('/api/health')).json();
    assert.equal(health.concurrency, 5);
    assert.equal(health.handoff, false);
    const response = await post('/api/runs', { goal: COFFEE_GOAL });
    const { runId } = await response.json();
    await Promise.race([ready, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('Five calls did not overlap')), 1500); timer.unref(); })]);
    assert.equal(limiter.active, 5);
    assert.equal((await post('/api/settings', { concurrency: 1, mode: 'handoff' })).status, 409);
    const snapshot = await (await request('/api/runs/' + runId)).json();
    assert.equal(snapshot.events.filter(e => e.type === 'agent-start').length, 5);
    assert.equal(snapshot.events.filter(e => e.type === 'agent-result').length, 0);
    release();
    const stream = await (await request('/api/runs/' + runId + '/events')).text();
    assert.match(stream, /"type":"done"/);
    assert.equal(limiter.active, 0);
    assert.equal((await post('/api/settings', { concurrency: 1, mode: 'handoff' })).status, 200);
    assert.equal(limiter.max, 1);
  } finally { release(); server.close(); }
});
