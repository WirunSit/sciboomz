import * as Phaser from 'phaser';
import { sfx } from '../audio/Sound';
import { FONT_FAMILY, TEXT_STROKE } from '../config';
import { bake } from './bake';

export interface TextButtonOptions {
  width?: number;
  height?: number;
  color?: number;
  fontSize?: number;
  disabled?: boolean;
}

/** Rounded, chunky button with a Thai label. Works with mouse and touch. */
export function addTextButton(
  scene: Phaser.Scene,
  x: number,
  y: number,
  label: string,
  onClick: () => void,
  opts: TextButtonOptions = {},
): Phaser.GameObjects.Container {
  const w = opts.width ?? 360;
  const h = opts.height ?? 72;
  const color = opts.disabled ? 0x777788 : (opts.color ?? 0xff8a1f);

  // Drawn once into a picture (cheaper to show every frame than shapes, especially on phones)
  const P = 2; // room for the outline
  const key = bake(scene, `button:${w}x${h}:${color}`, w + 4 + 2 * P, h + 6 + 2 * P, (b) => {
    b.fillStyle(0x000000, 0.35).fillRoundedRect(P + 4, P + 6, w, h, 20);
    b.fillStyle(color, 1).fillRoundedRect(P, P, w, h, 20);
    b.fillStyle(0xffffff, 0.25).fillRoundedRect(P + 8, P + 6, w - 16, h / 2 - 6, 14);
    b.lineStyle(4, 0x1b1d3a, 1).strokeRoundedRect(P, P, w, h, 20);
  });
  const g = scene.add.image(-w / 2 - P, -h / 2 - P, key).setOrigin(0);

  const text = scene.add
    .text(0, 0, label, {
      fontFamily: FONT_FAMILY,
      fontSize: `${opts.fontSize ?? 30}px`,
      fontStyle: '700',
      color: '#ffffff',
      stroke: TEXT_STROKE,
      strokeThickness: 5,
    })
    .setOrigin(0.5);

  const button = scene.add.container(x, y, [g, text]).setSize(w, h);
  if (!opts.disabled) {
    button.setInteractive({ useHandCursor: true });
    button.on('pointerdown', () => button.setScale(0.95));
    button.on('pointerout', () => button.setScale(1));
    button.on('pointerup', () => {
      button.setScale(1);
      sfx.click();
      onClick();
    });
  }
  return button;
}
