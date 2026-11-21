// Messages between the game and the PvP server (JSON over WebSocket at /ws).
import type { InstantSkill, ShotTimeline, SkillSlot, SkillState } from './battle';
import type { Character, Outfit } from './cosmetics';
import type { QuizItem } from './questions';
import type { RoomMode } from './multiplayer';

/** Room codes: 5 characters, no look-alikes (0/O, 1/I) */
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const ROOM_CODE_LENGTH = 5;
/** Quiz Duel: a right answer before your shot makes it this much stronger */
export const QUIZ_DUEL_BONUS = 1.15;

export interface PlayerInfo {
  id: string;
  name: string;
  character: Character;
  outfit: Outfit;
  level: number;
  weaponId: string;
  x: number;
  y: number;
  facing: 1 | -1;
  /** Side: teams 0 and 1 (in co-op every player is on team 0, the boss on 1) */
  team: 0 | 1;
}

/** The co-op boss as the game needs to draw it */
export interface BossInfo {
  id: string;
  bossId: string;
  name: string;
  texture: string;
  height: number;
  hp: number;
  x: number;
  y: number;
}

/** One student's place in the classroom tournament */
export interface TourneyStudentView {
  status: 'signup' | 'running' | 'done';
  players: number;
  joined: boolean;
  /** Round being played (1-based) and how many there are */
  round: number;
  rounds: number;
  me: 'signup' | 'waiting' | 'playing' | 'through' | 'out' | 'champion' | 'none';
  opponent: string | null;
  champion: string | null;
}

/** A room someone can join, as listed in the lobby */
export interface RoomSummary {
  code: string;
  host: string;
  mode: RoomMode;
  players: number;
  seats: number;
  quizDuel: boolean;
}

export type ClientMessage =
  | { t: 'hello'; name: string; character: Character; outfit: Outfit; level: number; weaponId: string; token?: string }
  | { t: 'create'; quizDuel: boolean; mode?: RoomMode }
  | { t: 'join'; code: string }
  /** Ask for the list of open rooms (sent again whenever it changes) */
  | { t: 'list' }
  /** The host starts a co-op room before it's full */
  | { t: 'begin' }
  | { t: 'emote'; id: number }
  /** Sign up for / drop out of the classroom tournament the teacher opened */
  | { t: 'tjoin' }
  | { t: 'tleave' }
  | { t: 'leave' }
  | { t: 'move'; x: number; y: number; facing: 1 | -1; angle: number }
  | { t: 'skill'; slot: InstantSkill }
  | { t: 'fire'; x: number; y: number; facing: 1 | -1; angle: number; power: number; armed: SkillSlot[] }
  | { t: 'pass' }
  | { t: 'answer'; chosen: number }
  | { t: 'rematch' };

export type ServerMessage =
  | { t: 'welcome'; id: string }
  | { t: 'created'; code: string; quizDuel: boolean; mode: RoomMode }
  /** Waiting room: who's in, and on which team (sent to everyone in it whenever it changes) */
  | { t: 'room'; code: string; mode: RoomMode; quizDuel: boolean; host: string; players: { id: string; name: string; team: 0 | 1 }[]; seats: number }
  | { t: 'roomList'; rooms: RoomSummary[] }
  | { t: 'error'; message: string }
  | {
      t: 'start';
      you: string;
      code: string;
      seed: number;
      map: number[];
      players: PlayerInfo[];
      quizDuel: boolean;
      mode: RoomMode;
      boss: BossInfo | null;
      /** A tournament match: shown at the start, and there's no rematch */
      label?: string;
    }
  | {
      t: 'turn';
      actor: string;
      wind: number;
      seconds: number;
      burn: number;
      hp: Record<string, number>;
      skills: SkillState | null;
      /** Who goes after this turn (delay order) */
      order: string[];
    }
  | { t: 'quiz'; item: QuizItem; seconds: number; title?: string }
  | { t: 'quizResult'; id: string; correct: boolean }
  /** Co-op: how the class did on the boss's question, and whether its ultimate was stopped */
  | { t: 'bossQuiz'; correct: number; total: number; interrupted: boolean; name: string }
  | { t: 'emote'; id: string; emote: number }
  /** The classroom tournament as this student sees it (null: none open) */
  | { t: 'tourney'; view: TourneyStudentView | null }
  | { t: 'moved'; id: string; x: number; y: number; facing: 1 | -1; angle: number }
  | { t: 'skillUsed'; id: string; slot: InstantSkill; hp: number; skills: SkillState | null }
  | {
      t: 'shot';
      id: string;
      x: number;
      y: number;
      facing: 1 | -1;
      angle: number;
      /** Shot skills that were used */
      armed: SkillSlot[];
      timelines: ShotTimeline[];
      /** Where everyone ended up, and their health, once everything settled */
      units: { id: string; x: number; y: number; hp: number; alive: boolean }[];
      skills: SkillState | null;
      /** Texture of the shell when it isn't the shooter's own weapon (the boss's ultimate) */
      projectile?: string;
    }
  /** A turn passed without a shot; `gone`: that player left the match */
  | { t: 'skipped'; id: string; gone?: boolean }
  /** `team`: the winning side (0 or 1; in co-op 1 is the boss), null for a draw */
  | { t: 'over'; winner: string | null; reason: 'win' | 'left'; team?: 0 | 1 | null }
  | { t: 'rematchWanted'; id: string };
