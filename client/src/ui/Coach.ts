import * as Phaser from 'phaser';
import { DEPTH, FONT_FAMILY, GAME_WIDTH, TEXT_STROKE } from '../config';
import { wrapThai } from './thaiWrap';

export interface Tip {
  text: string;
  /** Screen point the arrow shows */
  x: number;
  y: number;
}

const BOX_W = 420;

/**
 * How-to-play tips for a new player: a speech bubble with an arrow bouncing
 * at a button. It never blocks the game (only its own "เข้าใจแล้ว" button
 * takes taps), so the player can try the thing while reading.
 */
export class Coach {
  private parts: Phaser.GameObjects.GameObject[] = [];
  private done: (() => void) | null = null;

  constructor(private readonly scene: Phaser.Scene) {}

  /** Show one tip; resolves when it's dismissed (button) or closed from outside (close()) */
  show(tip: Tip): Promise<void> {
    this.close();
    const s = this.scene;
    const style = { fontFamily: FONT_FAMILY, fontSize: '22px', fontStyle: '700', color: '#1b1d3a', padding: { top: 6 }, lineSpacing: 4 };
    const body = s.add.text(0, 0, wrapThai(tip.text, '700 22px Kanit', BOX_W - 40), style).setOrigin(0.5, 0);
    const h = body.height + 86;
    // The bubble sits above the target if there's room, otherwise below
    const above = tip.y > h + 70;
    const bx = Phaser.Math.Clamp(tip.x, BOX_W / 2 + 16, GAME_WIDTH - BOX_W / 2 - 16);
    const by = above ? tip.y - 60 - h : tip.y + 60;
    const g = s.add.graphics();
    g.fillStyle(0x000000, 0.3).fillRoundedRect(bx - BOX_W / 2 + 5, by + 6, BOX_W, h, 20);
    g.fillStyle(0xfff8e1, 1).fillRoundedRect(bx - BOX_W / 2, by, BOX_W, h, 20);
    g.lineStyle(4, 0xffb020, 1).strokeRoundedRect(bx - BOX_W / 2, by, BOX_W, h, 20);
    body.setPosition(bx, by + 16);
    const btn = s.add
      .text(bx, by + h - 30, 'เข้าใจแล้ว', { fontFamily: FONT_FAMILY, fontSize: '20px', fontStyle: '700', color: '#ffffff', backgroundColor: '#ff8a1f', padding: { x: 18, y: 6 }, stroke: TEXT_STROKE, strokeThickness: 3 })
      .setOrigin(0.5)
      .setInteractive({ useHandCursor: true });
    btn.on('pointerup', () => this.close());
    // Arrow at the target
    const dir = above ? 1 : -1;
    const arrow = s.add.triangle(tip.x, tip.y - dir * 34, -18, -dir * 22, 18, -dir * 22, 0, dir * 6, 0xffb020).setStrokeStyle(3, 0x1b1d3a);
    s.tweens.add({ targets: arrow, y: arrow.y - dir * 12, duration: 380, yoyo: true, repeat: -1, ease: 'Sine.inOut' });
    const ring = s.add.circle(tip.x, tip.y, 46).setStrokeStyle(5, 0xffb020, 0.9);
    s.tweens.add({ targets: ring, scale: 1.25, alpha: 0.3, duration: 700, yoyo: true, repeat: -1 });
    this.parts = [g, body, btn, arrow, ring];
    for (const p of this.parts) (p as unknown as Phaser.GameObjects.Components.ScrollFactor & Phaser.GameObjects.Components.Depth).setScrollFactor(0).setDepth(DEPTH.overlay + 20);
    // The text was made first (to size the bubble): keep it in front of the bubble
    body.setDepth(DEPTH.overlay + 21);
    btn.setDepth(DEPTH.overlay + 21);
    for (const p of [g, body, btn]) {
      const o = p as unknown as Phaser.GameObjects.Components.Alpha;
      o.setAlpha(0);
      s.tweens.add({ targets: p, alpha: 1, duration: 250 });
    }
    return new Promise((resolve) => (this.done = resolve));
  }

  /** Take the current tip away (and let whoever waits on it carry on) */
  close() {
    for (const p of this.parts) {
      this.scene.tweens.killTweensOf(p);
      p.destroy();
    }
    this.parts = [];
    const done = this.done;
    this.done = null;
    done?.();
  }

  get open(): boolean {
    return this.parts.length > 0;
  }
}
