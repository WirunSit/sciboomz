// Automated check of the group modes online: four browsers play 2 v 2 (joining
// from the lobby's room list, turn order strip, quick chat, all screens agree),
// then two browsers raid a co-op boss (host starts early, the boss shoots by
// itself, its ultimate question goes to everyone).
// Needs `npm run dev` running (game + server). Usage: npm run playtest:team -w tools
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const URL = 'http://localhost:8080/';
const out = process.argv[2] ?? '../art/debug/playtest-team';
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ args: ['--disable-gpu'] });
const errors = [];
const isViteNoise = (t) => /websocket|\[vite\]/i.test(t);

async function player(name, character) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  page.on('pageerror', (e) => isViteNoise(e.message) || errors.push(`${name} pageerror: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && !isViteNoise(m.text()) && errors.push(`${name} console: ${m.text()}`));
  await page.addInitScript(([n, c]) => localStorage.setItem('sciboom.save.v1', JSON.stringify({ nickname: n, character: c, level: 1, tutorialDone: true })), [name, character]);
  await page.goto(URL);
  await page.waitForFunction(() => window.game?.scene?.isActive?.('Menu'), null, { timeout: 60_000 });
  await page.mouse.click(640, 510); // "เล่นกับเพื่อน (ออนไลน์)"
  await page.waitForFunction(() => window.game.scene.getScene('Lobby')?.net?.isOpen, null, { timeout: 15_000 });
  await page.waitForTimeout(400);
  return page;
}
const shot = async (page, name) => {
  const dataUrl = await page.evaluate(() => window.game.canvas.toDataURL('image/jpeg', 0.85));
  writeFileSync(`${out}/${name}.jpg`, Buffer.from(dataUrl.split(',')[1], 'base64'));
  console.log(`saved ${out}/${name}.jpg`);
};
const online = (page, expr) => page.evaluate(`(() => { const s = window.game.scene.getScene('Online'); return ${expr}; })()`);
const inOnline = (pages) => Promise.all(pages.map((p) => p.waitForFunction(() => window.game.scene.isActive('Online'), null, { timeout: 20_000 })));
const lobbyHasRoom = (page) => page.waitForFunction(() => window.game.scene.getScene('Lobby').rooms.length > 0, null, { timeout: 10_000 });
/** Whoever's turn it is fires a quick shot; returns false if nobody can (the boss's turn) */
async function anyoneFires(pages, tries = 10) {
  for (let k = 0; k < tries; k++) {
    for (const p of pages) {
      const mine = await online(p, 's.phase === "aiming" && s.human === s.me');
      if (!mine) continue;
      await p.keyboard.down('Space');
      await p.waitForTimeout(500);
      await p.keyboard.up('Space');
      return true;
    }
    await pages[0].waitForTimeout(300);
  }
  return false;
}

// ---- 2 v 2 ---------------------------------------------------------------------------------
const names = [
  ['เอ', 'boy'],
  ['บี', 'girl'],
  ['ซี', 'boy'],
  ['ดี', 'girl'],
];
const [a, b, c, d] = await Promise.all(names.map(([n, ch]) => player(n, ch)));
await a.mouse.click(330, 302); // mode "ทีม 2 ต่อ 2"
await a.mouse.click(330, 510); // "สร้างห้อง"
await a.waitForFunction(() => window.game.scene.getScene('Lobby').waitingCode !== null);
// The others see it in the list and join from there
await lobbyHasRoom(b);
await shot(b, '1-room-list');
await b.mouse.click(1150, 196);
await a.waitForTimeout(500);
await shot(a, '2-waiting-room');
for (const p of [c, d]) {
  await lobbyHasRoom(p);
  await p.mouse.click(1150, 196);
  await p.waitForTimeout(300);
}
await inOnline([a, b, c, d]);
const teams = await online(a, '[...s.team.entries()].map(([f, t]) => [f.name, t])');
assert.deepEqual(teams, [['เอ', 0], ['บี', 1], ['ซี', 0], ['ดี', 1]], 'teams by join order');
await a.waitForFunction(() => window.game.scene.getScene('Online').phase === 'aiming', null, { timeout: 20_000 });
await a.waitForTimeout(600);
await shot(a, '3-team-start');
// Two shots, then every screen agrees
for (let i = 0; i < 2; i++) {
  assert.ok(await anyoneFires([a, b, c, d]), 'someone has the turn');
  await Promise.all([a, b, c, d].map((p) => p.waitForFunction(() => { const s = window.game.scene.getScene('Online'); return s.phase === 'aiming' || (s.phase === 'idle' && !s.playback); }, null, { timeout: 30_000 })));
  await a.waitForTimeout(2500);
}
const hp = await Promise.all([a, b, c, d].map((p) => online(p, '[...s.fighters.values()].map((f) => f.hp)')));
for (const h of hp.slice(1)) assert.deepEqual(h, hp[0], 'same health on every screen');
// Quick chat: A says "ยิงดี!" and B sees it
await a.mouse.click(470, 30); // "พูด"
await a.waitForTimeout(300);
await a.mouse.click(470 - 37 + 70, 30 + 26 + 26); // first message
await b.waitForFunction(() => window.game.scene.getScene('Online').children.list.some((o) => o.type === 'Text' && o.text === 'ยิงดี!'), null, { timeout: 5_000 });
await shot(b, '4-team-emote');
for (const p of [a, b, c, d]) await p.context().close();

// ---- Co-op boss ----------------------------------------------------------------------------
const [h1, h2] = await Promise.all([player('หนึ่ง', 'girl'), player('สอง', 'boy')]);
await h1.mouse.click(510, 302); // mode "ตีบอสร่วมกัน"
await h1.mouse.click(330, 510);
await lobbyHasRoom(h2);
await h2.mouse.click(1150, 196);
await h1.waitForFunction(() => window.game.scene.getScene('Lobby').children.list.some((o) => o.type === 'Text' && o.text === 'สอง'), null, { timeout: 10_000 });
await shot(h1, '5-coop-waiting');
await h1.mouse.click(770, 515); // "เริ่มเลย"
await inOnline([h1, h2]);
await h1.waitForFunction(() => window.game.scene.getScene('Online').phase === 'aiming' || window.game.scene.getScene('Online').phase === 'idle', null, { timeout: 20_000 });
await h1.waitForTimeout(800);
await shot(h1, '6-coop-start');
assert.ok(await online(h1, '!!s.boss'), 'there is a boss');
// Play until the boss has shot and then asks its question (every 3rd boss turn)
let bossShots = 0;
let quiz = false;
for (let i = 0; i < 60 && !quiz; i++) {
  quiz = await online(h1, 's.phase === "quiz"');
  if (quiz) break;
  const fired = await anyoneFires([h1, h2], 1);
  if (!fired && (await online(h1, '!!s.playback && s.playback.shooter === s.boss'))) {
    bossShots++;
    if (bossShots === 1) {
      await h1.waitForTimeout(700);
      await shot(h1, '7-boss-shoots');
    }
    await h1.waitForFunction(() => !window.game.scene.getScene('Online').playback, null, { timeout: 30_000 });
  }
  await h1.waitForTimeout(700);
}
assert.ok(quiz, 'the boss asks everyone a question');
await h2.waitForFunction(() => window.game.scene.getScene('Online').phase === 'quiz', null, { timeout: 10_000 });
await h1.waitForTimeout(500);
await shot(h1, '8-boss-question');
for (const p of [h1, h2]) {
  await p.keyboard.press('1');
  await p.waitForFunction(() => window.game.scene.getScene('Online').children.list.some((o) => o.type === 'Container' && o.alpha === 1 && o.list?.some((t) => t.text === 'ไปต่อ' || t.text === 'เข้าใจแล้ว')), null, { timeout: 10_000 });
  await p.mouse.move(1030, 618);
  await p.waitForTimeout(150);
  await p.mouse.click(1030, 618);
}
await h1.waitForFunction(() => window.game.scene.getScene('Online').children.list.some((o) => o.type === 'Text' && /ขัดท่า|ไม่ถึงครึ่ง/.test(o.text)), null, { timeout: 15_000 });
await shot(h1, '9-boss-quiz-result');

await browser.close();
if (errors.length) {
  console.log(errors.join('\n'));
  process.exit(1);
}
console.log('playtest-team: OK');
