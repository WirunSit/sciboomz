import * as Phaser from 'phaser';
import {
  EMOTES,
  MODE_NAMES,
  Terrain,
  addExp,
  baseWeaponStats,
  bossBody,
  coopBoss,
  coopRewards,
  pickSkill,
  pvpRewards,
  type InstantSkill,
  type RoomMode,
  type ServerMessage,
  type SkillState,
} from '@sciboom/shared';
import type { Combatant } from '../game/Combatant';
import { Enemy } from '../game/Enemy';
import { Fighter } from '../game/Fighter';
import { WORLDS } from '../game/stages';
import type { Net } from '../net/Net';
import { updateSave } from '../save';
import { showQuiz, type QuizResult } from '../ui/QuizPopup';
import { sfx, type Ambience, type Track } from '../audio/Sound';
import { DEPTH, FONT_FAMILY, GAME_WIDTH, TEXT_STROKE } from '../config';
import { track } from '../progress';
import { ArenaScene, type AwardKind } from './ArenaScene';

type Start = Extract<ServerMessage, { t: 'start' }>;

/** Throttle for telling the others where we walked/aimed */
const MOVE_SEND_MS = 100;
/** Name tag colours: us, our teammate, the other side */
const COLOR_ME = 0x3a8dde;
const COLOR_ALLY = 0x2fbf9b;
const COLOR_FOE = [0xff5e8a, 0xff9a3d];

/**
 * Online match against (or with) classmates on other devices: 1 v 1, 2 v 2,
 * or together against a co-op boss. The server decides everything (turn
 * order, wind, every shot, the boss); this scene shows it, and sends our moves.
 */
export class OnlineBattleScene extends ArenaScene {
  private net!: Net;
  private startMsg!: Start;
  private me!: Fighter;
  private fighters = new Map<string, Fighter>();
  private boss: Enemy | null = null;
  private team = new Map<Combatant, 0 | 1>();
  private lastMoveSent = 0;
  private countdown?: Phaser.Time.TimerEvent;
  private quizClosed: Promise<QuizResult> | null = null;
  private turnSeconds = 20;
  private currentActor: Combatant | null = null;
  private over = false;
  /** Winning side from the server ('over') */
  private winTeam: 0 | 1 | null = null;
  /** Why the match ended early (friend left, connection lost), shown on the result panel */
  private endReason: string | null = null;
  private emoteMenu: Phaser.GameObjects.Container | null = null;

  constructor() {
    super('Online');
  }

  init(data: { net: Net; start: Start }) {
    this.net = data.net;
    this.startMsg = data.start;
  }

  private get mode(): RoomMode {
    return this.startMsg.mode ?? 'duel';
  }

  /** The other player (1 v 1) */
  private get them(): Fighter | undefined {
    return [...this.fighters.values()].find((f) => f !== this.me);
  }

  /** Every fighter and the boss, by id */
  private who(id: string): Combatant | undefined {
    return id === this.boss?.id ? this.boss : this.fighters.get(id);
  }

  create() {
    const s = this.startMsg;
    this.over = false;
    this.endReason = null;
    this.winTeam = null;
    this.quizClosed = null;
    this.currentActor = null;
    this.emoteMenu = null;
    this.fighters = new Map();
    this.team = new Map();
    this.boss = null;

    // A co-op raid happens in the boss's own world
    const world = s.boss ? WORLDS[coopBoss(s.boss.bossId).unit - 1] : null;
    this.setupArena(s.seed, world?.background ?? 'backgrounds/pvp_arena', world?.ground ?? 'terrain/arena_candy', Terrain.decode(s.map));

    const mine = s.players.find((p) => p.id === s.you)!;
    let foeIndex = 0;
    for (const p of s.players) {
      const color = p.id === s.you ? COLOR_ME : p.team === mine.team ? COLOR_ALLY : COLOR_FOE[foeIndex++ % COLOR_FOE.length];
      const f = new Fighter(this, p.id, p.name, p.x, p.y, p.facing, { character: p.character, outfit: p.outfit }, baseWeaponStats(p.weaponId), color);
      this.fighters.set(p.id, f);
      this.team.set(f, p.team ?? 0);
      if (p.id === s.you) this.me = f;
    }
    if (s.boss) {
      const def = coopBoss(s.boss.bossId);
      const body = bossBody(def.height);
      this.boss = new Enemy(
        this,
        s.boss.id,
        { texture: def.texture, name: def.name, height: def.height, hp: s.boss.hp, hitRadius: body.radius, hitOffsetY: body.offsetY, weapon: def.weapon, skill: def.skill, muzzle: body.muzzle },
        s.boss.x,
        s.boss.y,
      );
      this.team.set(this.boss, 1);
    }
    this.combatants = [...s.players.map((p) => this.fighters.get(p.id)!), ...(this.boss ? [this.boss] : [])];
    this.setupHud('Lobby', { side: (c) => (this.team.get(c) === 0 ? 'left' : 'right') });
    for (const f of this.fighters.values()) this.enableSkills(f, true);
    this.net.onClose = () => {
      if (!this.over) this.finish(null, 'การเชื่อมต่อหลุด', null);
    };
    this.addEmoteButton();
    if (s.label) this.hud.banner(s.label, '#ffcc33');
    else if (this.boss) this.hud.banner(`ร่วมกันปราบ ${this.boss.name}!`, '#ffcc33');
    else if (this.mode === 'team') this.hud.banner(`${MODE_NAMES.team}: ล้มทีมตรงข้ามให้หมด!`, '#ffcc33');
    else this.hud.banner(`เจอกับ ${this.them?.name ?? 'เพื่อน'}!`, '#ffcc33');
    void this.loop();
  }

  // ---- Messages from the server ---------------------------------------------------

  private async loop() {
    const token = ++this.matchToken;
    for (;;) {
      const msg = await this.net.next();
      if (token !== this.matchToken) return;
      await this.handle(msg);
      if (token !== this.matchToken) return;
    }
  }

  private async handle(msg: ServerMessage) {
    switch (msg.t) {
      case 'turn':
        return this.onTurn(msg);
      case 'quiz':
        this.phase = 'quiz';
        this.quizClosed = showQuiz(this, msg.item, { title: msg.title ?? 'Quiz Duel: ตอบถูก ยิงแรงขึ้น 15%', seconds: msg.seconds }).then((res) => {
          this.net.send({ t: 'answer', chosen: res.chosen });
          this.recordAnswer(msg.item.question.id, res);
          return res;
        });
        return;
      case 'quizResult': {
        if (msg.id === this.me.id) {
          await this.quizClosed;
          this.quizClosed = null;
          // The boss's question: everyone answers, nobody aims
          if (this.currentActor === this.boss) {
            this.phase = 'idle';
            return;
          }
          if (msg.correct) this.hud.banner('ตอบถูก! ยิงแรงขึ้น 15%', '#7dff8a');
          this.startMyAim();
        } else {
          const who = this.fighters.get(msg.id);
          this.hud.banner(`${who?.name ?? 'เพื่อน'} ตอบ${msg.correct ? 'ถูก' : 'ผิด'}`, msg.correct ? '#7dff8a' : '#ff9a9a');
        }
        return;
      }
      case 'bossQuiz': {
        // Our own question closes first
        await this.quizClosed;
        this.quizClosed = null;
        this.phase = 'idle';
        if (msg.interrupted) {
          sfx.correct();
          this.boss?.stopCharge();
          this.boss?.showStun();
          this.hud.banner(`ขัดท่า "${msg.name}" สำเร็จ! (ตอบถูก ${msg.correct}/${msg.total} คน)`, '#7dff8a');
        } else {
          sfx.wrong();
          this.hud.banner(`ตอบถูกไม่ถึงครึ่ง (${msg.correct}/${msg.total}) โดน "${msg.name}"!`, '#ff9a9a');
        }
        await this.wait(1200);
        return;
      }
      case 'moved': {
        const f = this.fighters.get(msg.id);
        if (!f || f === this.me) return;
        f.facing = msg.facing;
        f.angle = msg.angle;
        this.tweens.killTweensOf(f);
        this.tweens.add({ targets: f, x: msg.x, duration: MOVE_SEND_MS, onUpdate: () => f.sync() });
        f.sync();
        return;
      }
      case 'skillUsed': {
        const f = this.fighters.get(msg.id)!;
        // Our own skill was already taken here when we tapped it (with our walking so far); keep that
        if (f !== this.me) this.applySkills(msg.skills);
        this.showInstantSkill(f, msg.slot);
        f.hp = msg.hp;
        this.hud.refreshHp();
        return;
      }
      case 'shot':
        return this.onShot(msg);
      case 'skipped': {
        const who = this.who(msg.id);
        if (msg.gone) {
          if (who?.alive) who.die();
          this.hud.refreshHp();
          this.hud.banner(`${who?.name ?? 'เพื่อน'} ออกจากเกม`, '#ff9a9a');
          return;
        }
        if (msg.id === this.me.id && this.human) this.finishHuman(null);
        this.hud.banner(msg.id === this.me.id ? 'หมดเวลา!' : `${who?.name ?? 'เพื่อน'} หมดเวลา`, '#ff8866');
        return;
      }
      case 'emote':
        this.showEmote(msg.id, msg.emote);
        return;
      case 'over':
        return this.finish(msg.winner, msg.reason === 'left' ? 'เพื่อนออกจากเกม' : null, msg.team ?? null);
      case 'rematchWanted':
        this.hud.banner(`${this.fighters.get(msg.id)?.name ?? 'เพื่อน'} อยากเล่นอีกรอบ!`, '#ffcc33');
        return;
      case 'start':
        this.scene.restart({ net: this.net, start: msg });
        return;
      case 'error':
        this.hud.banner(msg.message, '#ff9a9a');
        return;
    }
  }

  private async onTurn(msg: Extract<ServerMessage, { t: 'turn' }>) {
    this.countdown?.remove();
    const actor = this.who(msg.actor)!;
    this.currentActor = actor;
    this.turnSeconds = msg.seconds;
    this.setWind(msg.wind);
    this.hud.setActive(this.combatants.indexOf(actor));
    // More than two: turns go by delay, so show who's next
    if (this.mode !== 'duel') this.hud.setOrder((msg.order ?? []).map((id) => this.who(id)).filter((c): c is Combatant => !!c));
    this.newGaugeTurn();
    if (actor.hidden) (actor as Fighter).setStealth(false);
    this.endShield(actor);
    if (msg.burn > 0) await this.showBurn(actor, msg.burn);
    for (const [id, hp] of Object.entries(msg.hp)) {
      const c = this.who(id);
      if (c) c.hp = hp;
    }
    this.hud.refreshHp();
    this.applySkills(msg.skills);
    if (!actor.alive) return;

    if (actor === this.boss) {
      this.boss.clearStun();
      this.hud.showTimer(false);
      this.hud.banner(`ตาของ ${actor.name}`, '#ff8866');
      this.focusOn(actor);
      return;
    }
    if (actor === this.me) {
      this.hud.banner('ตาของคุณ!');
      // Quiz Duel: the question comes first, aiming starts after the answer
      if (!this.startMsg.quizDuel) this.startMyAim();
    } else {
      this.hud.banner(`ตาของ ${actor.name}${this.isFoe(this.me, actor) ? '' : ' (ทีมเรา)'}`);
      this.focusOn(actor);
      this.showCountdown(msg.seconds);
    }
  }

  private startMyAim() {
    if (this.over) return;
    void this.humanTurn(this.me, this.turnSeconds).then((power) => {
      if (this.over) return;
      if (power === null) {
        this.net.send({ t: 'pass' });
        return;
      }
      const armed = [...(this.skills.get(this.me)?.armed ?? [])];
      this.net.send({ t: 'fire', x: this.me.x, y: this.me.y, facing: this.me.facing, angle: this.me.angle, power, armed });
      this.hud.showTimer(false);
    });
  }

  private async onShot(msg: Extract<ServerMessage, { t: 'shot' }>) {
    this.countdown?.remove();
    const shooter = this.who(msg.id)!;
    if (shooter === this.boss) {
      this.boss.facing = msg.facing;
      this.boss.angle = msg.angle;
      this.boss.sync();
      // Several shells at once = its ultimate
      if (msg.timelines.length > 1) {
        this.boss.startCharge();
        sfx.ultimate();
        await this.wait(500);
        this.boss.stopCharge();
      }
      await this.boss.windUp();
    } else if (shooter !== this.me) {
      const f = shooter as Fighter;
      this.tweens.killTweensOf(f);
      f.facing = msg.facing;
      f.angle = msg.angle;
      f.snapTo(msg.x, msg.y);
    }
    if (msg.armed.includes('ultimate')) {
      this.hud.banner('ไม้ตาย!', '#ffcc33');
      sfx.ultimate();
      await this.wait(400);
    }
    const outcomes = [];
    for (let i = 0; i < msg.timelines.length; i++) {
      if (i > 0) {
        if (shooter !== this.boss) this.hud.banner(`รอบที่ ${i + 1}!`, '#ffdd33');
        await this.wait(500);
      }
      outcomes.push(await this.playTimeline(shooter, msg.timelines[i], msg.projectile ?? shooter.weapon.projectile));
    }
    if (shooter === this.me) this.comboAward(shooter, outcomes);
    await this.waitSettled();
    // The server has the final word on where everyone is and how much health they have
    for (const u of msg.units) {
      const c = this.who(u.id);
      if (!c) continue;
      c.hp = u.hp;
      if (c.alive && !u.alive) c.die();
      else if (u.alive && c instanceof Fighter && Math.hypot(c.x - u.x, c.y - u.y) > 2) c.snapTo(u.x, u.y);
    }
    this.hud.refreshHp();
    this.applySkills(msg.skills);
  }

  /** Our own skill state as the server sees it */
  private applySkills(state: SkillState | null) {
    if (!state) return;
    this.skills.set(this.me, state);
    this.refreshSkills();
  }

  private showCountdown(seconds: number) {
    let left = seconds;
    this.hud.showTimer(true);
    this.hud.setTimer(left);
    this.countdown = this.time.addEvent({
      delay: 250,
      loop: true,
      callback: () => {
        const before = Math.ceil(left);
        left -= 0.25;
        this.hud.setTimer(left);
        // The same big 5-4-3-2-1 while watching the other player
        const sec = Math.ceil(left);
        if (sec !== before && sec <= 5 && sec > 0) this.hud.countdown(sec);
        if (left <= 0) this.countdown?.remove();
      },
    });
  }

  private recordAnswer(id: string, res: QuizResult) {
    updateSave((d) => {
      d.answers.push({ id, ok: res.correct, ms: Math.round(res.timeMs), at: Date.now() });
      if (res.correct) d.crystals++;
    });
    track(this, { kind: 'answer', correct: res.correct });
  }

  /** Our good shots count for quests and achievements */
  protected onAward(shooter: Combatant, kind: AwardKind) {
    if (shooter === this.me) track(this, { kind: 'award', award: kind });
  }

  // ---- Quick chat -------------------------------------------------------------------------

  /** "พูด" button by the top bar: opens the ready-made messages */
  private addEmoteButton() {
    const btn = this.add
      .text(GAME_WIDTH / 2 - 150, 30, 'พูด', { fontFamily: FONT_FAMILY, fontSize: '20px', fontStyle: '700', color: '#ffffff', stroke: TEXT_STROKE, strokeThickness: 4, backgroundColor: '#2fbf5b', padding: { x: 12, y: 4 } })
      .setOrigin(1, 0.5)
      .setScrollFactor(0)
      .setDepth(DEPTH.hud)
      .setInteractive({ useHandCursor: true });
    btn.on('pointerup', () => this.toggleEmoteMenu(btn.x - btn.width, btn.y + 26));
  }

  private toggleEmoteMenu(x: number, y: number) {
    if (this.emoteMenu) {
      this.emoteMenu.destroy();
      this.emoteMenu = null;
      return;
    }
    const items: Phaser.GameObjects.GameObject[] = [];
    const rows = Math.ceil(EMOTES.length / 2);
    const bg = this.add.graphics();
    bg.fillStyle(0x1b1d3a, 0.92).fillRoundedRect(0, 0, 300, rows * 46 + 12, 14);
    bg.lineStyle(3, 0x2fbf5b, 1).strokeRoundedRect(0, 0, 300, rows * 46 + 12, 14);
    items.push(bg);
    EMOTES.forEach((text, i) => {
      const t = this.add
        .text(12 + (i % 2) * 144, 10 + Math.floor(i / 2) * 46, text, { fontFamily: FONT_FAMILY, fontSize: '20px', fontStyle: '700', color: '#ffffff', backgroundColor: '#3a3f6b', padding: { x: 10, y: 6 }, fixedWidth: 132 })
        .setInteractive({ useHandCursor: true });
      t.on('pointerup', () => {
        this.net.send({ t: 'emote', id: i });
        this.emoteMenu?.destroy();
        this.emoteMenu = null;
      });
      items.push(t);
    });
    this.emoteMenu = this.add.container(x, y, items).setScrollFactor(0).setDepth(DEPTH.overlay);
  }

  /** Speech bubble over whoever sent the message */
  private showEmote(id: string, n: number) {
    const f = this.fighters.get(id);
    const text = EMOTES[n];
    if (!f || !text) return;
    sfx.pick();
    const t = this.add
      .text(f.x, f.y - f.height - 70, text, { fontFamily: FONT_FAMILY, fontSize: '24px', fontStyle: '700', color: '#1b1d3a', backgroundColor: '#ffffff', padding: { x: 12, y: 6 } })
      .setOrigin(0.5, 1)
      .setDepth(DEPTH.overlay);
    this.tweens.add({ targets: t, y: t.y - 16, duration: 300, ease: 'Back.out' });
    this.tweens.add({ targets: t, alpha: 0, delay: 2200, duration: 400, onComplete: () => t.destroy() });
  }

  // ---- Hooks from ArenaScene ------------------------------------------------------------

  /** Teammates aren't foes; in co-op everyone is against the boss */
  protected isFoe(a: Combatant, b: Combatant): boolean {
    return a !== b && this.team.get(a) !== this.team.get(b);
  }

  /** Over once one side has nobody left standing */
  protected matchResult(): Combatant | null | undefined {
    const standing = (t: 0 | 1) => this.combatants.some((c) => c.alive && this.team.get(c) === t);
    if (standing(0) && standing(1)) return undefined;
    return this.combatants.find((c) => c.alive) ?? null;
  }

  /** We only ever see our own camouflaged fighter */
  protected viewerOwns(c: Combatant): boolean {
    return c === this.me;
  }

  /** The server already started our turn; just clear what we picked last time */
  protected beginSkillTurn(sk: SkillState) {
    sk.armed = [];
  }

  /** Take it here right away (so stamina adds up while we keep walking); the server shows it to everyone */
  protected useInstantSkill(f: Fighter, slot: InstantSkill) {
    pickSkill(this.skills.get(f)!, slot);
    this.net.send({ t: 'skill', slot });
  }

  protected onHumanMoved(f: Fighter) {
    const now = this.time.now;
    if (now - this.lastMoveSent < MOVE_SEND_MS) return;
    this.lastMoveSent = now;
    this.net.send({ t: 'move', x: f.x, y: f.y, facing: f.facing, angle: f.angle });
  }

  protected leave(menuScene: string) {
    this.over = true;
    this.net.send({ t: 'leave' });
    this.net.close();
    this.scene.start(menuScene);
  }

  // ArenaScene's own match loop isn't used online: the server runs the turns
  protected async takeTurn(_actor: Combatant) {}

  protected musicTrack(): Track {
    return this.startMsg.boss ? 'boss' : 'pvp';
  }

  protected ambienceKind(): Ambience {
    return 'arena';
  }

  // ---- End -------------------------------------------------------------------------------

  private finish(winnerId: string | null, why: string | null, team: 0 | 1 | null) {
    if (this.over) return;
    this.over = true;
    this.countdown?.remove();
    this.endReason = why;
    const winner = winnerId ? (this.who(winnerId) ?? null) : null;
    // An older server only says who won: their side is the winning one
    this.winTeam = team ?? (winner ? (this.team.get(winner) ?? null) : null);
    if (this.human) this.finishHuman(null);
    this.endMatch(winner);
  }

  protected onMatchEnd(winner: Combatant | null) {
    const won = this.winTeam !== null && this.winTeam === this.team.get(this.me);
    if (won) sfx.win();
    else sfx.lose();
    const rewards = this.boss ? coopRewards(won) : pvpRewards(won);
    let levelUp = 0;
    const saved = updateSave((d) => {
      const lv = addExp(d, rewards.exp);
      d.level = lv.level;
      d.exp = lv.exp;
      levelUp = lv.levelsGained;
      d.coins += rewards.coins;
    });
    this.time.delayedCall(900, () => track(this, { kind: 'pvp', won }));
    // Everyone on the winning side cheers
    for (const c of this.combatants) if (c.alive && this.team.get(c) === this.winTeam) c.celebrate();
    if (winner) this.focusOn(winner);
    const lines = [`EXP +${rewards.exp} · เหรียญ +${rewards.coins}`];
    if (levelUp > 0) lines.push(`เลเวลอัป! ตอนนี้ Lv ${saved.level}`);
    if (this.endReason) lines.unshift(this.endReason);
    // A rematch needs everyone still here
    // A tournament match has no rematch: the winner goes on in the bracket
    const canRematch = this.net.isOpen && !this.endReason && !this.startMsg.label;
    if (this.startMsg.label) {
      const final = this.startMsg.label.includes('ชิงชนะเลิศ');
      lines.push(won ? (final ? 'คุณคือแชมป์ทัวร์นาเมนต์!' : 'ผ่านเข้ารอบต่อไป! กลับห้องรอเพื่อรอคู่ถัดไป') : 'จบการแข่งขันของคุณแล้ว ดูผลบนจอของครูได้');
    }
    const buttons = [];
    if (canRematch) {
      buttons.push({
        label: 'เล่นอีกครั้ง',
        onClick: () => {
          this.net.send({ t: 'rematch' });
          this.hud.banner('รอเพื่อนกดเล่นอีกครั้ง...', '#bfe8ff');
        },
      });
    }
    buttons.push({ label: 'กลับห้องรอ', onClick: () => this.leave('Lobby'), color: 0x3a8dde });
    let title: string;
    if (this.boss) title = won ? `ปราบ ${this.boss.name} สำเร็จ!` : `${this.boss.name} ชนะ... ลองใหม่!`;
    else if (this.mode === 'team') title = won ? 'ทีมคุณชนะ!' : this.winTeam === null ? 'เสมอ!' : 'ทีมคุณแพ้';
    else title = won ? 'คุณชนะ!' : winner ? `${winner.name} ชนะ` : 'เสมอ!';
    this.showResult(title, lines, buttons, won ? '#ffcc33' : '#ff8866');
  }
}
