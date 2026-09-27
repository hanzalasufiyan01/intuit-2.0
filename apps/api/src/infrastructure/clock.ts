/** Time source. Injected so expiry behavior can be tested deterministically. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };
