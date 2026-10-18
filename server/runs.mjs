import { mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { diag } from './llm.mjs';

const FINISHED = new Set(['done', 'error', 'cancelled', 'interrupted']);
// За persistDelayMs событий намного меньше: запас номеров после перезапуска.
const RESTART_SEQ_GAP = 1000;

/**
 * Задачи, которые живут на сервере независимо от вкладки браузера.
 * Каждое событие получает порядковый номер seq, хранится в памяти и на диске (data/runs/<id>.json),
 * поэтому страница после перезагрузки может получить все события заново.
 */
export class RunStore {
  constructor({ dataDir, keep = 50, persistDelayMs = 300 } = {}) {
    this.dir = dataDir ? join(dataDir, 'runs') : null;
    this.keep = keep;
    this.persistDelayMs = persistDelayMs;
    this.runs = new Map();
    if (this.dir) this.load();
  }

  load() {
    mkdirSync(this.dir, { recursive: true });
    for (const file of readdirSync(this.dir).filter(f => f.endsWith('.json'))) {
      try {
        const saved = JSON.parse(readFileSync(join(this.dir, file), 'utf8'));
        const run = this.hydrate(saved);
        // До падения клиент мог получить события, которые не успели попасть на диск (запись отложена на persistDelayMs).
        // События восстановления нумеруем с запасом, чтобы переподключение с ?after их не пропустило.
        run.seqFloor = (run.events.at(-1)?.seq || 0) + RESTART_SEQ_GAP;
        // Перезапуск после готового итога оборвал только обсуждение команды (CROSS_TALK): задача завершена.
        if (!FINISHED.has(run.status) && this.hasFinal(run)) {
          this.finishAfterFinal(run, 'Обсуждение команды прервано перезапуском сервера. Итоговый отчёт сохранён.');
        }
        // Сервер перезапустился посреди задачи: модель уже не отвечает ей, честно помечаем как прерванную.
        if (!FINISHED.has(run.status)) {
          this.push(run, 'error', { message: 'Сервер был перезапущен во время выполнения задачи. Готовые результаты сотрудников сохранены выше.', interrupted: true });
          run.status = 'interrupted';
          this.persistNow(run);
        }
        this.runs.set(run.id, run);
      } catch (error) {
        diag(`runs: не удалось прочитать ${file}`, { error: error.message });
      }
    }
  }

  hydrate(saved) {
    return { ...saved, events: saved.events || [], controller: null, subscribers: new Set(), timer: null };
  }

  create(goal) {
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const now = new Date().toISOString();
    const run = this.hydrate({ id, goal, status: 'running', createdAt: now, updatedAt: now, events: [] });
    run.controller = new AbortController();
    this.runs.set(id, run);
    this.persistNow(run);
    this.prune();
    return run;
  }

  get(id) {
    return this.runs.get(id);
  }

  list(limit = 30) {
    return [...this.runs.values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit)
      .map(({ id, goal, status, createdAt, updatedAt, events }) => ({ id, goal, status, createdAt, updatedAt, events: events.length }));
  }

  push(run, type, payload = {}) {
    // Номер — от последнего, а не от длины: после перезапуска черновиков (agent-delta) в журнале меньше,
    // и по длине новые события получили бы уже занятые номера (переподключение с ?after их бы пропустило).
    const event = { seq: Math.max(run.events.at(-1)?.seq || 0, run.seqFloor || 0) + 1, at: Date.now(), type, ...payload };
    run.events.push(event);
    run.updatedAt = new Date(event.at).toISOString();
    for (const subscriber of run.subscribers) subscriber(event);
    return event;
  }

  /** Событие от исполнителя задачи; после завершения или отмены новые события не принимаются. */
  emit(run, type, payload) {
    if (FINISHED.has(run.status)) return;
    this.push(run, type, payload);
    if (type === 'done') this.finish(run, 'done');
    else if (type === 'error') this.finish(run, 'error');
    // Итог готов, а дальше может идти долгое обсуждение (CROSS_TALK): отчёт сразу на диск, а не через persistDelayMs.
    else if (type === 'final') this.persistNow(run);
    else this.schedulePersist(run);
  }

  finish(run, status) {
    run.status = status;
    for (const subscriber of run.subscribers) subscriber(null);
    run.subscribers.clear();
    this.persistNow(run);
  }

  cancel(run) {
    if (FINISHED.has(run.status)) return false;
    run.controller?.abort(new Error('cancelled by user'));
    // Итог уже отправлен (final) — остановка обрывает только необязательное обсуждение команды (CROSS_TALK).
    if (this.hasFinal(run)) {
      this.finishAfterFinal(run, 'Обсуждение команды остановлено пользователем. Итоговый отчёт сохранён.');
      return true;
    }
    this.push(run, 'error', { message: 'Выполнение остановлено пользователем.', cancelled: true });
    this.push(run, 'agent-status', { agentId: 'ceo', status: 'idle', task: 'Остановлено пользователем' });
    this.finish(run, 'cancelled');
    return true;
  }

  hasFinal(run) {
    return run.events.some(event => event.type === 'final');
  }

  /** Обсуждение после итога оборвалось: отчёт остаётся, задача завершена, кто писал реплику, больше не «думает». */
  finishAfterFinal(run, message) {
    const lastStatus = new Map(run.events.filter(event => event.type === 'agent-status').map(event => [event.agentId, event.status]));
    for (const [agentId, status] of lastStatus) {
      if (status === 'thinking' || status === 'working') this.push(run, 'agent-status', { agentId, status: 'done', task: 'Подзадача готова' });
    }
    this.push(run, 'log', { agentId: 'ceo', message, kind: 'warning' });
    this.push(run, 'done', {});
    this.finish(run, 'done');
  }

  /** Подписка: сначала события после seq `after`, затем новые; onEvent(null) — задача завершена. */
  subscribe(run, after, onEvent) {
    for (const event of run.events) if (event.seq > after) onEvent(event);
    if (FINISHED.has(run.status)) {
      onEvent(null);
      return () => {};
    }
    run.subscribers.add(onEvent);
    return () => run.subscribers.delete(onEvent);
  }

  schedulePersist(run) {
    if (!this.dir || run.timer) return;
    run.timer = setTimeout(() => { run.timer = null; this.persistNow(run); }, this.persistDelayMs);
    run.timer.unref?.();
  }

  persistNow(run) {
    if (!this.dir) return;
    if (run.timer) { clearTimeout(run.timer); run.timer = null; }
    const { id, goal, status, createdAt, updatedAt } = run;
    // Черновики (agent-delta) нужны, пока сотрудник пишет; после его agent-result на диск их не пишем —
    // итоговый текст и так в результате, а файл не раздувается сотнями кусочков.
    const finishedAgents = new Set(run.events.filter(e => e.type === 'agent-result' || e.type === 'agent-error').map(e => e.agentId));
    const events = run.events.filter(e => e.type !== 'agent-delta' || !finishedAgents.has(e.agentId));
    const file = join(this.dir, `${id}.json`);
    const tmp = `${file}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify({ id, goal, status, createdAt, updatedAt, events }));
      renameSync(tmp, file);
    } catch (error) {
      diag(`runs: не удалось сохранить ${id}`, { error: error.message });
    }
  }

  // Храним только последние `keep` задач — и в памяти, и на диске.
  prune() {
    const old = [...this.runs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(this.keep);
    for (const run of old) {
      if (!FINISHED.has(run.status)) continue;
      this.runs.delete(run.id);
      if (this.dir) {
        try { unlinkSync(join(this.dir, `${run.id}.json`)); } catch { /* уже удалён */ }
      }
    }
  }

  /** Удалить завершённую задачу из истории (память и диск). Идущую задачу сначала нужно остановить. */
  remove(run) {
    if (!FINISHED.has(run.status)) return false;
    this.runs.delete(run.id);
    if (this.dir) {
      try { unlinkSync(join(this.dir, `${run.id}.json`)); } catch { /* уже удалён */ }
    }
    return true;
  }

  /** Сохранить всё перед остановкой сервера. */
  flush() {
    for (const run of this.runs.values()) if (run.timer) this.persistNow(run);
  }
}
