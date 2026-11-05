import type { Clock } from '@super-loop/protocol';

/** 可控时钟。默认起点 2026-01-01T00:00:00Z。 */
export class FakeClock implements Clock {
  #now: number;

  constructor(start: number | string = '2026-01-01T00:00:00.000Z') {
    this.#now = typeof start === 'number' ? start : Date.parse(start);
  }

  now(): number {
    return this.#now;
  }

  iso(): string {
    return new Date(this.#now).toISOString();
  }

  advance(ms: number): this {
    this.#now += ms;
    return this;
  }

  set(time: number | string): this {
    this.#now = typeof time === 'number' ? time : Date.parse(time);
    return this;
  }
}
