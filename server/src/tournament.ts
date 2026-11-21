// A classroom knockout tournament run by the teacher: students sign up from
// the game's lobby, the teacher presses start, and the server pairs them up
// round after round (1 v 1 matches, the winner goes through) until there's a
// champion. This file is only the bracket; lobby.ts starts the actual matches.
import type { Rng, TourneyStudentView } from '@sciboom/shared';

export interface TourneyPlayer {
  /** Student id (the same student keeps their place across reconnects) */
  id: string;
  name: string;
}

export type MatchStatus = 'pending' | 'waiting' | 'playing' | 'done';

export interface TourneyMatch {
  round: number;
  index: number;
  /** Student ids; null = nobody (a bye in round 1, or not decided yet) */
  a: string | null;
  b: string | null;
  winner: string | null;
  status: MatchStatus;
  /** Room code while playing */
  code?: string;
  /** When the match became ready to play (for walkovers) */
  readySince?: number;
}

/** What the teacher's screen shows (names, not ids) */
export interface TourneyView {
  status: 'signup' | 'running' | 'done';
  quizDuel: boolean;
  players: string[];
  rounds: { a: string | null; b: string | null; winner: string | null; status: MatchStatus }[][];
  champion: string | null;
}

export const MIN_PLAYERS = 2;

export class Tournament {
  status: 'signup' | 'running' | 'done' = 'signup';
  readonly players = new Map<string, TourneyPlayer>();
  rounds: TourneyMatch[][] = [];

  constructor(readonly quizDuel: boolean) {}

  join(p: TourneyPlayer): boolean {
    if (this.status !== 'signup') return false;
    this.players.set(p.id, { id: p.id, name: p.name });
    return true;
  }

  leave(id: string) {
    if (this.status === 'signup') this.players.delete(id);
  }

  /** Shuffle everyone into a bracket; byes (if the number isn't a power of two) go straight through */
  start(rng: Rng, now = Date.now()): string | null {
    if (this.status !== 'signup') return 'ทัวร์นาเมนต์เริ่มไปแล้ว';
    const list = [...this.players.values()];
    if (list.length < MIN_PLAYERS) return `ต้องมีนักเรียนลงชื่ออย่างน้อย ${MIN_PLAYERS} คน`;
    for (let i = list.length - 1; i > 0; i--) {
      const j = rng.int(0, i);
      [list[i], list[j]] = [list[j], list[i]];
    }
    let size = 2;
    while (size < list.length) size *= 2;
    const byes = size - list.length;
    const total = Math.log2(size);
    this.rounds = Array.from({ length: total }, (_, r) =>
      Array.from({ length: size / 2 ** (r + 1) }, (_, index): TourneyMatch => ({ round: r, index, a: null, b: null, winner: null, status: 'pending' })),
    );
    let next = 0;
    this.rounds[0].forEach((m, i) => {
      m.a = list[next++].id;
      // The first matches get the byes: never two empty seats in one match
      m.b = i < byes ? null : list[next++].id;
    });
    this.status = 'running';
    for (const m of this.rounds[0]) {
      if (m.b === null) this.decide(m, m.a!, now);
      else this.makeReady(m, now);
    }
    return null;
  }

  /** Matches that can be played now */
  ready(): TourneyMatch[] {
    return this.rounds.flat().filter((m) => m.status === 'waiting');
  }

  match(round: number, index: number): TourneyMatch | undefined {
    return this.rounds[round]?.[index];
  }

  /** A match is over: the winner goes through to the next round */
  decide(m: TourneyMatch, winner: string, now = Date.now()) {
    if (m.status === 'done' || (winner !== m.a && winner !== m.b)) return;
    m.winner = winner;
    m.status = 'done';
    m.code = undefined;
    const next = this.rounds[m.round + 1]?.[Math.floor(m.index / 2)];
    if (!next) {
      this.status = 'done';
      return;
    }
    if (m.index % 2 === 0) next.a = winner;
    else next.b = winner;
    if (next.a && next.b) this.makeReady(next, now);
  }

  private makeReady(m: TourneyMatch, now: number) {
    m.status = 'waiting';
    m.readySince = now;
  }

  get champion(): string | null {
    const final = this.rounds[this.rounds.length - 1]?.[0];
    return final?.winner ?? null;
  }

  /** The round being played now (0-based) */
  get currentRound(): number {
    const r = this.rounds.findIndex((round) => round.some((m) => m.status !== 'done'));
    return r < 0 ? this.rounds.length - 1 : r;
  }

  private nameOf(id: string | null): string | null {
    return id === null ? null : (this.players.get(id)?.name ?? '?');
  }

  view(): TourneyView {
    return {
      status: this.status,
      quizDuel: this.quizDuel,
      players: [...this.players.values()].map((p) => p.name),
      rounds: this.rounds.map((round) => round.map((m) => ({ a: this.nameOf(m.a), b: this.nameOf(m.b), winner: this.nameOf(m.winner), status: m.status }))),
      champion: this.nameOf(this.champion),
    };
  }

  studentView(id: string | null): TourneyStudentView {
    const joined = !!id && this.players.has(id);
    const base = { status: this.status, players: this.players.size, joined, round: this.currentRound + 1, rounds: this.rounds.length, opponent: null, champion: this.nameOf(this.champion) };
    if (!joined || !id) return { ...base, me: 'none' };
    if (this.status === 'signup') return { ...base, me: 'signup' };
    if (this.champion === id) return { ...base, me: 'champion' };
    const mine = this.rounds.flat().filter((m) => m.a === id || m.b === id);
    const lost = mine.some((m) => m.status === 'done' && m.winner !== id);
    if (lost) return { ...base, me: 'out' };
    const open = mine.find((m) => m.status !== 'done');
    if (!open) return { ...base, me: 'through' };
    const other = open.a === id ? open.b : open.a;
    return { ...base, me: open.status === 'playing' ? 'playing' : open.status === 'waiting' ? 'waiting' : 'through', opponent: this.nameOf(other) };
  }
}
