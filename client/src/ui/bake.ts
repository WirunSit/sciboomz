import * as Phaser from 'phaser';

/**
 * Draw shapes ONCE into a texture and return its key, so they can be shown as a
 * plain image. With WebGL a Graphics object is turned into triangles again on
 * every frame, which is what makes phones stutter; an image costs almost nothing.
 *
 * `draw` gets a Graphics whose (0, 0) is the texture's top-left corner. The
 * texture is kept (by key) for the whole game, so put everything that changes
 * the picture (size, colour…) into the key.
 */
export function bake(scene: Phaser.Scene, key: string, width: number, height: number, draw: (g: Phaser.GameObjects.Graphics) => void): string {
  if (!scene.textures.exists(key)) {
    const g = scene.make.graphics({}, false);
    draw(g);
    g.generateTexture(key, Math.max(1, Math.ceil(width)), Math.max(1, Math.ceil(height)));
    g.destroy();
  }
  return key;
}

/** A round dot (a dark ring around a coloured middle when `ring` is given) */
export function dotTexture(scene: Phaser.Scene, radius: number, color: number, ring?: { width: number; color: number; alpha: number }): string {
  const r = radius + (ring?.width ?? 0);
  return bake(scene, `dot:${radius}:${color}:${ring ? `${ring.width}:${ring.color}:${ring.alpha}` : ''}`, r * 2 + 2, r * 2 + 2, (g) => {
    if (ring) g.fillStyle(ring.color, ring.alpha).fillCircle(r + 1, r + 1, r);
    g.fillStyle(color, 1).fillCircle(r + 1, r + 1, radius);
  });
}

/**
 * Keeps a set of images (one texture) for things drawn many times per frame —
 * aim guide dots, smoke puffs — reusing them instead of creating new ones.
 */
export class ImagePool {
  private readonly items: Phaser.GameObjects.Image[] = [];
  private used = 0;

  constructor(
    private readonly scene: Phaser.Scene,
    private readonly depth: number,
    private readonly scrollFactor = 1,
  ) {}

  /** Start a new frame: everything from the last one is hidden unless it's taken again */
  begin() {
    this.used = 0;
  }

  take(key: string, x: number, y: number): Phaser.GameObjects.Image {
    let img = this.items[this.used];
    if (!img) {
      img = this.scene.add.image(x, y, key).setDepth(this.depth).setScrollFactor(this.scrollFactor);
      this.items.push(img);
    } else if (img.texture.key !== key) img.setTexture(key);
    this.used++;
    return img.setPosition(x, y).setVisible(true).setAlpha(1).setScale(1).setRotation(0);
  }

  /** Hide what wasn't taken since begin() */
  end() {
    for (let i = this.used; i < this.items.length; i++) this.items[i].setVisible(false);
  }

  clear() {
    this.begin();
    this.end();
  }

  destroy() {
    this.items.forEach((i) => i.destroy());
    this.items.length = 0;
  }
}

/**
 * Change a text's colour only if it's different: Phaser redraws the text and sends
 * it to the graphics card on EVERY setColor call, even with the same colour.
 */
export function setTextColor<T extends Phaser.GameObjects.Text>(text: T, color: string): T {
  if (text.style.color !== color) text.setColor(color);
  return text;
}
