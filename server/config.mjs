import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

export const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Переменные окружения процесса имеют приоритет над .env.
export function loadEnv(envPath = resolve(rootDir, '.env')) {
  if (!existsSync(envPath)) return;
  const contents = readFileSync(envPath, 'utf8');
  for (const line of contents.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || match[1].startsWith('#') || Object.hasOwn(process.env, match[1])) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[match[1]] = value;
  }
}

function envInt(env, name, fallback, min = 0) {
  const value = Number.parseInt(env[name] ?? '', 10);
  return Number.isFinite(value) && value >= min ? value : fallback;
}

function envBool(env, name, fallback) {
  const value = (env[name] ?? '').trim().toLowerCase();
  if (!value) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value);
}

// Все настройки выполнения. Значения можно переопределить в .env (см. .env.example).
export function readConfig(env = process.env) {
  const baseUrl = (env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const apiKey = (env.OPENAI_API_KEY || '').trim();
  const temperature = Number(env.LLM_TEMPERATURE);
  return {
    port: Number(env.PORT || 8787),
    // Разрешить страницы офиса, открытые с адресов локальной сети (npm run dev:lan). По умолчанию — только этот компьютер.
    allowLan: envBool(env, 'OFFICE_ALLOW_LAN', false),
    // Задачи и их результаты (data/runs/*.json). Папка в .gitignore.
    dataDir: env.DATA_DIR || resolve(rootDir, 'data'),
    model: env.OPENAI_MODEL || 'gpt-4.1-mini',
    baseUrl,
    apiKey: apiKey === 'replace_with_your_api_key' ? '' : apiKey,
    isLocalUrl: /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(`${baseUrl}/`),
    provider: (env.LLM_PROVIDER || (baseUrl.includes(':11434') ? 'ollama' : 'openai')).toLowerCase(),
    ollamaUrl: baseUrl.replace(/\/v1$/, ''),
    concurrency: envInt(env, 'LLM_CONCURRENCY', 1, 1),
    timeoutMs: envInt(env, 'LLM_TIMEOUT_MS', 240_000, 5_000),
    queueTimeoutMs: envInt(env, 'LLM_QUEUE_TIMEOUT_MS', 900_000, 5_000),
    routerMode: (env.CEO_ROUTER_MODE || 'auto').toLowerCase(), // auto | rules | llm
    routerTimeoutMs: envInt(env, 'CEO_ROUTER_TIMEOUT_MS', 60_000, 5_000),
    routerMaxTokens: envInt(env, 'CEO_ROUTER_MAX_TOKENS', 120, 20),
    agentMaxTokens: envInt(env, 'AGENT_MAX_TOKENS', 700, 50),
    // Лимит для заданий, где пользователь просит ответить коротко.
    agentShortMaxTokens: envInt(env, 'AGENT_SHORT_MAX_TOKENS', 220, 50),
    summaryMaxTokens: envInt(env, 'CEO_SUMMARY_MAX_TOKENS', 600, 50),
    // auto: сводка моделью только для ролевых заданий; при адресных заданиях итог собирается из ответов без пересказа.
    ceoSummary: ['', 'auto'].includes((env.CEO_SUMMARY ?? '').trim().toLowerCase()) ? 'auto' : envBool(env, 'CEO_SUMMARY', true),
    // Передача результата между зависимыми сотрудниками (research → product → creator/sales → finance).
    // auto: только для ролевых заданий и при LLM_CONCURRENCY=1 (см. handoffEnabled в office.mjs); true — всегда; false — никогда.
    handoff: ['', 'auto'].includes((env.HANDOFF ?? '').trim().toLowerCase()) ? 'auto' : envBool(env, 'HANDOFF', false),
    // Короткий раунд реплик коллегам после работы. По умолчанию выключен: +1 вызов модели на сотрудника.
    crossTalk: envBool(env, 'CROSS_TALK', false),
    crossTalkMaxTokens: envInt(env, 'CROSS_TALK_MAX_TOKENS', 80, 20),
    // Экспериментально: после итога (и обсуждения) — одно замечание и максимум одно исправление ответа сотрудника.
    // До 3 вызовов модели: выбор замечания, ответ автора, новая сводка (только если сводку писала модель).
    revision: envBool(env, 'REVISION', false),
    // Вся дополнительная стадия: по истечении она прерывается, готовый отчёт остаётся.
    revisionTimeoutMs: envInt(env, 'REVISION_TIMEOUT_MS', 300_000, 5_000),
    // Лимит ответа проверяющего (JSON с замечанием). Ответ автора ограничен лимитом его задания, сводка — CEO_SUMMARY_MAX_TOKENS.
    revisionPickMaxTokens: envInt(env, 'REVISION_PICK_MAX_TOKENS', 250, 50),
    maxAgents: Math.min(envInt(env, 'MAX_AGENTS', 5, 1), 5),
    ollamaThink: envBool(env, 'OLLAMA_THINK', false),
    ollamaNumCtx: envInt(env, 'OLLAMA_NUM_CTX', 4096, 512),
    ollamaKeepAlive: env.OLLAMA_KEEP_ALIVE || '30m',
    temperature: env.LLM_TEMPERATURE !== undefined && env.LLM_TEMPERATURE !== '' && Number.isFinite(temperature) ? temperature : 0.35
  };
}
