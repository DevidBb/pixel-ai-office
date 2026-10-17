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
};
