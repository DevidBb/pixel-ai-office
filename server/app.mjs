import http from 'node:http';
import { diag } from './llm.mjs';
import { RunStore } from './runs.mjs';
import {
  AGENTS, routeByExplicit, routeByRules, fallbackRoute, routerMessages, buildPlan, agentMessages,
  foreignAttributions, attributionBlock, combinedResults, summaryMessages, agentLabel, needsModelSummary, excludedAgents,
  assertSomeoneAllowed, uncertainNote, handoffEnabled, handoffGraph, compactHandoffs, chatMessages, chatPartner, cleanChatReply,
  revisionPickMessages, validateRemark, revisionMessages, parseAuthorReply, validateRevision
} from './office.mjs';

const DELTA_INTERVAL_MS = 300;
const shortName = agentId => agentLabel(agentId).split(' · ')[0];

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
// 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, *.local
const LAN_HOST = /^(?:10\.\d+\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+|192\.168\.\d+\.\d+|[\w-]+\.local)$/i;

function hostnameOf(value) {
  try { return new URL(value.includes('://') ? value : `http://${value}`).hostname; } catch { return null; }
}

/**
 * Защита от чужих сайтов, открытых в том же браузере.
 * - Host должен быть localhost: иначе это DNS rebinding (чужой домен, указывающий на 127.0.0.1).
 * - Изменяющие запросы (POST/DELETE) с заголовком Origin принимаются только со страниц офиса.
 *   Браузер всегда шлёт Origin в кросс-сайтовых POST, а «простой» POST с text/plain проходит без CORS-проверки.
 * - Тело POST — только application/json: такой запрос с чужого сайта браузер сначала проверяет через CORS.
 */
function rejectUntrusted(req, config) {
  const host = hostnameOf(req.headers.host || '');
  if (!host || !LOCAL_HOSTS.has(host)) return [421, 'Запрос к API должен идти на localhost.'];
  // Fetch Metadata: браузер сам помечает запросы с чужих сайтов — даже GET без Origin
  // (<img src>, <script src>, переход по ссылке). Страница офиса через прокси Vite даёт same-origin.
  if (req.headers['sec-fetch-site'] === 'cross-site') return [403, 'Запрос с чужого сайта отклонён. Офис принимает задачи только со своей страницы.'];
  if (req.method === 'GET' || req.method === 'HEAD') return null;
  const origin = req.headers.origin;
  if (origin) {
    const originHost = hostnameOf(origin);
    const trusted = originHost && (LOCAL_HOSTS.has(originHost) || (config.allowLan && LAN_HOST.test(originHost)));
    if (!trusted) return [403, 'Запрос с чужого сайта отклонён. Офис принимает задачи только со своей страницы.'];
  }
  const length = Number(req.headers['content-length'] || 0);
  const type = String(req.headers['content-type'] || '').toLowerCase();
  if (req.method === 'POST' && (length > 0 || req.headers['transfer-encoding']) && !type.startsWith('application/json')) {
    return [415, 'Тело запроса должно быть JSON (content-type: application/json).'];
  }
  return null;
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

function extractJson(text) {
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const first = cleaned.indexOf('{');
  const last = cleaned.lastIndexOf('}');
  if (first < 0 || last <= first) throw new Error('CEO не вернул ответ в корректном JSON-формате.');
  return JSON.parse(cleaned.slice(first, last + 1));
}

function formatStats(stats) {
  if (!stats) return '';
  const parts = [];
  if (stats.outputTokens) parts.push(`${stats.outputTokens} ток.`);
  if (stats.tokPerSec) parts.push(`${stats.tokPerSec} ток/с`);
  if (stats.promptTokens) parts.push(`подсказка ${stats.promptTokens} ток. за ${Math.round((stats.promptMs || 0) / 100) / 10} с`);
  if (stats.queueMs >= 1000) parts.push(`ожидание очереди ${Math.round(stats.queueMs / 1000)} с`);
  if (stats.loadMs >= 1000) parts.push(`загрузка модели ${Math.round(stats.loadMs / 1000)} с`);
  return parts.length ? ` (${parts.join(', ')})` : '';
}

/** HTTP-сервер офиса. callModel(messages, opts) → { text, stats } передаётся снаружи, чтобы тесты могли подменить модель. */
export function createApp({ config, callModel, limiter, runs = new RunStore() }) {
  async function routeByModel(goal, signal) {
    const { text } = await callModel(routerMessages(goal), {
      json: true, maxTokens: config.routerMaxTokens, timeoutMs: config.routerTimeoutMs, signal, label: 'ceo-router'
    });
    const parsed = extractJson(text);
    // Исключения пользователя («не подключай Luma 2») сильнее выбора модели.
    const excluded = excludedAgents(goal);
    const allowed = new Set(AGENTS.map(a => a.id).filter(id => !excluded.includes(id)));
    const agentIds = [...new Set((Array.isArray(parsed.agents) ? parsed.agents : []).map(String).filter(id => allowed.has(id)))].slice(0, config.maxAgents);
    if (!agentIds.length) throw new Error('CEO не выбрал ни одного известного сотрудника.');
    return { agentIds, source: 'model', reason: String(parsed.reason || 'выбор CEO').slice(0, 300) };
  }

  async function routeGoal(goal, signal) {
    // Если исключены все, ни правила, ни модель, ни резервный выбор не должны никого назначать.
    assertSomeoneAllowed(excludedAgents(goal));
    // Явные указания пользователя действуют в любом режиме маршрутизации.
    const explicit = routeByExplicit(goal, config.maxAgents);
    if (explicit) return { ...explicit, method: 'rules' };
    if (config.routerMode !== 'llm') {
      const quick = routeByRules(goal, config.maxAgents);
      if (quick) return { ...quick, method: 'rules' };
      if (config.routerMode === 'rules') return { ...fallbackRoute(goal, config.maxAgents), method: 'rules' };
    }
    try {
      return { ...(await routeByModel(goal, signal)), method: 'llm' };
    } catch (error) {
      if (signal?.aborted) throw error;
      diag('ceo-router: модель не дала маршрут, используется резервный выбор', { error: error.message });
      return { ...fallbackRoute(goal, config.maxAgents), method: 'fallback' };
    }
  }

  function validateGoal(body) {
    const goal = String(body.goal || '').trim();
    if (!goal) return { error: 'Напиши цель или задачу для CEO.' };
    if (goal.length > 5000) return { error: 'Слишком длинная задача: максимум 5000 символов.' };
    if (!config.apiKey && !config.isLocalUrl) {
      return { error: 'Не настроен API-ключ. Скопируй .env.example в .env и укажи OPENAI_API_KEY. Ключ нужен серверу, не вставляй его в браузер.' };
    }
    return { goal };
  }

  /** Выполнение задачи. Не знает, куда идут события: в SSE-ответ (/api/execute) или в журнал задачи (/api/runs). */
  async function executeRun(goal, { emit: send, signal, runId }) {
    const runStarted = Date.now();
    const cancelled = () => signal.aborted;
    // Возвращает ответ получателя событий: журнал задачи сообщает, записаны ли итог и исправление на диск.
    const safeEmit = (type, payload) => (cancelled() ? undefined : send(type, payload));
    diag(`[run ${runId}] новая задача`, { chars: goal.length, concurrency: config.concurrency, router: config.routerMode });

    try {
      safeEmit('log', { agentId: 'ceo', message: 'CEO принял цель и выбирает исполнителей.' });
      safeEmit('agent-status', { agentId: 'ceo', status: 'thinking', task: 'Распределяет задачу' });
      const route = await routeGoal(goal, signal);
      if (cancelled()) return;
      const plan = buildPlan(goal, route, config);
      const doubtful = uncertainNote(goal, route.agentIds);
      if (doubtful) safeEmit('log', { agentId: 'ceo', message: doubtful.trim(), kind: 'warning' });
      diag(`[run ${runId}] маршрут`, { method: route.method, source: route.source, agents: route.agentIds, ms: Date.now() - runStarted });
      safeEmit('plan', {
        summary: plan.summary,
        subtasks: plan.tasks.map(t => ({ id: t.id, agentId: t.agentId, title: t.title, objective: t.objective, status: 'queued' }))
      });
      const how = route.method === 'rules' ? 'мгновенно, без вызова модели' : route.method === 'llm' ? 'с помощью модели' : 'по резервному правилу';
      const queueNote = plan.tasks.length > config.concurrency
        ? ` Модель отвечает максимум на ${config.concurrency} ${config.concurrency === 1 ? 'запрос' : 'запроса'} одновременно — остальные ждут в очереди.`
        : '';
      safeEmit('log', { agentId: 'ceo', message: `CEO назначил ${plan.tasks.length === 1 ? 'одного специалиста' : `${plan.tasks.length} специалистов`} (${how}): ${plan.tasks.map(t => agentLabel(t.agentId)).join(', ')}.${queueNote}` });
      safeEmit('agent-status', { agentId: 'ceo', status: 'working', task: 'Координирует команду' });
      // Передача результата: зависимый сотрудник ждёт результатов тех, на чьих данных строит работу.
      const handoff = handoffEnabled(plan, config.handoff, config.concurrency);
      const graph = handoff ? handoffGraph(plan) : {};
      const names = ids => ids.map(id => AGENTS.find(a => a.id === id).name).join(', ');
      for (const task of plan.tasks) {
        const sources = graph[task.agentId] || [];
        safeEmit('agent-status', { agentId: task.agentId, status: 'idle', task: sources.length ? `Задание получено, ждёт данные от ${names(sources)}` : 'Задание получено, ждёт очереди к модели' });
      }
      if (handoff && plan.tasks.some(t => graph[t.agentId].length)) {
        const chains = plan.tasks.filter(t => graph[t.agentId].length).map(t => `${names(graph[t.agentId])} → ${names([t.agentId])}`);
        safeEmit('log', { agentId: 'ceo', message: `CEO связал работу команды: ${chains.join('; ')}. Остальные начинают сразу.` });
      }

      // Независимые задания выдаются сразу; зависимые — как только готовы их источники.
      // Результат каждого отправляется по готовности. Фактическую параллельность генерации ограничивает LLM_CONCURRENCY.
      let startedCount = 0;
      const running = new Map();
      const runTask = task => {
        if (!running.has(task.agentId)) running.set(task.agentId, performTask(task));
        return running.get(task.agentId);
      };
      const performTask = async task => {
        const agent = AGENTS.find(a => a.id === task.agentId);
        const agentStarted = { at: 0 };
        const sources = graph[task.agentId] || [];
        // Граф без циклов (источник всегда выше по списку AGENTS), поэтому ожидание не зацикливается.
        const inputs = await Promise.all(sources.map(id => runTask(plan.tasks.find(t => t.agentId === id))));
        if (cancelled()) return null;
        const handoffs = compactHandoffs(inputs.filter(o => o?.result));
        const received = handoffs.map(h => h.agentId);
        const missing = sources.filter(id => !received.includes(id));
        if (received.length) {
          safeEmit('log', { agentId: agent.id, message: `${agent.name} получил данные от ${names(received)}.` });
        }
        if (missing.length) {
          safeEmit('log', { agentId: agent.id, message: `Данных от ${names(missing)} нет — ${agent.name} работает без них.`, kind: 'warning' });
        }
        // Текст по мере написания: копим кусочки и отправляем не чаще раза в DELTA_INTERVAL_MS.
        let pending = '';
        let lastDeltaAt = 0;
        const flushDelta = () => {
          if (!pending) return;
          safeEmit('agent-delta', { agentId: agent.id, subtaskId: task.id, text: pending });
          pending = '';
          lastDeltaAt = Date.now();
        };
        try {
          const { text: result, stats } = await callModel(agentMessages(agent, task, plan, handoffs), {
            maxTokens: task.maxTokens,
            signal,
            label: `${runId}/${agent.id}`,
            onToken: piece => {
              pending += piece;
              if (Date.now() - lastDeltaAt >= DELTA_INTERVAL_MS) flushDelta();
            },
            onStart: () => {
              agentStarted.at = Date.now();
              startedCount++;
              safeEmit('agent-start', { agentId: agent.id, subtaskId: task.id, title: task.title, index: startedCount, total: plan.tasks.length });
              safeEmit('agent-status', { agentId: agent.id, status: 'working', task: task.title });
              safeEmit('log', { agentId: agent.id, message: `Начал подзадачу ${startedCount}/${plan.tasks.length}: ${task.title}` });
            }
          });
          if (cancelled()) return null;
          flushDelta();
          const seconds = Math.round((Date.now() - agentStarted.at) / 1000);
          // Имена тех, чьи данные переданы явно, — ссылка на источник, а не «пишет за команду».
          const foreign = foreignAttributions(agent.id, result, received);
          safeEmit('agent-result', { agentId: agent.id, subtaskId: task.id, result, stats, foreign, ...(received.length ? { handoffFrom: received } : {}) });
          safeEmit('agent-status', { agentId: agent.id, status: 'done', task: 'Подзадача готова' });
          safeEmit('log', { agentId: agent.id, message: `Результат готов за ${seconds} с${formatStats(stats)}.`, kind: 'success' });
          if (stats?.doneReason === 'length') {
            safeEmit('log', { agentId: agent.id, message: `Ответ обрезан лимитом ${task.maxTokens} токенов.`, kind: 'warning' });
          }
          if (foreign.length) {
            safeEmit('log', { agentId: agent.id, message: `В ответе упомянуты другие сотрудники (${foreign.join(', ')}). Это текст ${agent.name}, а не их результаты.`, kind: 'warning' });
          }
          return { agentId: agent.id, result, ...(received.length ? { handoffFrom: received } : {}) };
        } catch (error) {
          if (cancelled()) return null;
          const message = error?.message || 'Неизвестная ошибка.';
          safeEmit('agent-error', { agentId: agent.id, subtaskId: task.id, message });
          safeEmit('agent-status', { agentId: agent.id, status: 'error', task: 'Ошибка выполнения' });
          safeEmit('log', { agentId: agent.id, message: `Не справился: ${message}`, kind: 'warning' });
          return { agentId: agent.id, error: message };
        }
      };
      const outcomes = await Promise.all(plan.tasks.map(runTask));
      if (cancelled()) return;

      const results = outcomes.filter(o => o?.result);
      const failed = plan.tasks.map(t => t.agentId).filter(id => !results.some(r => r.agentId === id));
      if (!results.length) throw new Error('Ни один специалист не смог выполнить задачу. Подробности — в журнале и в логах сервера.');

      let summary;
      // Как собран отчёт: single — единственный ответ, combined — ответы сотрудников, model — сводка модели.
      // Исправление (REVISION) пересобирает отчёт тем же способом.
      let summaryKind = 'combined';
      if (results.length === 1) {
        summary = results[0].result;
        summaryKind = 'single';
        safeEmit('log', { agentId: 'ceo', message: 'Результат получен от одного специалиста — итог передан без дополнительной сводки.' });
      } else if (!needsModelSummary(plan, config.ceoSummary)) {
        safeEmit('log', { agentId: 'ceo', message: config.ceoSummary === 'auto'
          ? 'Все задания адресные — итог собран из настоящих ответов сотрудников без пересказа моделью.'
          : 'Сводка CEO отключена (CEO_SUMMARY=false) — показаны ответы сотрудников.' });
      } else {
        if (plan.tasks.every(t => t.assigned)) {
          safeEmit('log', { agentId: 'ceo', message: 'CEO_SUMMARY=true в .env: сводка запускается даже для адресных заданий — на CPU это может добавить несколько минут. Значение auto собирает итог из ответов сотрудников.', kind: 'warning' });
        }
        safeEmit('review-start', { agentId: 'ceo', message: 'CEO сводит результаты команды.' });
        safeEmit('agent-status', { agentId: 'ceo', status: 'thinking', task: 'Проверяет результаты команды' });
        try {
          ({ text: summary } = await callModel(summaryMessages(goal, results, failed), {
            maxTokens: config.summaryMaxTokens, signal, label: `${runId}/ceo-summary`
          }));
          summaryKind = 'model';
        } catch (error) {
          if (cancelled()) return;
          safeEmit('log', { agentId: 'ceo', message: `Сводка CEO не получена (${error.message}). Показаны результаты специалистов.`, kind: 'warning' });
        }
      }
      if (cancelled()) return;
      summary ||= combinedResults(results);
      const finalResult = `${attributionBlock(plan, outcomes.filter(Boolean))}\n\n${summary}`;
      safeEmit('final', { result: finalResult, completedAgents: results.map(r => r.agentId), failedAgents: failed });
      safeEmit('agent-status', { agentId: 'ceo', status: 'done', task: 'Итоговый отчёт готов' });
      safeEmit('log', {
        agentId: 'ceo',
        message: failed.length
          ? `Готово, но ${failed.length} из ${plan.tasks.length} специалистов не выполнили задание: ${failed.map(agentLabel).join(', ')}.`
          : `Итоговый отчёт готов. Результаты сдали: ${results.map(r => agentLabel(r.agentId)).join(', ')}.`,
        kind: failed.length ? 'warning' : 'success'
      });
      // Реплики — после итога: отчёт не ждёт обсуждения. Отмена прерывает и этот раунд.
      const chat = config.crossTalk && results.length > 1 ? await crossTalk(results, { safeEmit, signal, runId }) : [];
      if (cancelled()) return;
      // Одно исправление по замечанию — после обсуждения, один раз, без новых кругов обсуждения.
      if (config.revision) {
        await reviseOnce({ goal, plan, outcomes: outcomes.filter(Boolean), results, failed, summaryKind, chat, safeEmit, signal, runId });
      }
      if (cancelled()) return;
      diag(`[run ${runId}] завершено за ${Math.round((Date.now() - runStarted) / 1000)} с`, { ok: results.length, failed: failed.length });
      safeEmit('done', {});
    } catch (error) {
      if (!cancelled()) {
        const message = error?.message || 'Неизвестная ошибка выполнения.';
        diag(`[run ${runId}] ошибка`, { error: message });
        // Статус — до error: в журнале задачи error завершает приём событий.
        safeEmit('agent-status', { agentId: 'ceo', status: 'error', task: 'Задача остановлена' });
        safeEmit('error', { message });
      }
    }
  }

  /**
   * Короткий раунд реплик (CROSS_TALK): каждый, кто сдал результат, пишет одному коллеге 1–2 предложения
   * (chatPartner), а если коллега уже написал ему — отвечает. Пересказ чужого результата не показывается.
   * Реплики — отдельные события agent-chat: не результаты, не попадают в «Кто выполнил задачу» и в проверку чужих имён.
   * Всё состояние — в рамках одного запуска. Возвращает показанные реплики (для REVISION).
   */
  async function crossTalk(results, { safeEmit, signal, runId }) {
    const participants = results.map(r => r.agentId);
    const said = [];
    safeEmit('chat-start', {});
    safeEmit('log', { agentId: 'ceo', message: 'Команда коротко обсуждает результаты (CROSS_TALK).' });
    for (const own of results) {
      if (signal.aborted) return said;
      const agent = AGENTS.find(a => a.id === own.agentId);
      const incoming = said.findLast(message => message.to === own.agentId);
      const partner = results.find(r => r.agentId === chatPartner(own.agentId, participants, incoming?.agentId));
      safeEmit('agent-status', { agentId: agent.id, status: 'thinking', task: 'Пишет коллеге' });
      let reply = null;
      try {
        const { text, stats } = await callModel(chatMessages(agent, own.result, partner, incoming?.agentId === partner.agentId ? incoming : undefined), {
          maxTokens: config.crossTalkMaxTokens, signal, label: `${runId}/chat-${agent.id}`
        });
        if (signal.aborted) return said;
        reply = cleanChatReply(text, agent.id, participants, {
          truncated: stats?.doneReason === 'length',
          // Пересказ результата коллеги или уже сказанной реплики — ничего нового.
          sources: [...results.filter(r => r.agentId !== agent.id).map(r => r.result), ...said.map(message => message.text)]
        });
        if (!reply) diag(`[run ${runId}] реплика ${agent.id} пропущена: пустая, заглушка или пересказ`, { text: String(text || '').slice(0, 80) });
        else said.push({ agentId: agent.id, ...reply });
      } catch (error) {
        if (signal.aborted) return said;
        // Реплика — необязательная часть: сбой не портит готовый итог.
        diag(`[run ${runId}] реплика ${agent.id} не получена`, { error: error?.message });
      }
      // Сначала статус, потом реплика: на сцене реплика становится подписью сотрудника, и статус её не затирает.
      safeEmit('agent-status', { agentId: agent.id, status: 'done', task: 'Подзадача готова' });
      if (reply) safeEmit('agent-chat', { agentId: agent.id, ...reply });
    }
    return said;
  }

  /**
   * Одно исправление по замечанию (REVISION). Готовый отчёт уже показан, стадия его не задерживает.
   * Не больше трёх вызовов модели: выбор замечания, ответ автора и новая сводка (только если сводку писала модель).
   * Сервер проверяет замечание (validateRemark) и исправление (validateRevision); решает, исправлять ли, автор ответа.
   * Новый ответ сотрудника и новый отчёт уходят одним событием revision. Нет замечания, автор отклонил его,
   * исправление не прошло проверку, сбой, тайм-аут или отмена — ответы и отчёт остаются прежними.
   */
  async function reviseOnce({ goal, plan, outcomes, results, failed, summaryKind, chat, safeEmit, signal, runId }) {
    const limit = config.revisionTimeoutMs >= 1000 ? `${Math.round(config.revisionTimeoutMs / 1000)} с` : `${config.revisionTimeoutMs} мс`;
    const timer = AbortSignal.timeout(config.revisionTimeoutMs);
    const stage = AbortSignal.any([signal, timer]);
    // Версия ответа: 1 — первый результат. Замечание относится к той версии, которую процитировало.
    const versions = Object.fromEntries(results.map(r => [r.agentId, 1]));
    const keep = (outcome, reason, extra = {}) => safeEmit('revision-kept', { outcome, reason, ...extra });
    let author = null;
    safeEmit('revision-start', {});
    safeEmit('log', { agentId: 'ceo', message: `Проверка одного замечания (REVISION): не больше 3 вызовов модели и ${limit}. Готовый отчёт уже показан и до проверенного исправления не меняется.` });
    safeEmit('agent-status', { agentId: 'ceo', status: 'thinking', task: 'Ищет проверяемое замечание' });
    try {
      const pick = await callModel(revisionPickMessages(goal, results, chat), {
        json: true, maxTokens: config.revisionPickMaxTokens, signal: stage, label: `${runId}/revision-pick`
      });
      let parsed = null;
      try { parsed = extractJson(pick.text); } catch { /* не JSON — замечание не принимается */ }
      const checked = validateRemark(parsed, { goal, results, versions });
      if (checked.none) {
        keep('none', 'проверяющий не нашёл ошибки, которую можно подтвердить цитатой из задания или данных коллеги');
        safeEmit('log', { agentId: 'ceo', message: 'Замечаний, подтверждённых заданием или данными коллеги, нет — ответы и отчёт без изменений.' });
        return;
      }
      if (!checked.remark) {
        keep('invalid', checked.reason);
        safeEmit('log', { agentId: 'ceo', message: `Замечание не принято сервером: ${checked.reason}. Ответы и отчёт без изменений.`, kind: 'warning' });
        return;
      }
      const { remark } = checked;
      const task = plan.tasks.find(t => t.agentId === remark.to);
      const agent = AGENTS.find(a => a.id === remark.to);
      const current = results.find(r => r.agentId === remark.to).result;
      const basis = remark.basis.source === 'goal' ? 'задание' : `ответ ${shortName(remark.basis.source)}`;
      safeEmit('revision-remark', { remark });
      safeEmit('log', { agentId: remark.from, message: `Замечание для ${agent.name}: ${remark.defect} В ответе: «${remark.quote}». Основание (${basis}): «${remark.basis.quote}».` });
      author = agent.id;
      safeEmit('agent-status', { agentId: agent.id, status: 'thinking', task: `Проверяет замечание ${shortName(remark.from)}` });
      const answer = await callModel(revisionMessages(agent, task, plan, current, remark), {
        maxTokens: task.maxTokens, signal: stage, label: `${runId}/revision-${agent.id}`
      });
      const reply = parseAuthorReply(answer.text);
      if (!reply.verdict) {
        keep('unclear', 'автор не ответил ясно, исправлять ли');
        safeEmit('log', { agentId: agent.id, message: `${agent.name} не ответил ясно, исправлять ли, — ответ не изменён.`, kind: 'warning' });
        return;
      }
      if (reply.verdict === 'reject') {
        keep('rejected', reply.reason || 'без объяснения', { reply: reply.reason });
        safeEmit('log', { agentId: agent.id, message: `${agent.name} отклонил замечание${reply.reason ? `: ${reply.reason}` : ' без объяснения'}. Ответ не изменён.` });
        return;
      }
      const problem = validateRevision(task, current, reply, remark, { truncated: answer.stats?.doneReason === 'length' });
      if (problem) {
        keep('unchecked', problem, { reply: reply.reason });
        safeEmit('log', { agentId: 'ceo', message: `Исправление ${agent.name} не применено: ${problem}. Ответ и отчёт без изменений.`, kind: 'warning' });
        return;
      }
      // Новый отчёт собирается так же, как первый: из ответов сотрудников или сводкой модели.
      const nextOutcomes = outcomes.map(o => (o.agentId === agent.id ? { ...o, result: reply.result, revisedBy: remark.from } : o));
      const nextResults = results.map(r => (r.agentId === agent.id ? { ...r, result: reply.result } : r));
      let summary = summaryKind === 'single' ? reply.result : combinedResults(nextResults);
      if (summaryKind === 'model') {
        safeEmit('agent-status', { agentId: 'ceo', status: 'thinking', task: 'Обновляет итоговый отчёт' });
        ({ text: summary } = await callModel(summaryMessages(goal, nextResults, failed), {
          maxTokens: config.summaryMaxTokens, signal: stage, label: `${runId}/revision-summary`
        }));
      }
      // Тайм-аут или остановка до применения — прежняя версия; замечание к устаревшей версии не применяется.
      stage.throwIfAborted();
      if (versions[agent.id] !== remark.version) {
        keep('stale', 'замечание относится к устаревшей версии ответа');
        return;
      }
      const received = outcomes.find(o => o.agentId === agent.id)?.handoffFrom || [];
      const saved = safeEmit('revision', {
        agentId: agent.id, subtaskId: task.id, fromVersion: remark.version, version: remark.version + 1,
        result: reply.result, final: `${attributionBlock(plan, nextOutcomes)}\n\n${summary}`,
        remark, reply: reply.reason, foreign: foreignAttributions(agent.id, reply.result, received), stats: answer.stats
      });
      versions[agent.id] = remark.version + 1;
      safeEmit('log', {
        agentId: agent.id,
        message: `${agent.name} исправил ответ по замечанию ${shortName(remark.from)}${reply.reason ? `: ${reply.reason}` : ''}. Ответ и итоговый отчёт обновлены вместе.${saved === true ? ' Новая версия записана на диск.' : ''}`,
        kind: 'success'
      });
      if (saved === false) {
        safeEmit('log', { agentId: 'ceo', message: 'Исправление показано, но запись на диск не удалась: после перезапуска сервера может открыться прежняя версия отчёта.', kind: 'warning' });
      }
    } catch (error) {
      if (signal.aborted) return;
      const reason = timer.aborted ? `не уложилась в ${limit} (REVISION_TIMEOUT_MS)` : `не удалась: ${error?.message || 'неизвестная ошибка'}`;
      diag(`[run ${runId}] revision: проверка замечания ${reason}`);
      keep('failed', `проверка замечания ${reason}`);
      safeEmit('log', { agentId: 'ceo', message: `Проверка замечания ${reason}. Итоговый отчёт остаётся прежним.`, kind: 'warning' });
    } finally {
      // Кто проверял замечание, больше не «думает». При остановке пользователем это делает RunStore.
      if (!signal.aborted) {
        if (author) safeEmit('agent-status', { agentId: author, status: 'done', task: 'Подзадача готова' });
        safeEmit('agent-status', { agentId: 'ceo', status: 'done', task: 'Итоговый отчёт готов' });
      }
    }
  }

  function openSse(res) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no'
    });
    res.write(': Pixel AI Office\n\n');
    // Комментарий-пинг держит SSE-соединение живым, пока модель долго считает на CPU.
    const heartbeat = setInterval(() => { if (!res.writableEnded) res.write(': ping\n\n'); }, 15_000);
    res.on('close', () => clearInterval(heartbeat));
  }

  // Прежний режим: задача живёт, пока открыто соединение; закрытие отменяет запросы к модели.
  async function runExecution(req, res, body) {
    const { goal, error } = validateGoal(body);
    if (error) return sendJson(res, 400, { error });
    openSse(res);
    const runId = Math.random().toString(36).slice(2, 8);
    const controller = new AbortController();
    let finished = false;
    res.on('close', () => {
      if (!finished) {
        diag(`[run ${runId}] клиент закрыл соединение — отменяю запросы к модели`);
        controller.abort(new Error('client closed'));
      }
    });
    await executeRun(goal, { emit: (type, payload) => emit(res, type, payload), signal: controller.signal, runId });
    finished = true;
    if (!res.writableEnded && !controller.signal.aborted) res.end();
  }

  // Задача на сервере: не зависит от вкладки, переживает перезагрузку страницы, сохраняется на диск.
  function startRun(res, body) {
    const { goal, error } = validateGoal(body);
    if (error) return sendJson(res, 400, { error });
    const run = runs.create(goal);
    executeRun(goal, { emit: (type, payload) => runs.emit(run, type, payload), signal: run.controller.signal, runId: run.id })
      .catch(err => diag(`[run ${run.id}] непредвиденная ошибка`, { error: err?.message }))
      .finally(() => {
        if (run.status === 'running') runs.emit(run, 'error', { message: 'Задача завершилась без итогового события. Подробности — в логах сервера.' });
      });
    return sendJson(res, 202, { runId: run.id });
  }

  // События задачи: сначала всё после seq `after` (или Last-Event-ID), затем новые. Закрытие вкладки задачу не отменяет.
  function streamRun(req, res, run, url) {
    const after = Number(url.searchParams.get('after') ?? req.headers['last-event-id'] ?? 0) || 0;
    openSse(res);
    const unsubscribe = runs.subscribe(run, after, event => {
      if (res.writableEnded) return;
      if (event === null) return res.end();
      res.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`);
    });
    res.on('close', unsubscribe);
  }

  async function checkModel() {
    const startedAt = Date.now();
    try {
      const { text, stats } = await callModel([{ role: 'user', content: 'Ответь одним словом: готов' }], { maxTokens: 10, timeoutMs: Math.min(config.timeoutMs, 120_000), label: 'health-check' });
      return { ok: true, ms: Date.now() - startedAt, reply: text.slice(0, 80), stats };
    } catch (error) {
      return { ok: false, ms: Date.now() - startedAt, error: error.message };
    }
  }

  return http.createServer(async (req, res) => {
    const rejected = rejectUntrusted(req, config);
    if (rejected) {
      diag('отклонён запрос', { method: req.method, url: req.url, origin: req.headers.origin, host: req.headers.host, status: rejected[0] });
      return sendJson(res, rejected[0], { error: rejected[1] });
    }
    if (req.method === 'GET' && req.url === '/api/health') {
      return sendJson(res, 200, {
        ok: true, configured: Boolean(config.apiKey) || config.isLocalUrl, model: config.model, provider: config.provider,
        concurrency: config.concurrency, activeCalls: limiter.active, queuedCalls: limiter.waiting,
        timeoutMs: config.timeoutMs, router: config.routerMode, ceoSummary: config.ceoSummary,
        agentMaxTokens: config.agentMaxTokens, agentShortMaxTokens: config.agentShortMaxTokens,
        handoff: config.handoff, crossTalk: config.crossTalk, revision: config.revision
      });
    }
    // Проверка модели вызывает модель (занимает очередь, у платного API стоит денег), поэтому только POST:
    // его с чужого сайта отсекает проверка Origin выше. GET здесь — только подсказка.
    if (req.url === '/api/health/model') {
      if (req.method === 'POST') return sendJson(res, 200, { model: config.model, provider: config.provider, think: config.ollamaThink, ...(await checkModel()) });
      res.setHeader('allow', 'POST');
      return sendJson(res, 405, { error: 'Проверка модели вызывает модель — используй POST: curl -X POST http://127.0.0.1:8787/api/health/model' });
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
    const url = new URL(req.url || '/', 'http://localhost');
    if (url.pathname === '/api/runs') {
      if (req.method === 'GET') return sendJson(res, 200, { runs: runs.list() });
      if (req.method === 'POST') {
        try { return startRun(res, await readBody(req)); }
        catch (error) { return sendJson(res, 400, { error: error.message || 'Не удалось прочитать запрос.' }); }
      }
    }
    const runRoute = url.pathname.match(/^\/api\/runs\/([\w-]+)(\/events|\/cancel)?$/);
    if (runRoute) {
      const run = runs.get(runRoute[1]);
      if (!run) return sendJson(res, 404, { error: 'Задача не найдена на сервере. Возможно, она старше последних 50 задач.' });
      const [, , action] = runRoute;
      if (req.method === 'GET' && action === '/events') return streamRun(req, res, run, url);
      if (req.method === 'POST' && action === '/cancel') {
        const cancelled = runs.cancel(run);
        if (cancelled) diag(`[run ${run.id}] остановлено пользователем`);
        return sendJson(res, 200, { status: run.status, cancelled });
      }
      if (req.method === 'DELETE' && !action) {
        if (!runs.remove(run)) return sendJson(res, 409, { error: 'Задача ещё выполняется — сначала останови её.' });
        return sendJson(res, 200, { deleted: true });
      }
      if (req.method === 'GET' && !action) {
        const { id, goal, status, createdAt, updatedAt, events } = run;
        return sendJson(res, 200, { id, goal, status, createdAt, updatedAt, events });
      }
    }
    if (req.url?.startsWith('/api/')) return sendJson(res, 404, { error: 'Неизвестный API-маршрут.' });
    sendJson(res, 404, { error: 'API доступен только по /api/*.' });
  });
}
