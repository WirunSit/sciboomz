// Automated check of the map shapes: a floating-islands stage (world 2) and a
// canyon stage (world 4) draw properly with both sides standing on ground,
// and walking off the edge of an island loses the match.
// Needs the dev server running first:  npm run dev
// Usage: npm run playtest:maps -w tools
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';

const URL = 'http://localhost:8080/';
const out = process.argv[2] ?? '../art/debug/playtest-maps';
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ args: ['--disable-gpu'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
const isViteNoise = (t) => /websocket|\[vite\]/i.test(t);
page.on('pageerror', (e) => isViteNoise(e.message) || errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => m.type() === 'error' && !isViteNoise(m.text()) && errors.push(`console: ${m.text()}`));

const wait = (ms) => page.waitForTimeout(ms);
const until = (fn, timeout = 60000) => page.waitForFunction(fn, null, { timeout, polling: 100 });
const shot = async (name) => {
  const dataUrl = await page.evaluate(() => window.game.canvas.toDataURL('image/jpeg', 0.85));
  writeFileSync(`${out}/${name}.jpg`, Buffer.from(dataUrl.split(',')[1], 'base64'));
  console.log(`saved ${out}/${name}.jpg`);
};
const startStage = async (stageId) => {
  await page.evaluate((id) => {
    const g = window.game;
    g.scene.getScenes(true).forEach((s) => g.scene.stop(s.scene.key));
    g.scene.start('Stage', { stageId: id });
  }, stageId);
  await until(() => window.game.scene.getScene('Stage').phase === 'aiming');
};
/** Where everyone stands, and whether there's ground right under them */
const footing = () =>
  page.evaluate(() => {
    const s = window.game.scene.getScene('Stage');
    return s.combatants.map((c) => ({ name: c.name, x: Math.round(c.x), y: Math.round(c.y), ground: s.terrain.groundBelow(c.x, c.y - 20) }));
  });

await page.addInitScript(() => {
  localStorage.setItem('sciboom.save.v1', JSON.stringify({ character: 'girl', tutorialDone: true, answers: [] }));
});
await page.goto(URL);
await until(() => window.game?.scene?.isActive?.('Menu'));

for (const [id, name] of [['2-1', 'islands'], ['4-3', 'canyon']]) {
  await startStage(id);
  await wait(800);
  for (const f of await footing()) assert.ok(f.ground !== null && Math.abs(f.ground - f.y) < 4, `${id}: ${f.name} stands on ground (${JSON.stringify(f)})`);
  // Zoom out to see the whole map in the picture
  await page.evaluate(() => {
    const s = window.game.scene.getScene('Stage');
    s.guideBox = { minX: 0, maxX: 2000, minY: 0 };
  });
  await wait(1200);
  await shot(`${id}-${name}`);
}

// Islands: walk the player off the edge of the island → falls → loses
await startStage('2-1');
await page.evaluate(() => {
  const s = window.game.scene.getScene('Stage');
  s.controls.moveDir = -1; // keep walking left, off the island
  Object.defineProperty(s.controls, 'moveDir', { get: () => -1, configurable: true });
  s.skills.get(s.player).stamina = 1e6;
});
await until(() => !window.game.scene.getScene('Stage').player.alive, 30000);
await until(() => window.game.scene.getScene('Stage').phase === 'over', 15000);
await wait(1500);
await shot('fell-off');

await browser.close();
if (errors.length) {
  console.log(errors.join('\n'));
  process.exit(1);
}
console.log('playtest-maps: OK');
