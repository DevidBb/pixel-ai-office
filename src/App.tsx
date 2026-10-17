import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import Phaser from 'phaser';
import { OfficeScene } from './OfficeScene';
import type { Agent, OfficeLog, OfficeSubtask, OfficeTask, TaskStatus } from './types';
import './stage2.css';

const initialAgents: Agent[] = [
  { id: 'ceo', name: 'Luma 1', role: 'CEO · Руководитель', color: '#5b8fa8', status: 'idle', task: 'Готов принимать цели', x: 165, y: 250 },
  { id: 'research', name: 'Luma 2', role: 'Исследователь рынка', color: '#a7b879', status: 'idle', task: 'Ждёт назначения', x: 500, y: 250 },
  { id: 'product', name: 'Luma 3', role: 'Продуктолог', color: '#c69a72', status: 'idle', task: 'Ждёт назначения', x: 835, y: 250 },
  { id: 'creator', name: 'Luma 4', role: 'Креатор', color: '#a78bc3', status: 'idle', task: 'Ждёт назначения', x: 165, y: 500 },
  { id: 'sales', name: 'Luma 5', role: 'Менеджер продаж', color: '#6cae9e', status: 'idle', task: 'Ждёт назначения', x: 500, y: 500 },
  { id: 'finance', name: 'Luma 6', role: 'Финансовый аналитик', color: '#c77777', status: 'idle', task: 'Ждёт назначения', x: 835, y: 500 }
];

const agentStatusLabel: Record<Agent['status'], string> = {
  idle: 'Ожидает', working: 'Работает', thinking: 'Думает', done: 'Готово', error: 'Ошибка'
};
const taskStatusLabel: Record<TaskStatus, string> = {
  planning: 'Планирует', working: 'Выполняется', review: 'Проверка CEO', done: 'Завершено', error: 'Ошибка'
};
const STORAGE_KEY = 'pixel-ai-office.tasks.stage2';

type ApiEvent = {
  type: string;
  agentId?: string;
  status?: Agent['status'];
  task?: string;
  message?: string;
  summary?: string;
  subtasks?: OfficeSubtask[];
  subtaskId?: string;
  title?: string;
  result?: string;
  kind?: OfficeLog['kind'];
};

function loadSavedTasks(): OfficeTask[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function clockNow() {
  return new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

function makeLog(agentId: string, message: string, kind?: OfficeLog['kind']): OfficeLog {
  return { id: crypto.randomUUID(), time: clockNow(), agentId, message, kind };
}

export default function App() {
  const gameHost = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<OfficeScene | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const activeTaskRef = useRef<string | null>(null);
  const [agents, setAgents] = useState<Agent[]>(initialAgents);
  const [tasks, setTasks] = useState<OfficeTask[]>(loadSavedTasks);
  const [prompt, setPrompt] = useState('');
  const [selectedAgent, setSelectedAgent] = useState('ceo');
  const [apiConfigured, setApiConfigured] = useState<boolean | null>(null);
  const [apiModel, setApiModel] = useState('');
  const [isRunning, setIsRunning] = useState(false);

  useEffect(() => {
    const game = new Phaser.Game({
      type: Phaser.CANVAS,
      parent: gameHost.current ?? undefined,
      width: 1000,
      height: 700,
      backgroundColor: '#c9c6ba',
      pixelArt: true,
      antialias: false,
      scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH },
      scene: {
        preload() {},
        create(this: Phaser.Scene) {
          const scene = new OfficeScene();
          game.scene.add('office', scene, true, { agents: initialAgents });
          sceneRef.current = scene;
          agents.forEach(agent => scene.updateAgent(agent));
        }
      }
    });
    return () => { abortRef.current?.abort(); game.destroy(true); sceneRef.current = null; };
    // Phaser must be instantiated once; the scene receives state updates below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    agents.forEach(agent => sceneRef.current?.updateAgent(agent));
  }, [agents]);

  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks.slice(0, 30))); } catch { /* storage may be disabled */ }
  }, [tasks]);

  useEffect(() => {
    let cancelled = false;
    let attempts = 0;
    let retryTimer: number | undefined;
    const checkHealth = () => {
      attempts += 1;
      fetch('/api/health')
        .then(response => response.json())
        .then(data => {
          if (cancelled) return;
          setApiConfigured(Boolean(data.configured));
          setApiModel(String(data.model || ''));
        })
        .catch(() => {
          if (cancelled) return;
          if (attempts < 7) retryTimer = window.setTimeout(checkHealth, 900);
          else setApiConfigured(false);
        });
    };
    checkHealth();
    return () => { cancelled = true; if (retryTimer) window.clearTimeout(retryTimer); };
  }, []);

  function updateTask(taskId: string, updater: (task: OfficeTask) => OfficeTask) {
    setTasks(current => current.map(task => task.id === taskId ? updater(task) : task));
  }

  function updateAgent(agentId: string, updater: (agent: Agent) => Agent) {
    setAgents(current => current.map(agent => agent.id === agentId ? updater(agent) : agent));
  }

  function addLog(taskId: string, agentId: string, message: string, kind?: OfficeLog['kind']) {
    updateTask(taskId, task => ({ ...task, logs: [...(task.logs || []), makeLog(agentId, message, kind)] }));
  }

  function handleApiEvent(taskId: string, event: ApiEvent) {
    if (event.type === 'log' && event.agentId && event.message) {
      addLog(taskId, event.agentId, event.message, event.kind);
      return;
    }
    if (event.type === 'agent-status' && event.agentId && event.status) {
      updateAgent(event.agentId, agent => ({ ...agent, status: event.status!, task: event.task || agent.task }));
      return;
    }
    if (event.type === 'plan') {
      updateTask(taskId, task => ({ ...task, status: 'working', planSummary: event.summary || '', subtasks: event.subtasks || [] }));
      updateAgent('ceo', agent => ({ ...agent, status: 'working', task: 'Координирует команду' }));
      return;
    }
    if (event.type === 'agent-start' && event.agentId && event.subtaskId) {
      updateTask(taskId, task => ({
        ...task,
        status: 'working',
        subtasks: (task.subtasks || []).map(subtask => subtask.id === event.subtaskId ? { ...subtask, status: 'working' } : subtask)
      }));
      if (event.title) updateAgent(event.agentId, agent => ({ ...agent, task: event.title!, status: 'working' }));
      return;
    }
    if (event.type === 'agent-result' && event.agentId && event.subtaskId) {
      updateTask(taskId, task => ({
        ...task,
        subtasks: (task.subtasks || []).map(subtask => subtask.id === event.subtaskId
          ? { ...subtask, status: 'done', result: event.result || 'Агент вернул пустой результат.' }
          : subtask)
      }));
      return;
    }
    if (event.type === 'agent-error' && event.agentId && event.subtaskId) {
      updateTask(taskId, task => ({
        ...task,
        subtasks: (task.subtasks || []).map(subtask => subtask.id === event.subtaskId
          ? { ...subtask, status: 'error', result: `Ошибка: ${event.message || 'неизвестная ошибка'}` }
          : subtask)
      }));
      return;
    }
    if (event.type === 'review-start') {
      updateTask(taskId, task => ({ ...task, status: 'review' }));
      updateAgent('ceo', agent => ({ ...agent, status: 'thinking', task: event.message || 'Проверяет результаты команды' }));
      return;
    }
    if (event.type === 'final') {
      updateTask(taskId, task => ({ ...task, status: 'review', result: event.result || '' }));
      return;
    }
    if (event.type === 'done') {
      updateTask(taskId, task => ({ ...task, status: 'done' }));
      updateAgent('ceo', agent => ({ ...agent, status: 'done', task: 'Итоговый отчёт готов' }));
      setIsRunning(false);
      activeTaskRef.current = null;
      abortRef.current = null;
      return;
    }
    if (event.type === 'error') {
      const message = event.message || 'Неизвестная ошибка.';
      updateTask(taskId, task => ({ ...task, status: 'error', result: `Выполнение остановлено: ${message}` }));
      addLog(taskId, 'ceo', `Ошибка: ${message}`, 'warning');
      updateAgent('ceo', agent => ({ ...agent, status: 'error', task: 'Нужна проверка ошибки' }));
      setIsRunning(false);
      activeTaskRef.current = null;
      abortRef.current = null;
    }
  }

  async function submitTask(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const title = prompt.trim();
    if (!title || isRunning) return;
    const taskId = crypto.randomUUID();
    const task: OfficeTask = {
      id: taskId,
      title,
      agentId: 'ceo',
      status: 'planning',
      createdAt: clockNow(),
      subtasks: [],
      logs: [makeLog('ceo', 'Задача принята. CEO готовит план и распределяет работу.')]
    };
    setTasks(current => [task, ...current]);
    setAgents(current => current.map(agent => ({
      ...agent,
      status: agent.id === 'ceo' ? 'thinking' as const : 'idle' as const,
      task: agent.id === 'ceo' ? 'Планирует работу' : 'Ждёт назначения'
    })));
    setPrompt('');
    setIsRunning(true);
    activeTaskRef.current = taskId;
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const response = await fetch('/api/execute', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ goal: title }),
        signal: controller.signal
      });
      if (!response.ok) {
        let message = `HTTP ${response.status}`;
        try { const data = await response.json(); message = data.error || message; } catch { /* response may not be JSON */ }
        throw new Error(message);
      }
      if (!response.body) throw new Error('Браузер не поддерживает потоковый ответ. Попробуй обновить браузер.');

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      const consumeBlock = (block: string) => {
        const dataLines = block.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trim());
        if (!dataLines.length) return;
        try { handleApiEvent(taskId, JSON.parse(dataLines.join('\n')) as ApiEvent); } catch { /* ignore malformed event */ }
      };
      while (true) {
        const { value, done } = await reader.read();
        buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
        let separator = buffer.indexOf('\n\n');
        while (separator >= 0) {
          consumeBlock(buffer.slice(0, separator));
          buffer = buffer.slice(separator + 2);
          separator = buffer.indexOf('\n\n');
        }
        if (done) break;
      }
      if (buffer.trim()) consumeBlock(buffer);
      if (activeTaskRef.current === taskId) {
        updateTask(taskId, current => current.status === 'done' || current.status === 'error' ? current : ({ ...current, status: 'error', result: current.result || 'Соединение завершилось до получения итогового события. Попробуй открыть задачу снова.' }));
        setIsRunning(false);
        activeTaskRef.current = null;
        abortRef.current = null;
      }
    } catch (error) {
      if (controller.signal.aborted) {
        updateTask(taskId, current => ({ ...current, status: 'error', result: 'Задача была прервана.' }));
      } else {
        const message = error instanceof Error ? error.message : 'Неизвестная ошибка.';
        updateTask(taskId, current => ({ ...current, status: 'error', result: `Не удалось выполнить задачу: ${message}` }));
        addLog(taskId, 'ceo', `Ошибка выполнения: ${message}`, 'warning');
      }
      updateAgent('ceo', agent => ({ ...agent, status: 'error', task: 'Не удалось завершить задачу' }));
      setIsRunning(false);
      activeTaskRef.current = null;
      abortRef.current = null;
    }
  }

  function stopTask() {
    const currentTaskId = activeTaskRef.current;
    abortRef.current?.abort();
    if (currentTaskId) {
      updateTask(currentTaskId, task => ({ ...task, status: 'error', result: 'Выполнение остановлено пользователем.' }));
      addLog(currentTaskId, 'ceo', 'Пользователь остановил выполнение.', 'warning');
    }
    updateAgent('ceo', agent => ({ ...agent, status: 'idle', task: 'Остановлено пользователем' }));
    setIsRunning(false);
    activeTaskRef.current = null;
    abortRef.current = null;
  }

  const completed = tasks.filter(task => task.status === 'done').length;
  const activeAgents = agents.filter(agent => agent.status === 'working' || agent.status === 'thinking').length;
  const selectedAgentInfo = agents.find(agent => agent.id === selectedAgent) || agents[0];

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-mark">✳</div>
        <div className="brand-copy"><strong>PIXEL AI OFFICE</strong><span>АГЕНТНАЯ КОМАНДА · STAGE 2</span></div>
        <div className="topbar-spacer" />
        <div className={`live-indicator ${apiConfigured ? 'api-ready' : 'api-missing'}`}><i /> {apiConfigured === null ? 'ПРОВЕРКА API' : apiConfigured ? `МОДЕЛЬ ПОДКЛЮЧЕНА · ${apiModel}` : 'НУЖЕН API-КЛЮЧ'}</div>
        <div className="avatar">Y</div>
      </header>

      <section className="workspace">
        <div className="section-heading">
          <div><p className="eyebrow">ЦЕЛИ → ПЛАН → РАБОТА КОМАНДЫ → ПРОВЕРКА</p><h1>Офис агентов</h1><p className="subheading">CEO распределяет работу. Специалисты выполняют подзадачи, используют результаты коллег и возвращают итоговый отчёт.</p></div>
          <div className="date-chip">⌁ {new Date().toLocaleDateString('ru-RU', { day: '2-digit', month: 'short', year: 'numeric' })}</div>
        </div>

        {!apiConfigured && <section className="setup-notice">
          <strong>Нужно подключить модель</strong>
          <p>В папке проекта создай файл <code>.env</code> на основе <code>.env.example</code> и добавь свой API-ключ. Ключ используется только локальным сервером. Подписка ChatGPT не включает оплату API; запросы API могут тарифицироваться отдельно.</p>
        </section>}

        <div className="metrics">
          <div className="metric"><span>АГЕНТЫ</span><strong>{agents.length.toString().padStart(2, '0')}</strong><small>CEO + 5 специалистов</small></div>
          <div className="metric"><span>В РАБОТЕ</span><strong>{activeAgents.toString().padStart(2, '0')}</strong><small>Активные роли</small></div>
          <div className="metric"><span>ЗАВЕРШЕНО</span><strong>{completed.toString().padStart(2, '0')}</strong><small>Задачи с итоговым отчётом</small></div>
        </div>

        <div className="main-grid">
          <section className="office-panel">
            <div className="panel-header"><div><span className="panel-kicker">FLOOR 01</span><h2>Основной офис</h2></div><span className="tiny-status"><i /> {isRunning ? 'КОМАНДА РАБОТАЕТ' : 'ГОТОВ К РАБОТЕ'}</span></div>
            <div className="scene-frame"><div ref={gameHost} className="game-host" /></div>
            <div className="legend"><span><i className="dot idle" />Ожидает</span><span><i className="dot working" />Работает</span><span><i className="dot done" />Готово</span><span><i className="dot error" />Ошибка</span></div>
          </section>

          <aside className="side-column">
            <section className="panel agents-panel">
              <div className="panel-header"><div><span className="panel-kicker">TEAM STATUS</span><h2>Команда</h2></div><span className="count-pill">{agents.length}</span></div>
              <div className="agent-list">
                {agents.map(agent => <button key={agent.id} className={`agent-row ${selectedAgent === agent.id ? 'selected' : ''}`} onClick={() => setSelectedAgent(agent.id)}>
                  <span className="agent-avatar" style={{ background: agent.color }}>{agent.name.split(' ')[1]}</span>
                  <span className="agent-copy"><strong>{agent.name}{agent.id === 'ceo' ? ' · CEO' : ''}</strong><small>{agent.role}</small><small className="agent-task">{agent.task}</small></span>
                  <span className={`status-tag ${agent.status}`}><i />{agentStatusLabel[agent.status]}</span>
                </button>)}
              </div>
              <div className="agent-focus"><small>ВЫБРАННЫЙ СОТРУДНИК</small><strong>{selectedAgentInfo.name} · {selectedAgentInfo.role}</strong><p>{selectedAgentInfo.id === 'ceo' ? 'Принимает твою цель, распределяет подзадачи, собирает результаты и проверяет итог.' : 'Получает отдельную подзадачу от CEO и использует результаты, переданные предыдущими специалистами.'}</p></div>
            </section>

            <section className="panel task-panel">
              <div className="panel-header"><div><span className="panel-kicker">TASK DISPATCH</span><h2>Поставить цель CEO</h2></div><span className="paper-icon">↗</span></div>
              <form onSubmit={submitTask} className="task-form">
                <div className="ceo-route"><span className="ceo-route-icon">C</span><span><strong>CEO · Luma 1</strong><small>Сам назначит специалистов и приоритеты</small></span></div>
                <label htmlFor="task-prompt">КАКОЙ РЕЗУЛЬТАТ НУЖЕН?</label>
                <textarea id="task-prompt" value={prompt} onChange={event => setPrompt(event.target.value)} placeholder="Например: проверь спрос на услугу для малого бизнеса в Эстонии, подготовь предложение и план привлечения первого клиента…" rows={5} maxLength={5000} />
                <div className="prompt-meta"><span>CEO составит план и выполнит задачи по очереди</span><span>{prompt.length}/5000</span></div>
                <button className="dispatch-button" type="submit" disabled={!prompt.trim() || isRunning || apiConfigured === false}><span>{isRunning ? 'Команда выполняет задачу…' : 'Передать цель CEO'}</span><span>↗</span></button>
                {isRunning && <button className="stop-button" type="button" onClick={stopTask}>Остановить выполнение</button>}
                <p className="prototype-note"><span>ⓘ</span> Используются реальные вызовы модели через локальный API-сервер. Поиск в интернете, рассылка сообщений и оплата не выполняются автоматически.</p>
              </form>
            </section>
          </aside>
        </div>

        <section className="panel activity-panel">
          <div className="panel-header"><div><span className="panel-kicker">TASKS & COLLABORATION</span><h2>Задачи, обсуждение и результаты</h2></div><span className="activity-count">{tasks.length} задач</span></div>
          {tasks.length === 0 ? <div className="empty-state"><span className="empty-symbol">⌁</span><strong>Офис ждёт первую цель</strong><p>CEO разобьёт её на отдельные подзадачи и передаст их специалистам.</p></div> :
            <div className="task-list">{tasks.map(task => {
              const ceo = agents.find(agent => agent.id === task.agentId);
              return <article className="task-item task-item-expanded" key={task.id}>
                <span className={`task-state ${task.status}`} />
                <div className="task-item-copy">
                  <div className="task-title-line"><strong>{task.title}</strong><span className={`status-tag ${task.status}`}>{taskStatusLabel[task.status]}</span></div>
                  <small>{ceo?.name || 'CEO'} · {task.createdAt}</small>
                  {task.planSummary && <div className="plan-summary"><strong>План CEO</strong><p>{task.planSummary}</p></div>}
                  {(task.subtasks || []).length > 0 && <div className="subtask-list"><h3>Назначенные подзадачи</h3>{task.subtasks!.map(subtask => {
                    const agent = agents.find(item => item.id === subtask.agentId);
                    return <details className="subtask-card" key={subtask.id} open={subtask.status === 'working' || subtask.status === 'error'}>
                      <summary><span className={`subtask-indicator ${subtask.status}`} /><span className="subtask-heading"><strong>{agent?.role || subtask.agentId}</strong><small>{subtask.title}</small></span><span className={`mini-status ${subtask.status}`}>{subtask.status === 'queued' ? 'В очереди' : subtask.status === 'working' ? 'Работает' : subtask.status === 'done' ? 'Готово' : 'Ошибка'}</span></summary>
                      <p className="subtask-objective">{subtask.objective}</p>
                      {subtask.result && <div className="agent-result"><strong>Результат сотрудника</strong><pre>{subtask.result}</pre></div>}
                    </details>;
                  })}</div>}
                  {task.result && <details className="final-result" open={task.status === 'error'}><summary>Итоговый отчёт CEO</summary><pre>{task.result}</pre></details>}
                  {(task.logs || []).length > 0 && <details className="collaboration-log"><summary>Журнал действий ({task.logs!.length})</summary><div className="log-entries">{task.logs!.map(log => {
                    const agent = agents.find(item => item.id === log.agentId);
                    return <div className={`log-entry ${log.kind || 'info'}`} key={log.id}><time>{log.time}</time><strong>{agent?.name || log.agentId}</strong><span>{log.message}</span></div>;
                  })}</div></details>}
                </div>
              </article>;
            })}</div>}
        </section>
      </section>
      <footer><span>PIXEL AI OFFICE <span className="footer-muted">/ STAGE 2</span></span><span>Локальное приложение · CEO orchestration · API-модель</span></footer>
    </main>
  );
}
