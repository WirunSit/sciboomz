import * as Phaser from 'phaser';
import { DEPTH } from '../config';

// Drawn effects (no extra art): flying dirt, weapon-coloured sparks, shock
// rings and smoke trails. Each burst is ONE Graphics object redrawn every frame,
// so a big explosion stays cheap, and it works in Canvas mode too (no tints).

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  color: number;
  shape: Shape;
  spin: number;
  angle: number;
}

type Shape = 'chunk' | 'dot' | 'shard' | 'streak' | 'leaf';

/** How a projectile's blast and trail look (by projectile texture) */
export interface BlastStyle {
  colors: number[];
  shape: Shape;
  /** Colour of the expanding shock ring */
  ring: number;
  /** Smoke/glow left behind in the air while flying */
  trail: number;
  /** Sparks float up (light things) instead of being thrown about */
  floaty?: boolean;
}

const STYLES: Record<string, BlastStyle> = {
  proj_cannonball: { colors: [0xfff1c4, 0xffb347, 0x8a8a8a], shape: 'dot', ring: 0xffe08a, trail: 0xd8d8d8 },
  proj_beaker: { colors: [0xc8fff4, 0x7cf2a0, 0xffffff], shape: 'shard', ring: 0x9dffb8, trail: 0xa8ffd0 },
  proj_atom: { colors: [0xd29bff, 0x8f6bff, 0xffffff], shape: 'dot', ring: 0xc58bff, trail: 0xc9a6ff },
  proj_slime: { colors: [0x8dff5a, 0x3fcf3a, 0xd6ff9a], shape: 'dot', ring: 0x9cff6a, trail: 0x9cff6a, floaty: false },
  proj_seed: { colors: [0x7bd34a, 0x3f9d2e, 0xc9a06a], shape: 'leaf', ring: 0xb6ff8a, trail: 0xb8e08a, floaty: true },
  proj_pollen: { colors: [0xffe45a, 0xfff4a8, 0xffb52e], shape: 'dot', ring: 0xfff07a, trail: 0xfff07a, floaty: true },
  proj_fireball: { colors: [0xffe27a, 0xff8a1f, 0xff3b1f], shape: 'dot', ring: 0xff9a3a, trail: 0xff8a2a, floaty: true },
  proj_lightning: { colors: [0xffffff, 0x8fe3ff, 0x4fb4ff], shape: 'streak', ring: 0x9fe8ff, trail: 0x9fe8ff },
  plane: { colors: [0xffffff, 0xe6ecff], shape: 'shard', ring: 0xffffff, trail: 0xffffff },
};

export function blastStyle(projectile: string): BlastStyle {
  return STYLES[projectile] ?? STYLES.proj_cannonball;
}

const GRAVITY = 900;

/** Throw particles out and let them fall/fade, all drawn by one Graphics */
function burst(scene: Phaser.Scene, parts: Particle[], seconds: number, gravity = GRAVITY) {
  const g = scene.add.graphics().setDepth(DEPTH.fx + 1);
  let t = 0;
  const tick = (_time: number, deltaMs: number) => {
    // Follows the scene's slow motion (finishing blow)
    const dt = (Math.min(deltaMs, 50) / 1000) * scene.time.timeScale;
    t += dt;
    const life = 1 - t / seconds;
    if (life <= 0 || !g.active) {
      scene.events.off(Phaser.Scenes.Events.UPDATE, tick);
      g.destroy();
      return;
    }
    g.clear();
    const alpha = Math.min(1, life * 2.5);
    for (const p of parts) {
      p.vy += gravity * dt;
      p.vx *= 0.985;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.angle += p.spin * dt;
      g.fillStyle(p.color, alpha);
      g.lineStyle(Math.max(2, p.size * 0.5), p.color, alpha);
      switch (p.shape) {
        case 'dot':
          g.fillCircle(p.x, p.y, p.size * (0.5 + 0.5 * life));
          break;
        case 'streak': {
          const len = p.size * 2.2;
          const a = Math.atan2(p.vy, p.vx);
          g.lineBetween(p.x, p.y, p.x - Math.cos(a) * len, p.y - Math.sin(a) * len);
          break;
        }
        default: {
          // Small rotated quad: dirt chunk, glass shard, leaf
          const w = p.size;
          const h = p.shape === 'chunk' ? p.size * 0.8 : p.size * 0.45;
          const c = Math.cos(p.angle);
          const s = Math.sin(p.angle);
          const pt = (dx: number, dy: number) => new Phaser.Math.Vector2(p.x + dx * c - dy * s, p.y + dx * s + dy * c);
          g.fillPoints([pt(-w, -h), pt(w, -h), pt(w, h), pt(-w, h)], true);
        }
      }
    }
  };
  scene.events.on(Phaser.Scenes.Events.UPDATE, tick);
  scene.events.once(Phaser.Scenes.Events.SHUTDOWN, () => scene.events.off(Phaser.Scenes.Events.UPDATE, tick));
}

/** Clods of ground flying out of a fresh crater (colours sampled from the ground there) */
export function debris(scene: Phaser.Scene, x: number, y: number, radius: number, colors: number[]) {
  if (colors.length === 0) return;
  const n = Math.round(10 + radius / 4);
  const parts: Particle[] = [];
  for (let i = 0; i < n; i++) {
    // Mostly upwards, fanned out
    const a = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 1.1;
    const speed = 220 + Math.random() * 380 * (radius / 55);
    parts.push({
      x: x + (Math.random() - 0.5) * radius * 0.6,
      y: y + (Math.random() - 0.5) * radius * 0.4,
      vx: Math.cos(a) * speed,
      vy: Math.sin(a) * speed,
      size: 3 + Math.random() * 5,
      color: colors[i % colors.length],
      shape: 'chunk',
      spin: (Math.random() - 0.5) * 14,
      angle: Math.random() * Math.PI,
    });
  }
  burst(scene, parts, 1.3);
}

/** Weapon-coloured sparks and a shock ring */
export function weaponBlast(scene: Phaser.Scene, x: number, y: number, radius: number, style: BlastStyle, big = false) {
  const n = Math.round((big ? 26 : 14) + radius / 6);
  const parts: Particle[] = [];
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2;
    const speed = (style.floaty ? 120 : 200) + Math.random() * (big ? 520 : 340);
    parts.push({
      x,
      y,
      vx: Math.cos(a) * speed,
      vy: Math.sin(a) * speed - (style.floaty ? 120 : 60),
      size: style.shape === 'streak' ? 6 + Math.random() * 6 : 3 + Math.random() * (big ? 7 : 5),
      color: style.colors[i % style.colors.length],
      shape: style.shape,
      spin: (Math.random() - 0.5) * 10,
      angle: Math.random() * Math.PI,
    });
  }
  burst(scene, parts, big ? 1.1 : 0.8, style.floaty ? -120 : 500);

  // Shock ring
  const ring = scene.add.graphics().setDepth(DEPTH.fx + 1);
  const state = { r: radius * 0.4, a: 0.9 };
  scene.tweens.add({
    targets: state,
    r: radius * (big ? 2.2 : 1.6),
    a: 0,
    duration: big ? 600 : 420,
    ease: 'Cubic.out',
    onUpdate: () => {
      ring.clear();
      ring.lineStyle(big ? 10 : 6, style.ring, state.a).strokeCircle(x, y, state.r);
    },
    onComplete: () => ring.destroy(),
  });
}

/**
 * Glowing puffs left in the air behind projectiles. Call add() as they fly and
 * draw() every frame; puffs shrink and fade on their own.
 */
export class Trail {
  private readonly g: Phaser.GameObjects.Graphics;
  private puffs: { x: number; y: number; color: number; age: number; size: number }[] = [];

  constructor(scene: Phaser.Scene) {
    this.g = scene.add.graphics().setDepth(DEPTH.projectile - 1);
  }

  add(x: number, y: number, color: number, size = 7) {
    this.puffs.push({ x, y, color, age: 0, size });
  }

  draw(dt: number) {
    const LIFE = 0.55;
    this.g.clear();
    this.puffs = this.puffs.filter((p) => (p.age += dt) < LIFE);
    for (const p of this.puffs) {
      const k = 1 - p.age / LIFE;
      this.g.fillStyle(p.color, 0.55 * k).fillCircle(p.x, p.y, p.size * (0.4 + 0.6 * k));
    }
  }

  clear() {
    this.puffs = [];
    this.g.clear();
  }
}
