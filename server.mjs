import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const rootDir = dirname(fileURLToPath(import.meta.url));

function loadEnv() {
  const envPath = resolve(rootDir, '.env');
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
loadEnv();

function envInt(name, fallback, min = 0) {
  const value = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(value) && value >= min ? value : fallback;
}

function envBool(name, fallback) {
  const value = (process.env[name] ?? '').trim().toLowerCase();
  if (!value) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value);
}

const PORT = Number(process.env.PORT || 8787);
const MODEL = process.env.OPENAI_MODEL || 'gpt-4.1-mini';
const BASE_URL = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
const API_KEY = (process.env.OPENAI_API_KEY || '').trim();
const IS_LOCAL_URL = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(`${BASE_URL}/`);

// Настройки выполнения. Все значения можно переопределить в .env (см. .env.example).
const LLM_PROVIDER = (process.env.LLM_PROVIDER || (BASE_URL.includes(':11434') ? 'ollama' : 'openai')).toLowerCase();
const OLLAMA_URL = BASE_URL.replace(/\/v1$/, '');
const LLM_CONCURRENCY = envInt('LLM_CONCURRENCY', 1, 1);
const LLM_TIMEOUT_MS = envInt('LLM_TIMEOUT_MS', 240_000, 5_000);
const LLM_QUEUE_TIMEOUT_MS = envInt('LLM_QUEUE_TIMEOUT_MS', 900_000, 5_000);
const ROUTER_MODE = (process.env.CEO_ROUTER_MODE || 'auto').toLowerCase(); // auto | rules | llm
const ROUTER_TIMEOUT_MS = envInt('CEO_ROUTER_TIMEOUT_MS', 60_000, 5_000);
const ROUTER_MAX_TOKENS = envInt('CEO_ROUTER_MAX_TOKENS', 120, 20);
const AGENT_MAX_TOKENS = envInt('AGENT_MAX_TOKENS', 700, 50);
const SUMMARY_MAX_TOKENS = envInt('CEO_SUMMARY_MAX_TOKENS', 600, 50);
const CEO_SUMMARY = envBool('CEO_SUMMARY', true);
const MAX_AGENTS = Math.min(envInt('MAX_AGENTS', 5, 1), 5);
const OLLAMA_THINK = envBool('OLLAMA_THINK', false);
const OLLAMA_NUM_CTX = envInt('OLLAMA_NUM_CTX', 4096, 512);
const OLLAMA_KEEP_ALIVE = process.env.OLLAMA_KEEP_ALIVE || '30m';
const TEMPERATURE = Number.isFinite(Number(process.env.LLM_TEMPERATURE)) && process.env.LLM_TEMPERATURE !== undefined && process.env.LLM_TEMPERATURE !== ''
  ? Number(process.env.LLM_TEMPERATURE)
  : 0.35;

const AGENTS = [
  { id: 'research', name: 'Luma 2', role: 'Исследователь рынка', focus: 'Проверяй спрос, сегменты клиентов, конкурентов и источники. Отделяй факты от гипотез.' },
  { id: 'product', name: 'Luma 3', role: 'Продуктолог', focus: 'Создавай конкретное предложение, состав услуги/продукта, цену-гипотезу и критерии результата.' },
  { id: 'creator', name: 'Luma 4', role: 'Креатор', focus: 'Создавай полезные демонстрации, тексты, сценарии или другие реальные материалы для проверки идеи.' },
  { id: 'sales', name: 'Luma 5', role: 'Менеджер продаж', focus: 'Предлагай честную стратегию привлечения клиентов, персональные сообщения и следующие шаги. Ничего не отправляй автоматически.' },
  { id: 'finance', name: 'Luma 6', role: 'Финансовый аналитик', focus: 'Рассчитывай выручку, затраты, маржу и риски с явными допущениями. Не выдавай прогноз за факт.' }
];
const CEO = { id: 'ceo', name: 'Luma 1', role: 'CEO · Руководитель' };

// Ключевые слова для быстрой маршрутизации без вызова модели (корни слов, нижний регистр).
const ROUTING_KEYWORDS = {
  research: ['рынок', 'рынк', 'конкурент', 'спрос', 'аудитори', 'сегмент', 'исследова', 'ниш', 'тренд', 'целев', 'опрос', 'market', 'competitor'],
  product: ['продукт', 'оффер', 'услуг', 'mvp', 'функци', 'тариф', 'упаков', 'ценност', 'фич', 'прототип', 'требовани', 'product'],
  creator: ['текст', 'пост', 'сценари', 'стать', 'слоган', 'контент', 'креатив', 'назван', 'лендинг', 'описани', 'видео', 'стих', 'истори', 'напиши', 'сочини', 'придумай'],
  sales: ['продаж', 'продат', 'клиент', 'письм', 'сообщени', 'холодн', 'переговор', 'воронк', 'лид', 'скрипт', 'привлеч', 'рассылк', 'sales'],
  finance: ['выручк', 'затрат', 'марж', 'бюджет', 'расход', 'окупаем', 'прибыл', 'юнит', 'финанс', 'себестоимост', 'рассчита', 'посчита', 'доход', 'деньг', 'стоимост']
};
const COMPLEX_MARKERS = ['бизнес', 'стартап', 'запуст', 'запуск', 'с нуля', 'комплексн', 'полный план', 'стратеги', 'всей команд', 'все специалист'];

let llmCallSeq = 0;

function diag(message, extra) {
  const time = new Date().toISOString().slice(11, 23);
  console.log(`[${time}] ${message}${extra ? ' ' + JSON.stringify(extra) : ''}`);
}

function sendJson(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
}

function readBody(req, maxBytes = 100_000) {
  return new Promise((resolveBody, reject) => {
    let data = '';
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error('Слишком большой запрос. Сократи описание задачи.'));
        req.destroy();
        return;
      }
      data += chunk.toString('utf8');
    });
    req.on('end', () => {
      try { resolveBody(JSON.parse(data || '{}')); }
      catch { reject(new Error('Не удалось прочитать JSON-запрос.')); }
    });
    req.on('error', reject);
  });
}

function emit(res, type, payload = {}) {
  if (res.destroyed || res.writableEnded) return;
  res.write(`data: ${JSON.stringify({ type, ...payload })}\n\n`);
}

// Глобальный ограничитель одновременных запросов к модели (общий для всех задач сервера).
class Limiter {
  constructor(max) {
    this.max = max;
    this.active = 0;
    this.queue = [];
  }

  acquire(signal, timeoutMs) {
    if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('aborted'));
    if (this.active < this.max) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise((resolveSlot, reject) => {
      const entry = { grant: null };
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        const index = this.queue.indexOf(entry);
        if (index >= 0) this.queue.splice(index, 1);
      };
      const onAbort = () => { cleanup(); reject(signal.reason ?? new Error('aborted')); };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Очередь к модели не освободилась за ${Math.round(timeoutMs / 1000)} с.`));
      }, timeoutMs);
      entry.grant = () => { cleanup(); this.active++; resolveSlot(); };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.queue.push(entry);
    });
  }

  release() {
    this.active = Math.max(0, this.active - 1);
    const next = this.queue[0];
    if (next && this.active < this.max) next.grant();
  }

  get waiting() { return this.queue.length; }
}

const limiter = new Limiter(LLM_CONCURRENCY);

function stripThinking(text) {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/^\s*<think>[\s\S]*$/i, '').trim();
}

async function requestOllama(messages, { json, maxTokens, signal }) {
  const body = {
    model: MODEL,
    messages,
    stream: false,
    think: OLLAMA_THINK,
    keep_alive: OLLAMA_KEEP_ALIVE,
    options: { temperature: TEMPERATURE, num_predict: maxTokens, num_ctx: OLLAMA_NUM_CTX }
  };
  if (json) body.format = 'json';
  const response = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal
  });
  const responseText = await response.text();
  let data;
  try { data = JSON.parse(responseText); }
  catch { data = null; }
  if (!response.ok) {
    const detail = data?.error || responseText.slice(0, 400) || `HTTP ${response.status}`;
    throw new Error(`Ошибка Ollama (${response.status}): ${detail}`);
  }
  return {
    content: data?.message?.content,
    stats: {
      promptTokens: data?.prompt_eval_count,
      outputTokens: data?.eval_count,
      loadMs: Math.round((data?.load_duration || 0) / 1e6),
      promptMs: Math.round((data?.prompt_eval_duration || 0) / 1e6),
      genMs: Math.round((data?.eval_duration || 0) / 1e6),
      doneReason: data?.done_reason
    }
  };
}

async function requestOpenAI(messages, { json, maxTokens, signal }) {
  const headers = { 'content-type': 'application/json' };
  if (API_KEY && API_KEY !== 'replace_with_your_api_key') headers.authorization = `Bearer ${API_KEY}`;
  const body = { model: MODEL, messages, temperature: TEMPERATURE, max_completion_tokens: maxTokens };
  if (json) body.response_format = { type: 'json_object' };
  const response = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST', headers, body: JSON.stringify(body), signal
  });
  const responseText = await response.text();
  let data;
  try { data = JSON.parse(responseText); }
  catch { data = null; }
  if (!response.ok) {
    const detail = data?.error?.message || responseText.slice(0, 400) || `HTTP ${response.status}`;
    throw new Error(`Ошибка API (${response.status}): ${detail}`);
  }
  return {
    content: data?.choices?.[0]?.message?.content,
    stats: {
      promptTokens: data?.usage?.prompt_tokens,
      outputTokens: data?.usage?.completion_tokens,
      doneReason: data?.choices?.[0]?.finish_reason
    }
  };
}

/**
 * Один вызов модели: ждёт свободный слот в очереди, ограничен тайм-аутом
 * и отменяется, если пользователь закрыл соединение (signal).
 */
async function callModel(messages, { json = false, maxTokens = AGENT_MAX_TOKENS, timeoutMs = LLM_TIMEOUT_MS, signal, label = 'llm', onStart } = {}) {
  const id = ++llmCallSeq;
  const queuedAt = Date.now();
  if (limiter.active >= limiter.max) diag(`[llm#${id}] ${label}: в очереди`, { waiting: limiter.waiting + 1 });
  await limiter.acquire(signal, LLM_QUEUE_TIMEOUT_MS);
  const startedAt = Date.now();
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  diag(`[llm#${id}] ${label}: старт`, { provider: LLM_PROVIDER, maxTokens, timeoutMs, queueMs: startedAt - queuedAt });
  try {
    onStart?.();
    const request = LLM_PROVIDER === 'ollama' ? requestOllama : requestOpenAI;
    const { content, stats } = await request(messages, { json, maxTokens, signal: combined });
    const text = typeof content === 'string' ? stripThinking(content) : '';
    const totalMs = Date.now() - startedAt;
    const tokPerSec = stats.genMs && stats.outputTokens ? +(stats.outputTokens / (stats.genMs / 1000)).toFixed(1) : undefined;
    diag(`[llm#${id}] ${label}: готово за ${totalMs} мс`, { ...stats, tokPerSec, chars: text.length });
    if (!text) throw new Error('Модель вернула пустой ответ. Проверь доступность выбранной модели.');
    return text;
  } catch (error) {
    const totalMs = Date.now() - startedAt;
    if (timeoutSignal.aborted && !signal?.aborted) {
      diag(`[llm#${id}] ${label}: ТАЙМ-АУТ через ${totalMs} мс — запрос отменён`);
      throw new Error(`Модель не ответила за ${Math.round(timeoutMs / 1000)} с (LLM_TIMEOUT_MS). Запрос отменён.`);
    }
    if (signal?.aborted) {
      diag(`[llm#${id}] ${label}: отменён клиентом через ${totalMs} мс`);
      throw new Error('Запрос отменён: клиент закрыл соединение.');
    }
    diag(`[llm#${id}] ${label}: ошибка через ${totalMs} мс`, { error: error?.message });
    if (error?.message?.startsWith('Ошибка')) throw error;
    throw new Error(`Не удалось подключиться к API модели: ${error?.message || 'ошибка соединения'}`);
  } finally {
    limiter.release();
  }
}

function extractJson(text) {
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const first = cleaned.indexOf('{');
  const last = cleaned.lastIndexOf('}');
  if (first < 0 || last <= first) throw new Error('CEO не вернул ответ в корректном JSON-формате.');
  return JSON.parse(cleaned.slice(first, last + 1));
}

function scoreAgents(goal) {
  const text = goal.toLowerCase();
  const scores = AGENTS.map(agent => ({
    id: agent.id,
    score: ROUTING_KEYWORDS[agent.id].reduce((sum, word) => sum + (text.includes(word) ? 1 : 0), 0)
  }));
  const complex = COMPLEX_MARKERS.some(marker => text.includes(marker));
  return { scores: scores.sort((a, b) => b.score - a.score), complex };
}

// Быстрое решение без модели. Возвращает null, если в тексте нет явных признаков профиля.
function routeByRules(goal) {
  const { scores, complex } = scoreAgents(goal);
  if (complex) return { agentIds: AGENTS.map(a => a.id).slice(0, MAX_AGENTS), reason: 'комплексная задача — подключена команда' };
  const matched = scores.filter(s => s.score > 0 && s.score === scores[0].score).map(s => s.id).slice(0, MAX_AGENTS);
  if (matched.length === 1) return { agentIds: matched, reason: 'простая задача — один профильный специалист' };
  if (matched.length) return { agentIds: matched, reason: 'задача затрагивает несколько профилей' };
  return null;
}

function fallbackRoute(goal) {
  return routeByRules(goal) || { agentIds: ['product'], reason: 'профиль не определён — задача передана продуктологу' };
}

async function routeByModel(goal, signal) {
  const catalog = AGENTS.map(a => `${a.id}: ${a.role}`).join('\n');
  const raw = await callModel([
    { role: 'system', content: 'Ты CEO-диспетчер. Быстро выбираешь исполнителей. Отвечаешь только JSON.' },
    { role: 'user', content: `Задача пользователя:\n${goal}\n\nСотрудники:\n${catalog}\n\nВыбери МИНИМУМ нужных сотрудников. Простая задача (текст, расчёт, вопрос) — ровно один. Всю команду — только для комплексных задач вроде запуска бизнеса. Ответ: {"agents":["id"],"reason":"кратко почему"}` }
  ], { json: true, maxTokens: ROUTER_MAX_TOKENS, timeoutMs: ROUTER_TIMEOUT_MS, signal, label: 'ceo-router' });
  const parsed = extractJson(raw);
  const allowed = new Set(AGENTS.map(a => a.id));
  const agentIds = [...new Set((Array.isArray(parsed.agents) ? parsed.agents : []).map(String).filter(id => allowed.has(id)))].slice(0, MAX_AGENTS);
  if (!agentIds.length) throw new Error('CEO не выбрал ни одного известного сотрудника.');
  return { agentIds, reason: String(parsed.reason || 'выбор CEO').slice(0, 300) };
}

async function routeGoal(goal, signal) {
  if (ROUTER_MODE !== 'llm') {
    const quick = routeByRules(goal);
    if (quick) return { ...quick, method: 'rules' };
    if (ROUTER_MODE === 'rules') return { ...fallbackRoute(goal), method: 'rules' };
  }
  try {
    return { ...(await routeByModel(goal, signal)), method: 'llm' };
  } catch (error) {
    if (signal?.aborted) throw error;
    diag('ceo-router: модель не дала маршрут, используется резервный выбор', { error: error.message });
    return { ...fallbackRoute(goal), method: 'fallback' };
  }
}

function buildPlan(goal, route) {
  const single = route.agentIds.length === 1;
  return {
    summary: `CEO назначил: ${route.agentIds.map(id => AGENTS.find(a => a.id === id).role).join(', ')} — ${route.reason}.`,
    tasks: route.agentIds.map(agentId => {
      const agent = AGENTS.find(a => a.id === agentId);
      return {
        id: `task-${agentId}`,
        agentId,
        title: single ? `${agent.role}: выполнить задачу` : `${agent.role}: своя часть задачи`,
        objective: single
          ? goal
          : `Выполни часть цели, относящуюся к твоей роли (${agent.role}): ${goal}`
      };
    })
  };
}

function agentMessages(agent, goal, task, plan) {
  const team = plan.tasks.length > 1
    ? `\nПараллельно над целью работают: ${plan.tasks.filter(t => t.agentId !== agent.id).map(t => AGENTS.find(a => a.id === t.agentId).role).join(', ')}. Не делай их часть работы.`
    : '';
  return [
    { role: 'system', content: `Ты сотрудник Pixel AI Office — ${agent.role}. ${agent.focus} Отвечай на русском, конкретно и честно. Не выдумывай ссылки, клиентов, контакты, продажи и внешние действия. Если нужен веб-поиск, которого у тебя нет, прямо скажи об этом.` },
    { role: 'user', content: `ЦЕЛЬ ПОЛЬЗОВАТЕЛЯ:\n${goal}\n\nТВОЯ ЗАДАЧА:\n${task.objective}${team}\n\nДай готовый практический результат (не план намерений). Будь кратким: заголовки и короткие списки. Отмечай, что является фактом, а что — допущением.` }
  ];
}

async function runExecution(req, res, body) {
  const goal = String(body.goal || '').trim();
  if (!goal) return sendJson(res, 400, { error: 'Напиши цель или задачу для CEO.' });
  if (goal.length > 5000) return sendJson(res, 400, { error: 'Слишком длинная задача: максимум 5000 символов.' });
  if ((!API_KEY || API_KEY === 'replace_with_your_api_key') && !IS_LOCAL_URL) {
    return sendJson(res, 400, { error: 'Не настроен API-ключ. Скопируй .env.example в .env и укажи OPENAI_API_KEY. Ключ нужен серверу, не вставляй его в браузер.' });
  }

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no'
  });
  res.write(': Pixel AI Office stage 2\n\n');
  const runId = Math.random().toString(36).slice(2, 8);
  const runStarted = Date.now();
  const controller = new AbortController();
  const signal = controller.signal;
  let finished = false;
  // Комментарий-пинг держит SSE-соединение живым, пока модель долго считает на CPU.
  const heartbeat = setInterval(() => { if (!res.writableEnded) res.write(': ping\n\n'); }, 15_000);
  res.on('close', () => {
    clearInterval(heartbeat);
    if (!finished) {
      diag(`[run ${runId}] клиент закрыл соединение — отменяю запросы к модели`);
      controller.abort(new Error('client closed'));
    }
  });
  const cancelled = () => signal.aborted;
  const safeEmit = (type, payload) => { if (!cancelled()) emit(res, type, payload); };
  diag(`[run ${runId}] новая задача`, { chars: goal.length, concurrency: LLM_CONCURRENCY, router: ROUTER_MODE });

  try {
    safeEmit('log', { agentId: 'ceo', message: 'CEO принял цель и выбирает исполнителей.' });
    safeEmit('agent-status', { agentId: 'ceo', status: 'thinking', task: 'Распределяет задачу' });
    const route = await routeGoal(goal, signal);
    if (cancelled()) return;
    const plan = buildPlan(goal, route);
    diag(`[run ${runId}] маршрут`, { method: route.method, agents: route.agentIds, ms: Date.now() - runStarted });
    safeEmit('plan', {
      summary: plan.summary,
      subtasks: plan.tasks.map(t => ({ ...t, status: 'queued' }))
    });
    const how = route.method === 'rules' ? 'мгновенно, без вызова модели' : route.method === 'llm' ? 'с помощью модели' : 'по резервному правилу';
    safeEmit('log', { agentId: 'ceo', message: `CEO назначил ${plan.tasks.length === 1 ? 'одного специалиста' : `${plan.tasks.length} специалистов`} (${how}). Одновременных запросов к модели: ${LLM_CONCURRENCY}.` });
    safeEmit('agent-status', { agentId: 'ceo', status: 'working', task: 'Координирует команду' });
    for (const task of plan.tasks) {
      safeEmit('agent-status', { agentId: task.agentId, status: 'idle', task: 'В очереди к модели' });
    }

    // Сотрудники работают независимо; результат каждого отправляется сразу по готовности.
    // Фактическую параллельность ограничивает LLM_CONCURRENCY.
    let startedCount = 0;
    const outcomes = await Promise.all(plan.tasks.map(async task => {
      const agent = AGENTS.find(a => a.id === task.agentId);
      const agentStarted = { at: 0 };
      try {
        const result = await callModel(agentMessages(agent, goal, task, plan), {
          maxTokens: AGENT_MAX_TOKENS,
          signal,
          label: `${runId}/${agent.id}`,
          onStart: () => {
            agentStarted.at = Date.now();
            startedCount++;
            safeEmit('agent-start', { agentId: agent.id, subtaskId: task.id, title: task.title, index: startedCount, total: plan.tasks.length });
            safeEmit('agent-status', { agentId: agent.id, status: 'working', task: task.title });
            safeEmit('log', { agentId: agent.id, message: `Начал подзадачу ${startedCount}/${plan.tasks.length}: ${task.title}` });
          }
        });
        if (cancelled()) return null;
        const seconds = Math.round((Date.now() - agentStarted.at) / 1000);
        safeEmit('agent-result', { agentId: agent.id, subtaskId: task.id, result });
        safeEmit('agent-status', { agentId: agent.id, status: 'done', task: 'Подзадача готова' });
        safeEmit('log', { agentId: agent.id, message: `Результат готов за ${seconds} с.`, kind: 'success' });
        return { agentId: agent.id, role: agent.role, title: task.title, result };
      } catch (error) {
        if (cancelled()) return null;
        const message = error?.message || 'Неизвестная ошибка.';
        safeEmit('agent-error', { agentId: agent.id, subtaskId: task.id, message });
        safeEmit('agent-status', { agentId: agent.id, status: 'error', task: 'Ошибка выполнения' });
        safeEmit('log', { agentId: agent.id, message: `Не справился: ${message}`, kind: 'warning' });
        return null;
      }
    }));
    if (cancelled()) return;

    const results = outcomes.filter(Boolean);
    if (!results.length) throw new Error('Ни один специалист не смог выполнить задачу. Подробности — в журнале и в логах сервера.');

    let finalResult;
    if (results.length === 1) {
      finalResult = results[0].result;
      safeEmit('log', { agentId: 'ceo', message: 'Задача выполнена одним специалистом — итог передан без дополнительной сводки.' });
    } else if (CEO_SUMMARY) {
      safeEmit('review-start', { agentId: 'ceo', message: 'CEO сводит результаты команды.' });
      safeEmit('agent-status', { agentId: 'ceo', status: 'thinking', task: 'Проверяет результаты команды' });
      try {
        finalResult = await callModel([
          { role: 'system', content: 'Ты CEO и редактор итогового отчёта. Обобщай фактические результаты команды кратко. Не называй потенциальную выручку полученной прибылью, а планы — выполненными действиями.' },
          { role: 'user', content: `ЦЕЛЬ:\n${goal}\n\nРЕЗУЛЬТАТЫ СПЕЦИАЛИСТОВ:\n${results.map(r => `### ${r.role}\n${r.result}`).join('\n\n')}\n\nСоставь краткий итог на русском: (1) вывод, (2) что готово, (3) гипотезы и пробелы, (4) три следующих действия.` }
        ], { maxTokens: SUMMARY_MAX_TOKENS, signal, label: `${runId}/ceo-summary` });
      } catch (error) {
        if (cancelled()) return;
        safeEmit('log', { agentId: 'ceo', message: `Сводка CEO не получена (${error.message}). Показаны результаты специалистов.`, kind: 'warning' });
      }
    }
    if (cancelled()) return;
    finalResult ||= results.map(r => `### ${r.role}\n${r.result}`).join('\n\n');
    const failed = plan.tasks.length - results.length;
    safeEmit('final', { result: finalResult });
    safeEmit('agent-status', { agentId: 'ceo', status: 'done', task: 'Итоговый отчёт готов' });
    safeEmit('log', { agentId: 'ceo', message: failed ? `Готово, но ${failed} из ${plan.tasks.length} специалистов завершились с ошибкой.` : 'Итоговый отчёт готов. Все результаты сохранены в журнале этой страницы.', kind: failed ? 'warning' : 'success' });
    finished = true;
    diag(`[run ${runId}] завершено за ${Math.round((Date.now() - runStarted) / 1000)} с`, { ok: results.length, failed });
    safeEmit('done', {});
    res.end();
  } catch (error) {
    finished = true;
    if (!cancelled()) {
      const message = error?.message || 'Неизвестная ошибка выполнения.';
      diag(`[run ${runId}] ошибка`, { error: message });
      safeEmit('error', { message });
      safeEmit('agent-status', { agentId: 'ceo', status: 'error', task: 'Задача остановлена' });
      res.end();
    }
  } finally {
    clearInterval(heartbeat);
  }
}

async function checkModel() {
  const startedAt = Date.now();
  try {
    const text = await callModel([{ role: 'user', content: 'Ответь одним словом: готов' }], { maxTokens: 10, timeoutMs: Math.min(LLM_TIMEOUT_MS, 120_000), label: 'health-check' });
    return { ok: true, ms: Date.now() - startedAt, reply: text.slice(0, 80) };
  } catch (error) {
    return { ok: false, ms: Date.now() - startedAt, error: error.message };
  }
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/api/health') {
    const keyConfigured = (Boolean(API_KEY) && API_KEY !== 'replace_with_your_api_key') || IS_LOCAL_URL;
    return sendJson(res, 200, {
      ok: true, configured: keyConfigured, model: MODEL, provider: LLM_PROVIDER,
      concurrency: LLM_CONCURRENCY, activeCalls: limiter.active, queuedCalls: limiter.waiting,
      timeoutMs: LLM_TIMEOUT_MS, router: ROUTER_MODE
    });
  }
  if (req.method === 'GET' && req.url === '/api/health/model') {
    return sendJson(res, 200, { model: MODEL, provider: LLM_PROVIDER, think: OLLAMA_THINK, ...(await checkModel()) });
  }
  if (req.method === 'POST' && req.url === '/api/execute') {
    try {
      const body = await readBody(req);
      return await runExecution(req, res, body);
    } catch (error) {
      if (!res.headersSent) return sendJson(res, 400, { error: error.message || 'Не удалось прочитать запрос.' });
      if (!res.writableEnded) {
        emit(res, 'error', { message: error.message || 'Неизвестная ошибка.' });
        res.end();
      }
      return;
    }
  }
  if (req.url?.startsWith('/api/')) return sendJson(res, 404, { error: 'Неизвестный API-маршрут.' });
  sendJson(res, 404, { error: 'API доступен только по /api/*.' });
});

server.on('error', error => {
  if (error.code === 'EADDRINUSE') {
    console.error(`Порт ${PORT} уже занят — скорее всего, Pixel AI Office уже запущен. Открой http://localhost:5173/ или останови прежний процесс: fuser -k ${PORT}/tcp 5173/tcp`);
    process.exit(1);
  }
  throw error;
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Pixel AI Office API: http://127.0.0.1:${PORT}`);
  console.log(`Model: ${MODEL}; provider: ${LLM_PROVIDER}; API key: ${(API_KEY && API_KEY !== 'replace_with_your_api_key') ? 'configured' : 'not configured'}`);
  console.log(`LLM: concurrency=${LLM_CONCURRENCY}, timeout=${LLM_TIMEOUT_MS} ms, agentMaxTokens=${AGENT_MAX_TOKENS}, router=${ROUTER_MODE}${LLM_PROVIDER === 'ollama' ? `, think=${OLLAMA_THINK}, num_ctx=${OLLAMA_NUM_CTX}` : ''}`);
});
