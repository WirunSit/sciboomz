// Automated check of the classroom tournament: a teacher opens sign-up, two
// logged-in students join from the game's lobby, the teacher starts it, the
// match starts by itself, one student leaves, and the teacher's bracket
// shows the champion.
// Needs `npm run dev` running (game + server). Usage: npm run playtest:tournament -w tools
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const BASE = 'http://localhost:8080/';
const out = process.argv[2] ?? '../art/debug/playtest-tournament';
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ args: ['--disable-gpu'] });
const errors = [];
const isViteNoise = (t) => /websocket|\[vite\]/i.test(t);
const watch = (page, name) => {
  page.on('pageerror', (e) => isViteNoise(e.message) || errors.push(`${name} pageerror: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && !isViteNoise(m.text()) && errors.push(`${name} console: ${m.text()}`));
};
const api = async (method, path, body, token) => {
  const res = await fetch(BASE + 'api/' + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json();
  assert.ok(res.ok, `${path}: ${JSON.stringify(data)}`);
  return data;
};
const shot = async (page, name) => {
  const dataUrl = await page.evaluate(() => window.game.canvas.toDataURL('image/jpeg', 0.85));
  writeFileSync(`${out}/${name}.jpg`, Buffer.from(dataUrl.split(',')[1], 'base64'));
  console.log(`saved ${out}/${name}.jpg`);
};

// Teacher, classroom and two students (through the API)
const teacher = await api('POST', 'teacher/register', { username: `kru${Date.now().toString(36)}`, password: 'password123', displayName: 'ครูทดสอบ' });
const code = `T${Date.now().toString(36).toUpperCase().slice(-6)}`;
const room = await api('POST', 'teacher/classrooms', { name: 'ม.1/7 แข่งขัน', students: 2, code }, teacher.token);
const classId = room.classroom.id;
const detail = await api('GET', `teacher/classrooms/${classId}`, undefined, teacher.token);
const logins = [];
for (const s of detail.students) logins.push(await api('POST', 'student/login', { classCode: code, number: s.number, pin: s.pin }));
await api('PUT', 'student/nickname', { nickname: 'ฟ้า' }, logins[0].token);
await api('PUT', 'student/nickname', { nickname: 'ดิน' }, logins[1].token);

async function student(login, nickname) {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
  watch(page, nickname);
  const profile = { ...login.profile, nickname };
  await page.addInitScript(
    ([token, prof, key]) => {
      localStorage.setItem('sciboom.session.v1', JSON.stringify({ token, nickname: prof.nickname, profile: prof }));
      localStorage.setItem(key, JSON.stringify({ character: 'boy', tutorialDone: true, answers: [] }));
    },
    [login.token, profile, `sciboom.save.s.${profile.id}`],
  );
  await page.goto(BASE);
  await page.waitForFunction(() => window.game?.scene?.isActive?.('Menu'), null, { timeout: 60_000 });
  await page.mouse.click(640, 510); // "เล่นกับเพื่อน (ออนไลน์)"
  await page.waitForFunction(() => window.game.scene.getScene('Lobby')?.net?.isOpen, null, { timeout: 15_000 });
  return page;
}

// Teacher opens sign-up; students see the strip and join
await api('POST', `teacher/classrooms/${classId}/tournament`, { quizDuel: false }, teacher.token);
const a = await student(logins[0], 'ฟ้า');
const b = await student(logins[1], 'ดิน');
for (const p of [a, b]) {
  await p.waitForFunction(() => window.game.scene.getScene('Lobby').tourney?.status === 'signup', null, { timeout: 10_000 });
  await p.waitForTimeout(300);
  await p.mouse.click(1000, 612); // "เข้าร่วม"
  await p.waitForFunction(() => window.game.scene.getScene('Lobby').tourney?.joined === true, null, { timeout: 10_000 });
}
await shot(a, '1-lobby-joined');
const signup = await api('GET', `teacher/classrooms/${classId}/tournament`, undefined, teacher.token);
assert.deepEqual(signup.tournament.players.sort(), ['ดิน', 'ฟ้า']);

// Teacher's page during sign-up
const tp = await (await browser.newContext({ viewport: { width: 1280, height: 860 } })).newPage();
watch(tp, 'teacher');
await tp.addInitScript((t) => localStorage.setItem('sciboom.teacher.v1', t), teacher.token);
await tp.goto(`${BASE}teacher.html#/class/${classId}/tournament`);
await tp.getByText('เปิดรับสมัครอยู่').waitFor();
await tp.screenshot({ path: `${out}/2-teacher-signup.png`, fullPage: true });
console.log(`saved ${out}/2-teacher-signup.png`);

// Teacher starts: the match begins by itself on both screens
await tp.getByRole('button', { name: 'เริ่มแข่ง' }).click();
await Promise.all([a, b].map((p) => p.waitForFunction(() => window.game.scene.isActive('Online'), null, { timeout: 20_000 })));
await a.waitForTimeout(500);
await shot(a, '3-match-starts');
assert.equal(await a.evaluate(() => window.game.scene.getScene('Online').startMsg.label), 'ทัวร์นาเมนต์ รอบชิงชนะเลิศ!');
await tp.getByText('กำลังแข่ง').first().waitFor();
await tp.screenshot({ path: `${out}/4-teacher-playing.png`, fullPage: true });

// ดิน leaves: ฟ้า is champion, no rematch button
await b.mouse.click(815, 30); // "☰ ออก"
await a.waitForFunction(() => window.game.scene.getScene('Online').phase === 'over', null, { timeout: 15_000 });
await a.waitForTimeout(1500);
await shot(a, '5-winner');
const texts = await a.evaluate(() => window.game.scene.getScene('Online').children.list.filter((o) => o.type === 'Text').map((o) => o.text));
assert.ok(!texts.includes('เล่นอีกครั้ง'), 'no rematch in a tournament');
await tp.getByText('แชมป์: ฟ้า').waitFor({ timeout: 10_000 });
await tp.screenshot({ path: `${out}/6-teacher-champion.png`, fullPage: true });
console.log(`saved ${out}/6-teacher-champion.png`);

// Back in the lobby, the strip says who won
await a.mouse.click(640, 410); // "กลับห้องรอ"
await a.waitForFunction(() => window.game.scene.getScene('Lobby')?.tourney?.status === 'done', null, { timeout: 15_000 });
await a.waitForTimeout(400);
await shot(a, '7-lobby-champion');

await browser.close();
if (errors.length) {
  console.log(errors.join('\n'));
  process.exit(1);
}
console.log('playtest-tournament: OK');
