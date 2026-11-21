// Run with: npm test -w server
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { EMPTY_OUTFIT, Rng, type ClientMessage, type ServerMessage } from '@sciboom/shared';
import { loadQuestionUnits } from '../src/content';
import { Lobby } from '../src/lobby';
import { Tournament } from '../src/tournament';

const questions = loadQuestionUnits().flatMap((u) => u.questions);
const tick = () => new Promise((r) => setTimeout(r, 5));

test('bracket: byes go straight through, winners meet in the next round, the last winner is champion', () => {
  const t = new Tournament(false);
  for (let i = 1; i <= 5; i++) t.join({ id: `s${i}`, name: `นักเรียน ${i}` });
  assert.equal(new Tournament(false).start(new Rng(1)), 'ต้องมีนักเรียนลงชื่ออย่างน้อย 2 คน');
  assert.equal(t.start(new Rng(7)), null);
  assert.equal(t.join({ id: 'late', name: 'มาสาย' }), false, 'no signing up once it started');
  // 5 players → bracket of 8: 3 byes, 3 rounds
  assert.equal(t.rounds.length, 3);
  assert.equal(t.rounds[0].filter((m) => m.b === null).length, 3);
  for (const m of t.rounds[0]) assert.ok(m.a !== null, 'never two empty seats');
  // Play everything: the first player of each match wins
  for (let guard = 0; guard < 10 && t.status === 'running'; guard++) for (const m of t.ready()) t.decide(m, m.a!);
  assert.equal(t.status, 'done');
  assert.ok(t.champion);
  const v = t.view();
  assert.equal(v.champion, t.players.get(t.champion!)!.name);
  assert.equal(t.studentView(t.champion).me, 'champion');
  const loser = t.rounds[2][0].b!;
  assert.equal(t.studentView(loser).me, 'out');
});

/** A pretend logged-in student */
class Student {
  readonly inbox: ServerMessage[] = [];
  id: string;
  constructor(
    private readonly lobby: Lobby,
    readonly sid: string,
  ) {
    this.id = lobby.connect({ send: (text) => this.inbox.push(JSON.parse(text)), close: () => {} });
  }
  send(msg: ClientMessage) {
    return this.lobby.receive(this.id, JSON.stringify(msg));
  }
  hello() {
    return this.send({ t: 'hello', name: this.sid, character: 'boy', outfit: { ...EMPTY_OUTFIT }, level: 1, weaponId: 'starter_cannon', token: this.sid });
  }
  async next<T extends ServerMessage['t']>(t: T, ms = 3000): Promise<Extract<ServerMessage, { t: T }>> {
    const until = Date.now() + ms;
    for (;;) {
      const i = this.inbox.findIndex((m) => m.t === t);
      if (i >= 0) return this.inbox.splice(0, i + 1)[i] as Extract<ServerMessage, { t: T }>;
      if (Date.now() > until) throw new Error(`${this.sid}: no "${t}" (got ${this.inbox.map((m) => m.t).join(', ')})`);
      await tick();
    }
  }
}

const lobbies: Lobby[] = [];
afterEach(() => lobbies.splice(0).forEach((l) => l.shutdown()));
const classLobby = (walkoverMs = 60_000) => {
  const lobby = new Lobby({
    questions: () => questions,
    // Token = student id; everyone is in classroom "c1"
    identify: async (token) => (token ? { group: 'c1', name: token, studentId: token, classroomId: 'c1' } : { group: 'guests' }),
    room: { animationScale: 0, graceMs: 50, turnSeconds: 1, quizSeconds: 1 },
    walkoverMs,
  });
  lobbies.push(lobby);
  return lobby;
};

test('lobby tournament: students sign up, the teacher starts it, matches start by themselves, a leaver loses', async () => {
  const lobby = classLobby();
  const [a, b] = [new Student(lobby, 'stuA'), new Student(lobby, 'stuB')];
  for (const s of [a, b]) await s.hello();
  assert.equal((await a.next('tourney')).view, null, 'nothing open yet');
  await a.send({ t: 'tjoin' });
  assert.match((await a.next('error')).message, /ยังไม่ได้เปิด/);

  lobby.openTournament('c1', false);
  assert.equal((await a.next('tourney')).view?.status, 'signup');
  await a.send({ t: 'tjoin' });
  await b.send({ t: 'tjoin' });
  let v = (await b.next('tourney')).view!;
  while (b.inbox.some((m) => m.t === 'tourney')) v = (await b.next('tourney')).view!;
  assert.deepEqual([v.players, v.joined, v.me], [2, true, 'signup']);
  assert.deepEqual(lobby.tournamentView('c1')?.players.sort(), ['stuA', 'stuB']);

  assert.equal(lobby.startTournament('c1'), null);
  const sa = await a.next('start');
  await b.next('start');
  assert.equal(sa.label, 'ทัวร์นาเมนต์ รอบชิงชนะเลิศ!');
  // B leaves the match: A is the champion
  await b.send({ t: 'leave' });
  await a.next('over');
  await tick();
  const view = lobby.tournamentView('c1')!;
  assert.equal(view.status, 'done');
  assert.equal(view.champion, 'stuA');
  // No rematch in a tournament match
  await a.send({ t: 'rematch' });
  await tick();
  assert.equal(a.inbox.some((m) => m.t === 'start'), false);
});

test('lobby tournament: a player who never shows up loses by walkover', async () => {
  const lobby = classLobby(50);
  const a = new Student(lobby, 'stuA');
  await a.hello();
  lobby.openTournament('c1', false);
  await a.send({ t: 'tjoin' });
  // B signs up, then closes the game before the start
  const b = new Student(lobby, 'stuB');
  await b.hello();
  await b.send({ t: 'tjoin' });
  lobby.disconnect(b.id);
  assert.equal(lobby.startTournament('c1'), null);
  for (let i = 0; i < 300 && lobby.tournamentView('c1')?.status !== 'done'; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(lobby.tournamentView('c1')?.champion, 'stuA');
});
