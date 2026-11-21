// One online match: 1 v 1, 2 v 2 teams, or classmates together against a
// co-op boss. The server owns the truth: the map, positions, health, wind,
// skills, whose turn it is and every shot (worked out with the same shared
// rules the game uses), so nobody can cheat by changing their game.
import {
  CLIMB,
  COOP_INTERRUPT_SHARE,
  COOP_ULTIMATE_EVERY,
  DELAY_TURN,
  EMOTES,
  EMOTE_COOLDOWN_MS,
  GAUGE_CORRECT_ANSWER,
  HEAL_AMOUNT,
  MAP_STYLES,
  MAX_WIND,
  MODE_SEATS,
  QUIZ_DUEL_BONUS,
  QuizDeck,
  Rng,
  STAMINA_MAX,
  TURN_SECONDS,
  Terrain,
  SHIELD_FACTOR,
  WALK_PX_PER_STAMINA,
  WORLD_WIDTH,
  addGauge,
  bossBody,
  coopBoss,
  coopBossHp,
  fireSkills,
  baseWeaponStats,
  fighterMuzzle,
  gaugeGains,
  isInstantSkill,
  isSkillSlot,
  newFighterUnit,
  newSkillState,
  nextActor,
  nextEnemySkill,
  pickSkill,
  planShot,
  resolveShot,
  sanitizeOutfit,
  skillBlocker,
  startSkillTurn,
  teamForSeat,
  tickBurn,
  turnDelay,
  turnPreview,
  weaponDef,
  weaponSpecial,
  windFactor,
  type BossInfo,
  type ClientMessage,
  type CoopBoss,
  type DelayEntry,
  type PlayerInfo,
  type Question,
  type QuizItem,
  type RoomMode,
  type RoomSummary,
  type ServerMessage,
  type ShotTimeline,
  type SkillSlot,
  type SkillState,
  type Unit,
  type WeaponStats,
} from '@sciboom/shared';

type Hello = Extract<ClientMessage, { t: 'hello' }>;

export interface RoomOptions {
  send: (playerId: string, msg: ServerMessage) => void;
  questions: Question[];
  /** Shorter in tests */
  turnSeconds?: number;
  quizSeconds?: number;
  /** Extra wait for slow networks before a turn is skipped */
  graceMs?: number;
  /** Speed up the pauses while clients animate (tests) */
  animationScale?: number;
  seed?: number;
  /** Co-op: which boss (default: picked at random) */
  bossId?: string;
  /** Tournament match: a label for the players, no rematch, and who won goes back to the bracket */
  label?: string;
  onOver?: (winnerSeatId: string | null) => void;
}

interface Seat {
  id: string;
  info: PlayerInfo;
  unit: Unit;
  skills: SkillState;
  /** Shield skill: takes half damage until their next turn */
  shield: boolean;
  angle: number;
  wantsRematch: boolean;
  /** Turn order: least delay goes next */
  delay: number;
  /** Left the match (their fighter stays on the map, knocked out) */
  gone: boolean;
  /** Co-op: the boss's question was answered right, next shot is stronger */
  bonus: number;
  lastEmote: number;
}

interface Boss {
  def: CoopBoss;
  unit: Unit;
  facing: 1 | -1;
  skill: number;
  turns: number;
  delay: number;
}

type Phase = 'waiting' | 'quiz' | 'aiming' | 'resolving' | 'over';

const QUIZ_SECONDS = 20;
/** Steps per second of the shot simulation (shared physics STEP = 1/60) */
const STEPS_PER_SECOND = 60;
const BOSS_ID = 'boss';
/** Co-op: a right answer to the boss's question makes your next shot this much stronger */
const COOP_ANSWER_BONUS = 1.3;

export class PvpRoom {
  readonly seats: Seat[] = [];
  phase: Phase = 'waiting';
  private terrain!: Terrain;
  private rng: Rng;
  private deck: QuizDeck;
  private boss: Boss | null = null;
  private actorId = '';
  private wind = 0;
  private damageMul = 1;
  private walkFromX = 0;
  private quizItem: QuizItem | null = null;
  /** Co-op boss question: who has answered, and how */
  private bossAnswers = new Map<string, boolean>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly turnSeconds: number;
  private readonly quizSeconds: number;
  private readonly graceMs: number;
  private readonly animationScale: number;

  constructor(
    readonly code: string,
    readonly quizDuel: boolean,
    private readonly opts: RoomOptions,
    readonly mode: RoomMode = 'duel',
  ) {
    this.rng = new Rng(opts.seed ?? Math.floor(Math.random() * 1e9));
    this.deck = new QuizDeck(opts.questions, this.rng, 2);
    this.turnSeconds = opts.turnSeconds ?? TURN_SECONDS;
    this.quizSeconds = opts.quizSeconds ?? QUIZ_SECONDS;
    this.graceMs = opts.graceMs ?? 8000;
    this.animationScale = opts.animationScale ?? 1;
  }

  get maxSeats(): number {
    return MODE_SEATS[this.mode];
  }

  get full(): boolean {
    return this.seats.length >= this.maxSeats;
  }

  /** The player who made the room (can start a co-op raid early) */
  get host(): Seat | undefined {
    return this.seats[0];
  }

  addPlayer(id: string, hello: Hello) {
    const weaponId = weaponDef(hello.weaponId).id;
    const level = Math.max(1, Math.min(30, Math.round(hello.level) || 1));
    this.seats.push({
      id,
      info: {
        id,
        name: String(hello.name).slice(0, 24) || 'ผู้เล่น',
        character: hello.character === 'girl' ? 'girl' : 'boy',
        outfit: sanitizeOutfit(hello.outfit, level),
        level,
        weaponId,
        x: 0,
        y: 0,
        facing: 1,
        team: teamForSeat(this.mode, this.seats.length),
      },
      unit: newFighterUnit(id, 0, 0),
      skills: newSkillState(true),
      shield: false,
      angle: 45,
      wantsRematch: false,
      delay: 0,
      gone: false,
      bonus: 1,
      lastEmote: 0,
    });
    this.sendWaiting();
  }

  /** For the lobby's list of rooms to join */
  summary(): RoomSummary {
    return { code: this.code, host: this.host?.info.name ?? '', mode: this.mode, players: this.seats.length, seats: this.maxSeats, quizDuel: this.quizDuel };
  }

  /** Tell everyone in the waiting room who's here */
  private sendWaiting() {
    if (this.phase !== 'waiting') return;
    this.broadcast({
      t: 'room',
      code: this.code,
      mode: this.mode,
      quizDuel: this.quizDuel,
      host: this.host?.id ?? '',
      players: this.seats.map((s) => ({ id: s.id, name: s.info.name, team: s.info.team })),
      seats: this.maxSeats,
    });
  }

  /** New match: fresh map, full health */
  start() {
    const seed = this.rng.int(0, 1e9);
    this.terrain = Terrain.generate(seed, MAP_STYLES[this.rng.int(0, MAP_STYLES.length - 1)]);
    // Drop anyone who left after the last match
    for (let i = this.seats.length - 1; i >= 0; i--) if (this.seats[i].gone) this.seats.splice(i, 1);
    const xs = this.spawnXs();
    this.seats.forEach((s, i) => {
      const x = xs[i];
      const y = this.terrain.groundBelow(x, 0) ?? 400;
      s.unit = newFighterUnit(s.id, x, y);
      s.skills = newSkillState(true);
      s.shield = false;
      s.angle = 45;
      s.wantsRematch = false;
      s.delay = i; // everyone once, in join order, to begin with
      s.bonus = 1;
      s.info = { ...s.info, x, y, facing: x < WORLD_WIDTH / 2 ? 1 : -1, team: this.mode === 'coop' ? 0 : s.info.team };
    });
    this.boss = this.mode === 'coop' ? this.makeBoss() : null;
    const map = this.terrain.encode();
    const players = this.seats.map((o) => o.info);
    const boss: BossInfo | null = this.boss && {
      id: BOSS_ID,
      bossId: this.boss.def.id,
      name: this.boss.def.name,
      texture: this.boss.def.texture,
      height: this.boss.def.height,
      hp: this.boss.unit.maxHp,
      x: this.boss.unit.x,
      y: this.boss.unit.y,
    };
    for (const s of this.seats) {
      this.opts.send(s.id, { t: 'start', you: s.id, code: this.code, seed, map, players, quizDuel: this.quizDuel, mode: this.mode, boss, label: this.opts.label });
    }
    this.beginTurn();
  }

  /** Where everyone starts: the two sides at either end; co-op players together on the left */
  private spawnXs(): number[] {
    const n = this.seats.length;
    const t = this.terrain;
    const jitter = () => this.rng.int(0, 100);
    if (this.mode === 'coop') return this.seats.map((_, i) => t.standX(200 + i * 170 + jitter() / 2, 120));
    if (this.mode === 'team') {
      const left = [200, 470];
      const right = [WORLD_WIDTH - 200, WORLD_WIDTH - 470];
      const used = [0, 0];
      return this.seats.map((s) => {
        const side = s.info.team;
        const x = (side === 0 ? left : right)[used[side]++ % 2];
        return t.standX(x + (side === 0 ? jitter() : -jitter()), 120);
      });
    }
    return [t.standX(260 + jitter()), t.standX(WORLD_WIDTH - 260 - jitter())].slice(0, Math.max(2, n));
  }

  private makeBoss(): Boss {
    const def = coopBoss(this.opts.bossId ?? ['mixtron', 'amoebox', 'venomroot', 'magmadon', 'stormlord'][this.rng.int(0, 4)]);
    const body = bossBody(def.height);
    const x = this.terrain.standX(WORLD_WIDTH - 300, 250);
    const y = this.terrain.groundBelow(x, 0) ?? 400;
    const hp = coopBossHp(def, this.seats.length);
    // Questions from the boss's world
    const unitQuestions = this.opts.questions.filter((q) => q.id.startsWith(`u${def.unit}-`));
    if (unitQuestions.length > 0) this.deck = new QuizDeck(unitQuestions, this.rng, 3);
    return {
      def,
      unit: { id: BOSS_ID, x, y, hp, maxHp: hp, alive: true, radius: body.radius, offsetY: body.offsetY, burn: 0 },
      facing: -1,
      skill: def.skill,
      turns: 0,
      delay: this.seats.length, // after every player's first turn
    };
  }

  handle(id: string, msg: ClientMessage) {
    const seat = this.seats.find((s) => s.id === id);
    if (!seat || seat.gone) return;
    const isActor = this.actorId === seat.id;
    switch (msg.t) {
      case 'answer':
        if (this.phase === 'quiz' && this.boss && this.bossAnswers.has(seat.id) === false && this.actorId === BOSS_ID) this.bossAnswer(seat, msg.chosen);
        else if (this.phase === 'quiz' && isActor) this.answer(seat, msg.chosen);
        break;
      case 'move':
        if (this.phase === 'aiming' && isActor) {
          this.place(seat, msg.x, msg.y, msg.facing, msg.angle);
          this.sendOthers(seat, { t: 'moved', id, x: seat.unit.x, y: seat.unit.y, facing: seat.info.facing, angle: seat.angle });
        }
        break;
      case 'skill':
        if (this.phase === 'aiming' && isActor) this.instantSkill(seat, msg.slot);
        break;
      case 'fire':
        if (this.phase === 'aiming' && isActor) {
          this.place(seat, msg.x, msg.y, msg.facing, msg.angle);
          this.fire(seat, msg.power, Array.isArray(msg.armed) ? msg.armed.filter(isSkillSlot) : []);
        }
        break;
      case 'pass':
        if ((this.phase === 'aiming' || this.phase === 'quiz') && isActor) this.skip();
        break;
      case 'emote': {
        const n = Math.floor(Number(msg.id));
        const now = Date.now();
        if (this.phase === 'waiting' || n < 0 || n >= EMOTES.length || now - seat.lastEmote < EMOTE_COOLDOWN_MS) break;
        seat.lastEmote = now;
        this.broadcast({ t: 'emote', id: seat.id, emote: n });
        break;
      }
      case 'rematch':
        if (this.phase !== 'over' || this.seats.some((s) => s.gone) || this.opts.label) break;
        seat.wantsRematch = true;
        this.sendOthers(seat, { t: 'rematchWanted', id });
        if (this.seats.length >= this.minPlayers && this.seats.every((s) => s.wantsRematch)) this.start();
        break;
    }
  }

  /** Fewest players for a match of this mode */
  get minPlayers(): number {
    return this.mode === 'coop' ? 1 : this.maxSeats;
  }

  /** A player left or lost their connection */
  removePlayer(id: string) {
    const idx = this.seats.findIndex((s) => s.id === id);
    if (idx < 0) return;
    const seat = this.seats[idx];
    if (this.phase === 'waiting') {
      this.seats.splice(idx, 1);
      // Teams are by join order: everyone keeps a fair split
      this.seats.forEach((s, i) => (s.info.team = teamForSeat(this.mode, i)));
      this.sendWaiting();
      return;
    }
    if (this.phase === 'over') {
      this.seats.splice(idx, 1);
      for (const s of this.seats) this.opts.send(s.id, { t: 'over', winner: s.id, reason: 'left', team: null });
      return;
    }
    // Mid-match: their fighter is out; the match goes on while both sides still have someone
    seat.gone = true;
    seat.unit.alive = false;
    seat.unit.hp = 0;
    this.broadcast({ t: 'skipped', id: seat.id, gone: true });
    const present = this.seats.filter((s) => !s.gone);
    if (present.length === 0) {
      this.clearTimer();
      this.phase = 'over';
      return;
    }
    const sides = new Set(present.map((s) => s.info.team));
    if (this.mode !== 'coop' && sides.size < 2) {
      this.finish(present[0].info.team, 'left');
      return;
    }
    if (this.actorId === seat.id) {
      this.clearTimer();
      this.phase = 'resolving';
      this.later(800, () => this.endTurn());
    } else if (this.phase === 'quiz' && this.actorId === BOSS_ID && this.bossAnswers.size >= this.livePlayers().length) {
      this.resolveBossQuiz();
    }
  }

  dispose() {
    this.clearTimer();
  }

  // ---- Turns ---------------------------------------------------------------------

  private delayEntries(): DelayEntry[] {
    const list: DelayEntry[] = this.seats.map((s) => ({ id: s.id, delay: s.delay, alive: s.unit.alive && !s.gone }));
    if (this.boss) list.push({ id: BOSS_ID, delay: this.boss.delay, alive: this.boss.unit.alive });
    return list;
  }

  private livePlayers(): Seat[] {
    return this.seats.filter((s) => s.unit.alive && !s.gone);
  }

  private beginTurn() {
    const next = nextActor(this.delayEntries());
    if (!next) return;
    this.actorId = next.id;
    // Wind for the least experienced player, so everyone faces the same weather
    const level = Math.min(...this.seats.map((s) => s.info.level));
    this.wind = Math.round(this.rng.range(-MAX_WIND, MAX_WIND) * windFactor(level));
    this.damageMul = 1;
    // The order after this turn (as if it's a plain one)
    const after = this.delayEntries().map((e) => (e.id === next.id ? { ...e, delay: e.delay + DELAY_TURN } : e));
    const order = turnPreview(after, 5);
    const hp = Object.fromEntries([...this.seats.map((s) => [s.id, s.unit.hp]), ...(this.boss ? [[BOSS_ID, this.boss.unit.hp]] : [])]);

    if (next.id === BOSS_ID) {
      for (const s of this.seats) this.opts.send(s.id, { t: 'turn', actor: BOSS_ID, wind: this.wind, seconds: 0, burn: 0, hp, skills: s.skills, order });
      this.phase = 'resolving';
      this.later(1200, () => this.bossTurn());
      return;
    }

    const actor = this.seats.find((s) => s.id === next.id)!;
    this.walkFromX = actor.unit.x;
    startSkillTurn(actor.skills);
    actor.shield = false;
    const burn = tickBurn(actor.unit);
    for (const s of this.seats) {
      this.opts.send(s.id, { t: 'turn', actor: actor.id, wind: this.wind, seconds: this.turnSeconds, burn, hp: { ...hp, [actor.id]: actor.unit.hp }, skills: s.skills, order });
    }
    if (!actor.unit.alive) {
      actor.delay += DELAY_TURN;
      this.later(1500, () => this.endTurn());
      return;
    }
    if (this.quizDuel) {
      this.phase = 'quiz';
      this.quizItem = this.deck.next();
      this.opts.send(actor.id, { t: 'quiz', item: this.quizItem, seconds: this.quizSeconds });
      this.setTimer(this.quizSeconds * 1000 + this.graceMs, () => this.answer(actor, -1));
    } else {
      this.startAiming();
    }
  }

  private get actorSeat(): Seat | undefined {
    return this.seats.find((s) => s.id === this.actorId);
  }

  private answer(seat: Seat, chosen: number) {
    const item = this.quizItem!;
    const correct = chosen === item.correctIndex;
    this.deck.report(item.question, correct);
    if (correct) {
      this.damageMul = QUIZ_DUEL_BONUS;
      addGauge(seat.skills, GAUGE_CORRECT_ANSWER);
    }
    this.broadcast({ t: 'quizResult', id: seat.id, correct });
    this.startAiming();
  }

  private startAiming() {
    this.phase = 'aiming';
    this.setTimer(this.turnSeconds * 1000 + this.graceMs, () => this.skip());
  }

  private skip() {
    const actor = this.actorSeat;
    this.clearTimer();
    if (!actor) return;
    actor.delay += DELAY_TURN;
    this.phase = 'resolving';
    this.broadcast({ t: 'skipped', id: actor.id });
    this.later(800, () => this.endTurn());
  }

  /** Stamina the player's walk this turn has used (judged by how far they got, with a little slack) */
  private walkCost(seat: Seat): number {
    return Math.max(0, Math.abs(seat.unit.x - this.walkFromX) - 8) / WALK_PX_PER_STAMINA;
  }

  /** The player's skills as if their walking were paid for, to check what they can still afford */
  private budget(seat: Seat): SkillState {
    return { ...seat.skills, stamina: seat.skills.stamina - this.walkCost(seat) };
  }

  /** Accept the player's position if they didn't walk further than their stamina allows, then stand them on the ground */
  private place(seat: Seat, x: number, y: number, facing: number, angle: number) {
    if (Number.isFinite(x)) {
      const reach = Math.max(0, seat.skills.stamina) * WALK_PX_PER_STAMINA + 8;
      const nx = Math.max(this.walkFromX - reach, Math.min(this.walkFromX + reach, x));
      const ground = this.terrain.groundBelow(nx, (Number.isFinite(y) ? y : seat.unit.y) - CLIMB);
      if (ground !== null) {
        seat.unit.x = Math.max(0, Math.min(WORLD_WIDTH - 1, nx));
        seat.unit.y = ground;
      }
    }
    seat.info.facing = facing === -1 ? -1 : 1;
    if (Number.isFinite(angle)) seat.angle = Math.max(0, Math.min(90, angle));
  }

  private instantSkill(seat: Seat, slot: SkillSlot) {
    if (!isSkillSlot(slot) || !isInstantSkill(slot) || skillBlocker(this.budget(seat), slot, seat.unit.hp >= seat.unit.maxHp) !== null) return;
    pickSkill(seat.skills, slot);
    if (slot === 'heal') seat.unit.hp = Math.min(seat.unit.maxHp, seat.unit.hp + HEAL_AMOUNT);
    if (slot === 'shield') seat.shield = true;
    for (const s of this.seats) this.opts.send(s.id, { t: 'skillUsed', id: seat.id, slot, hp: seat.unit.hp, skills: s.skills });
  }

  /** Everyone on the field, as the rules see them */
  private allUnits(): Unit[] {
    return [...this.seats.map((s) => s.unit), ...(this.boss ? [this.boss.unit] : [])];
  }

  private shieldDamage = (id: string, dmg: number) => (this.seats.find((o) => o.id === id)?.shield ? Math.round(dmg * SHIELD_FACTOR) : dmg);

  private fire(seat: Seat, power: number, wanted: SkillSlot[]) {
    this.clearTimer();
    this.phase = 'resolving';
    // Take the shot skills the player picked, as far as their stamina (after walking) reaches
    const budget = this.budget(seat);
    budget.armed = [];
    for (const slot of wanted) if (!isInstantSkill(slot) && skillBlocker(budget, slot, true) === null) pickSkill(budget, slot);
    const armed = [...budget.armed];
    seat.skills.armed = budget.armed;
    seat.skills.stamina = Math.max(0, budget.stamina);
    const loadout = fireSkills(seat.skills);
    // A plain 1 v 1 just alternates; with more players, big turns wait longer for the next one
    seat.delay += this.mode === 'duel' ? DELAY_TURN : turnDelay(STAMINA_MAX - seat.skills.stamina, loadout.mode === 'ultimate');

    const weapon = baseWeaponStats(seat.info.weaponId);
    const mode = loadout.mode;
    const units = this.allUnits();
    const foes = () => units.filter((u) => u !== seat.unit && u.alive && this.teamOf(u.id) !== seat.info.team);
    const timelines: ShotTimeline[] = [];
    const bonus = seat.bonus;
    seat.bonus = 1;
    for (let k = 0; k < loadout.rounds; k++) {
      if (k > 0 && foes().length === 0) break;
      if (!seat.unit.alive) break;
      const m = fighterMuzzle(seat.unit.x, seat.unit.y, seat.info.facing, seat.angle);
      const result = resolveShot(this.terrain, units, {
        shooterId: seat.id,
        input: { x: m.x, y: m.y, angleDeg: seat.angle, facing: seat.info.facing, power: Math.max(0, Math.min(100, Number(power) || 0)), wind: this.wind },
        mode,
        special: mode === 'special' ? weaponSpecial(weapon.id).kind : null,
        damage: weapon.damage,
        radius: weapon.radius,
        damageMul: loadout.damageMul * this.damageMul * bonus,
      }, { modifyDamage: this.shieldDamage });
      this.terrain = result.terrain;
      timelines.push(compact(result));
    }
    for (const [id, n] of gaugeGains(timelines, seat.id)) {
      const s = this.seats.find((o) => o.id === id);
      if (s) addGauge(s.skills, n);
    }
    this.sendShot(seat.id, seat.unit, seat.info.facing, seat.angle, armed, timelines);
  }

  private teamOf(id: string): 0 | 1 {
    if (id === BOSS_ID) return 1;
    return this.seats.find((s) => s.id === id)?.info.team ?? 0;
  }

  /** Tell everyone about a shot, then wait while their games show it */
  private sendShot(id: string, from: Unit, facing: 1 | -1, angle: number, armed: SkillSlot[], timelines: ShotTimeline[], projectile?: string) {
    const unitsOut = this.allUnits().map((u) => ({ id: u.id, x: u.x, y: u.y, hp: u.hp, alive: u.alive }));
    for (const s of this.seats) {
      this.opts.send(s.id, { t: 'shot', id, x: from.x, y: from.y, facing, angle, armed, timelines, units: unitsOut, skills: s.skills, projectile });
    }
    const steps = timelines.reduce((a, tl) => a + tl.end, 0);
    const ms = (steps / STEPS_PER_SECOND) * 1000 + 1500 + (timelines.length - 1) * 900;
    this.later(ms, () => this.endTurn());
  }

  // ---- Co-op boss ----------------------------------------------------------------------

  private bossTurn() {
    const boss = this.boss!;
    boss.turns++;
    boss.delay += DELAY_TURN;
    if (boss.turns % COOP_ULTIMATE_EVERY === 0) {
      // The boss charges its ultimate: everyone gets the same question; enough right answers stop it
      this.phase = 'quiz';
      this.bossAnswers = new Map();
      this.quizItem = this.deck.next();
      const title = `${boss.def.name} กำลังชาร์จ "${boss.def.ultimate.name}"! ตอบถูกพร้อมกันครึ่งห้องเพื่อขัดท่า`;
      for (const s of this.livePlayers()) this.opts.send(s.id, { t: 'quiz', item: this.quizItem, seconds: this.quizSeconds, title });
      this.setTimer(this.quizSeconds * 1000 + this.graceMs, () => this.resolveBossQuiz());
      return;
    }
    this.bossShoot(boss.def.weapon, [this.bossTarget()]);
  }

  private bossAnswer(seat: Seat, chosen: number) {
    const correct = chosen === this.quizItem!.correctIndex;
    this.bossAnswers.set(seat.id, correct);
    this.deck.report(this.quizItem!.question, correct);
    if (correct) addGauge(seat.skills, GAUGE_CORRECT_ANSWER);
    this.broadcast({ t: 'quizResult', id: seat.id, correct });
    if (this.bossAnswers.size >= this.livePlayers().length) this.resolveBossQuiz();
  }

  private resolveBossQuiz() {
    if (this.phase !== 'quiz') return;
    this.clearTimer();
    this.phase = 'resolving';
    const boss = this.boss!;
    const live = this.livePlayers();
    const right = live.filter((s) => this.bossAnswers.get(s.id));
    const interrupted = live.length > 0 && right.length >= Math.ceil(live.length * COOP_INTERRUPT_SHARE);
    this.broadcast({ t: 'bossQuiz', correct: right.length, total: live.length, interrupted, name: boss.def.ultimate.name });
    if (interrupted) {
      // Stunned: no ultimate; whoever answered right hits harder next time
      for (const s of right) s.bonus = COOP_ANSWER_BONUS;
      this.later(1800, () => this.endTurn());
      return;
    }
    // The ultimate: one shell at each player still standing (up to three)
    const targets = [...live].sort(() => this.rng.next() - 0.5).slice(0, 3);
    this.later(1500, () => this.bossShoot(boss.def.ultimate.weapon, targets.map((s) => s.unit)));
  }

  /** The player the boss goes for: the weakest one (that's what bosses do) */
  private bossTarget(): Unit {
    const live = this.livePlayers();
    live.sort((a, b) => a.unit.hp - b.unit.hp || this.rng.next() - 0.5);
    return live[0].unit;
  }

  private bossShoot(weapon: WeaponStats, targets: Unit[]) {
    const boss = this.boss!;
    const body = bossBody(boss.def.height);
    const units = this.allUnits();
    const timelines: ShotTimeline[] = [];
    let angle = 50;
    let hitAny = false;
    for (const target of targets) {
      if (!boss.unit.alive || !target.alive) continue;
      boss.facing = target.x < boss.unit.x ? -1 : 1;
      const muzzle = { x: boss.unit.x + body.muzzle.x * -boss.facing, y: boss.unit.y + body.muzzle.y };
      const plan = planShot(muzzle, boss.facing, { id: target.id, x: target.x, y: target.y, radius: target.radius, offsetY: target.offsetY }, this.wind, this.terrain, units.filter((u) => u.alive).map((u) => ({ id: u.id, x: u.x, y: u.y, radius: u.radius, offsetY: u.offsetY })), BOSS_ID, boss.skill, this.rng);
      angle = plan.angle;
      const result = resolveShot(this.terrain, units, {
        shooterId: BOSS_ID,
        input: { x: muzzle.x, y: muzzle.y, angleDeg: plan.angle, facing: boss.facing, power: plan.power, wind: this.wind },
        mode: 'normal',
        special: null,
        damage: weapon.damage,
        radius: weapon.radius,
        damageMul: 1,
      }, { modifyDamage: this.shieldDamage });
      this.terrain = result.terrain;
      const tl = compact(result);
      hitAny ||= tl.events.some((e) => e.kind === 'explode' && e.hits.some((h) => h.id === target.id && h.damage > 0));
      timelines.push(tl);
    }
    // Like the stages: it aims better after a miss
    boss.skill = nextEnemySkill(boss.skill, boss.def.skill, hitAny);
    for (const [id, n] of gaugeGains(timelines, BOSS_ID)) {
      const s = this.seats.find((o) => o.id === id);
      if (s) addGauge(s.skills, n);
    }
    this.sendShot(BOSS_ID, boss.unit, boss.facing, angle, [], timelines, weapon.projectile);
  }

  // ---- End -------------------------------------------------------------------------------

  private endTurn() {
    const side = (t: 0 | 1) => this.allUnits().some((u) => u.alive && this.teamOf(u.id) === t && !this.seats.find((s) => s.id === u.id)?.gone);
    const a = side(0);
    const b = side(1);
    if (!a || !b) {
      this.finish(a ? 0 : b ? 1 : null, 'win');
      return;
    }
    this.beginTurn();
  }

  private finish(team: 0 | 1 | null, reason: 'win' | 'left') {
    this.clearTimer();
    this.phase = 'over';
    // `winner`: a player on the winning side (for 1 v 1 that's simply the winner); the boss if it won
    const winner = team === null ? null : team === 1 && this.boss ? BOSS_ID : (this.seats.find((s) => s.info.team === team && !s.gone)?.id ?? null);
    this.broadcast({ t: 'over', winner, reason, team });
    // A tournament needs a winner even after a draw: whoever had more health left
    const decided = winner ?? [...this.seats].sort((x, y) => y.unit.hp - x.unit.hp)[0]?.id ?? null;
    const report = this.opts.onOver;
    this.opts.onOver = undefined;
    report?.(decided);
  }

  // ---- Helpers --------------------------------------------------------------------

  private broadcast(msg: ServerMessage) {
    for (const s of this.seats) if (!s.gone) this.opts.send(s.id, msg);
  }

  private sendOthers(seat: Seat, msg: ServerMessage) {
    for (const s of this.seats) if (s !== seat && !s.gone) this.opts.send(s.id, msg);
  }

  private setTimer(ms: number, fn: () => void) {
    this.clearTimer();
    this.timer = setTimeout(fn, ms);
  }

  /** Pause while the games animate (shortened in tests) */
  private later(ms: number, fn: () => void) {
    this.clearTimer();
    this.timer = setTimeout(fn, ms * this.animationScale);
  }

  private clearTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}

/** Round path points to 0.1 px: about a third of the bytes, no visible difference */
function compact(tl: ShotTimeline): ShotTimeline {
  const r = (v: number) => Math.round(v * 10) / 10;
  return {
    flights: tl.flights.map((f) => ({ ...f, path: f.path.map((p) => ({ x: r(p.x), y: r(p.y) })) })),
    events: tl.events,
    end: tl.end,
  };
}
