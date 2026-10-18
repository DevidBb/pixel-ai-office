// Сборка задачи из событий сервера. Чистые функции: одинаково работают для живого потока,
// повтора после перезагрузки и восстановления истории из data/runs (GET /api/runs/:id).
import type { OfficeLog, OfficeSubtask, OfficeTask, RunEvent, ServerRun } from './types';

export function clockNow(at?: number) {
  return new Date(at ?? Date.now()).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

/** «18.10, 03:11» — для задач из истории, где важен и день. */
export function formatRunTime(iso: string) {
  return new Date(iso).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

export function makeLog(agentId: string, message: string, kind?: OfficeLog['kind'], at?: number): OfficeLog {
  return { id: crypto.randomUUID(), time: clockNow(at), agentId, message, kind };
}

function withLog(task: OfficeTask, agentId: string, message: string, kind?: OfficeLog['kind'], at?: number): OfficeTask {
  return { ...task, logs: [...(task.logs || []), makeLog(agentId, message, kind, at)] };
}

function updateSubtask(task: OfficeTask, subtaskId: string, update: (subtask: OfficeSubtask) => OfficeSubtask): OfficeTask {
  return { ...task, subtasks: (task.subtasks || []).map(subtask => subtask.id === subtaskId ? update(subtask) : subtask) };
}

/** Применяет одно событие к задаче. Состояние сотрудников на сцене сюда не входит. */
export function reduceTask(task: OfficeTask, event: RunEvent): OfficeTask {
  switch (event.type) {
    case 'log':
      return event.agentId && event.message ? withLog(task, event.agentId, event.message, event.kind, event.at) : task;
    case 'plan':
      return { ...task, status: 'working', planSummary: event.summary || '', subtasks: event.subtasks || [] };
    case 'agent-start':
      return event.subtaskId ? { ...updateSubtask(task, event.subtaskId, s => ({ ...s, status: 'working' })), status: 'working' } : task;
    case 'agent-delta':
      return event.subtaskId && event.text ? updateSubtask(task, event.subtaskId, s => ({ ...s, draft: (s.draft || '') + event.text })) : task;
    case 'agent-result':
      return event.subtaskId
        ? updateSubtask(task, event.subtaskId, s => ({ ...s, status: 'done', result: event.result || 'Агент вернул пустой результат.', draft: undefined, stats: event.stats, foreign: event.foreign }))
        : task;
    case 'agent-error':
      return event.subtaskId
        ? updateSubtask(task, event.subtaskId, s => ({ ...s, status: 'error', draft: undefined, result: `Ошибка: ${event.message || 'неизвестная ошибка'}` }))
        : task;
    case 'review-start':
      return { ...task, status: 'review' };
    case 'final':
      return { ...task, status: 'review', result: event.result || '' };
    case 'done':
      return { ...task, status: 'done' };
    case 'error': {
      const message = event.message || 'Неизвестная ошибка.';
      const result = event.cancelled || event.interrupted ? message : `Выполнение остановлено: ${message}`;
      return withLog({ ...task, status: 'error', result }, 'ceo', `Ошибка: ${message}`, 'warning', event.at);
    }
    default:
      return task;
  }
}

/** Пустая задача, готовая к проигрыванию событий с начала. */
export function resetTask(task: OfficeTask): OfficeTask {
  return { ...task, status: 'planning', planSummary: undefined, subtasks: [], logs: [], result: undefined };
}

/** Задача из истории сервера (data/runs), которой нет в этом браузере. */
export function taskFromRun(run: ServerRun): OfficeTask {
  const base: OfficeTask = {
    id: `run-${run.id}`,
    runId: run.id,
    title: run.goal,
    agentId: 'ceo',
    status: 'planning',
    createdAt: formatRunTime(run.createdAt),
    startedAt: run.createdAt,
    subtasks: [],
    logs: []
  };
  const task = run.events.reduce(reduceTask, base);
  // На случай, если журнал оборвался без итогового события.
  if (run.status !== 'running' && task.status !== 'done' && task.status !== 'error') {
    return { ...task, status: run.status === 'done' ? 'done' : 'error', result: task.result || 'Задача завершилась без итогового отчёта.' };
  }
  return task;
}

/** Новые сверху; задачи без времени запуска (из старых версий) — в конце, в прежнем порядке. */
export function sortTasks(tasks: OfficeTask[]): OfficeTask[] {
  return tasks
    .map((task, index) => ({ task, index }))
    .sort((a, b) => (b.task.startedAt || '').localeCompare(a.task.startedAt || '') || a.index - b.index)
    .map(({ task }) => task);
}

/** Добавляет к задачам браузера задачи с сервера, которых в браузере нет. */
export function mergeHistory(local: OfficeTask[], restored: OfficeTask[], limit = 30): OfficeTask[] {
  const known = new Set(local.map(task => task.runId).filter(Boolean));
  return sortTasks([...local, ...restored.filter(task => !known.has(task.runId))]).slice(0, limit);
}
