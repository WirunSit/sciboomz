// Online modes with more than two players: 2v2 teams and a co-op boss raid,
// plus the DDTank-style "delay" turn order and the quick chat (emotes).
// Pure rules: used by the PvP server and the game alike.
import { ENEMY_WEAPONS, type WeaponStats } from './weapons';

/**
 * duel = 1 v 1 · team = 2 v 2 · coop = 1–4 classmates together against a boss
 */
export type RoomMode = 'duel' | 'team' | 'coop';
export const ROOM_MODES: RoomMode[] = ['duel', 'team', 'coop'];
export const MODE_NAMES: Record<RoomMode, string> = { duel: 'ดวล 1 ต่อ 1', team: 'ทีม 2 ต่อ 2', coop: 'ตีบอสร่วมกัน' };
/** Seats in a room of each mode */
export const MODE_SEATS: Record<RoomMode, number> = { duel: 2, team: 4, coop: 4 };

/** Team of the n-th player to join (teams alternate so friends who join together end up apart... unless they swap) */
export function teamForSeat(mode: RoomMode, seat: number): 0 | 1 {
  if (mode === 'coop') return 0;
  return (seat % 2) as 0 | 1;
}

// ---- Delay: whose turn is next -----------------------------------------------------------

/**
 * Every action adds "delay"; whoever has the least delay goes next (ties: the
 * earlier seat). A plain turn costs DELAY_TURN; walking and skills add their
 * stamina on top, so a big turn (+2, triple, a long walk) means waiting longer
 * for the next one. With plain turns everyone simply takes turns in order.
 */
export const DELAY_TURN = 100;
/** Extra delay per point of stamina used in a turn */
export const DELAY_PER_STAMINA = 0.6;
/** The ultimate shakes you up: extra delay */
export const DELAY_ULTIMATE = 25;

export interface DelayEntry {
  id: string;
  delay: number;
  alive: boolean;
}

/** Who acts next: least delay among the living (first in the list on a tie) */
export function nextActor(entries: DelayEntry[]): DelayEntry | undefined {
  let best: DelayEntry | undefined;
  for (const e of entries) if (e.alive && (!best || e.delay < best.delay)) best = e;
  return best;
}

/** The next few turns, assuming everyone takes a plain turn (shown as a strip of faces) */
export function turnPreview(entries: DelayEntry[], count: number): string[] {
  const sim = entries.filter((e) => e.alive).map((e) => ({ ...e }));
  const out: string[] = [];
  for (let i = 0; i < count && sim.length > 0; i++) {
    const n = nextActor(sim)!;
    out.push(n.id);
    n.delay += DELAY_TURN;
  }
  return out;
}

/** Delay earned by a player's turn: stamina used (walking + skills) and the ultimate cost extra */
export function turnDelay(staminaUsed: number, ultimate: boolean): number {
  return DELAY_TURN + Math.max(0, staminaUsed) * DELAY_PER_STAMINA + (ultimate ? DELAY_ULTIMATE : 0);
}

// ---- Co-op boss raid -----------------------------------------------------------------------

export interface CoopBoss {
  id: string;
  name: string;
  /** Texture key in the game (bosses/...) */
  texture: string;
  /** Question unit (the world it comes from) */
  unit: number;
  height: number;
  /** Health for ONE player; more players → more health */
  hp: number;
  weapon: WeaponStats;
  ultimate: { weapon: WeaponStats; name: string };
  /** Starting aim (0–1) */
  skill: number;
}

const W = ENEMY_WEAPONS;
export const COOP_BOSSES: CoopBoss[] = [
  { id: 'mixtron', name: 'Mixtron ราชาสารผสม', texture: 'bosses/mixtron', unit: 1, height: 270, hp: 1700, weapon: W.mixture_bomb, ultimate: { weapon: W.atom_storm, name: 'พายุอะตอม' }, skill: 0.45 },
  { id: 'amoebox', name: 'Amoebox อะมีบายักษ์', texture: 'bosses/amoebox', unit: 2, height: 270, hp: 1850, weapon: W.amoeba_blob, ultimate: { weapon: W.cell_flood, name: 'น้ำท่วมเซลล์' }, skill: 0.45 },
  { id: 'venomroot', name: 'Venomroot ต้นไม้กินคน', texture: 'bosses/venomroot', unit: 3, height: 270, hp: 1950, weapon: W.thorn_seed, ultimate: { weapon: W.thorn_rain, name: 'ฝนหนาม' }, skill: 0.5 },
  { id: 'magmadon', name: 'Magmadon มังกรลาวา', texture: 'bosses/magmadon', unit: 4, height: 270, hp: 2100, weapon: W.magma_bomb, ultimate: { weapon: W.meteor_rain, name: 'ฝนอุกกาบาตลาวา' }, skill: 0.5 },
  { id: 'stormlord', name: 'Stormlord เจ้าพายุ', texture: 'bosses/stormlord', unit: 5, height: 270, hp: 2250, weapon: W.storm_bolt, ultimate: { weapon: W.lightning_strike, name: 'สายฟ้าฟาด' }, skill: 0.55 },
];

export function coopBoss(id: string): CoopBoss {
  return COOP_BOSSES.find((b) => b.id === id) ?? COOP_BOSSES[0];
}

/** A tougher boss for a bigger group (but each player still has to pull their weight) */
export function coopBossHp(boss: CoopBoss, players: number): number {
  return Math.round(boss.hp * (0.55 + 0.45 * Math.max(1, players)));
}

/** The boss charges its ultimate every this many of its turns; a question goes to everyone */
export const COOP_ULTIMATE_EVERY = 3;
/** At least this share of the living players must answer right to stop the ultimate */
export const COOP_INTERRUPT_SHARE = 0.5;

/** Hit circle and muzzle of a boss body (same proportions as the stages) */
export function bossBody(height: number) {
  return {
    radius: Math.round(height * 0.35),
    offsetY: Math.round(height * 0.47),
    /** Muzzle relative to the feet for the art facing LEFT */
    muzzle: { x: -Math.round(height * 0.22), y: -Math.round(height * 0.8) },
  };
}

/** Rewards for a co-op raid: everyone gets the same */
export function coopRewards(won: boolean): { exp: number; coins: number } {
  return won ? { exp: 110, coins: 90 } : { exp: 40, coins: 25 };
}

// ---- Quick chat -------------------------------------------------------------------------------

/** Ready-made messages only (no typing: nothing rude can be sent) */
export const EMOTES = ['ยิงดี!', 'เกือบแล้ว!', 'ขอบคุณ!', 'สู้ ๆ!', 'ขอโทษนะ', 'ว้าว!', 'ช่วยด้วย!', 'ตาฉันเอง'];
/** Fastest a player may send them */
export const EMOTE_COOLDOWN_MS = 2000;
