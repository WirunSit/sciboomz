// Connections and rooms: "สร้างห้อง" makes a 5-character code, "เข้าห้อง" joins it
// (by code, or from the list of open rooms of the same classroom).
import { randomInt } from 'node:crypto';
import { ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH, ROOM_MODES, Rng, type ClientMessage, type Question, type RoomMode, type ServerMessage } from '@sciboom/shared';
import { PvpRoom, type RoomOptions } from './pvp';
import { Tournament, type TourneyMatch, type TourneyView } from './tournament';

/** A tournament match waits this long for a player who isn't in the lobby, then the other goes through */
const WALKOVER_MS = 60_000;

type Hello = Extract<ClientMessage, { t: 'hello' }>;

export interface Connection {
  send(text: string): void;
  close(): void;
}

interface Client {
  id: string;
  conn: Connection;
  hello: Hello | null;
  room: PvpRoom | null;
  /** Group allowed to play together (classroom id once accounts exist; null = anyone) */
  group: string | null;
  /** Logged-in students: who they are and their classroom (for the teacher's tournament) */
  studentId: string | null;
  classroomId: string | null;
  /** Messages are handled one after another, in the order they arrived */
  queue: Promise<void>;
}

export interface LobbyOptions {
  questions: () => Question[] | Promise<Question[]>;
  /**
   * Check a login token: returns who may play together (`group`, e.g. the
   * classroom) and the name to show (students can't pick a rude one this way),
   * or undefined if the token is bad.
   */
  identify?: (token: string | undefined) => Promise<{ group: string | null; name?: string; studentId?: string; classroomId?: string } | undefined>;
  room?: Partial<Omit<RoomOptions, 'send' | 'questions'>>;
  /** How long a tournament match waits for an absent player (tests make it short) */
  walkoverMs?: number;
}

export class Lobby {
  private readonly clients = new Map<string, Client>();
  private readonly rooms = new Map<string, PvpRoom>();
  private readonly roomGroups = new Map<string, string | null>();
  private nextId = 1;
  /** One tournament per classroom, run by its teacher */
  private readonly tournaments = new Map<string, Tournament>();
  private tourneyTimer: ReturnType<typeof setInterval> | null = null;
  private readonly rng = new Rng(Math.floor(Math.random() * 1e9));

  constructor(private readonly opts: LobbyOptions) {}

  get roomCount(): number {
    return this.rooms.size;
  }

  connect(conn: Connection): string {
    const id = `p${this.nextId++}`;
    this.clients.set(id, { id, conn, hello: null, room: null, group: null, studentId: null, classroomId: null, queue: Promise.resolve() });
    this.send(id, { t: 'welcome', id });
    return id;
  }

  /** A message from a player. Waits for that player's earlier messages first ("hello" checks the database). */
  receive(id: string, text: string): Promise<void> {
    const client = this.clients.get(id);
    if (!client) return Promise.resolve();
    client.queue = client.queue.then(() => this.process(client, text)).catch((e) => console.error(e));
    return client.queue;
  }

  private async process(client: Client, text: string) {
    const id = client.id;
    let msg: ClientMessage;
    try {
      msg = JSON.parse(text) as ClientMessage;
    } catch {
      return;
    }
    switch (msg.t) {
      case 'hello': {
        const who = this.opts.identify ? await this.opts.identify(msg.token) : { group: null };
        if (!who) return this.error(id, 'กรุณาเข้าสู่ระบบใหม่อีกครั้ง');
        client.hello = who.name ? { ...msg, name: who.name } : msg;
        client.group = who.group;
        client.studentId = who.studentId ?? null;
        client.classroomId = who.classroomId ?? null;
        this.sendTourney(client);
        // Back in the lobby: a tournament match may have been waiting for this student
        this.tourneyTick();
        return;
      }
      case 'tjoin':
      case 'tleave': {
        const t = client.classroomId ? this.tournaments.get(client.classroomId) : undefined;
        if (!t || !client.studentId || !client.hello) return this.error(id, 'ตอนนี้ครูยังไม่ได้เปิดทัวร์นาเมนต์');
        if (msg.t === 'tjoin' && !t.join({ id: client.studentId, name: client.hello.name })) return this.error(id, 'ทัวร์นาเมนต์เริ่มไปแล้ว');
        if (msg.t === 'tleave') t.leave(client.studentId);
        this.notifyTourney(client.classroomId!);
        return;
      }
      case 'create': {
        if (!client.hello) return this.error(id, 'ยังไม่ได้แนะนำตัว');
        this.leaveRoom(client);
        const code = this.newCode();
        const mode: RoomMode = ROOM_MODES.includes(msg.mode as RoomMode) ? (msg.mode as RoomMode) : 'duel';
        const room = new PvpRoom(
          code,
          !!msg.quizDuel,
          {
            ...this.opts.room,
            questions: await this.opts.questions(),
            send: (pid, m) => this.send(pid, m),
          },
          mode,
        );
        this.rooms.set(code, room);
        this.roomGroups.set(code, client.group);
        this.send(id, { t: 'created', code, quizDuel: room.quizDuel, mode });
        room.addPlayer(id, client.hello);
        client.room = room;
        this.sendRoomList(client.group);
        return;
      }
      case 'join': {
        if (!client.hello) return this.error(id, 'ยังไม่ได้แนะนำตัว');
        const code = String(msg.code ?? '').toUpperCase().trim();
        const room = this.rooms.get(code);
        if (!room || room.phase !== 'waiting') return this.error(id, 'ไม่พบห้องนี้ ลองตรวจรหัสอีกครั้ง');
        if (room.full) return this.error(id, 'ห้องนี้เต็มแล้ว');
        const group = this.roomGroups.get(code) ?? null;
        if (group !== null && client.group !== group) return this.error(id, 'เล่นได้เฉพาะเพื่อนในห้องเรียนเดียวกัน');
        this.leaveRoom(client);
        room.addPlayer(id, client.hello);
        client.room = room;
        // A full room starts by itself; a co-op raid can also be started early by its host ("begin")
        if (room.full) room.start();
        this.sendRoomList(group);
        return;
      }
      case 'begin': {
        const room = client.room;
        if (!room || room.phase !== 'waiting' || room.host?.id !== id || room.seats.length < room.minPlayers) return;
        room.start();
        this.sendRoomList(this.roomGroups.get(room.code) ?? null);
        return;
      }
      case 'list':
        return this.send(id, { t: 'roomList', rooms: this.openRooms(client.group) });
      case 'leave':
        return this.leaveRoom(client);
      default:
        client.room?.handle(id, msg);
    }
  }

  /** Stop every room's timers (server shutdown, tests) */
  shutdown() {
    if (this.tourneyTimer) clearInterval(this.tourneyTimer);
    this.tourneyTimer = null;
    for (const room of this.rooms.values()) room.dispose();
    this.rooms.clear();
    this.clients.clear();
  }

  disconnect(id: string) {
    const client = this.clients.get(id);
    if (!client) return;
    this.leaveRoom(client);
    this.clients.delete(id);
  }

  // ---- Classroom tournament (the teacher runs it from the teacher pages) ------------------------

  tournamentView(classroomId: string): TourneyView | null {
    return this.tournaments.get(classroomId)?.view() ?? null;
  }

  /** Open sign-up (a new tournament replaces a finished one) */
  openTournament(classroomId: string, quizDuel: boolean): TourneyView {
    const old = this.tournaments.get(classroomId);
    if (old && old.status !== 'done') return old.view();
    const t = new Tournament(quizDuel);
    this.tournaments.set(classroomId, t);
    this.notifyTourney(classroomId);
    return t.view();
  }

  /** Close sign-up and start round 1; returns a message (Thai) if it can't start */
  startTournament(classroomId: string): string | null {
    const t = this.tournaments.get(classroomId);
    if (!t) return 'ยังไม่ได้เปิดรับสมัคร';
    const problem = t.start(this.rng);
    if (problem) return problem;
    this.tourneyTimer ??= setInterval(() => this.tourneyTick(), 1000);
    this.tourneyTimer.unref?.();
    this.notifyTourney(classroomId);
    this.tourneyTick();
    return null;
  }

  cancelTournament(classroomId: string) {
    this.tournaments.delete(classroomId);
    this.notifyTourney(classroomId);
  }

  /** A student who's in the lobby and not playing */
  private freeStudent(studentId: string | null): Client | undefined {
    if (!studentId) return undefined;
    return [...this.clients.values()].find((c) => c.studentId === studentId && c.hello && !c.room);
  }

  /** Start every tournament match whose two players are free; walk over absent players after a while */
  private tourneyTick(now = Date.now()) {
    for (const [classroomId, t] of this.tournaments) {
      if (t.status !== 'running') continue;
      let changed = false;
      for (const m of t.ready()) {
        const ca = this.freeStudent(m.a);
        const cb = this.freeStudent(m.b);
        if (ca && cb) {
          // Taken now so the next tick doesn't start it twice
          m.status = 'playing';
          void this.startTourneyMatch(classroomId, t, m, ca, cb);
          changed = true;
        } else if (now - (m.readySince ?? now) >= (this.opts.walkoverMs ?? WALKOVER_MS)) {
          // Only one of them showed up (or neither): the one who's here goes through
          t.decide(m, cb && !ca ? m.b! : m.a!, now);
          changed = true;
        }
      }
      if (changed) this.notifyTourney(classroomId);
    }
  }

  private async startTourneyMatch(classroomId: string, t: Tournament, m: TourneyMatch, ca: Client, cb: Client) {
    const questions = await this.opts.questions();
    // Someone may have left (or started something else) while the questions loaded
    if (ca.room || cb.room || !this.clients.has(ca.id) || !this.clients.has(cb.id) || !this.tournaments.has(classroomId)) {
      m.status = 'waiting';
      return;
    }
    const code = this.newCode();
    const students = new Map([
      [ca.id, m.a!],
      [cb.id, m.b!],
    ]);
    const final = m.round === t.rounds.length - 1;
    const room = new PvpRoom(
      code,
      t.quizDuel,
      {
        ...this.opts.room,
        questions,
        send: (pid, msg) => this.send(pid, msg),
        label: final ? 'ทัวร์นาเมนต์ รอบชิงชนะเลิศ!' : 'ทัวร์นาเมนต์ รอบที่ ' + (m.round + 1),
        onOver: (winnerSeat) => {
          t.decide(m, (winnerSeat && students.get(winnerSeat)) || m.a!);
          this.notifyTourney(classroomId);
          this.tourneyTick();
        },
      },
      'duel',
    );
    this.rooms.set(code, room);
    this.roomGroups.set(code, ca.group);
    m.code = code;
    for (const c of [ca, cb]) {
      room.addPlayer(c.id, c.hello!);
      c.room = room;
    }
    room.start();
  }

  /** Everyone of the classroom in the lobby sees where the tournament stands */
  private notifyTourney(classroomId: string) {
    for (const c of this.clients.values()) if (c.classroomId === classroomId && !c.room) this.sendTourney(c);
  }

  private sendTourney(c: Client) {
    if (!c.classroomId) return;
    const t = this.tournaments.get(c.classroomId);
    this.send(c.id, { t: 'tourney', view: t ? t.studentView(c.studentId) : null });
  }

  private leaveRoom(client: Client) {
    const room = client.room;
    if (!room) return;
    client.room = null;
    room.removePlayer(client.id);
    // Back to the lobby: show the tournament again (they may have a next match)
    this.sendTourney(client);
    const group = this.roomGroups.get(room.code) ?? null;
    // Gone for good when nobody's left in it (players who left mid-match don't count)
    if (room.seats.every((s) => [...this.clients.values()].every((c) => c.room !== room || c.id !== s.id))) {
      room.dispose();
      this.rooms.delete(room.code);
      this.roomGroups.delete(room.code);
    }
    this.sendRoomList(group);
  }

  /** Rooms still waiting for players, that people in this group may join */
  private openRooms(group: string | null) {
    return [...this.rooms.values()]
      .filter((r) => r.phase === 'waiting' && !r.full && r.seats.length > 0 && (this.roomGroups.get(r.code) ?? null) === group)
      .map((r) => r.summary());
  }

  /** Everyone of the group who's in the lobby (not in a room) sees the new list */
  private sendRoomList(group: string | null) {
    const rooms = this.openRooms(group);
    for (const c of this.clients.values()) {
      if (c.hello && !c.room && c.group === group) this.send(c.id, { t: 'roomList', rooms });
    }
  }

  private newCode(): string {
    for (;;) {
      let code = '';
      for (let i = 0; i < ROOM_CODE_LENGTH; i++) code += ROOM_CODE_ALPHABET[randomInt(ROOM_CODE_ALPHABET.length)];
      if (!this.rooms.has(code)) return code;
    }
  }

  private send(id: string, msg: ServerMessage) {
    this.clients.get(id)?.conn.send(JSON.stringify(msg));
  }

  private error(id: string, message: string) {
    this.send(id, { t: 'error', message });
  }
}
