import * as Phaser from 'phaser';
import { DEPTH, FONT_FAMILY, GAME_WIDTH, TEXT_STROKE } from '../config';

/** Toasts on screen now, per scene (new ones wait their turn below the others) */
const showing = new WeakMap<Phaser.Scene, Phaser.GameObjects.Container[]>();

/**
 * A card that slides down from the top for a few seconds, e.g. "ภารกิจรายวันสำเร็จ!".
 * Sits above everything (also above the battle HUD) and never blocks taps.
 */
export function showToast(scene: Phaser.Scene, title: string, detail: string, color = '#ffcc33') {
  const list = (showing.get(scene) ?? []).filter((c) => c.active);
  showing.set(scene, list);
  const y = 70 + list.length * 92;
  const style = (size: number, c: string) => ({ fontFamily: FONT_FAMILY, fontSize: `${size}px`, fontStyle: '700', color: c, stroke: TEXT_STROKE, strokeThickness: 5, padding: { top: 6 } });
  const t1 = scene.add.text(0, -16, title, style(24, color)).setOrigin(0.5);
  const t2 = scene.add.text(0, 18, detail, style(19, '#ffffff')).setOrigin(0.5);
  const w = Math.max(t1.width, t2.width) + 60;
  const bg = scene.add.graphics();
  bg.fillStyle(0x000000, 0.35).fillRoundedRect(-w / 2 + 4, -38, w, 82, 18);
  bg.fillStyle(0x1b1d3a, 0.95).fillRoundedRect(-w / 2, -42, w, 82, 18);
  bg.lineStyle(4, Phaser.Display.Color.HexStringToColor(color).color, 1).strokeRoundedRect(-w / 2, -42, w, 82, 18);
  const c = scene.add.container(GAME_WIDTH / 2, y - 120, [bg, t1, t2]).setDepth(DEPTH.overlay + 50).setScrollFactor(0);
  list.push(c);
  scene.tweens.add({ targets: c, y, duration: 350, ease: 'Back.out' });
  scene.tweens.add({ targets: c, y: y - 120, alpha: 0, delay: 2800 + list.length * 300, duration: 350, ease: 'Cubic.in', onComplete: () => c.destroy() });
}
