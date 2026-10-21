import Phaser from 'phaser';
import type { Agent } from './types';
import { CEO_SPOTS, PERSON_LIFT, pathToCeo, segmentDurations } from './officeMoves';
import type { Point, SceneCue } from './officeMoves';

type SceneData = { agents: Agent[] };

/** Сотрудник на сцене: контейнер бегает по офису, фигурка внутри покачивается, пока он работает. */
type Person = {
  name: string;
  container: Phaser.GameObjects.Container;
  figure: Phaser.GameObjects.Graphics;
  paper: Phaser.GameObjects.Graphics;
  home: Point;
  status: Agent['status'];
  running: boolean;
  /** Стоит у стола CEO (между пробежкой туда и обратно). */
  atCeo: boolean;
  /** Текущая пробежка: при новой задаче её обрывают. */
  chain?: Phaser.Tweens.TweenChain;
};

// Порядок отрисовки: столы → сотрудники на месте → подписи → бегущие сотрудники.
const DEPTH_AT_DESK = 5;
const DEPTH_LABEL = 10;
const DEPTH_RUNNING = 30;
// Сколько CEO держит итоговый отчёт перед командой.
const REPORT_HOLD_MS = 4500;
// Пробежка прежней задачи прервана началом новой: задание в очереди дальше не идёт.
const STALE = new Error('stale visit');

export class OfficeScene extends Phaser.Scene {
  private people = new Map<string, Person>();
  private statusLabels = new Map<string, Phaser.GameObjects.Text>();
  private bubbles = new Map<string, Phaser.GameObjects.Text>();
  // Очередь пробежек каждого сотрудника: новая начинается, когда он вернулся с прошлой.
  private visits = new Map<string, Promise<void>>();
  private desks: Point[] = [];
  // Кого CEO ждёт на итоговый отчёт: сдав результат, они остаются у CEO, а не бегают к себе и обратно.
  private reportCrew = new Set<string>();
  private inbox?: Phaser.GameObjects.Graphics;
  private ceoDesk?: Point;
  private inboxCount = 0;
  private initialized = false;
  // Номер задачи на сцене: растёт при каждом новом распределении заданий. Пробежки прежней задачи
  // по нему видят, что их прервали, и не трогают сцену новой.
  private epoch = 0;
  private abortRuns = new Set<() => void>();
  private startEpoch: () => void = () => {};
  // Выполняется, когда начинается следующая задача.
  private nextEpoch: Promise<void> = this.epochSignal();

  constructor() {
    super('OfficeScene');
  }

  create(data: SceneData) {
    this.cameras.main.setBackgroundColor('#c9c6ba');
    this.drawFloor();
    this.drawRoomDetails();
    this.desks = data.agents.map(agent => ({ x: agent.x, y: agent.y }));
    data.agents.forEach(agent => this.drawDesk(agent));
    this.scale.on('resize', () => this.drawRoomDetails());
    this.initialized = true;
    // Сцена могла загрузиться, когда задача уже идёт: сразу показать текущие статусы.
    data.agents.forEach(agent => this.updateAgent(agent));
  }

  private drawFloor() {
    const g = this.add.graphics();
    g.fillStyle(0xd0cdc2, 1);
    g.fillRect(0, 0, 1000, 700);
    g.lineStyle(1, 0xbcb9ae, 0.65);
    for (let x = 0; x < 1000; x += 100) g.lineBetween(x, 0, x, 700);
    for (let y = 0; y < 700; y += 100) g.lineBetween(0, y, 1000, y);
    g.fillStyle(0x000000, 0.08);
    g.fillRect(0, 0, 1000, 18);
  }

  private drawRoomDetails() {
    const g = this.add.graphics();
    g.clear();
    g.fillStyle(0x303840, 1); g.fillRect(68, 25, 230, 100);
    g.fillStyle(0xe0e7e8, 1); g.fillRect(77, 34, 212, 82);
    g.lineStyle(5, 0x515b63, 1);
    g.lineBetween(183, 34, 183, 116); g.lineBetween(77, 75, 289, 75);
    g.fillStyle(0x70513a, 1); g.fillRect(365, 28, 205, 110);
    for (let y = 35; y < 130; y += 30) {
      g.fillStyle(0x9b7954, 1); g.fillRect(371, y + 20, 193, 5);
      for (let x = 378; x < 556; x += 18) {
        const colors = [0x52636a, 0x8b6848, 0xb4a88c, 0x65745e, 0x4a4e59];
        g.fillStyle(colors[Math.floor((x + y) / 18) % colors.length], 1);
        g.fillRect(x, y, 11, 20);
      }
    }
    [190, 390].forEach(y => {
      g.fillStyle(0x8d9292, 1); g.fillRect(20, y, 64, 100);
      g.fillStyle(0xbcc0be, 1); g.fillRect(24, y + 4, 56, 29);
      g.fillRect(24, y + 36, 56, 28); g.fillRect(24, y + 67, 56, 29);
      g.fillStyle(0x707879, 1); g.fillRect(45, y + 16, 13, 3);
      g.fillRect(45, y + 47, 13, 3); g.fillRect(45, y + 78, 13, 3);
    });
    g.fillStyle(0x171d23, 1); g.fillRect(635, 22, 330, 82);
    g.fillStyle(0x8ad6ae, 1); g.fillRect(655, 43, 6, 6);
    g.fillStyle(0xd8e1e3, 1); g.fillRect(669, 42, 70, 4);
    g.fillStyle(0x3c5550, 1); g.fillRect(655, 61, 290, 2);
    for (let i = 0; i < 12; i++) {
      g.fillStyle(i % 3 === 0 ? 0x79d9b0 : 0x658e91, 1);
      g.fillRect(675 + i * 19, 77 - ((i * 13) % 34), 8, 27 + ((i * 13) % 34));
    }
  }

  private drawDesk(agent: Agent) {
    const x = agent.x;
    const y = agent.y;
    const g = this.add.graphics();
    g.fillStyle(0x000000, 0.14); g.fillRect(x - 78, y - 2, 156, 70);
    g.fillStyle(0x44372e, 1); g.fillRect(x - 69, y + 43, 8, 22); g.fillRect(x + 61, y + 43, 8, 22);
    g.fillStyle(0x806044, 1); g.fillRect(x - 78, y - 12, 156, 58);
    g.fillStyle(0x967451, 1); g.fillRect(x - 74, y - 9, 148, 49);
    g.fillStyle(0x50585b, 1); g.fillRect(x - 68, y + 1, 23, 20);
    g.fillStyle(0x7e9291, 1); g.fillRect(x - 64, y + 5, 15, 11);
    g.fillStyle(0xe4e0d4, 1); g.fillRect(x + 49, y + 2, 18, 12);
    g.fillStyle(0x252a2d, 1); g.fillRect(x - 34, y + 40, 68, 39);
    g.fillStyle(0x121b20, 1); g.fillRect(x - 29, y + 45, 58, 27);
    g.fillStyle(0x77d7b0, 1); g.fillRect(x - 24, y + 50, 28, 3);
    g.fillStyle(0x91a8b1, 1); g.fillRect(x - 24, y + 57, 43, 2);
    g.fillRect(x - 24, y + 63, 34, 2);
    g.fillStyle(0x45494a, 1); g.fillRect(x - 4, y + 78, 8, 8);
    if (agent.id === 'ceo') {
      // Стопка сданных результатов на столе CEO.
      this.inbox = this.add.graphics().setDepth(1);
      this.ceoDesk = { x, y };
    }
    const container = this.add.container(x, y - PERSON_LIFT).setDepth(DEPTH_AT_DESK);
    const p = this.add.graphics();
    p.fillStyle(0x000000, 0.15); p.fillRect(-15, 31, 30, 5);
    p.fillStyle(0x25272b, 1); p.fillRect(-10, 17, 20, 19);
    p.fillStyle(0x343a40, 1); p.fillRect(-13, 19, 7, 17); p.fillRect(6, 19, 7, 17);
    p.fillStyle(0xe0b18d, 1); p.fillRect(-9, 0, 18, 17);
    p.fillStyle(0x49382e, 1); p.fillRect(-10, -4, 20, 7); p.fillRect(-10, 1, 4, 5);
    p.fillStyle(0x292929, 1); p.fillRect(-5, 7, 3, 3); p.fillRect(4, 7, 3, 3);
    p.fillStyle(0xf1d0b0, 1); p.fillRect(-3, 12, 7, 2);
    p.fillStyle(Phaser.Display.Color.HexStringToColor(agent.color).color, 1); p.fillRect(-11, 18, 22, 12);
    // Лист с результатом в руке: виден, пока сотрудник несёт его CEO.
    const paper = this.add.graphics();
    paper.fillStyle(0xf7f5ec, 1); paper.fillRect(9, 12, 11, 14);
    paper.fillStyle(0x9aa3a8, 1); paper.fillRect(11, 15, 7, 1); paper.fillRect(11, 18, 7, 1); paper.fillRect(11, 21, 5, 1);
    paper.setVisible(false);
    container.add([p, paper]);
    this.people.set(agent.id, {
      name: agent.name, container, figure: p, paper,
      home: { x, y: y - PERSON_LIFT }, status: agent.status, running: false, atCeo: false
    });

    const label = this.add.text(x, y - 69, `${agent.name} · ${this.statusText(agent.status)}`, {
      fontFamily: 'monospace', fontSize: '11px', color: '#f3f4ef',
      backgroundColor: '#20252bcc', padding: { x: 7, y: 5 }
    }).setOrigin(0.5).setDepth(DEPTH_LABEL);
    this.statusLabels.set(agent.id, label);
    this.add.text(x, y + 91, agent.role.toUpperCase(), {
      fontFamily: 'monospace', fontSize: '9px', color: '#5b5b54', letterSpacing: 1
    }).setOrigin(0.5).setAlpha(0.9);
  }

  private statusText(status: Agent['status']) {
    return ({ idle: 'ОЖИДАЕТ', working: 'РАБОТАЕТ', thinking: 'ДУМАЕТ', done: 'ГОТОВО', error: 'ОШИБКА' })[status];
  }

  updateAgent(agent: Agent) {
    if (!this.initialized) return;
    const label = this.statusLabels.get(agent.id);
    if (label) label.setText(`${agent.name} · ${this.statusText(agent.status)}`);
    const person = this.people.get(agent.id);
    if (!person) return;
    person.status = agent.status;
    this.animateFigure(person);
  }

  /**
   * Показывает пробежку к CEO по событию задачи. Promise выполняется, когда CEO объявил итоговый отчёт.
   * quiet — вкладка в фоне: без пробежек, но новая задача всё равно начинается с чистой сцены, а стопка листов растёт.
   */
  playCue(cue: SceneCue, { quiet = false }: { quiet?: boolean } = {}): Promise<void> {
    if (!this.initialized) return Promise.resolve();
    if (quiet) {
      if (cue.kind === 'briefing') this.resetVisits();
      if (cue.kind === 'deliver' && !cue.failed) {
        this.inboxCount++;
        this.drawInbox();
      }
      return Promise.resolve();
    }
    switch (cue.kind) {
      case 'briefing': this.briefing(cue.agentIds); return Promise.resolve();
      case 'deliver': this.deliver(cue.agentId, cue.failed); return Promise.resolve();
      case 'report': return this.report(cue.agentIds);
    }
  }

  /** Покачивание: быстрое на бегу, медленное за работой, без движения в остальное время. */
  private animateFigure(person: Person) {
    this.tweens.killTweensOf(person.figure);
    person.figure.y = 0;
    if (person.running) {
      this.tweens.add({ targets: person.figure, y: -3, duration: 110, yoyo: true, repeat: -1 });
    } else if (person.status === 'working' || person.status === 'thinking') {
      this.tweens.add({ targets: person.figure, y: -2, duration: 480, yoyo: true, repeat: -1 });
    }
  }

  private epochSignal() {
    return new Promise<void>(resolve => { this.startEpoch = resolve; });
  }

  /** Новая задача: прервать пробежки прежней и вернуть всех за столы. */
  private resetVisits() {
    this.epoch++;
    this.startEpoch();
    this.nextEpoch = this.epochSignal();
    for (const person of this.people.values()) {
      person.chain?.stop();
      person.chain = undefined;
      person.container.setPosition(person.home.x, person.home.y).setDepth(DEPTH_AT_DESK);
      person.running = false;
      person.atCeo = false;
      person.paper.setVisible(false);
      this.animateFigure(person);
    }
    // Остановленная цепочка не вызывает onComplete: отпустить ждущие её задания вручную.
    for (const abort of [...this.abortRuns]) abort();
    this.abortRuns.clear();
    for (const bubble of this.bubbles.values()) bubble.destroy();
    this.bubbles.clear();
    this.visits.clear();
    this.reportCrew = new Set();
    this.inboxCount = 0;
    this.drawInbox();
  }

  private briefing(agentIds: string[]) {
    this.resetVisits();
    this.say('ceo', 'Раздаю задания', 2600);
    agentIds.forEach((id, index) => this.enqueue(id, async () => {
      // Не всей толпой разом.
      await this.wait(index * 250);
      await this.goToCeo(id);
      this.say(id, 'Понял!', 1100);
      await this.wait(900);
      await this.goHome(id);
    }));
  }

  private deliver(agentId: string, failed: boolean) {
    this.enqueue(agentId, async () => {
      const person = this.people.get(agentId)!;
      person.paper.setVisible(!failed);
      await this.goToCeo(agentId);
      this.say(agentId, failed ? 'Не вышло…' : 'Готово, держи!', 1500);
      await this.wait(700);
      person.paper.setVisible(false);
      if (!failed) {
        this.inboxCount++;
        this.drawInbox();
      }
      this.say('ceo', failed ? `${person.name}, понял, учту` : `Принято, ${person.name}`, 1600);
      await this.wait(800);
      if (this.reportCrew.has(agentId)) return;
      await this.goHome(agentId);
    });
  }

  /** Итог: дождаться, пока все донесут результаты, собрать команду у CEO и объявить отчёт. */
  private async report(agentIds: string[]) {
    const epoch = this.epoch;
    const crew = agentIds.filter(id => this.people.has(id) && CEO_SPOTS[id]);
    this.reportCrew = new Set(crew);
    await Promise.all([...this.visits.values()]);
    if (epoch !== this.epoch) return;
    let dismiss!: () => void;
    const dismissed = new Promise<void>(resolve => { dismiss = resolve; });
    const arrivals = crew.map(id => new Promise<void>(arrived => {
      this.enqueue(id, async () => {
        if (!this.people.get(id)!.atCeo) await this.goToCeo(id);
        arrived();
        await dismissed;
        await this.goHome(id);
      });
    }));
    // Если пока команда собиралась, началась новая задача, отчёт прежней не объявляем.
    await Promise.race([Promise.all(arrivals), this.nextEpoch]);
    if (epoch !== this.epoch) return;
    const ceo = this.people.get('ceo');
    ceo?.paper.setVisible(true);
    this.say('ceo', 'Итоговый отчёт готов!', REPORT_HOLD_MS);
    if (ceo) this.tweens.add({ targets: ceo.figure, y: -5, duration: 160, yoyo: true, repeat: 2, onComplete: () => this.animateFigure(ceo) });
    this.time.delayedCall(REPORT_HOLD_MS, () => {
      if (epoch !== this.epoch) return;
      ceo?.paper.setVisible(false);
      this.reportCrew = new Set();
      dismiss();
    });
  }

  private enqueue(agentId: string, job: () => Promise<void>) {
    if (!this.people.has(agentId) || !CEO_SPOTS[agentId]) return;
    const epoch = this.epoch;
    const next = (this.visits.get(agentId) || Promise.resolve())
      .then(() => epoch === this.epoch ? job() : undefined)
      .catch(() => undefined);
    this.visits.set(agentId, next);
  }

  private async goToCeo(agentId: string) {
    const person = this.people.get(agentId)!;
    await this.run(person, pathToCeo(person.home, CEO_SPOTS[agentId], this.desks));
    person.atCeo = true;
  }

  private async goHome(agentId: string) {
    const person = this.people.get(agentId)!;
    person.atCeo = false;
    const back = [...pathToCeo(person.home, CEO_SPOTS[agentId], this.desks)].reverse().slice(1);
    await this.run(person, [...back, person.home]);
    person.container.setDepth(DEPTH_AT_DESK);
  }

  /** Бег по точкам. Отклоняется (STALE), если за это время началась новая задача. */
  private run(person: Person, points: Point[]): Promise<void> {
    if (!points.length) return Promise.resolve();
    const epoch = this.epoch;
    const durations = segmentDurations({ x: person.container.x, y: person.container.y }, points);
    person.running = true;
    person.container.setDepth(DEPTH_RUNNING);
    this.animateFigure(person);
    return new Promise((resolve, reject) => {
      const finish = () => {
        this.abortRuns.delete(finish);
        if (epoch !== this.epoch) return reject(STALE);
        person.chain = undefined;
        person.running = false;
        this.animateFigure(person);
        resolve();
      };
      this.abortRuns.add(finish);
      person.chain = this.tweens.chain({
        targets: person.container,
        tweens: points.map((point, index) => ({ x: point.x, y: point.y, duration: durations[index], ease: 'Linear' })),
        onComplete: finish
      });
    });
  }

  private say(agentId: string, text: string, ms: number) {
    const person = this.people.get(agentId);
    if (!person) return;
    this.bubbles.get(agentId)?.destroy();
    // У CEO над головой подпись статуса: реплика выше неё.
    const bubble = this.add.text(0, agentId === 'ceo' ? -62 : -22, text, {
      fontFamily: 'monospace', fontSize: '10px', color: '#20252b',
      backgroundColor: '#fbfaf3', padding: { x: 6, y: 4 }
    }).setOrigin(0.5, 1);
    person.container.add(bubble);
    this.bubbles.set(agentId, bubble);
    this.time.delayedCall(ms, () => {
      if (this.bubbles.get(agentId) === bubble) this.bubbles.delete(agentId);
      if (bubble.active) bubble.destroy();
    });
  }

  private drawInbox() {
    const ceo = this.ceoDesk;
    if (!this.inbox || !ceo) return;
    const g = this.inbox;
    g.clear();
    const sheets = Math.min(this.inboxCount, 6);
    for (let i = 0; i < sheets; i++) {
      g.fillStyle(0x7d7a70, 1); g.fillRect(ceo.x + 48, ceo.y + 1 - i * 3, 20, 14);
      g.fillStyle(i === sheets - 1 ? 0xf7f5ec : 0xe4e0d4, 1); g.fillRect(ceo.x + 49, ceo.y + 2 - i * 3, 18, 12);
    }
  }

  /** Пауза. Отклоняется (STALE), если за это время началась новая задача. */
  private wait(ms: number) {
    const epoch = this.epoch;
    return new Promise<void>((resolve, reject) => {
      this.time.delayedCall(ms, () => epoch === this.epoch ? resolve() : reject(STALE));
    });
  }
}
