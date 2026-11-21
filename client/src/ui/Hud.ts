import * as Phaser from 'phaser';
import { MAX_WIND, type Terrain, type Vec } from '@sciboom/shared';
import { DEPTH, FONT_FAMILY, GAME_HEIGHT, GAME_WIDTH, TEXT_STROKE } from '../config';
import type { Combatant } from '../game/Combatant';
import { bake, dotTexture, setTextColor } from './bake';
import { BAR_FRAMES, FrameBar } from './FrameBar';

const textStyle = (size: number, color = '#ffffff'): Phaser.Types.GameObjects.Text.TextStyle => ({
  fontFamily: FONT_FAMILY,
  fontSize: `${size}px`,
  fontStyle: '700',
  color,
  stroke: TEXT_STROKE,
  strokeThickness: Math.max(3, size / 6),
});

interface FighterPanel {
  portrait: Phaser.GameObjects.Image;
  hpBar: FrameBar;
  hpText: Phaser.GameObjects.Text;
  /** Where the portrait rests (it bobs while it's that fighter's turn) */
  baseY: number;
}

const MINIMAP = { x: GAME_WIDTH / 2 - 120, y: 122, w: 240, h: 64 };
/** Small panels when there are more than two on the field (2 v 2, co-op) */
const COMPACT = { w: 300, h: 46, gap: 4 };

export interface HudOptions {
  /** Which side of the screen a fighter's panel goes on (default: first left, the rest right) */
  side?: (c: Combatant, index: number) => 'left' | 'right';
}

/** Everything drawn on top of the battlefield (doesn't scroll with the camera) */
export class Hud {
  private readonly panels: FighterPanel[] = [];
  private readonly timerText: Phaser.GameObjects.Text;
  private readonly windArrow: Phaser.GameObjects.Image;
  private readonly windText: Phaser.GameObjects.Text;
  private readonly angleText: Phaser.GameObjects.Text;
  private readonly powerBar: FrameBar;
  private readonly powerMarker: Phaser.GameObjects.Triangle;
  private readonly powerArea: { x: number; w: number };
  private readonly staminaFill: Phaser.GameObjects.Image;
  private readonly staminaEnd: Phaser.GameObjects.Image;
  private readonly staminaText: Phaser.GameObjects.Text;
  /** Drawn on a small canvas only when craters change the ground (not every frame) */
  private readonly minimapGround: Phaser.GameObjects.Image;
  private readonly minimapTexture: Phaser.Textures.CanvasTexture;
  private readonly minimapView: Phaser.GameObjects.Rectangle;
  private readonly minimapDots: Phaser.GameObjects.Image[] = [];
  private readonly minimapShot: Phaser.GameObjects.Image;
  private readonly mapScale: number;
  private statusItems: Phaser.GameObjects.GameObject[] = [];
  private lastBanner?: Phaser.GameObjects.Text;
  private countdownText?: Phaser.GameObjects.Text;
  /** Bottom of the panels on the left (status icons and award ribbons go below) */
  readonly leftBottom: number;
  /** "Who's next" faces (2 v 2, co-op) */
  private orderItems: Phaser.GameObjects.GameObject[] = [];
  private readonly compact: boolean;
  /** Shot award ribbons on screen now (new ones go underneath) */
  private awards: Phaser.GameObjects.Container[] = [];
  /** Whether a fighter gets a dot on the mini-map (camouflage hides it from the other side) */
  showOnMap: (c: Combatant) => boolean = () => true;

  constructor(
    private readonly scene: Phaser.Scene,
    private readonly fighters: Combatant[],
    worldWidth: number,
    opts: HudOptions = {},
  ) {
    const sideOf = opts.side ?? ((_c: Combatant, i: number) => (i === 0 ? 'left' : 'right'));
    this.compact = fighters.length > 2;
    const stacked = { left: 0, right: 0 };
    fighters.forEach((f, i) => {
      const side = sideOf(f, i);
      // One big panel per side for 1 v 1 (or a boss); small stacked ones for teams
      const small = this.compact && fighters.filter((o, k) => sideOf(o, k) === side).length > 1;
      this.panels.push(small ? this.compactPanel(f, side, stacked[side]++) : this.fighterPanel(f, side));
    });
    this.leftBottom = stacked.left > 1 ? 8 + stacked.left * (COMPACT.h + COMPACT.gap) : 100;

    // Turn timer
    const timerBg = scene.add.circle(GAME_WIDTH / 2, 44, 34, 0x1b1d3a, 0.75).setStrokeStyle(4, 0xffcc33);
    this.timerText = scene.add.text(GAME_WIDTH / 2, 44, '20', textStyle(34, '#ffcc33')).setOrigin(0.5);

    // Wind
    this.windArrow = scene.add.image(GAME_WIDTH / 2, 100, 'ui/wind_arrow');
    this.windText = scene.add.text(GAME_WIDTH / 2, 100, '', textStyle(20)).setOrigin(0.5);
    // Hidden until the first turn sets the wind (the art is huge before it's scaled)
    this.setWind(0);

    // Mini-map
    this.mapScale = MINIMAP.w / worldWidth;
    const mapBg = scene.add.rectangle(MINIMAP.x, MINIMAP.y, MINIMAP.w, MINIMAP.h, 0x1b1d3a, 0.55).setOrigin(0).setStrokeStyle(2, 0xffffff, 0.6);
    if (scene.textures.exists('hud:minimap')) scene.textures.remove('hud:minimap');
    this.minimapTexture = scene.textures.createCanvas('hud:minimap', MINIMAP.w, MINIMAP.h)!;
    this.minimapGround = scene.add.image(MINIMAP.x, MINIMAP.y, 'hud:minimap').setOrigin(0);
    this.minimapView = scene.add.rectangle(MINIMAP.x, MINIMAP.y, 1, MINIMAP.h).setOrigin(0).setStrokeStyle(2, 0xffffff, 0.8);
    this.minimapShot = scene.add.image(0, 0, dotTexture(scene, 2.5, 0xffffff)).setVisible(false);

    // Bottom: angle + power bar
    const barY = GAME_HEIGHT - 52;
    const gauge = scene.add.image(GAME_WIDTH / 2 - 300, barY - 6, 'ui/gauge');
    gauge.setScale(84 / gauge.width);
    this.angleText = scene.add.text(GAME_WIDTH / 2 - 300, barY + 26, '', textStyle(22)).setOrigin(0.5);

    // Power bar: the fill sits exactly in the frame's inner slot
    this.powerBar = new FrameBar(scene, GAME_WIDTH / 2 + 10, barY, 440, 56, BAR_FRAMES.power);
    this.powerArea = { x: this.powerBar.holeX, w: this.powerBar.holeW };
    this.powerMarker = scene.add.triangle(0, barY - 20, 0, 0, 16, 0, 8, 12, 0xffffff).setStrokeStyle(2, 0x1b1d3a);
    const powerLabel = scene.add.text(GAME_WIDTH / 2 + 10, barY - 42, 'แรง', textStyle(18)).setOrigin(0.5);

    // Stamina for walking and skills (above the move buttons)
    const stY = GAME_HEIGHT - 138;
    const stLabel = scene.add.text(40, stY - 20, 'สตามินา', textStyle(16)).setOrigin(0, 0.5);
    this.staminaText = scene.add.text(230, stY - 20, '', textStyle(16, '#5fd4ff')).setOrigin(1, 0.5);
    const stBg = scene.add.image(39, stY - 8, bake(scene, 'hud:stamina-bg', 192, 16, (g) => {
      g.fillStyle(0x1b1d3a, 0.7).fillRoundedRect(1, 1, 190, 14, 7);
      g.lineStyle(2, 0xffffff, 0.7).strokeRoundedRect(1, 1, 190, 14, 7);
    })).setOrigin(0);
    // The full bar cut at the level (crop) plus a round right end: drawn once, not per level
    this.staminaFill = scene.add.image(43, stY - 4, bake(scene, 'hud:stamina', 184, 8, (g) => g.fillStyle(0x5fd4ff, 1).fillRoundedRect(0, 0, 184, 8, 4))).setOrigin(0);
    this.staminaEnd = scene.add.image(0, stY, dotTexture(scene, 4, 0x5fd4ff)).setOrigin(1, 0.5);

    for (const o of [
      timerBg, this.timerText, this.windArrow, this.windText, mapBg, this.minimapGround, this.minimapView, this.minimapShot,
      gauge, this.angleText, ...this.powerBar.objects, this.powerMarker, powerLabel, stLabel, this.staminaText, stBg, this.staminaFill, this.staminaEnd,
    ]) {
      o.setScrollFactor(0).setDepth(DEPTH.hud);
    }
  }

  private fighterPanel(f: Combatant, side: 'left' | 'right'): FighterPanel {
    const s = this.scene;
    const dir = side === 'left' ? 1 : -1;
    const edge = side === 'left' ? 16 : GAME_WIDTH - 16;

    const plate = s.add.image(side === 'left' ? 8 : GAME_WIDTH - 368, 8, bake(s, 'hud:plate', 360, 92, (g) => g.fillStyle(0x1b1d3a, 0.6).fillRoundedRect(0, 0, 360, 92, 18))).setOrigin(0);
    const portrait = s.add.image(edge + dir * 40, 96, f.portraitKey).setOrigin(0.5, 1);
    portrait.setScale(Math.min(86 / portrait.height, 84 / portrait.width));
    const name = s.add.text(edge + dir * 92, 14, f.name, textStyle(22)).setOrigin(side === 'left' ? 0 : 1, 0);

    // HP bar: the frame keeps its round ends, the fill sits exactly in its inner slot
    const hpBar = new FrameBar(s, edge + dir * 222, 68, 252, 40, BAR_FRAMES.hp);
    const hpText = s.add.text(edge + dir * 222, 68, '', textStyle(15)).setOrigin(0.5);

    for (const o of [plate, portrait, name, ...hpBar.objects, hpText]) o.setScrollFactor(0).setDepth(DEPTH.hud);
    const panel = { portrait, hpBar, hpText, baseY: 96 };
    this.setHpBar(panel, f);
    return panel;
  }

  /** Small panel: face, name, health; stacked down the side */
  private compactPanel(f: Combatant, side: 'left' | 'right', row: number): FighterPanel {
    const s = this.scene;
    const dir = side === 'left' ? 1 : -1;
    const edge = side === 'left' ? 8 : GAME_WIDTH - 8;
    const y = 8 + row * (COMPACT.h + COMPACT.gap);
    const plate = s.add.image(side === 'left' ? edge : edge - COMPACT.w, y, bake(s, `hud:compact:${side}:${f.color}`, COMPACT.w, COMPACT.h, (g) => {
      g.fillStyle(0x1b1d3a, 0.6).fillRoundedRect(0, 0, COMPACT.w, COMPACT.h, 12);
      // Team colour stripe
      g.fillStyle(f.color, 1).fillRoundedRect(side === 'left' ? 0 : COMPACT.w - 6, 4, 6, COMPACT.h - 8, 3);
    })).setOrigin(0);
    const portrait = s.add.image(edge + dir * 34, y + COMPACT.h - 2, f.portraitKey).setOrigin(0.5, 1);
    portrait.setScale(Math.min((COMPACT.h - 4) / portrait.height, 52 / portrait.width));
    const name = s.add.text(edge + dir * 64, y + 2, f.name, textStyle(15)).setOrigin(side === 'left' ? 0 : 1, 0);
    const hpBar = new FrameBar(s, edge + dir * 180, y + 32, 220, 24, BAR_FRAMES.hp);
    const hpText = s.add.text(edge + dir * 180, y + 32, '', textStyle(12)).setOrigin(0.5);
    for (const o of [plate, portrait, name, ...hpBar.objects, hpText]) o.setScrollFactor(0).setDepth(DEPTH.hud);
    const panel = { portrait, hpBar, hpText, baseY: y + COMPACT.h - 2 };
    this.setHpBar(panel, f);
    return panel;
  }

  private setHpBar(p: FighterPanel, f: Combatant) {
    const frac = f.hp / f.maxHp;
    p.hpBar.setFill(frac, frac > 0.5 ? 0x4cd964 : frac > 0.25 ? 0xffcc00 : 0xff3b30);
    p.hpText.setText(`${f.hp} / ${f.maxHp}`);
  }

  refreshHp() {
    this.fighters.forEach((f, i) => this.setHpBar(this.panels[i], f));
  }

  setActive(index: number) {
    this.panels.forEach((p, i) => {
      this.scene.tweens.killTweensOf(p.portrait);
      p.portrait.setAlpha(i === index ? 1 : 0.55);
      p.portrait.y = p.baseY;
      if (i === index) this.scene.tweens.add({ targets: p.portrait, y: p.baseY - 6, duration: 300, yoyo: true, repeat: -1 });
    });
  }

  /** Small icons + labels under the left (player) panel, e.g. shield, crystals */
  setStatus(items: { icon: string; text: string }[]) {
    this.statusItems.forEach((o) => o.destroy());
    this.statusItems = [];
    let x = 20;
    for (const it of items) {
      const y = this.leftBottom + 24;
      const icon = this.scene.add.image(x, y, it.icon).setOrigin(0, 0.5);
      icon.setScale(30 / icon.height);
      const label = this.scene.add.text(x + icon.displayWidth + 4, y, it.text, textStyle(17)).setOrigin(0, 0.5);
      for (const o of [icon, label]) o.setScrollFactor(0).setDepth(DEPTH.hud);
      this.statusItems.push(icon, label);
      x += icon.displayWidth + label.width + 18;
    }
  }

  /** Hide/show the turn timer (hidden during the computer's turn) */
  showTimer(visible: boolean) {
    this.timerText.setVisible(visible);
  }

  setTimer(seconds: number) {
    const s = Math.max(0, Math.ceil(seconds));
    this.timerText.setText(String(s));
    setTextColor(this.timerText, s <= 5 ? '#ff5544' : '#ffcc33');
  }

  setWind(wind: number) {
    const strength = Math.abs(wind) / MAX_WIND;
    this.windArrow.setVisible(wind !== 0);
    this.windArrow.setScale((60 + 100 * strength) / this.windArrow.width, 44 / this.windArrow.height);
    this.windArrow.setFlipX(wind < 0);
    this.windText.setText(wind === 0 ? 'ไม่มีลม' : `ลม ${Math.abs(wind)}`);
  }

  setAngle(angle: number) {
    this.angleText.setText(`มุม ${Math.round(angle)}°`);
  }

  setPower(power: number, last: number | null) {
    this.powerBar.setFill(power / 100, 0xff7a1a);
    this.powerMarker.setVisible(last !== null);
    if (last !== null) this.powerMarker.x = this.powerArea.x + (this.powerArea.w * last) / 100 - 8;
  }

  setStamina(frac: number, value?: number) {
    // Rounded ends like the frame (the radius shrinks for a nearly empty bar)
    const w = 184 * Math.max(0, Math.min(1, frac));
    this.staminaFill.setVisible(w > 0.5).setCrop(0, 0, Math.max(0, w - 4), 8);
    this.staminaEnd.setVisible(w > 0.5).setX(43 + Math.max(w, 9) + 1);
    this.staminaText.setText(value === undefined ? '' : String(Math.floor(value)));
  }

  /** Redraw the terrain outline in the mini-map (call after craters change it) */
  drawMinimap(terrain: Terrain) {
    const ctx = this.minimapTexture.getContext();
    ctx.clearRect(0, 0, MINIMAP.w, MINIMAP.h);
    ctx.fillStyle = 'rgba(127, 211, 106, 0.9)';
    const sy = MINIMAP.h / terrain.height;
    for (let x = 0; x < terrain.width; x += 8) {
      // Every solid stretch of the column (floating islands have sky below them)
      for (const [top, bottom] of terrain.columnRuns(x)) {
        ctx.fillRect(x * this.mapScale, top * sy, Math.max(1, 8 * this.mapScale), Math.max(1, (bottom + 1 - top) * sy));
      }
    }
    this.minimapTexture.refresh();
  }

  updateMinimap(terrainHeight: number, viewX: number, viewW: number, projectile: Vec | null) {
    const sy = MINIMAP.h / terrainHeight;
    const vx = MINIMAP.x + viewX * this.mapScale;
    const vw = viewW * this.mapScale;
    if (this.minimapView.x !== vx || this.minimapView.width !== vw) this.minimapView.setPosition(vx, MINIMAP.y).setSize(vw, MINIMAP.h);
    this.fighters.forEach((f, i) => {
      // Fighters can join mid-match (a boss splitting in two)
      const dot = (this.minimapDots[i] ??= this.scene.add.image(0, 0, dotTexture(this.scene, 4, f.color)).setScrollFactor(0).setDepth(DEPTH.hud));
      const on = f.alive && this.showOnMap(f);
      dot.setVisible(on);
      if (on) dot.setPosition(MINIMAP.x + f.x * this.mapScale, MINIMAP.y + Math.max(0, f.y - 30) * sy);
    });
    this.minimapShot.setVisible(!!projectile);
    if (projectile) this.minimapShot.setPosition(MINIMAP.x + projectile.x * this.mapScale, MINIMAP.y + Phaser.Math.Clamp(projectile.y, 0, terrainHeight) * sy);
  }

  /** Big centred message that fades away (e.g. "ตาของผู้เล่น 1") */
  banner(text: string, color = '#ffffff') {
    // A new message replaces the old one instead of piling on top of it
    if (this.lastBanner?.active) {
      this.scene.tweens.killTweensOf(this.lastBanner);
      this.lastBanner.destroy();
    }
    const t = this.scene.add
      .text(GAME_WIDTH / 2, GAME_HEIGHT / 2 - 80, text, textStyle(52, color))
      .setOrigin(0.5)
      .setScrollFactor(0)
      .setDepth(DEPTH.overlay)
      .setScale(0.6)
      .setAlpha(0);
    this.scene.tweens.add({ targets: t, alpha: 1, scale: 1, duration: 220, ease: 'Back.out' });
    this.scene.tweens.add({ targets: t, alpha: 0, y: t.y - 30, delay: 1000, duration: 400, onComplete: () => t.destroy() });
    this.lastBanner = t;
  }

  /**
   * A gold ribbon for a good shot (like Boom Z's "ยิงไกล!"), pops up on the left under
   * the player's panel; several stack up and fade one after another.
   */
  award(text: string, color = '#fff3b0') {
    this.awards = this.awards.filter((a) => a.active);
    const y = this.leftBottom + 86 + this.awards.length * 52;
    const label = this.scene.add.text(0, 0, text, textStyle(28, color)).setOrigin(0.5);
    const w = label.width + 70;
    const ribbon = this.scene.add.graphics();
    ribbon.fillStyle(0x1b1d3a, 0.55).fillRoundedRect(-w / 2 + 3, -22, w, 48, 22);
    ribbon.fillStyle(0xc2410c, 0.95).fillRoundedRect(-w / 2, -25, w, 48, 22);
    ribbon.fillStyle(0xffffff, 0.18).fillRoundedRect(-w / 2 + 6, -22, w - 12, 16, 8);
    ribbon.lineStyle(3, 0xffd34d, 1).strokeRoundedRect(-w / 2, -25, w, 48, 22);
    const c = this.scene.add.container(24 + w / 2, y, [ribbon, label]).setScrollFactor(0).setDepth(DEPTH.overlay).setScale(0.3).setAlpha(0);
    this.scene.tweens.add({ targets: c, scale: 1, alpha: 1, duration: 260, ease: 'Back.out' });
    this.scene.tweens.add({ targets: c, alpha: 0, x: c.x - 60, delay: 1500 + this.awards.length * 250, duration: 350, onComplete: () => c.destroy() });
    this.awards.push(c);
  }

  /** "K.O.!" slammed onto the middle of the screen for the finishing blow */
  knockout() {
    const t = this.scene.add
      .text(GAME_WIDTH / 2, GAME_HEIGHT / 2 - 40, 'K.O.!', { ...textStyle(150, '#ffdd33'), strokeThickness: 16 })
      .setOrigin(0.5)
      .setScrollFactor(0)
      .setDepth(DEPTH.overlay)
      .setScale(3)
      .setAngle(-12)
      .setAlpha(0);
    this.scene.tweens.add({ targets: t, scale: 1, alpha: 1, angle: -6, duration: 260, ease: 'Back.out' });
    this.scene.tweens.add({ targets: t, alpha: 0, scale: 1.2, delay: 1100, duration: 400, onComplete: () => t.destroy() });
  }

  /**
   * The next few turns as a row of small faces under the mini-map (turn order
   * goes by delay, so a big turn can push you back).
   */
  setOrder(next: Combatant[]) {
    this.orderItems.forEach((o) => o.destroy());
    this.orderItems = [];
    if (next.length === 0) return;
    const y = MINIMAP.y + MINIMAP.h + 26;
    const size = 34;
    const x0 = GAME_WIDTH / 2 - ((next.length - 1) * (size + 8)) / 2 + 30;
    const label = this.scene.add.text(x0 - 34, y, 'ต่อไป', textStyle(15, '#bfe8ff')).setOrigin(1, 0.5);
    this.orderItems.push(label);
    next.forEach((c, i) => {
      const x = x0 + i * (size + 8);
      const ring = this.scene.add.circle(x, y, size / 2 + 2, 0x1b1d3a, 0.8).setStrokeStyle(3, c.color);
      const face = this.scene.add.image(x, y + size / 2, c.portraitKey).setOrigin(0.5, 1);
      face.setScale(Math.min(size / face.height, size / face.width));
      this.orderItems.push(ring, face);
    });
    for (const o of this.orderItems) (o as unknown as Phaser.GameObjects.Components.ScrollFactor & Phaser.GameObjects.Components.Depth).setScrollFactor(0).setDepth(DEPTH.hud);
  }

  /** More than two on the field: small stacked panels */
  get isCompact(): boolean {
    return this.compact;
  }

  /** Big number in the middle of the screen for the last seconds of a turn (5, 4, 3, 2, 1) */
  countdown(n: number) {
    this.clearCountdown();
    const t = this.scene.add
      .text(GAME_WIDTH / 2, GAME_HEIGHT / 2 + 10, String(n), { ...textStyle(140, n <= 3 ? '#ff5544' : '#ffcc33'), strokeThickness: 12 })
      .setOrigin(0.5)
      .setScrollFactor(0)
      .setDepth(DEPTH.overlay)
      .setScale(1.8)
      .setAlpha(0);
    // Slam in, hold, then fade before the next number
    this.scene.tweens.add({ targets: t, alpha: 0.9, scale: 1, duration: 200, ease: 'Back.out' });
    this.scene.tweens.add({ targets: t, alpha: 0, scale: 0.8, delay: 600, duration: 300, onComplete: () => t.destroy() });
    this.countdownText = t;
  }

  clearCountdown() {
    if (!this.countdownText?.active) return;
    this.scene.tweens.killTweensOf(this.countdownText);
    this.countdownText.destroy();
  }
}
