// Connections and rooms: "สร้างห้อง" makes a 5-character code, "เข้าห้อง" joins it
// (by code, or from the list of open rooms of the same classroom).
import { randomInt } from 'node:crypto';
import { ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH, ROOM_MODES, type ClientMessage, type Question, type RoomMode, type ServerMessage } from '@sciboom/shared';
import { PvpRoom, type RoomOptions } from './pvp';

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
  identify?: (token: string | undefined) => Promise<{ group: string | null; name?: string } | undefined>;
  room?: Partial<Omit<RoomOptions, 'send' | 'questions'>>;
}

export class Lobby {
  private readonly clients = new Map<string, Client>();
  private readonly rooms = new Map<string, PvpRoom>();
  private readonly roomGroups = new Map<string, string | null>();
  private nextId = 1;

  constructor(private readonly opts: LobbyOptions) {}

  get roomCount(): number {
    return this.rooms.size;
  }

  connect(conn: Connection): string {
    const id = `p${this.nextId++}`;
    this.clients.set(id, { id, conn, hello: null, room: null, group: null, queue: Promise.resolve() });
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

  private leaveRoom(client: Client) {
    const room = client.room;
    if (!room) return;
    client.room = null;
    room.removePlayer(client.id);
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
