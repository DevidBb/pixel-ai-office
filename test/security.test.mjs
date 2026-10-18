import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readConfig } from '../server/config.mjs';
import { createApp } from '../server/app.mjs';
import { Limiter } from '../server/llm.mjs';
import { RunStore } from '../server/runs.mjs';

const env = { OPENAI_BASE_URL: 'http://127.0.0.1:11434/v1', OPENAI_MODEL: 'mock' };

async function withServer(config, fn) {
  const calls = [];
  const limiter = new Limiter(1);
  const callModel = async (messages, opts) => { calls.push(opts.label); opts.onStart?.(); return { text: 'ok' }; };
  const runs = new RunStore();
  const server = createApp({ config, callModel, limiter, runs });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { await fn(server.address().port, { calls, runs }); }
  finally { server.closeAllConnections(); server.close(); }
}

// fetch() не даёт подменить Host и Origin, поэтому — сырой http.request, как это сделал бы браузер.
function request(port, { method = 'POST', path = '/api/runs', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers }, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

const goal = JSON.stringify({ goal: 'Luma 4 — слоган' });
const json = { 'content-type': 'application/json' };

test('чужой сайт не может запустить задачу простым POST text/plain (CSRF)', async () => {
  await withServer(readConfig(env), async (port, { calls, runs }) => {
    const response = await request(port, { headers: { origin: 'https://evil.example', 'content-type': 'text/plain' }, body: goal });
    assert.equal(response.status, 403);
    assert.match(response.body.error, /чужого сайта/);
    assert.equal(runs.list().length, 0);
    assert.equal(calls.length, 0, 'модель не вызывалась');
  });
});

test('чужой сайт не может остановить или удалить задачу', async () => {
  await withServer(readConfig(env), async (port, { runs }) => {
    const run = runs.create('x');
    for (const [method, path] of [['POST', `/api/runs/${run.id}/cancel`], ['DELETE', `/api/runs/${run.id}`], ['POST', '/api/execute']]) {
      const response = await request(port, { method, path, headers: { origin: 'http://attacker.test:5173' } });
      assert.equal(response.status, 403, `${method} ${path}`);
    }
    assert.equal(run.status, 'running');
  });
});

test('POST без JSON отклоняется даже без Origin', async () => {
  await withServer(readConfig(env), async port => {
    const response = await request(port, { headers: { 'content-type': 'text/plain' }, body: goal });
    assert.equal(response.status, 415);
  });
});

test('DNS rebinding: запрос с чужим Host отклоняется, даже GET', async () => {
  await withServer(readConfig(env), async port => {
    for (const method of ['GET', 'POST']) {
      const response = await request(port, { method, path: method === 'GET' ? '/api/runs' : '/api/runs', headers: { host: `rebind.attacker.test:${port}`, ...json }, body: method === 'POST' ? goal : undefined });
      assert.equal(response.status, 421, method);
    }
  });
});

test('страница офиса работает: localhost, 127.0.0.1 и запросы без Origin', async () => {
  await withServer(readConfig(env), async (port, { runs }) => {
    for (const origin of ['http://localhost:5173', 'http://127.0.0.1:5173', undefined]) {
      const response = await request(port, { headers: { ...json, ...(origin ? { origin } : {}) }, body: goal });
      assert.equal(response.status, 202, String(origin));
    }
    assert.equal(runs.list().length, 3);
    const run = runs.list()[0];
    assert.equal((await request(port, { path: `/api/runs/${run.id}/cancel`, headers: { origin: 'http://localhost:5173' } })).status, 200, 'отмена без тела');
    assert.equal((await request(port, { method: 'GET', path: '/api/health', headers: { origin: 'https://evil.example' } })).status, 200, 'GET читать можно: ответ чужому сайту браузер не отдаст без CORS');
  });
});

test('адрес локальной сети: только при OFFICE_ALLOW_LAN=true', async () => {
  const lanOrigin = { ...json, origin: 'http://192.168.1.20:5173' };
  await withServer(readConfig(env), async port => {
    assert.equal((await request(port, { headers: lanOrigin, body: goal })).status, 403);
  });
  await withServer(readConfig({ ...env, OFFICE_ALLOW_LAN: 'true' }), async port => {
    for (const origin of ['http://192.168.1.20:5173', 'http://10.0.0.5:5173', 'http://172.20.1.2:5173', 'http://office.local:5173']) {
      assert.equal((await request(port, { headers: { ...json, origin }, body: goal })).status, 202, origin);
    }
    // Даже в режиме сети чужие публичные сайты не проходят.
    for (const origin of ['https://evil.example', 'http://172.32.0.1:5173', 'http://8.8.8.8']) {
      assert.equal((await request(port, { headers: { ...json, origin }, body: goal })).status, 403, origin);
    }
  });
});

test('по умолчанию Vite слушает только 127.0.0.1', async () => {
  const { readFileSync } = await import('node:fs');
  const viteConfig = readFileSync(new URL('../vite.config.ts', import.meta.url), 'utf8');
  assert.match(viteConfig, /process\.env\.OFFICE_HOST \|\| '127\.0\.0\.1'/);
  const scripts = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).scripts;
  for (const name of ['dev', 'start', 'dev:web']) assert.ok(!scripts[name].includes('0.0.0.0'), name);
  assert.match(scripts['dev:lan'], /OFFICE_ALLOW_LAN=true/);
});
