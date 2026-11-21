// Phone smoothness check: opens the game in Chromium posing as a landscape phone
// (touch, high pixel ratio, CPU slowed down like a cheap phone), plays a few shots
// of the 2-player battle and reports the frame rate and the longest hitches.
// Needs the dev server running first:  npm run dev   (in another terminal)
// Usage: npm run playtest:mobile -w tools  [-- --throttle 4 --canvas]
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const THROTTLE = Number(opt('throttle', 4)); // 4 = a mid-range phone, 6 = an old/cheap one
const query = args.includes('--canvas') ? '?canvas' : args.includes('--webgl') ? '?webgl' : '';
const URL = `http://localhost:8080/${query}`;

// Real GPU when there is one (Windows); falls back to software rendering otherwise
const browser = await chromium.launch({ args: ['--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=default'] });
const context = await browser.newContext({
  viewport: { width: 844, height: 390 }, // iPhone 12-ish, landscape
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
});
// Fire with the buttons (a phone would start with the slingshot)
await context.addInitScript(() => localStorage.setItem('sciboom.aim', 'buttons'));
const page = await context.newPage();
const cdp = await context.newCDPSession(page);
const errors = [];
const isViteNoise = (t) => /websocket|\[vite\]/i.test(t);
page.on('pageerror', (e) => isViteNoise(e.message) || errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => m.type() === 'error' && !isViteNoise(m.text()) && errors.push(`console: ${m.text()}`));

await page.goto(URL);
await page.waitForFunction(() => window.game?.scene.isActive('Menu'), null, { timeout: 60000 });
const info = await page.evaluate(() => ({
  renderer: window.game.renderer.type === 2 ? 'WebGL' : 'Canvas',
  canvas: `${window.game.canvas.width}x${window.game.canvas.height}`,
  css: `${window.game.canvas.clientWidth}x${window.game.canvas.clientHeight}`,
}));
console.log(`renderer ${info.renderer}, canvas ${info.canvas} shown at ${info.css} css px, CPU slowed ×${THROTTLE}`);

// Count frames from the browser's own clock (what the player sees)
await page.evaluate(() => {
  const w = window;
  w.__frames = [];
  let last = performance.now();
  const tick = (t) => {
    if (w.__recording) w.__frames.push(t - last);
    last = t;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});
const measure = async (label, fn) => {
  await page.evaluate(() => {
    window.__frames = [];
    window.__recording = true;
  });
  await fn();
  const f = await page.evaluate(() => {
    window.__recording = false;
    return window.__frames;
  });
  const sorted = [...f].sort((a, b) => a - b);
  const total = f.reduce((a, b) => a + b, 0);
  const p = (q) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? 0;
  const res = {
    label,
    fps: +(f.length / (total / 1000)).toFixed(1),
    p95: +p(0.95).toFixed(1),
    worst: +(sorted.at(-1) ?? 0).toFixed(1),
    hitches: f.filter((d) => d > 50).length,
  };
  console.log(`${label.padEnd(22)} fps ${String(res.fps).padStart(5)}  p95 ${String(res.p95).padStart(5)} ms  worst ${String(res.worst).padStart(6)} ms  frames>50ms ${res.hitches}`);
  return res;
};

await cdp.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE });
await page.evaluate(() => window.game.scene.getScene('Menu').scene.start('Battle'));
await page.waitForFunction(() => window.game.scene.getScene('Battle').phase === 'aiming', null, { timeout: 60000, polling: 200 });
await page.waitForTimeout(800);

// --profile: print the functions that took the most time while aiming (for finding slow code)
if (args.includes('--profile')) {
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.start');
  await page.keyboard.down('ArrowRight');
  await page.waitForTimeout(1500);
  await page.keyboard.up('ArrowRight');
  await page.waitForTimeout(1500);
  const { profile } = await cdp.send('Profiler.stop');
  const self = new Map();
  const dt = profile.timeDeltas;
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  profile.samples.forEach((id, i) => {
    const n = byId.get(id).callFrame;
    const key = `${n.functionName || '(anon)'} ${n.url.split('/').pop()}:${n.lineNumber + 1}`;
    self.set(key, (self.get(key) ?? 0) + (dt[i] ?? 0) / 1000);
  });
  const top = [...self].sort((a, b) => b[1] - a[1]).slice(0, 25);
  console.log('\nself time (ms) over 3 s while walking/aiming:');
  for (const [k, ms] of top) console.log(`${ms.toFixed(0).padStart(7)}  ${k}`);
  await browser.close();
  process.exit(0);
}

const results = [];
results.push(await measure('aiming (idle)', () => page.waitForTimeout(3000)));
// Walk, then charge and fire with the keyboard (same code path as the on-screen buttons)
results.push(
  await measure('walk + aim', async () => {
    await page.keyboard.down('ArrowRight');
    await page.waitForTimeout(1200);
    await page.keyboard.up('ArrowRight');
    await page.keyboard.down('ArrowUp');
    await page.waitForTimeout(600);
    await page.keyboard.up('ArrowUp');
  }),
);
for (let shot = 1; shot <= 3; shot++) {
  results.push(
    await measure(`shot ${shot}: charge+fly+boom`, async () => {
      await page.keyboard.down('Space');
      await page.waitForTimeout(1300);
      await page.keyboard.up('Space');
      await page.waitForFunction(() => window.game.scene.getScene('Battle').phase === 'flying', null, { timeout: 30000, polling: 100 });
      await page.waitForFunction(() => window.game.scene.getScene('Battle').phase !== 'flying', null, { timeout: 30000, polling: 100 });
      await page.waitForTimeout(600);
    }),
  );
  await page.waitForFunction(() => window.game.scene.getScene('Battle').phase === 'aiming', null, { timeout: 30000, polling: 200 });
  await page.waitForTimeout(300);
}

const all = results.filter((r) => r.label.startsWith('shot'));
console.log(`\nshots: avg fps ${(all.reduce((a, r) => a + r.fps, 0) / all.length).toFixed(1)}, frames>50ms ${all.reduce((a, r) => a + r.hitches, 0)}`);
if (errors.length) console.log('\nERRORS:\n' + errors.join('\n'));
await browser.close();
process.exit(errors.length ? 1 : 0);
