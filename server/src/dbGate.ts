// Keep the server up when the database isn't there yet. Supabase's free plan
// pauses a project after 7 quiet days; before this, the server stopped at
// start-up, Render restarted it, it stopped again... and nobody could play at
// all. Now the server starts anyway (guests can play, students' progress waits
// on their device) and keeps trying the database until it answers.

export interface DbGateOptions<T> {
  open: () => Promise<T>;
  /** Called once, when the database finally opens */
  onReady: (db: T) => void;
  /** Explain a failure in plain Thai (printed once per different reason) */
  explain: (err: unknown) => string;
  log?: (text: string) => void;
  /** Waits between tries, ms (the last one repeats) */
  delays?: number[];
}

/** Try now, then again and again (5 s, 15 s, 30 s, then every minute) until the database opens */
export class DbGate<T> {
  db: T | null = null;
  /** Why it isn't open yet (short, safe to show) */
  problem: string | null = null;
  tries = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastLogged = '';
  private stopped = false;

  constructor(private readonly opts: DbGateOptions<T>) {}

  get ready(): boolean {
    return this.db !== null;
  }

  /** Resolves after the first try (opened or not); later tries run in the background */
  async start(): Promise<void> {
    await this.attempt();
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  private async attempt() {
    if (this.stopped || this.db) return;
    this.tries++;
    try {
      const db = await this.opts.open();
      this.db = db;
      this.problem = null;
      if (this.tries > 1) (this.opts.log ?? console.log)(`ต่อฐานข้อมูลได้แล้ว (ลองครั้งที่ ${this.tries}) ระบบบัญชีและหน้าครูใช้งานได้ตามปกติ`);
      this.opts.onReady(db);
    } catch (err) {
      const text = this.opts.explain(err);
      this.problem = text.split('\n').find((l) => l.startsWith('สาเหตุ')) ?? 'ต่อฐานข้อมูลไม่ได้';
      // The same reason over and over would flood the log: print it when it changes
      if (text !== this.lastLogged) {
        (this.opts.log ?? console.error)(`${text}\n(เซิร์ฟเวอร์ยังเปิดอยู่: เล่นแบบไม่เข้าสู่ระบบได้ และจะลองต่อฐานข้อมูลใหม่เรื่อย ๆ)`);
        this.lastLogged = text;
      }
      const delays = this.opts.delays ?? [5_000, 15_000, 30_000, 60_000];
      const wait = delays[Math.min(this.tries - 1, delays.length - 1)];
      this.timer = setTimeout(() => void this.attempt(), wait);
      this.timer.unref?.();
    }
  }
}
