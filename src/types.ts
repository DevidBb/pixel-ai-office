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

export type OfficeSubtask = {
  id: string;
  agentId: string;
  title: string;
  objective: string;
  status: SubtaskStatus;
  result?: string;
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
