export type AgentStatus = 'idle' | 'working' | 'thinking' | 'done' | 'error';
export type TaskStatus = 'planning' | 'working' | 'review' | 'discussion' | 'done' | 'error';
export type SubtaskStatus = 'queued' | 'working' | 'done' | 'error';

export type Agent = {
  id: string;
  name: string;
  role: string;
  color: string;
  status: AgentStatus;
  task: string;
  x: number;
  y: number;
};

export type OfficeLog = {
  id: string;
  time: string;
  agentId: string;
  message: string;
  kind?: 'info' | 'success' | 'warning';
};

export type ModelStats = {
  promptTokens?: number;
  outputTokens?: number;
  promptMs?: number;
  genMs?: number;
  loadMs?: number;
  queueMs?: number;
  totalMs?: number;
  tokPerSec?: number;
  maxTokens?: number;
  doneReason?: string;
};

export type OfficeSubtask = {
  id: string;
  agentId: string;
  title: string;
  objective: string;
  status: SubtaskStatus;
  result?: string;
  /** Текст, который сотрудник пишет прямо сейчас (до agent-result). */
  draft?: string;
  stats?: ModelStats;
  /** Имена других сотрудников, упомянутые в ответе этого агента. */
  foreign?: string[];
  /** Сотрудники, чьи результаты агент получил как входные данные (HANDOFF). */
  handoffFrom?: string[];
  /** Версия ответа: 1 — первый, 2 — исправленный по замечанию (REVISION). */
  version?: number;
  /** Ответ до исправления. */
  previousResult?: string;
  /** Кто сделал замечание, по которому ответ исправлен. */
  revisedBy?: string;
};

/** Замечание, прошедшее проверку сервера: адресат, дефект, цитата из ответа и основание. */
export type RevisionRemark = {
  from: string;
  to: string;
  defect: string;
  quote: string;
  basis: { source: string; quote: string };
  version: number;
};

/** Проверка одного замечания (REVISION): идёт, исправление применено или всё оставлено как было. */
export type OfficeRevision = {
  status: 'checking' | 'applied' | 'kept';
  remark?: RevisionRemark;
  /** kept: none | invalid | unclear | rejected | unchecked | stale | failed. */
  outcome?: string;
  reason?: string;
  /** Объяснение автора ответа. */
  reply?: string;
};

/** Реплика сотрудника коллеге (CROSS_TALK) — не результат и не часть итога. */
export type OfficeChat = {
  id: string;
  time: string;
  agentId: string;
  to?: string;
  text: string;
};

export type OfficeTask = {
  id: string;
  title: string;
  agentId: string;
  status: TaskStatus;
  createdAt: string;
  planSummary?: string;
  subtasks?: OfficeSubtask[];
  logs?: OfficeLog[];
  /** Реплики команды после работы (событие agent-chat). */
  chat?: OfficeChat[];
  result?: string;
  /** Итоговый отчёт до исправления по замечанию. */
  previousResult?: string;
  revision?: OfficeRevision;
  /** Номер задачи на сервере (/api/runs/:id) — по нему страница переподключается после перезагрузки. */
  runId?: string;
  /** Время запуска (ISO) — для сортировки истории. */
  startedAt?: string;
};

/** Событие задачи от сервера (SSE /api/runs/:id/events или /api/execute). */
export type RunEvent = {
  type: string;
  agentId?: string;
  status?: AgentStatus;
  task?: string;
  message?: string;
  summary?: string;
  subtasks?: OfficeSubtask[];
  subtaskId?: string;
  title?: string;
  result?: string;
  kind?: OfficeLog['kind'];
  /** Порядковый номер и время события задачи на сервере (/api/runs). */
  seq?: number;
  at?: number;
  cancelled?: boolean;
  interrupted?: boolean;
  stats?: ModelStats;
  foreign?: string[];
  text?: string;
  /** agent-chat: кому адресована реплика. */
  to?: string;
  handoffFrom?: string[];
  /** revision-remark, revision: замечание; revision: новый ответ (result) и новый отчёт (final) вместе. */
  remark?: RevisionRemark;
  reply?: string;
  outcome?: string;
  reason?: string;
  fromVersion?: number;
  version?: number;
  final?: string;
};

/** Задача из GET /api/runs/:id. */
export type ServerRun = {
  id: string;
  goal: string;
  status: 'running' | 'done' | 'error' | 'cancelled' | 'interrupted';
  createdAt: string;
  updatedAt: string;
  events: RunEvent[];
};
