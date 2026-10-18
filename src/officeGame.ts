// Сцена офиса на Phaser. Модуль загружается динамически (import()), чтобы ~1,5 МБ движка
// не задерживали появление интерфейса задач.
import Phaser from 'phaser';
import { OfficeScene } from './OfficeScene';
import type { Agent } from './types';

/** Создаёт игру в `parent`; getAgents() отдаёт актуальных сотрудников на момент готовности сцены. */
export function createOfficeGame(parent: HTMLElement, getAgents: () => Agent[], onReady: (scene: OfficeScene) => void) {
  const game = new Phaser.Game({
    type: Phaser.CANVAS,
    parent,
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
        game.scene.add('office', scene, true, { agents: getAgents() });
        onReady(scene);
      }
    }
  });
  return () => game.destroy(true);
}
