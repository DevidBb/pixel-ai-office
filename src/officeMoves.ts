// Пробежки сотрудников к CEO на сцене офиса. Чистые функции без Phaser: какие события
// вызывают пробежку и по какому маршруту бежать. Сцена (OfficeScene) только проигрывает их.
import type { RunEvent } from './types';

export type Point = { x: number; y: number };

/** Насколько фигурка сотрудника стоит выше центра своего стола. */
export const PERSON_LIFT = 31;
/** Проход между верхним и нижним рядом столов: по нему бегают, чтобы не перелезать через чужие столы. */
export const CORRIDOR_Y = 375;
/** Шаг в сторону от своего стола перед тем, как бежать (половина стола и ещё немного). */
export const DESK_SIDE = 95;
/** Скорость бега, пикселей в секунду. */
export const RUN_SPEED = 300;

/** Место у стола CEO для каждого сотрудника: справа от стола и перед ним, чтобы не стоять друг на друге. */
export const CEO_SPOTS: Record<string, Point> = {
  research: { x: 300, y: 196 },
  product: { x: 345, y: 262 },
  creator: { x: 95, y: 372 },
  sales: { x: 165, y: 372 },
  finance: { x: 235, y: 372 }
};

export type SceneCue =
  | { kind: 'briefing'; agentIds: string[] }
  | { kind: 'deliver'; agentId: string; failed: boolean }
  | { kind: 'report'; agentIds: string[] };

/**
 * Что показать на сцене в ответ на событие задачи: сотрудники бегут к CEO за заданием (plan),
 * относят результат или сообщают о неудаче (agent-result / agent-error), собираются на итоговый отчёт (final).
 * `historyUntil` — номер последнего события, которое уже было на сервере, когда страница открылась:
 * такие события — история, их не проигрываем (часы браузера и сервера для этого не нужны).
 * `seen` — ключи уже показанных событий: при переподключении сервер присылает все события заново.
 */
export function cueForEvent(event: RunEvent, { historyUntil = 0, seen, key }: { historyUntil?: number; seen?: Set<string>; key?: string } = {}): SceneCue | null {
  const cue = rawCue(event);
  if (!cue) return null;
  if (typeof event.seq === 'number' && event.seq <= historyUntil) return null;
  if (seen && key) {
    if (seen.has(key)) return null;
    seen.add(key);
  }
  return cue;
}

/**
 * Граница истории для задачи, к которой страница подключается при открытии (по строке из GET /api/runs).
 * У идущей задачи история — события до lastSeq; у завершённой — всё; задачи нет в списке — тоже всё.
 */
export function historyBoundary(run?: { status?: string; lastSeq?: number }) {
  if (!run || run.status !== 'running') return Number.MAX_SAFE_INTEGER;
  return Number(run.lastSeq) || 0;
}

function rawCue(event: RunEvent): SceneCue | null {
  switch (event.type) {
    case 'plan': {
      const agentIds = unique((event.subtasks || []).map(subtask => subtask.agentId).filter(id => id && id !== 'ceo'));
      return agentIds.length ? { kind: 'briefing', agentIds } : null;
    }
    case 'agent-result':
    case 'agent-error':
      return event.agentId && event.agentId !== 'ceo' ? { kind: 'deliver', agentId: event.agentId, failed: event.type === 'agent-error' } : null;
    case 'final':
      return { kind: 'report', agentIds: unique((event.completedAgents || []).filter(id => id !== 'ceo')) };
    default:
      return null;
  }
}

/**
 * Маршрут от места сотрудника (`home`) до его места у CEO (`spot`), без конечной точки `home`.
 * Сначала шаг в сторону от своего стола; если на пути по своему ряду нет чужого стола — сразу к CEO,
 * иначе через проход между рядами. Обратный путь — тот же маршрут задом наперёд.
 */
export function pathToCeo(home: Point, spot: Point, desks: Point[] = []): Point[] {
  const points: Point[] = [];
  let { x, y } = home;
  const topRow = home.y < CORRIDOR_Y;
  if (topRow) {
    x = home.x + (spot.x < home.x ? -DESK_SIDE : DESK_SIDE);
    points.push({ x, y });
    const left = Math.min(x, spot.x);
    const right = Math.max(x, spot.x);
    const blocked = desks.some(desk => Math.abs(desk.y - PERSON_LIFT - home.y) < 40 && desk.x !== home.x && desk.x > left && desk.x < right);
    const sameRow = spot.y < CORRIDOR_Y - 60;
    if (!blocked && sameRow) {
      points.push(spot);
      return dedupe(points);
    }
  }
  y = CORRIDOR_Y;
  points.push({ x, y }, { x: spot.x, y }, spot);
  return dedupe(points);
}

/** Длительность каждого отрезка маршрута при беге со скоростью RUN_SPEED. */
export function segmentDurations(from: Point, points: Point[], speed = RUN_SPEED): number[] {
  let previous = from;
  return points.map(point => {
    const ms = Math.round(Math.hypot(point.x - previous.x, point.y - previous.y) / speed * 1000);
    previous = point;
    return Math.max(ms, 60);
  });
}

function unique(ids: string[]) {
  return [...new Set(ids)];
}

function dedupe(points: Point[]) {
  return points.filter((point, index) => index === 0 || point.x !== points[index - 1].x || point.y !== points[index - 1].y);
}
