// Замер скорости локальной модели Ollama с теми же параметрами, что использует server.mjs.
// Запуск: node scripts/bench-model.mjs [--max-tokens 200] [--runs 2] [--concurrency 1,2]
// Читает OPENAI_MODEL / OPENAI_BASE_URL / OLLAMA_* из .env (ключ API не нужен и не выводится).
import { loadEnv } from '../server/config.mjs';
import { freemem, totalmem, loadavg } from 'node:os';

loadEnv();

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const MODEL = process.env.OPENAI_MODEL || 'qwen3:1.7b';
const OLLAMA_URL = (process.env.OPENAI_BASE_URL || 'http://127.0.0.1:11434/v1').replace(/\/+$/, '').replace(/\/v1$/, '');
const NUM_CTX = Number(process.env.OLLAMA_NUM_CTX || 4096);
const THINK = ['1', 'true', 'yes', 'on'].includes(String(process.env.OLLAMA_THINK || 'false').toLowerCase());
const MAX_TOKENS = Number(arg('max-tokens', 200));
const RUNS = Number(arg('runs', 2));
const CONCURRENCY = String(arg('concurrency', '1')).split(',').map(Number).filter(n => n > 0);

const PROMPT = [
  { role: 'system', content: 'Ты сотрудник Pixel AI Office — Luma 4, Креатор. Отвечай на русском, коротко. Пиши только свою часть.' },
  { role: 'user', content: 'Контекст: маленькая кофейня возле университета.\nТВОЁ ЗАДАНИЕ: слоган.\nДай готовый результат коротко.' }
];

async function once() {
  const startedAt = Date.now();
  const response = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: MODEL, messages: PROMPT, stream: false, think: THINK, keep_alive: process.env.OLLAMA_KEEP_ALIVE || '30m',
      options: { temperature: 0.35, num_predict: MAX_TOKENS, num_ctx: NUM_CTX }
    })
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data?.error || `HTTP ${response.status}`);
  const ms = value => Math.round((value || 0) / 1e6);
  return {
    wallMs: Date.now() - startedAt,
    loadMs: ms(data.load_duration),
    promptTokens: data.prompt_eval_count,
    promptMs: ms(data.prompt_eval_duration),
    outputTokens: data.eval_count,
    genMs: ms(data.eval_duration),
    tokPerSec: data.eval_count && data.eval_duration ? +(data.eval_count / (data.eval_duration / 1e9)).toFixed(1) : undefined,
    doneReason: data.done_reason
  };
}

console.log(`Модель: ${MODEL} · ${OLLAMA_URL} · num_ctx=${NUM_CTX} · think=${THINK} · max_tokens=${MAX_TOKENS}`);
console.log(`RAM свободно: ${(freemem() / 2 ** 30).toFixed(1)} из ${(totalmem() / 2 ** 30).toFixed(1)} GiB · load avg: ${loadavg().map(v => v.toFixed(2)).join(' ')}`);
for (const concurrency of CONCURRENCY) {
  for (let run = 1; run <= RUNS; run++) {
    const startedAt = Date.now();
    const results = await Promise.all(Array.from({ length: concurrency }, () => once()));
    const batchMs = Date.now() - startedAt;
    console.log(`\nconcurrency=${concurrency} · прогон ${run} · вся партия ${batchMs} мс`);
    for (const r of results) console.log('  ', JSON.stringify(r));
  }
}
