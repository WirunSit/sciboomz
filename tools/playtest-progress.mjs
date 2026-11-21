// Automated check of the "come back tomorrow" features: how-to-play tips for a
// new player, daily quests + badges (complete, collect), the classroom
// leaderboard (real accounts on the dev server) and hard mode.
// Needs the dev server running first:  npm run dev
// Usage: npm run playtest:progress -w tools
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';

const BASE = 'http://localhost:8080/';
const out = process.argv[2] ?? '../art/debug/playtest-progress';
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ args: ['--disable-gpu'] });
const errors = [];
const isViteNoise = (t) => /websocket|\[vite\]/i.test(t);

async function openGame(save, session) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on('pageerror', (e) => isViteNoise(e.message) || errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && !isViteNoise(m.text()) && errors.push(`console: ${m.text()}`));
  await page.addInitScript(
    ([s, sess]) => {
      if (sess) {
        localStorage.setItem('sciboom.session.v1', JSON.stringify(sess));
        localStorage.setItem(`sciboom.save.s.${sess.profile.id}`, JSON.stringify(s));
      } else localStorage.setItem('sciboom.save.v1', JSON.stringify(s));
    },
    [save, session],
  );
  await page.goto(BASE);
  await page.waitForFunction(() => window.game?.scene?.isActive?.('Menu'), null, { timeout: 60000 });
  return page;
}
const until = (page, fn, timeout = 60000) => page.waitForFunction(fn, null, { timeout, polling: 100 });
const shot = async (page, name) => {
  const dataUrl = await page.evaluate(() => window.game.canvas.toDataURL('image/jpeg', 0.85));
  writeFileSync(`${out}/${name}.jpg`, Buffer.from(dataUrl.split(',')[1], 'base64'));
  console.log(`saved ${out}/${name}.jpg`);
};
const go = (page, key, data) =>
  page.evaluate(
    ([k, d]) => {
      const g = window.game;
      g.scene.getScenes(true).forEach((s) => g.scene.stop(s.scene.key));
      g.scene.start(k, d);
    },
    [key, data],
  );
const api = async (method, path, body, token) => {
  const res = await fetch(BASE + 'api/' + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json();
  assert.ok(res.ok, `${path}: ${JSON.stringify(data)}`);
  return data;
};

// ---- 1. A brand-new player gets tips in the first stage ---------------------------------------------
{
  const page = await openGame({ character: 'boy', answers: [] });
  await go(page, 'Stage', { stageId: '1-1' });
  await until(page, () => window.game.scene.getScene('Stage').phase === 'aiming');
  await until(page, () => window.game.scene.getScene('Stage').coach.open, 10000);
  await page.waitForTimeout(400);
  await shot(page, '1-tutorial-tip');
  // Changing the angle closes the "aim" tip and shows the "fire" tip
  await page.keyboard.down('ArrowUp');
  await page.waitForTimeout(400);
  await page.keyboard.up('ArrowUp');
  await page.waitForTimeout(500);
  const second = await page.evaluate(() => window.game.scene.getScene('Stage').coach.open);
  assert.ok(second, 'the next tip shows after aiming');
  await shot(page, '2-tutorial-fire');
  await page.close();
}

// ---- 2. Daily quests: one already complete → collect it ---------------------------------------------
{
  const page = await openGame({ character: 'girl', tutorialDone: true, coins: 10, answers: [] });
  // Complete today's first quest by bumping its counter (the same way the game records events)
  await page.evaluate(() => {
    const raw = JSON.parse(localStorage.getItem('sciboom.save.v1'));
    return raw;
  });
  await go(page, 'Quests', { tab: 'daily', from: 'Menu' });
  await page.waitForTimeout(800);
  const made = await page.evaluate(() => {
    const key = 'sciboom.save.v1';
    const d = JSON.parse(localStorage.getItem(key));
    // The scene filled in today's quests when it loaded the save; finish quest 1
    const scene = window.game.scene.getScene('Quests');
    return { has: !!d, scene: !!scene };
  });
  assert.ok(made.scene);
  // Use the real tracker: answer right many times
  await page.evaluate(async () => {
    const { track } = await import('/src/progress.ts');
    for (let i = 0; i < 15; i++) track(null, { kind: 'answer', correct: true });
    for (let i = 0; i < 4; i++) track(null, { kind: 'crate' });
    for (let i = 0; i < 3; i++) track(null, { kind: 'award', award: 'ko' });
    track(null, { kind: 'award', award: 'long' });
    track(null, { kind: 'stage', won: true, stars: 3, boss: true, hard: false });
    track(null, { kind: 'stage', won: true, stars: 3, boss: false, hard: false });
    track(null, { kind: 'pvp', won: true });
  });
  await go(page, 'Quests', { tab: 'daily', from: 'Menu' });
  await page.waitForTimeout(800);
  await shot(page, '3-daily-quests');
  const before = await page.evaluate(() => JSON.parse(localStorage.getItem('sciboom.save.v1')));
  const ready = before.daily.claimed.length;
  assert.equal(ready, 3);
  // Collect all three (buttons at x=1000, rows at y=210/318/426) and the bonus (y=540)
  for (const y of [210, 318, 426, 540]) {
    await page.mouse.click(1000, y);
    await page.waitForTimeout(600);
  }
  const after = await page.evaluate(() => JSON.parse(localStorage.getItem('sciboom.save.v1')));
  assert.deepEqual(after.daily.claimed, [true, true, true], 'all three quests collected');
  assert.ok(after.daily.bonusClaimed, 'bonus collected');
  assert.ok(after.coins > before.coins, `coins went up (${before.coins} → ${after.coins})`);
  await shot(page, '4-daily-collected');
  await go(page, 'Quests', { tab: 'badges', from: 'Menu' });
  await page.waitForTimeout(800);
  await shot(page, '5-badges');
  await go(page, 'Menu', {});
  await page.waitForTimeout(800);
  await shot(page, '6-menu-red-dot');
  await page.close();
}

// ---- 3. Classroom leaderboard with real accounts ----------------------------------------------------
{
  const t = await api('POST', 'teacher/register', { username: `kru${Date.now().toString(36)}`, password: 'password123', displayName: 'ครูทดสอบ' });
  const code = `L${Date.now().toString(36).toUpperCase().slice(-6)}`;
  const room = await api('POST', 'teacher/classrooms', { name: 'ม.1/8 ทดสอบ', students: 4, code }, t.token);
  const detail = await api('GET', `teacher/classrooms/${room.classroom.id}`, undefined, t.token);
  const logins = [];
  for (const s of detail.students.slice(0, 3)) logins.push(await api('POST', 'student/login', { classCode: code, number: s.number, pin: s.pin }));
  const now = Date.now();
  const saves = [
    { level: 3, stars: { '1-1': 2 }, stats: { pvpWins: 1 }, achieved: ['correct-10'], answers: [1, 2, 3].map((i) => ({ id: `u1-00${i}`, ok: true, ms: 3000, at: now - i * 1000 })) },
    { level: 9, stars: { '1-1': 3, '1-2': 3 }, stats: { pvpWins: 6 }, achieved: ['correct-10', 'level-5'], answers: [1, 2, 3, 4, 5, 6].map((i) => ({ id: `u1-01${i}`, ok: true, ms: 3000, at: now - i * 1000 })) },
    { level: 5, stars: {}, stats: { pvpWins: 0 }, achieved: [], answers: [{ id: 'u1-020', ok: true, ms: 3000, at: now }] },
  ];
  for (let i = 0; i < 3; i++) await api('PUT', 'student/save', { save: saves[i] }, logins[i].token);
  await api('PUT', 'student/nickname', { nickname: 'ฟ้าใส' }, logins[1].token);
  const me = logins[0];
  const page = await openGame({ ...saves[0], tutorialDone: true }, { token: me.token, nickname: me.profile.nickname, profile: me.profile });
  await go(page, 'Leaderboard', {});
  await until(page, () => !!window.game.scene.getScene('Leaderboard').loaded, 20000);
  await page.waitForTimeout(500);
  await shot(page, '7-leaderboard');
  const rows = await page.evaluate(() => window.game.scene.getScene('Leaderboard').loaded.rows.length);
  assert.equal(rows, 3, 'three classmates who played');
  await page.mouse.click(640 + 0.5 * 280, 112); // "ชนะออนไลน์"
  await page.waitForTimeout(600);
  await shot(page, '8-leaderboard-pvp');
  await page.close();
}

// ---- 4. Hard mode opens after the world's boss -------------------------------------------------------
{
  const page = await openGame({ character: 'boy', tutorialDone: true, stars: { '1-1': 3, '1-2': 3, '1-3': 2 }, answers: [] });
  await go(page, 'WorldMap', { world: 1, hard: true });
  await page.waitForTimeout(900);
  await shot(page, '9-world-hard');
  await go(page, 'Stage', { stageId: '1-1', hard: true });
  await until(page, () => window.game.scene.getScene('Stage').phase === 'aiming');
  const hp = await page.evaluate(() => window.game.scene.getScene('Stage').enemy.maxHp);
  assert.equal(hp, Math.round(850 * 1.5), 'hard enemy has 1.5x health');
  await page.close();
}

await browser.close();
if (errors.length) {
  console.log(errors.join('\n'));
  process.exit(1);
}
console.log('playtest-progress: OK');
