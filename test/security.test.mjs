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
      res.on('end', () => {
        let body = data || null;
        try { body = data ? JSON.parse(data) : null; } catch { /* SSE или текст — оставляем строкой */ }
        resolve({ status: res.statusCode, body });
      });
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

// Ревью Codex (PR #6, P1): GET /api/health/model вызывал модель и был доступен чужому сайту через <img src>.
test('GET /api/health/model больше не вызывает модель (405), проверка — только POST', async () => {
  await withServer(readConfig(env), async (port, { calls }) => {
    // Так выглядит запрос от <img src="http://127.0.0.1:8787/api/health/model"> на чужой странице.
    const img = await request(port, { method: 'GET', path: '/api/health/model', headers: { 'sec-fetch-site': 'cross-site', 'sec-fetch-dest': 'image' } });
    assert.equal(img.status, 403);
    // Старый браузер без Fetch Metadata и без Origin — всё равно не вызывает модель.
    const legacy = await request(port, { method: 'GET', path: '/api/health/model' });
    assert.equal(legacy.status, 405);
    assert.match(legacy.body.error, /используй POST/);
    assert.equal(calls.length, 0, 'модель не вызывалась');
    // Свой вызов (curl или страница офиса) работает.
    const own = await request(port, { path: '/api/health/model', headers: { origin: 'http://localhost:5173' } });
    assert.equal(own.status, 200);
    assert.equal(own.body.ok, true);
    assert.deepEqual(calls, ['health-check']);
    // POST с чужого сайта — 403 без вызова модели.
    assert.equal((await request(port, { path: '/api/health/model', headers: { origin: 'https://evil.example' } })).status, 403);
    assert.equal(calls.length, 1);
  });
});

test('Sec-Fetch-Site: cross-site отклоняется для любых маршрутов, same-origin и none проходят', async () => {
  await withServer(readConfig(env), async (port, { runs }) => {
    const run = runs.create('x');
    for (const path of ['/api/health', '/api/runs', `/api/runs/${run.id}`, `/api/runs/${run.id}/events`]) {
      assert.equal((await request(port, { method: 'GET', path, headers: { 'sec-fetch-site': 'cross-site' } })).status, 403, path);
    }
    assert.equal((await request(port, { headers: { ...json, 'sec-fetch-site': 'cross-site' }, body: goal })).status, 403);
    for (const site of ['same-origin', 'same-site', 'none']) {
      assert.equal((await request(port, { method: 'GET', path: '/api/health', headers: { 'sec-fetch-site': site } })).status, 200, site);
    }
  });
});

test('ни один GET-маршрут не вызывает модель', async () => {
  await withServer(readConfig(env), async (port, { calls, runs }) => {
    const run = runs.create('x');
    runs.emit(run, 'done', {});
    for (const path of ['/api/health', '/api/health/model', '/api/runs', `/api/runs/${run.id}`, `/api/runs/${run.id}/events`, '/api/execute', '/api/unknown']) {
      await request(port, { method: 'GET', path });
    }
    assert.deepEqual(calls, []);
  });
});
