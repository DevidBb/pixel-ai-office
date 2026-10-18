export type AgentStatus = 'idle' | 'working' | 'thinking' | 'done' | 'error';
export type TaskStatus = 'planning' | 'working' | 'review' | 'done' | 'error';
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
  result?: string;
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
