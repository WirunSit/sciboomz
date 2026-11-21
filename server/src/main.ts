// SciBoom server: PvP rooms over WebSocket (/ws), the REST API (/api) for
// accounts, teacher pages and questions, and, in production, the built game.
//   Development: started together with the game by `npm run dev` (port 8081;
//   Vite on 8080 forwards /ws and /api here, so one port is enough).
//   Production:  `npm run build && npm start` — everything on $PORT.
// Settings (environment variables, see docs/DEPLOY.md):
//   PORT, DATABASE_URL (PostgreSQL; default: SQLite file server/data/sciboom.db),
//   TEACHER_SIGNUP_CODE (needed to make a teacher account, if set)
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { WebSocketServer } from 'ws';
import type { Question } from '@sciboom/shared';
import { createApi } from './api';
import { ROOT, loadQuestionUnits } from './content';
import { DbGate } from './dbGate';
import { Lobby } from './lobby';
import { explainDbError } from './dbHelp';
import { Store } from './store';

const PORT = Number(process.env.PORT ?? 8081);
const STATIC_DIR = join(ROOT, 'client', 'dist');

// The database may be asleep (Supabase pauses quiet projects): the server starts
// anyway and keeps trying; the API answers "not ready yet" until then
let api: ReturnType<typeof createApi> | null = null;
const gate = new DbGate<Store>({
  open: () => Store.open(process.env.DATABASE_URL ?? join(ROOT, 'server', 'data', 'sciboom.db')),
  explain: (err) => explainDbError(err, process.env.DATABASE_URL),
  // The teacher pages run classroom tournaments through the lobby
  onReady: (store) => (api = createApi(store, { teacherSignupCode: process.env.TEACHER_SIGNUP_CODE || undefined, tournaments: lobby })),
});
/** The bundled questions, while the database (with the teachers' edits) isn't there */
const bundled = loadQuestionUnits();
const NOT_READY = 'ระบบบัญชีนักเรียนกำลังเตรียมตัว ลองใหม่ในอีกสักครู่ (ระหว่างนี้เล่นแบบไม่เข้าสู่ระบบได้)';

const lobby = new Lobby({
  // Quiz Duel uses the same bank teachers edit (enabled questions only)
  questions: async (): Promise<Question[]> => (gate.db ? await gate.db.playableUnits() : bundled).flatMap((u) => u.questions),
  identify: async (token) => {
    // Without an account (or while the database is waking up): play with other guests
    const store = gate.db;
    if (!token || !store) return { group: 'guests' };
    const s = await store.session(token);
    if (!s || s.kind !== 'student') return undefined;
    const p = await store.studentProfile(s.userId);
    // Same classroom only, unless the teacher opened PvP to other open classrooms
    return { group: p.classroom.pvpOpen ? 'open' : p.classroom.id, name: p.nickname, studentId: s.userId, classroomId: p.classroom.id };
  },
});

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname === '/api/health') {
    await health(url, res);
    return;
  }
  if (url.pathname.startsWith('/api/') && !api) {
    // The game still gets its questions (the bundled ones) while the database wakes up
    if (url.pathname === '/api/questions') return json(res, 200, { units: bundled });
    return json(res, 503, { error: NOT_READY });
  }
  if (api && (await api(req, res))) return;
  // Static game files (production); /teacher is the teacher pages
  let path = normalize(decodeURIComponent(url.pathname)).replace(/^[/\\]+/, '');
  if (path === '' || path.endsWith('/') || path.endsWith('\\')) path += 'index.html';
  if (path === 'teacher') path = 'teacher.html';
  const file = join(STATIC_DIR, path);
  if (!file.startsWith(STATIC_DIR) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(existsSync(STATIC_DIR) ? 'Not found' : 'Game not built yet: run `npm run build` (or use `npm run dev` while developing)');
    return;
  }
  res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
  createReadStream(file).pipe(res);
});

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

/**
 * /api/health: Render checks it (always 200 while the server runs, so a sleeping
 * database never makes a deploy fail). /api/health?db=1 also runs a query on the
 * database: the GitHub "keep awake" job calls it every few days so Supabase sees
 * activity and doesn't pause the project; it answers 503 if the database can't
 * be reached (the job then fails and GitHub emails the owner).
 */
async function health(url: URL, res: ServerResponse) {
  const store = gate.db;
  const base = { rooms: lobby.roomCount, db: store ? store.db.kind : 'waiting', tries: gate.tries };
  if (url.searchParams.get('db') !== '1') return json(res, 200, { ok: true, ...base, problem: gate.problem });
  if (!store) return json(res, 503, { ok: false, ...base, problem: gate.problem });
  try {
    await store.ping();
    json(res, 200, { ok: true, ...base, query: 'ok' });
  } catch (e) {
    json(res, 503, { ok: false, ...base, problem: explainDbError(e, process.env.DATABASE_URL).split('\n').find((l) => l.startsWith('สาเหตุ')) ?? 'query failed' });
  }
}

const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', (ws) => {
  const id = lobby.connect({ send: (text) => ws.readyState === ws.OPEN && ws.send(text), close: () => ws.close() });
  ws.on('message', (data) => void lobby.receive(id, data.toString()));
  ws.on('close', () => lobby.disconnect(id));
});

await gate.start();
server.listen(PORT, () => console.log(`SciBoom server on http://localhost:${PORT} (WebSocket /ws, database: ${gate.db ? gate.db.db.kind : 'กำลังรอ'})`));
