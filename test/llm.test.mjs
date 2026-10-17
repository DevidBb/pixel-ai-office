import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readConfig } from '../server/config.mjs';
import { createModelClient, Limiter } from '../server/llm.mjs';

// Заглушка Ollama: либо отвечает сразу, либо «висит», пока клиент не оборвёт соединение.
async function startStub({ hang }) {
  const state = { requests: 0, closedByClient: 0 };
  const server = http.createServer((req, res) => {
    state.requests++;
    req.resume();
    if (hang) {
      res.on('close', () => { if (!res.writableEnded) state.closedByClient++; });
      return;
    }
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ message: { content: 'готов' }, eval_count: 1, eval_duration: 1e8, prompt_eval_count: 5, done_reason: 'stop' }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const config = { ...readConfig({ OPENAI_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`, OPENAI_MODEL: 'stub', LLM_PROVIDER: 'ollama' }), queueTimeoutMs: 150 };
  return { server, state, config, stop: () => { server.closeAllConnections(); server.close(); } };
}

const messages = [{ role: 'user', content: 'тест' }];

test('callModel: ответ Ollama возвращает текст и статистику', async () => {
  const stub = await startStub({ hang: false });
  try {
    const { callModel, limiter } = createModelClient(stub.config);
    const { text, stats } = await callModel(messages, { maxTokens: 10, label: 'ok' });
    assert.equal(text, 'готов');
    assert.equal(stats.maxTokens, 10);
    assert.equal(stats.doneReason, 'stop');
    assert.equal(limiter.active, 0);
  } finally { stub.stop(); }
});

test('callModel: тайм-аут обрывает запрос и освобождает слот', async () => {
  const stub = await startStub({ hang: true });
  try {
    const { callModel, limiter } = createModelClient(stub.config);
    const startedAt = Date.now();
    await assert.rejects(callModel(messages, { timeoutMs: 150, label: 'timeout' }), /не ответила за/);
    assert.ok(Date.now() - startedAt < 2_000);
    assert.equal(limiter.active, 0);
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(stub.state.closedByClient, 1, 'HTTP-запрос к модели должен быть оборван');
  } finally { stub.stop(); }
});

test('callModel: отмена клиентом обрывает запрос и снимает ожидающих из очереди', async () => {
  const stub = await startStub({ hang: true });
  try {
    const limiter = new Limiter(1);
    const { callModel } = createModelClient({ ...stub.config, queueTimeoutMs: 5_000 }, limiter);
    const controller = new AbortController();
    const first = callModel(messages, { signal: controller.signal, label: 'first' });
    const second = callModel(messages, { signal: controller.signal, label: 'queued' });
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(limiter.waiting, 1);
    controller.abort(new Error('client closed'));
    await assert.rejects(first, /отменён/);
    await assert.rejects(second, /client closed/);
    assert.equal(limiter.active, 0);
    assert.equal(limiter.waiting, 0);
    assert.equal(stub.state.requests, 1, 'запрос из очереди не должен уйти к модели');
  } finally { stub.stop(); }
});

test('callModel: ожидание в очереди ограничено LLM_QUEUE_TIMEOUT_MS', async () => {
  const stub = await startStub({ hang: true });
  try {
    const limiter = new Limiter(1);
    const { callModel } = createModelClient(stub.config, limiter);
    const first = callModel(messages, { timeoutMs: 1_000, label: 'busy' });
    await assert.rejects(callModel(messages, { label: 'waits' }), /Очередь к модели не освободилась/);
    await assert.rejects(first, /не ответила/);
    assert.equal(limiter.active, 0);
  } finally { stub.stop(); }
});
