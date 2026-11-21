// Automated check of the "game feel" effects: a finishing blow on stage 1-1
// (slow motion, camera zooms in, K.O.!, award ribbons, dirt and sparks) and
// the result panel waiting until it has played out.
// Needs the dev server running first:  npm run dev
// Usage: npm run playtest:feel -w tools
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const URL = 'http://localhost:8080/';
const out = process.argv[2] ?? '../art/debug/playtest-feel';
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ args: ['--disable-gpu'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
const isViteNoise = (t) => /websocket|\[vite\]/i.test(t);
page.on('pageerror', (e) => isViteNoise(e.message) || errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => m.type() === 'error' && !isViteNoise(m.text()) && errors.push(`console: ${m.text()}`));

const wait = (ms) => page.waitForTimeout(ms);
const until = async (fn, timeout = 40000) => {
  try {
    await page.waitForFunction(fn, null, { timeout, polling: 100 });
  } catch (e) {
    const state = await page.evaluate(() => {
      const s = window.game?.scene?.getScene?.('Stage');
      if (!s?.combatants) return 'no stage';
      const pb = s.playback;
      return JSON.stringify({ phase: s.phase, hp: s.combatants.map((c) => [c.name, c.hp, c.alive, Math.round(c.x)]), pb: pb && { el: pb.elapsed, end: pb.timeline.end, ev: pb.timeline.events.map((v) => v.kind), path: pb.timeline.flights[0].path.slice(0, 3), n: pb.timeline.flights.length }, p: [s.player.x, s.player.y, s.player.angle, s.player.facing, s.wind] });
    });
    console.log('STUCK waiting for:', fn.toString().slice(0, 120), '\nstate:', state, '\nerrors:', errors.join(' | '));
    throw e;
  }
};
const stage = (fn) => page.evaluate(fn);
const shot = async (name) => {
  const dataUrl = await page.evaluate(() => window.game.canvas.toDataURL('image/jpeg', 0.85));
  writeFileSync(`${out}/${name}.jpg`, Buffer.from(dataUrl.split(',')[1], 'base64'));
  console.log(`saved ${out}/${name}.jpg`);
};

await page.addInitScript(() => {
  localStorage.setItem('sciboom.save.v1', JSON.stringify({ character: 'boy', tutorialDone: true, answers: [] }));
});
await page.goto(URL);
await until(() => window.game?.scene?.isActive?.('Menu'));
await stage(() => {
  const g = window.game;
  g.scene.getScenes(true).forEach((s) => g.scene.stop(s.scene.key));
  g.scene.start('Stage', { stageId: '1-1' });
});
await until(() => window.game.scene.getScene('Stage').phase === 'aiming', 60000);

// Put the enemy far away on the ground and leave it 1 HP; aim the player's shot straight at it
const sharedUrl = '/@fs/' + resolve('../shared/src/index.ts').split('\\').join('/');
const aim = await page.evaluate(async (url) => {
  const sh = await import(url);
  const s = window.game.scene.getScene('Stage');
  s.crates?.forEach((c) => { c.img?.destroy(); c.glow?.destroy(); });
  s.crates = [];
  const e = s.enemy;
  e.hp = 1;
  e.x = s.player.x + 1200;
  e.y = s.terrain.groundBelow(e.x, 0);
  e.sync();
  s.setWind(0);
  // Search angle/power that lands a direct hit, with the game's own flight rules
  const f = s.player;
  f.facing = 1;
  for (let a = 30; a <= 80; a += 1) {
    for (let p = 40; p <= 100; p += 0.25) {
      f.angle = a;
      const m = f.muzzle();
      const r = sh.fly(sh.launchState({ x: m.x, y: m.y, angleDeg: a, facing: 1, power: p, wind: 0 }), { windAccel: 0 }, s.terrain, [e.toTarget()], f.id);
      if (r.directHitId === e.id) {
        f.sync();
        return { a, p };
      }
    }
  }
  return null;
}, sharedUrl);
assert.ok(aim, 'found a shot that reaches the enemy');
await page.evaluate((p) => window.game.scene.getScene('Stage').finishHuman(p), aim.p);

// Explosion: wait for the slow motion
await until(() => !!window.game.scene.getScene('Stage').finisher, 20000);
await wait(150);
await shot('1-knockout');
const during = await stage(() => {
  const s = window.game.scene.getScene('Stage');
  return { timeScale: s.time.timeScale, zoom: s.cameras.main.zoom, phase: s.phase };
});
assert.ok(during.timeScale < 1, `slow motion during the finishing blow (${during.timeScale})`);
await wait(700);
await shot('2-zoomed-in');
const zoomed = await stage(() => window.game.scene.getScene('Stage').cameras.main.zoom);
assert.ok(zoomed > 1.05, `camera closes in on the loser (${zoomed})`);
// The result panel only comes after the slow motion
const early = await stage(() => window.game.scene.getScene('Stage').children.list.some((o) => o.text === 'ด่านต่อไป' || o.list?.some?.((t) => t.text === 'ด่านต่อไป')));
assert.ok(!early, 'result panel waits for the finishing blow');
await until(() => !window.game.scene.getScene('Stage').finisher, 10000);
const after = await stage(() => window.game.scene.getScene('Stage').time.timeScale);
assert.equal(after, 1, 'normal speed again');
await wait(1500);
await shot('3-result');

await browser.close();
if (errors.length) {
  console.log(errors.join('\n'));
  process.exit(1);
}
console.log('playtest-feel: OK');
