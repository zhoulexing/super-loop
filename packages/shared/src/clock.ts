import type { Clock } from '@super-loop/protocol';

export const systemClock: Clock = {
  now: () => Date.now(),
  iso: () => new Date().toISOString(),
};
