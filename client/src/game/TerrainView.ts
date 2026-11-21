import * as Phaser from 'phaser';
import type { Terrain } from '@sciboom/shared';
import { DEPTH } from '../config';

/**
 * Width of one strip of the ground picture. A crater only re-sends the strips it
 * touches to the graphics card (a whole 2000×720 picture makes phones hitch).
 */
const STRIP = 256;

/**
 * Draws a shared Terrain mask into canvas textures (side-by-side strips) and
 * keeps the two in sync when explosions carve craters.
 */
export class TerrainView {
  private readonly strips: { texture: Phaser.Textures.CanvasTexture; ctx: CanvasRenderingContext2D; x: number }[] = [];
  /** The ground's colours as first painted (read back for crater dirt without asking the graphics card) */
  private pixels: Uint8ClampedArray = new Uint8ClampedArray(0);

  /**
   * @param groundKey texture from art sheet 12 (e.g. 'terrain/arena_candy'); its top edge
   *                  (grass/crust) follows the ground surface. Omit to use drawn soil.
   */
  constructor(
    scene: Phaser.Scene,
    readonly terrain: Terrain,
    groundKey?: string,
  ) {
    for (let x = 0, i = 0; x < terrain.width; x += STRIP, i++) {
      const key = `terrain:${i}`;
      if (scene.textures.exists(key)) scene.textures.remove(key);
      const texture = scene.textures.createCanvas(key, Math.min(STRIP, terrain.width - x), terrain.height)!;
      this.strips.push({ texture, ctx: texture.getContext(), x });
      scene.add.image(x, 0, key).setOrigin(0).setDepth(DEPTH.terrain);
    }
    if (groundKey && scene.textures.exists(groundKey)) this.paintTextured(scene, groundKey);
    else this.paint();
  }

  /** Copy the painted picture into the strips */
  private show(img: ImageData) {
    this.pixels = img.data;
    for (const s of this.strips) {
      s.ctx.putImageData(img, -s.x, 0, s.x, 0, s.texture.width, s.texture.height);
      s.texture.refresh();
    }
  }

  /** Colour every solid pixel: grass on top, then layered soil with speckles */
  private paint() {
    const { width: w, height: h, mask } = this.terrain;
    const img = new ImageData(w, h);
    const px = img.data;
    for (let x = 0; x < w; x++) {
      let top = -1;
      for (let y = 0; y < h; y++) {
        const i = y * w + x;
        if (!mask[i]) {
          top = -1; // a gap: the next solid stretch (e.g. a floating island) gets its own grass
          continue;
        }
        if (top < 0) top = y;
        const depth = y - top;
        // Cheap repeatable noise for speckles
        const n = ((x * 73856093) ^ (y * 19349663)) >>> 0;
        const speck = (n % 23 === 0 ? -28 : 0) + ((n >>> 8) % 9) - 4;
        let r: number, g: number, b: number;
        if (depth < 9) {
          [r, g, b] = [96 + speck, 196 + speck, 70]; // grass
        } else if (depth < 13) {
          [r, g, b] = [58, 130, 48]; // grass edge
        } else {
          const shade = Math.max(0.55, 1 - depth / 900);
          [r, g, b] = [(176 + speck) * shade, (118 + speck) * shade, (72 + speck) * shade]; // soil
          if (Math.floor((y + Math.sin(x * 0.02) * 6) / 38) % 2 === 0) {
            r *= 0.93;
            g *= 0.93;
            b *= 0.93; // soil bands
          }
        }
        const o = i * 4;
        px[o] = r;
        px[o + 1] = g;
        px[o + 2] = b;
        px[o + 3] = 255;
      }
    }
    this.show(img);
  }

  /**
   * Map the ground texture so its top band sits on the surface everywhere, then
   * mirror-repeat the lower part going down (mirroring hides tile seams).
   */
  private paintTextured(scene: Phaser.Scene, groundKey: string) {
    const src = scene.textures.get(groundKey).getSourceImage() as HTMLImageElement;
    const tileCanvas = document.createElement('canvas');
    tileCanvas.width = src.width;
    tileCanvas.height = src.height;
    const tctx = tileCanvas.getContext('2d')!;
    tctx.drawImage(src, 0, 0);
    const tile = tctx.getImageData(0, 0, src.width, src.height).data;
    const T = src.width;

    const SCALE = 0.55; // shown at 55% so the grass band isn't too thick
    const TOP_BAND = 0.35; // top 35% of the tile is the surface crust
    const mirror = (v: number, n: number) => {
      const m = v % (2 * n);
      return m < n ? m : 2 * n - 1 - m;
    };

    const { width: w, height: h, mask } = this.terrain;
    const img = new ImageData(w, h);
    const px = img.data;
    for (let x = 0; x < w; x++) {
      const u = mirror(Math.floor(x / SCALE), T);
      let top = -1;
      for (let y = 0; y < h; y++) {
        const i = y * w + x;
        if (!mask[i]) {
          top = -1; // a gap: the next solid stretch (e.g. a floating island) gets its own crust
          continue;
        }
        if (top < 0) top = y;
        const d = Math.floor((y - top) / SCALE);
        const band = Math.floor(T * TOP_BAND);
        const v = d < T ? d : band + mirror(d - T, T - band);
        const t = (v * T + u) * 4;
        const shade = Math.max(0.6, 1 - (y - top) / 1100);
        const o = i * 4;
        px[o] = tile[t] * shade;
        px[o + 1] = tile[t + 1] * shade;
        px[o + 2] = tile[t + 2] * shade;
        px[o + 3] = 255;
      }
    }
    this.show(img);
  }

  /** Colours of the ground inside a circle (for the dirt thrown out of a crater); empty if there's none */
  groundColors(cx: number, cy: number, radius: number, count = 6): number[] {
    const out: number[] = [];
    for (let i = 0; i < count * 3 && out.length < count; i++) {
      const a = (i / count) * Math.PI * 2;
      const r = radius * (0.3 + 0.6 * ((i * 7) % 5) / 5);
      const x = Math.round(cx + Math.cos(a) * r);
      const y = Math.round(cy + Math.sin(a) * r);
      if (!this.terrain.isSolid(x, y)) continue;
      const o = (y * this.terrain.width + x) * 4;
      out.push((this.pixels[o] << 16) | (this.pixels[o + 1] << 8) | this.pixels[o + 2]);
    }
    return out;
  }

  /** Blow a crater in both the data and the picture, with a scorched rim */
  carve(cx: number, cy: number, radius: number) {
    this.terrain.carve(cx, cy, radius);
    const reach = radius + 8;
    for (const { texture, ctx, x } of this.strips) {
      if (cx + reach < x || cx - reach > x + texture.width) continue; // this strip isn't touched
      ctx.save();
      ctx.translate(-x, 0);
      // Darken the ground just around the hole (only where ground exists)
      ctx.globalCompositeOperation = 'source-atop';
      ctx.fillStyle = 'rgba(60, 35, 20, 0.55)';
      ctx.beginPath();
      ctx.arc(cx, cy, radius + 7, 0, Math.PI * 2);
      ctx.fill();
      // Then cut the hole itself
      ctx.globalCompositeOperation = 'destination-out';
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      texture.refresh();
    }
  }
}
