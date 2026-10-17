import http from 'node:http';
import { diag } from './llm.mjs';
import {
  AGENTS, routeByExplicit, routeByRules, fallbackRoute, routerMessages, buildPlan, agentMessages,
  foreignAttributions, attributionBlock, combinedResults, summaryMessages, agentLabel, needsModelSummary, excludedAgents,
  assertSomeoneAllowed, uncertainNote
} from './office.mjs';

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
export function createApp({ config, callModel, limiter }) {
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

  async function runExecution(req, res, body) {
    const goal = String(body.goal || '').trim();
    if (!goal) return sendJson(res, 400, { error: 'Напиши цель или задачу для CEO.' });
    if (goal.length > 5000) return sendJson(res, 400, { error: 'Слишком длинная задача: максимум 5000 символов.' });
    if (!config.apiKey && !config.isLocalUrl) {
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
      for (const task of plan.tasks) {
        safeEmit('agent-status', { agentId: task.agentId, status: 'idle', task: 'Задание получено, ждёт очереди к модели' });
      }

      // Все задания выдаются сразу; результат каждого отправляется по готовности.
      // Фактическую параллельность генерации ограничивает LLM_CONCURRENCY.
      let startedCount = 0;
      const outcomes = await Promise.all(plan.tasks.map(async task => {
        const agent = AGENTS.find(a => a.id === task.agentId);
        const agentStarted = { at: 0 };
        try {
          const { text: result, stats } = await callModel(agentMessages(agent, task, plan), {
            maxTokens: task.maxTokens,
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
          const foreign = foreignAttributions(agent.id, result);
          safeEmit('agent-result', { agentId: agent.id, subtaskId: task.id, result, stats, foreign });
          safeEmit('agent-status', { agentId: agent.id, status: 'done', task: 'Подзадача готова' });
          safeEmit('log', { agentId: agent.id, message: `Результат готов за ${seconds} с${formatStats(stats)}.`, kind: 'success' });
          if (stats?.doneReason === 'length') {
            safeEmit('log', { agentId: agent.id, message: `Ответ обрезан лимитом ${task.maxTokens} токенов.`, kind: 'warning' });
          }
          if (foreign.length) {
            safeEmit('log', { agentId: agent.id, message: `В ответе упомянуты другие сотрудники (${foreign.join(', ')}). Это текст ${agent.name}, а не их результаты.`, kind: 'warning' });
          }
          return { agentId: agent.id, result };
        } catch (error) {
          if (cancelled()) return null;
          const message = error?.message || 'Неизвестная ошибка.';
          safeEmit('agent-error', { agentId: agent.id, subtaskId: task.id, message });
          safeEmit('agent-status', { agentId: agent.id, status: 'error', task: 'Ошибка выполнения' });
          safeEmit('log', { agentId: agent.id, message: `Не справился: ${message}`, kind: 'warning' });
          return { agentId: agent.id, error: message };
        }
      }));
      if (cancelled()) return;

      const results = outcomes.filter(o => o?.result);
      const failed = plan.tasks.map(t => t.agentId).filter(id => !results.some(r => r.agentId === id));
      if (!results.length) throw new Error('Ни один специалист не смог выполнить задачу. Подробности — в журнале и в логах сервера.');

      let summary;
      if (results.length === 1) {
        summary = results[0].result;
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
      finished = true;
      diag(`[run ${runId}] завершено за ${Math.round((Date.now() - runStarted) / 1000)} с`, { ok: results.length, failed: failed.length });
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
      const { text, stats } = await callModel([{ role: 'user', content: 'Ответь одним словом: готов' }], { maxTokens: 10, timeoutMs: Math.min(config.timeoutMs, 120_000), label: 'health-check' });
      return { ok: true, ms: Date.now() - startedAt, reply: text.slice(0, 80), stats };
    } catch (error) {
      return { ok: false, ms: Date.now() - startedAt, error: error.message };
    }
  }

  return http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/api/health') {
      return sendJson(res, 200, {
        ok: true, configured: Boolean(config.apiKey) || config.isLocalUrl, model: config.model, provider: config.provider,
        concurrency: config.concurrency, activeCalls: limiter.active, queuedCalls: limiter.waiting,
        timeoutMs: config.timeoutMs, router: config.routerMode, ceoSummary: config.ceoSummary,
        agentMaxTokens: config.agentMaxTokens, agentShortMaxTokens: config.agentShortMaxTokens
      });
    }
    if (req.method === 'GET' && req.url === '/api/health/model') {
      return sendJson(res, 200, { model: config.model, provider: config.provider, think: config.ollamaThink, ...(await checkModel()) });
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
}
