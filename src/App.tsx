import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { OfficeScene } from './OfficeScene';
import type { Agent, ModelStats, OfficeLog, OfficeTask, RunEvent, ServerRun, TaskStatus } from './types';
import { clockNow, makeLog, mergeHistory, reduceTask, resetTask, taskFromRun } from './taskEvents';
import './stage2.css';
import { buildDocumentation } from './documentation';

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
  planning: 'Планирует', working: 'Выполняется', review: 'Проверка CEO', discussion: 'Обсуждение команды', done: 'Завершено', error: 'Ошибка'
};
const STORAGE_KEY = 'pixel-ai-office.tasks.stage2';

function formatStats(stats?: ModelStats) {
  if (!stats) return '';
  const parts: string[] = [];
  if (stats.totalMs) parts.push(`${Math.round(stats.totalMs / 1000)} с`);
  if (stats.outputTokens) parts.push(`${stats.outputTokens}${stats.maxTokens ? `/${stats.maxTokens}` : ''} ток.`);
  if (stats.tokPerSec) parts.push(`${stats.tokPerSec} ток/с`);
  if (stats.queueMs && stats.queueMs >= 1000) parts.push(`в очереди ${Math.round(stats.queueMs / 1000)} с`);
  if (stats.doneReason === 'length') parts.push('обрезано лимитом');
  return parts.join(' · ');
}

function loadSavedTasks(): OfficeTask[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

const RUNNING_STATUSES: TaskStatus[] = ['planning', 'working', 'review', 'discussion'];
const RECONNECT_DELAY_MS = 2_000;
const RECONNECT_ATTEMPTS = 30;
const sleep = (ms: number) => new Promise(resolve => window.setTimeout(resolve, ms));

export default function App() {
  const gameHost = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<OfficeScene | null>(null);
  const [sceneState, setSceneState] = useState<'loading' | 'ready' | 'error'>('loading');
  const abortRef = useRef<AbortController | null>(null);
  const activeTaskRef = useRef<string | null>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const [agents, setAgents] = useState<Agent[]>(initialAgents);
  // Актуальные сотрудники для сцены, которая загружается позже первого рендера.
  const agentsRef = useRef(agents);
  const [tasks, setTasks] = useState<OfficeTask[]>(loadSavedTasks);
  const [prompt, setPrompt] = useState('');
  const [selectedAgent, setSelectedAgent] = useState('ceo');
  const [apiConfigured, setApiConfigured] = useState<boolean | null>(null);
  const [apiModel, setApiModel] = useState('');
  const [isRunning, setIsRunning] = useState(false);
  const [concurrency, setConcurrency] = useState(3);
  const [workMode, setWorkMode] = useState('parallel');
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [settingsDirty, setSettingsDirty] = useState(false);
  const [settingsMessage, setSettingsMessage] = useState('');
  const [provider, setProvider] = useState('');

  useEffect(() => {
    let cancelled = false;
    let destroyGame: (() => void) | undefined;
    // Phaser и сцена — отдельный файл: интерфейс задач появляется сразу, сцена догружается.
    import('./officeGame')
      .then(({ createOfficeGame }) => {
        if (cancelled || !gameHost.current) return;
        destroyGame = createOfficeGame(gameHost.current, () => agentsRef.current, scene => {
          sceneRef.current = scene;
          setSceneState('ready');
        });
      })
      .catch(() => { if (!cancelled) setSceneState('error'); });
    return () => { cancelled = true; abortRef.current?.abort(); destroyGame?.(); sceneRef.current = null; };
    // Phaser must be instantiated once; the scene receives state updates below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    agentsRef.current = agents;
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
          setConcurrency(data.concurrency || 1);
          setWorkMode(data.handoff === true || (data.handoff === 'auto' && data.concurrency === 1) ? 'handoff' : 'parallel');
          setProvider(String(data.provider || ''));
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

  async function applyWorkSettings() {
    setSettingsBusy(true);
    setSettingsMessage('');
    try {
      const response = await fetch('/api/settings', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ concurrency, mode: workMode })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Не удалось сохранить режим');
      setSettingsDirty(false);
      setSettingsMessage(`Применено: до ${data.concurrency} запросов одновременно. Действует до перезапуска сервера.`);
    } catch (error) {
      setSettingsMessage(error instanceof Error ? error.message : 'Нет связи с сервером');
    } finally { setSettingsBusy(false); }
  }

  function downloadDocumentation(task: OfficeTask) {
    const blob = new Blob([buildDocumentation(task)], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `office-${task.id.replace(/[^a-zA-Z0-9_-]/g, '_')}.md`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function updateTask(taskId: string, updater: (task: OfficeTask) => OfficeTask) {
    setTasks(current => current.map(task => task.id === taskId ? updater(task) : task));
  }

  function updateAgent(agentId: string, updater: (agent: Agent) => Agent) {
    setAgents(current => current.map(agent => agent.id === agentId ? updater(agent) : agent));
  }

  function addLog(taskId: string, agentId: string, message: string, kind?: OfficeLog['kind'], at?: number) {
    updateTask(taskId, task => ({ ...task, logs: [...(task.logs || []), makeLog(agentId, message, kind, at)] }));
  }

  function handleApiEvent(taskId: string, event: RunEvent) {
    updateTask(taskId, task => reduceTask(task, event));
    // Сотрудники на сцене — только для задачи, которая идёт сейчас.
    if (event.type === 'agent-status' && event.agentId && event.status) {
      updateAgent(event.agentId, agent => ({ ...agent, status: event.status!, task: event.task || agent.task }));
    } else if (event.type === 'plan') {
      const assigned = new Set((event.subtasks || []).map(subtask => subtask.agentId));
      setAgents(current => current.map(agent => agent.id === 'ceo'
        ? { ...agent, status: 'working', task: 'Координирует команду' }
        : assigned.has(agent.id) ? agent : { ...agent, status: 'idle', task: 'Не назначен в этой задаче' }));
    } else if (event.type === 'agent-start' && event.agentId && event.title) {
      updateAgent(event.agentId, agent => ({ ...agent, task: event.title!, status: 'working' }));
    } else if (event.type === 'agent-chat' && event.agentId && event.text) {
      // Реплика видна и на сцене — в подписи сотрудника.
      const to = initialAgents.find(agent => agent.id === event.to)?.name;
      updateAgent(event.agentId, agent => ({ ...agent, task: `${to ? `→ ${to}: ` : ''}${event.text}` }));
    } else if (event.type === 'review-start') {
      updateAgent('ceo', agent => ({ ...agent, status: 'thinking', task: event.message || 'Проверяет результаты команды' }));
    } else if (event.type === 'done') {
      updateAgent('ceo', agent => ({ ...agent, status: 'done', task: 'Итоговый отчёт готов' }));
      finishLocally(taskId);
    } else if (event.type === 'error') {
      setAgents(current => current.map(agent => agent.id !== 'ceo' && (agent.status === 'working' || agent.status === 'thinking')
        ? { ...agent, status: 'idle', task: 'Выполнение остановлено' } : agent));
      updateAgent('ceo', agent => ({ ...agent, status: 'error', task: 'Нужна проверка ошибки' }));
      finishLocally(taskId);
    }
  }

  function finishLocally(taskId: string) {
    if (activeTaskRef.current !== taskId) return;
    setIsRunning(false);
    activeTaskRef.current = null;
    abortRef.current = null;
  }

  /**
   * Подключается к задаче на сервере и проигрывает все её события с начала.
   * Задача живёт на сервере, поэтому после перезагрузки страницы или обрыва связи
   * достаточно подключиться заново: состояние задачи и сотрудников собирается из событий.
   */
  async function followRun(taskId: string, runId: string, token = { cancelled: false }) {
    activeTaskRef.current = taskId;
    setIsRunning(true);
    for (let attempt = 0; attempt <= RECONNECT_ATTEMPTS; attempt++) {
      if (token.cancelled || activeTaskRef.current !== taskId) return;
      const controller = new AbortController();
      abortRef.current = controller;
      updateTask(taskId, resetTask);
      setAgents(initialAgents);
      try {
        const response = await fetch(`/api/runs/${runId}/events?after=0`, { signal: controller.signal });
        if (response.status === 404) {
          updateTask(taskId, task => ({ ...task, status: 'error', result: 'Задача не найдена на сервере: история очищена или задача старше последних 50.' }));
          finishLocally(taskId);
          return;
        }
        if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        const consumeBlock = (block: string) => {
          const dataLines = block.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trim());
          if (!dataLines.length) return;
          try { handleApiEvent(taskId, JSON.parse(dataLines.join('\n')) as RunEvent); } catch { /* ignore malformed event */ }
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
        // done/error уже сняли activeTaskRef — задача завершена.
        if (activeTaskRef.current !== taskId) return;
      } catch {
        if (token.cancelled || controller.signal.aborted || activeTaskRef.current !== taskId) return;
      }
      // Связь оборвалась, а задача на сервере продолжается: переподключаемся.
      await sleep(RECONNECT_DELAY_MS);
    }
    updateTask(taskId, task => ({ ...task, status: 'error', result: task.result || 'Нет связи с сервером. Задача, возможно, продолжается — обнови страницу позже.' }));
    finishLocally(taskId);
  }

  // При открытии страницы: подгрузить с сервера задачи, которых нет в этом браузере (история data/runs),
  // и подключиться к незавершённой задаче.
  useEffect(() => {
    const token = { cancelled: false };
    void (async () => {
      let restored: OfficeTask[] = [];
      try {
        const { runs = [] } = await (await fetch('/api/runs')).json() as { runs?: Array<{ id: string }> };
        const known = new Set(tasks.map(task => task.runId).filter(Boolean));
        for (const { id } of runs.filter(run => !known.has(run.id))) {
          const response = await fetch(`/api/runs/${id}`);
          if (response.ok) restored.push(taskFromRun(await response.json() as ServerRun));
        }
      } catch { restored = []; /* сервер недоступен — показываем то, что есть в браузере */ }
      if (token.cancelled) return;
      const merged = mergeHistory(tasks, restored);
      setTasks(merged);
      const unfinished = merged.find(task => RUNNING_STATUSES.includes(task.status));
      if (!unfinished) return;
      if (unfinished.runId) {
        void followRun(unfinished.id, unfinished.runId, token);
      } else {
        // Задача из старой версии (до /api/runs) жила в соединении и прервалась вместе со страницей.
        updateTask(unfinished.id, task => ({ ...task, status: 'error', result: task.result || 'Задача была прервана перезагрузкой страницы.' }));
      }
    })();
    // В StrictMode эффект запускается дважды: очистка обрывает первое подключение, второе начинает заново.
    return () => { token.cancelled = true; abortRef.current?.abort(); };
    // Только при первом открытии страницы.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function repeatTask(task: OfficeTask) {
    setPrompt(task.title);
    promptRef.current?.focus();
    promptRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  async function deleteTask(task: OfficeTask) {
    if (task.runId) {
      try { await fetch(`/api/runs/${task.runId}`, { method: 'DELETE' }); } catch { /* удалим хотя бы из браузера */ }
    }
    setTasks(current => current.filter(item => item.id !== task.id));
  }

  async function submitTask(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const title = prompt.trim();
    if (!title || isRunning || settingsBusy || settingsDirty || apiConfigured !== true) return;
    const taskId = crypto.randomUUID();
    const task: OfficeTask = {
      id: taskId,
      title,
      agentId: 'ceo',
      status: 'planning',
      createdAt: clockNow(),
      startedAt: new Date().toISOString(),
      subtasks: [],
      logs: [makeLog('ceo', 'Задача принята. CEO готовит план и распределяет работу.')]
    };
    setTasks(current => [task, ...current]);
    setPrompt('');
    setIsRunning(true);
    activeTaskRef.current = taskId;
    try {
      const response = await fetch('/api/runs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ goal: title })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.runId) throw new Error(data.error || `HTTP ${response.status}`);
      updateTask(taskId, current => ({ ...current, runId: data.runId }));
      await followRun(taskId, data.runId);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Неизвестная ошибка.';
      updateTask(taskId, current => ({ ...current, status: 'error', result: `Не удалось выполнить задачу: ${message}` }));
      addLog(taskId, 'ceo', `Ошибка выполнения: ${message}`, 'warning');
      updateAgent('ceo', agent => ({ ...agent, status: 'error', task: 'Не удалось завершить задачу' }));
      finishLocally(taskId);
    }
  }

  async function stopTask() {
    const currentTaskId = activeTaskRef.current;
    const runId = tasks.find(task => task.id === currentTaskId)?.runId;
    // Сервер сам отправит событие об остановке; ждём его в текущем потоке.
    if (runId) {
      try {
        await fetch(`/api/runs/${runId}/cancel`, { method: 'POST' });
        return;
      } catch { /* сервер недоступен — останавливаем локально */ }
    }
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
          <div><p className="eyebrow">ЦЕЛИ → ПЛАН → РАБОТА КОМАНДЫ → ПРОВЕРКА</p><h1>Офис агентов</h1><p className="subheading">CEO сразу раздаёт задания. Каждый специалист выполняет только своё, CEO сводит настоящие результаты в итоговый отчёт.</p></div>
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
            <div className="scene-frame"><div ref={gameHost} className="game-host" />{sceneState !== 'ready' && <div className="scene-placeholder" role="status">{sceneState === 'error' ? 'Не удалось загрузить сцену офиса. Работа команды и задачи не затронуты.' : 'Загрузка сцены офиса…'}</div>}</div>
            <div className="legend"><span><i className="dot idle" />Ожидает</span><span><i className="dot working" />Работает</span><span><i className="dot done" />Готово</span><span><i className="dot error" />Ошибка</span></div>
          </section>

          <aside className="side-column">
            <section className="panel agents-panel">
              <div className="panel-header"><div><span className="panel-kicker">TEAM STATUS</span><h2>Команда</h2></div><span className="count-pill">{agents.length}</span></div>
              <div className="agent-list">
                {agents.map(agent => <button key={agent.id} className={`agent-row agent-${agent.status} ${selectedAgent === agent.id ? 'selected' : ''}`} onClick={() => setSelectedAgent(agent.id)}>
                  <span className="agent-avatar" style={{ background: agent.color }}>{agent.name.split(' ')[1]}</span>
                  <span className="agent-copy"><strong>{agent.name}{agent.id === 'ceo' ? ' · CEO' : ''}</strong><small>{agent.role}</small><small className="agent-task">{agent.task}</small></span>
                  <span className={`status-tag ${agent.status}`}><i />{agentStatusLabel[agent.status]}</span>
                </button>)}
              </div>
              <div className="agent-focus"><small>ВЫБРАННЫЙ СОТРУДНИК</small><strong>{selectedAgentInfo.name} · {selectedAgentInfo.role}</strong><p>{selectedAgentInfo.id === 'ceo' ? 'Принимает твою цель, распределяет подзадачи, собирает результаты и проверяет итог.' : 'Получает от CEO отдельное задание и пишет только свою часть. В режиме связанной работы получает готовые данные коллег; в параллельном работает над своей частью сразу.'}</p></div>
            </section>

            <section className="panel task-panel">
              <div className="panel-header"><div><span className="panel-kicker">TASK DISPATCH</span><h2>Поставить цель CEO</h2></div><span className="paper-icon">↗</span></div>
              <div className="work-settings">
                <strong>Как работает команда</strong>
                <div className="work-settings-fields">
                  <label>Режим<select aria-label="Режим работы команды" value={workMode} onChange={event => { setWorkMode(event.target.value); setSettingsDirty(true); setSettingsMessage('Нажми «Применить режим» перед запуском задачи.'); }} disabled={isRunning || settingsBusy}>
                    <option value="parallel">Все начинают сразу</option>
                    <option value="handoff">С передачей данных коллегам</option>
                  </select></label>
                  <label>Одновременно<select aria-label="Число одновременных запросов" value={concurrency} onChange={event => { setConcurrency(Number(event.target.value)); setSettingsDirty(true); setSettingsMessage('Нажми «Применить режим» перед запуском задачи.'); }} disabled={isRunning || settingsBusy}>
                    {[1, 2, 3, 4, 5].map(n => <option key={n} value={n}>{n} {n === 1 ? 'запрос' : n === 5 ? 'запросов' : 'запроса'}</option>)}
                  </select></label>
                </div>
                <button type="button" onClick={() => void applyWorkSettings()} disabled={isRunning || settingsBusy || !apiConfigured}>{settingsBusy ? 'Применяем…' : 'Применить режим'}</button>
                <small>{workMode === 'parallel' ? 'Независимые части выполняются одновременно, CEO собирает общий итог.' : 'Сотрудник ждёт только тех коллег, чьи результаты нужны для его части.'}</small>
                {provider === 'ollama' && <small>Локальная модель тоже должна поддерживать несколько одновременных запросов; число слотов само по себе не ускоряет CPU.</small>}
                {settingsMessage && <p role="status">{settingsMessage}</p>}
              </div>
              <form onSubmit={submitTask} className="task-form">
                <div className="ceo-route"><span className="ceo-route-icon">C</span><span><strong>CEO · Luma 1</strong><small>Сам назначит специалистов и приоритеты</small></span></div>
                <label htmlFor="task-prompt">КАКОЙ РЕЗУЛЬТАТ НУЖЕН?</label>
                <textarea id="task-prompt" ref={promptRef} value={prompt} onChange={event => setPrompt(event.target.value)} placeholder="Например: проверь спрос на услугу для малого бизнеса в Эстонии, подготовь предложение и план привлечения первого клиента…" rows={5} maxLength={5000} />
                <div className="prompt-meta"><span>Можно адресовать задания: «Luma 4 — слоган»</span><span>{prompt.length}/5000</span></div>
                <button className="dispatch-button" type="submit" disabled={!prompt.trim() || isRunning || settingsBusy || settingsDirty || apiConfigured !== true}><span>{isRunning ? 'Команда выполняет задачу…' : 'Передать цель CEO'}</span><span>↗</span></button>
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
              const subtasks = task.subtasks || [];
              const finished = subtasks.filter(item => item.status === 'done').length;
              const working = RUNNING_STATUSES.includes(task.status) ? subtasks.filter(item => item.status === 'working').length : 0;
              const failed = subtasks.filter(item => item.status === 'error').length;
              return <article className="task-item task-item-expanded" key={task.id}>
                <span className={`task-state ${task.status}`} />
                <div className="task-item-copy">
                  <div className="task-title-line"><strong>{task.title}</strong><span className={`status-tag ${task.status}`}>{taskStatusLabel[task.status]}</span></div>
                  <small>{ceo?.name || 'CEO'} · {task.createdAt}</small>
                  {!RUNNING_STATUSES.includes(task.status) && <div className="task-actions">
                    <button type="button" onClick={() => repeatTask(task)} disabled={isRunning} title="Подставить текст задачи в поле, чтобы запустить заново">Повторить</button>
                    <button type="button" onClick={() => void deleteTask(task)} title="Удалить из истории в браузере и на сервере">Удалить</button>
                  </div>}
                  {subtasks.length > 0 && <div className="team-progress">
                    <div><strong>{finished} из {subtasks.length} готово</strong><span>{working} работают · {subtasks.length - finished - working - failed} {RUNNING_STATUSES.includes(task.status) ? 'ожидают' : 'не завершены'}{failed ? ` · ${failed} с ошибкой` : ''}</span></div>
                    <progress aria-label="Завершённые подзадачи" value={finished} max={subtasks.length} />
                  </div>}
                  {task.planSummary && <div className="plan-summary"><strong>План CEO</strong><p>{task.planSummary}</p></div>}
                  {(task.subtasks || []).length > 0 && <div className="subtask-list"><h3>Назначенные подзадачи</h3>{task.subtasks!.map(subtask => {
                    const agent = agents.find(item => item.id === subtask.agentId);
                    return <details className="subtask-card" key={subtask.id} open={subtask.status === 'working' || subtask.status === 'error'}>
                      <summary><span className={`subtask-indicator ${subtask.status}`} /><span className="subtask-heading"><strong>{agent ? `${agent.name} · ${agent.role}` : subtask.agentId}</strong><small>{subtask.title}</small></span><span className={`mini-status ${subtask.status}`}>{subtask.status === 'queued' ? 'В очереди' : subtask.status === 'working' ? 'Работает' : subtask.status === 'done' ? 'Готово' : 'Ошибка'}</span></summary>
                      <p className="subtask-objective">{subtask.objective}</p>
                      {!subtask.result && subtask.draft && <div className="agent-result agent-draft" aria-live="polite">
                        <strong>{agent?.name || subtask.agentId} пишет…</strong>
                        <pre>{subtask.draft}<span className="draft-cursor">▍</span></pre>
                      </div>}
                      {subtask.result && <div className="agent-result">
                        <strong>Результат {agent?.name || subtask.agentId}{subtask.stats ? <small className="result-stats"> · {formatStats(subtask.stats)}</small> : null}</strong>
                        {(subtask.handoffFrom || []).length > 0 && <p className="result-handoff">↳ Использованы данные от {subtask.handoffFrom!.map(id => agents.find(item => item.id === id)?.name || id).join(', ')}.</p>}
                        {(subtask.foreign || []).length > 0 && <p className="result-warning">⚠ В ответе упомянуты {subtask.foreign!.join(', ')}. Это текст {agent?.name}, а не их результаты.</p>}
                        <pre>{subtask.result}</pre>
                      </div>}
                    </details>;
                  })}</div>}
                  {(task.chat || []).length > 0 && <div className="team-chat"><h3>Обсуждение команды</h3>{task.chat!.map(line => {
                    const agent = agents.find(item => item.id === line.agentId);
                    const to = agents.find(item => item.id === line.to);
                    return <div className="chat-line" key={line.id}><time>{line.time}</time><strong>{agent?.name || line.agentId}{to ? ` → ${to.name}` : ''}</strong><span>{line.text}</span></div>;
                  })}</div>}
                  {task.planSummary && <div className="document-actions"><button type="button" onClick={() => downloadDocumentation(task)}>{task.result ? '↓ Скачать документацию CEO (.md)' : '↓ Скачать текущее ТЗ (.md)'}</button><small>Цель, задания, результаты и итог в одном документе</small></div>}
                  {task.result && <details className="final-result" open><summary>Итоговый отчёт CEO</summary><pre>{task.result}</pre></details>}
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
