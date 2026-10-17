import Phaser from 'phaser';
import type { Agent } from './types';

type SceneData = { agents: Agent[] };

export class OfficeScene extends Phaser.Scene {
  private agentSprites = new Map<string, Phaser.GameObjects.Container>();
  private statusLabels = new Map<string, Phaser.GameObjects.Text>();
  private initialized = false;

  constructor() {
    super('OfficeScene');
  }

  create(data: SceneData) {
    this.cameras.main.setBackgroundColor('#c9c6ba');
    this.drawFloor();
    this.drawRoomDetails();
    data.agents.forEach(agent => this.drawDesk(agent));
    this.scale.on('resize', () => this.drawRoomDetails());
    this.initialized = true;
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
    const person = this.add.container(x, y - 31);
    const p = this.add.graphics();
    p.fillStyle(0x000000, 0.15); p.fillRect(-15, 31, 30, 5);
    p.fillStyle(0x25272b, 1); p.fillRect(-10, 17, 20, 19);
    p.fillStyle(0x343a40, 1); p.fillRect(-13, 19, 7, 17); p.fillRect(6, 19, 7, 17);
    p.fillStyle(0xe0b18d, 1); p.fillRect(-9, 0, 18, 17);
    p.fillStyle(0x49382e, 1); p.fillRect(-10, -4, 20, 7); p.fillRect(-10, 1, 4, 5);
    p.fillStyle(0x292929, 1); p.fillRect(-5, 7, 3, 3); p.fillRect(4, 7, 3, 3);
    p.fillStyle(0xf1d0b0, 1); p.fillRect(-3, 12, 7, 2);
    p.fillStyle(Phaser.Display.Color.HexStringToColor(agent.color).color, 1); p.fillRect(-11, 18, 22, 12);
    person.add(p);
    this.agentSprites.set(agent.id, person);

    const label = this.add.text(x, y - 69, `${agent.name} · ${this.statusText(agent.status)}`, {
      fontFamily: 'monospace', fontSize: '11px', color: '#f3f4ef',
      backgroundColor: '#20252bcc', padding: { x: 7, y: 5 }
    }).setOrigin(0.5);
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
    const sprite = this.agentSprites.get(agent.id);
    if (!sprite) return;
    this.tweens.killTweensOf(sprite);
    if (agent.status === 'working' || agent.status === 'thinking') {
      this.tweens.add({ targets: sprite, y: agent.y - 33, duration: 480, yoyo: true, repeat: -1 });
    } else {
      sprite.y = agent.y - 31;
    }
  }
}
