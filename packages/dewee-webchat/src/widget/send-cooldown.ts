// Cooldown after a RATE_LIMITED refusal: sending stays disabled until the gateway's retryAfterMs elapses.

export class SendCooldown {
  private until = 0;
  private tick: ReturnType<typeof setInterval> | undefined;
  private done: ReturnType<typeof setTimeout> | undefined;

  /**
   * `onTick` runs once a second while cooling down, with the whole seconds left; `onEnd` runs once
   * when sending is allowed again.
   */
  constructor(private onTick: (secondsLeft: number) => void, private onEnd: () => void) {}

  get active(): boolean {
    return Date.now() < this.until;
  }

  get secondsLeft(): number {
    return Math.max(0, Math.ceil((this.until - Date.now()) / 1000));
  }

  /** Starts (or extends) the cooldown; a shorter one never cuts a running one short. */
  start(ms: number): void {
    const until = Date.now() + Math.max(0, ms);
    if (until <= this.until) return;
    this.until = until;
    this.clear();
    this.tick = setInterval(() => this.onTick(this.secondsLeft), 1000);
    this.done = setTimeout(() => {
      this.until = 0; // ends on elapsed time, even if the wall clock moved back meanwhile
      this.clear();
      this.onEnd();
    }, until - Date.now());
  }

  private clear(): void {
    clearInterval(this.tick);
    clearTimeout(this.done);
  }
}
