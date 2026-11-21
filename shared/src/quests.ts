// Daily quests and achievements: reasons to come back every day, and always
// something new to aim for. Pure rules (no Phaser): the game records what
// happened (events), this file turns that into quest progress and unlocks.
// The same 3 daily quests are given to everyone on a day, so classmates can
// compare and help each other.
import { Rng } from './rng';

/** Lifetime counters kept in the save */
export interface PlayerStats {
  correct: number;
  stageWins: number;
  bossWins: number;
  threeStars: number;
  hardWins: number;
  pvpGames: number;
  pvpWins: number;
  crates: number;
  knockouts: number;
  longShots: number;
  multiHits: number;
  fallKills: number;
  dailyDone: number;
}

export function emptyStats(): PlayerStats {
  return {
    correct: 0,
    stageWins: 0,
    bossWins: 0,
    threeStars: 0,
    hardWins: 0,
    pvpGames: 0,
    pvpWins: 0,
    crates: 0,
    knockouts: 0,
    longShots: 0,
    multiHits: 0,
    fallKills: 0,
    dailyDone: 0,
  };
}

/** Something that happened in the game */
export type GameEvent =
  | { kind: 'answer'; correct: boolean }
  | { kind: 'stage'; won: boolean; stars: number; boss: boolean; hard: boolean }
  | { kind: 'pvp'; won: boolean }
  | { kind: 'crate' }
  | { kind: 'award'; award: 'long' | 'multi' | 'ko' | 'fall' | string };

/** Which counter an event bumps (and by how much) */
function bumps(e: GameEvent): Partial<Record<keyof PlayerStats, number>> {
  switch (e.kind) {
    case 'answer':
      return e.correct ? { correct: 1 } : {};
    case 'stage':
      if (!e.won) return {};
      return { stageWins: 1, bossWins: e.boss ? 1 : 0, threeStars: e.stars >= 3 ? 1 : 0, hardWins: e.hard ? 1 : 0 };
    case 'pvp':
      return { pvpGames: 1, pvpWins: e.won ? 1 : 0 };
    case 'crate':
      return { crates: 1 };
    case 'award':
      if (e.award === 'long') return { longShots: 1 };
      if (e.award === 'multi') return { multiHits: 1 };
      if (e.award === 'ko') return { knockouts: 1 };
      if (e.award === 'fall') return { fallKills: 1 };
      return {};
  }
}

// ---- Daily quests ------------------------------------------------------------------------

export interface QuestDef {
  id: string;
  /** What to do, in Thai ({n} = target) */
  text: string;
  stat: keyof PlayerStats;
  target: number;
  coins: number;
  exp: number;
}

/** Everything a daily quest can be; 3 different ones are picked each day */
export const DAILY_POOL: QuestDef[] = [
  { id: 'answer5', text: 'ตอบคำถามถูก {n} ข้อ', stat: 'correct', target: 5, coins: 60, exp: 60 },
  { id: 'answer12', text: 'ตอบคำถามถูก {n} ข้อ', stat: 'correct', target: 12, coins: 120, exp: 120 },
  { id: 'win2', text: 'ผ่านด่านผจญภัย {n} ครั้ง', stat: 'stageWins', target: 2, coins: 80, exp: 60 },
  { id: 'stars3', text: 'ผ่านด่านแบบได้ 3 ดาว {n} ครั้ง', stat: 'threeStars', target: 1, coins: 70, exp: 50 },
  { id: 'crates4', text: 'ยิงทะลุกล่องปริศนา {n} กล่อง', stat: 'crates', target: 4, coins: 60, exp: 50 },
  { id: 'ko3', text: 'ปิดเกมด้วย K.O. {n} ครั้ง', stat: 'knockouts', target: 3, coins: 70, exp: 50 },
  { id: 'long1', text: 'ยิงโดนแบบ "ยิงไกล!" {n} ครั้ง', stat: 'longShots', target: 1, coins: 60, exp: 40 },
  { id: 'pvp1', text: 'เล่นออนไลน์กับเพื่อน {n} เกม', stat: 'pvpGames', target: 1, coins: 70, exp: 60 },
  { id: 'boss1', text: 'ปราบบอส {n} ตัว', stat: 'bossWins', target: 1, coins: 100, exp: 80 },
];

/** Bonus for finishing all three quests of the day */
export const DAILY_BONUS = { coins: 150, exp: 100 };
export const DAILY_COUNT = 3;

export interface DailyState {
  /** Local date the quests are for, YYYY-MM-DD */
  day: string;
  ids: string[];
  /** Counter values when the day started (progress = now − start) */
  start: number[];
  claimed: boolean[];
  bonusClaimed: boolean;
}

/** Today's date as YYYY-MM-DD in Thailand (UTC+7), so the day turns at midnight for the class */
export function questDay(now = Date.now()): string {
  return new Date(now + 7 * 3600_000).toISOString().slice(0, 10);
}

/** The day's three quests: the same for everyone on the same day */
export function dailyQuests(day: string): QuestDef[] {
  let seed = 0;
  for (const ch of day) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;
  const rng = new Rng(seed);
  const pool = [...DAILY_POOL];
  const picked: QuestDef[] = [];
  while (picked.length < DAILY_COUNT && pool.length > 0) {
    const q = pool.splice(rng.int(0, pool.length - 1), 1)[0];
    // Never two quests about the same thing on one day
    if (!picked.some((p) => p.stat === q.stat)) picked.push(q);
  }
  return picked;
}

export function questById(id: string): QuestDef | undefined {
  return DAILY_POOL.find((q) => q.id === id);
}

/** Start a new day's quests if the saved ones are from an earlier day */
export function freshDaily(daily: DailyState | undefined, stats: PlayerStats, day = questDay()): DailyState {
  if (daily && daily.day === day && daily.ids.length === DAILY_COUNT) return daily;
  const qs = dailyQuests(day);
  return { day, ids: qs.map((q) => q.id), start: qs.map((q) => stats[q.stat]), claimed: qs.map(() => false), bonusClaimed: false };
}

export interface QuestProgress {
  quest: QuestDef;
  done: number;
  complete: boolean;
  claimed: boolean;
}

export function dailyProgress(daily: DailyState, stats: PlayerStats): QuestProgress[] {
  return daily.ids.map((id, i) => {
    const quest = questById(id)!;
    const done = Math.max(0, Math.min(quest.target, stats[quest.stat] - daily.start[i]));
    return { quest, done, complete: done >= quest.target, claimed: daily.claimed[i] };
  });
}

export function questText(q: QuestDef): string {
  return q.text.replace('{n}', String(q.target));
}

// ---- Achievements --------------------------------------------------------------------------

export interface AchievementDef {
  id: string;
  name: string;
  desc: string;
  stat: keyof PlayerStats | 'level';
  target: number;
  coins: number;
}

/** Tiered so there's always a next one to reach */
function tiers(stat: AchievementDef['stat'], name: string, desc: string, targets: number[], coins: number[]): AchievementDef[] {
  const roman = ['I', 'II', 'III', 'IV', 'V'];
  return targets.map((target, i) => ({
    id: `${stat}-${target}`,
    name: targets.length > 1 ? `${name} ${roman[i]}` : name,
    desc: desc.replace('{n}', String(target)),
    stat,
    target,
    coins: coins[i],
  }));
}

export const ACHIEVEMENTS: AchievementDef[] = [
  ...tiers('correct', 'นักวิทย์ฝึกหัด', 'ตอบคำถามถูกรวม {n} ข้อ', [10, 50, 150, 300, 500], [50, 150, 300, 500, 800]),
  ...tiers('level', 'เติบโตทุกวัน', 'ถึงเลเวล {n}', [5, 10, 20, 30], [80, 200, 400, 800]),
  ...tiers('stageWins', 'นักผจญภัย', 'ผ่านด่านผจญภัยรวม {n} ครั้ง', [5, 25, 75], [80, 200, 400]),
  ...tiers('bossWins', 'ผู้ปราบบอส', 'ปราบบอสรวม {n} ครั้ง', [1, 5, 15], [100, 250, 500]),
  ...tiers('threeStars', 'เก็บดาวครบ', 'ผ่านด่านแบบ 3 ดาวรวม {n} ครั้ง', [5, 20], [100, 300]),
  ...tiers('hardWins', 'ท้าทายสุดขีด', 'ผ่านด่านโหมดยากรวม {n} ครั้ง', [1, 5, 15], [150, 300, 600]),
  ...tiers('knockouts', 'จอมปิดเกม', 'ปิดเกมด้วย K.O. รวม {n} ครั้ง', [10, 50], [100, 300]),
  ...tiers('longShots', 'มือปืนระยะไกล', 'ยิงโดนแบบ "ยิงไกล!" รวม {n} ครั้ง', [5, 25], [100, 300]),
  ...tiers('multiHits', 'ยิงทีเดียวได้สอง', 'ยิงโดนหลายตัวในนัดเดียว {n} ครั้ง', [3], [150]),
  ...tiers('fallKills', 'ส่งลงเหว', 'ทำให้ศัตรูตกเหว {n} ครั้ง', [1, 10], [100, 300]),
  ...tiers('crates', 'นักล่ากล่องปริศนา', 'ยิงทะลุกล่องปริศนารวม {n} กล่อง', [20, 100], [100, 300]),
  ...tiers('pvpGames', 'เพื่อนเล่นที่ดี', 'เล่นออนไลน์กับเพื่อนรวม {n} เกม', [5, 30], [100, 300]),
  ...tiers('pvpWins', 'แชมป์ห้องเรียน', 'ชนะออนไลน์รวม {n} ครั้ง', [3, 15, 40], [100, 300, 600]),
  ...tiers('dailyDone', 'ขยันทุกวัน', 'ทำภารกิจรายวันครบรวม {n} วัน', [3, 10, 30], [150, 400, 800]),
];

export function achievementValue(a: AchievementDef, stats: PlayerStats, level: number): number {
  return a.stat === 'level' ? level : stats[a.stat];
}

/** Reached but the reward hasn't been collected yet */
export function claimableAchievements(stats: PlayerStats, level: number, claimed: string[]): AchievementDef[] {
  return ACHIEVEMENTS.filter((a) => !claimed.includes(a.id) && achievementValue(a, stats, level) >= a.target);
}

// ---- Recording events ----------------------------------------------------------------------

export interface ProgressHolder {
  stats: PlayerStats;
  daily: DailyState;
  achieved: string[];
  level: number;
}

export interface EventResult {
  /** Daily quests that just became complete */
  quests: QuestDef[];
  /** Achievements that just became reachable */
  achievements: AchievementDef[];
}

/** Count an event: bump the counters and report quests/achievements it just completed */
export function recordEvent(p: ProgressHolder, e: GameEvent, day = questDay()): EventResult {
  p.daily = freshDaily(p.daily, p.stats, day);
  const before = dailyProgress(p.daily, p.stats);
  const ready = new Set(claimableAchievements(p.stats, p.level, p.achieved).map((a) => a.id));
  for (const [k, v] of Object.entries(bumps(e))) {
    if (v) p.stats[k as keyof PlayerStats] += v;
  }
  const after = dailyProgress(p.daily, p.stats);
  return {
    quests: after.filter((q, i) => q.complete && !before[i].complete).map((q) => q.quest),
    achievements: claimableAchievements(p.stats, p.level, p.achieved).filter((a) => !ready.has(a.id)),
  };
}

/** Collect a finished daily quest. Returns the reward, or null if it can't be claimed. */
export function claimQuest(p: ProgressHolder, index: number): { coins: number; exp: number } | null {
  const prog = dailyProgress(p.daily, p.stats)[index];
  if (!prog || !prog.complete || prog.claimed) return null;
  p.daily.claimed[index] = true;
  if (p.daily.claimed.every(Boolean)) p.stats.dailyDone++;
  return { coins: prog.quest.coins, exp: prog.quest.exp };
}

/** All three done and collected: the day's bonus chest */
export function claimDailyBonus(p: ProgressHolder): { coins: number; exp: number } | null {
  if (p.daily.bonusClaimed || !p.daily.claimed.every(Boolean)) return null;
  p.daily.bonusClaimed = true;
  return { ...DAILY_BONUS };
}

export function claimAchievement(p: ProgressHolder, id: string): { coins: number } | null {
  const a = claimableAchievements(p.stats, p.level, p.achieved).find((x) => x.id === id);
  if (!a) return null;
  p.achieved.push(a.id);
  return { coins: a.coins };
}

/** How many things are waiting to be collected (red dot on the menu button) */
export function rewardsWaiting(p: ProgressHolder, day = questDay()): number {
  const daily = freshDaily(p.daily, p.stats, day);
  const quests = dailyProgress(daily, p.stats).filter((q) => q.complete && !q.claimed).length;
  const bonus = !daily.bonusClaimed && daily.claimed.every(Boolean) ? 1 : 0;
  return quests + bonus + claimableAchievements(p.stats, p.level, p.achieved).length;
}
