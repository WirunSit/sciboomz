import * as Phaser from 'phaser';
import { startMusic } from '../audio/Sound';
import { MODE_NAMES, ROOM_CODE_LENGTH, ROOM_MODES, nicknameProblem, weaponDef, type RoomMode, type RoomSummary, type ServerMessage, type TourneyStudentView } from '@sciboom/shared';
import { FONT_FAMILY, GAME_HEIGHT, GAME_WIDTH, TEXT_STROKE } from '../config';
import { drawArtBackground } from '../game/background';
import { Net } from '../net/Net';
import { equippedWeapon, loadSave, updateSave } from '../save';
import { setNickname } from '../net/account';
import { isStudent, session } from '../net/session';
import { addTextButton } from '../ui/TextButton';
import { addTextInput } from '../ui/TextInput';

const text = (size: number, color = '#ffffff'): Phaser.Types.GameObjects.Text.TextStyle => ({
  fontFamily: FONT_FAMILY,
  fontSize: `${size}px`,
  fontStyle: '700',
  color,
  stroke: TEXT_STROKE,
  strokeThickness: Math.max(3, size / 6),
  padding: { top: 6 },
});

const MODE_HINTS: Record<RoomMode, string> = {
  duel: 'ยิงกันตัวต่อตัว',
  team: 'สองทีม ทีมละ 2 คน (ครบ 4 คนเริ่มเอง)',
  coop: 'เพื่อน 1–4 คนช่วยกันสู้บอส ตอบคำถามพร้อมกันเพื่อขัดท่า',
};

type RoomState = Extract<ServerMessage, { t: 'room' }>;

/**
 * Online play: make a room (1 v 1, 2 v 2 or a co-op boss raid) or join one,
 * from the list of rooms open in the classroom or with its code.
 */
export class LobbyScene extends Phaser.Scene {
  private net: Net | null = null;
  private status!: Phaser.GameObjects.Text;
  private quizDuel = false;
  private mode: RoomMode = 'duel';
  private panel: Phaser.GameObjects.GameObject[] = [];
  private leaving = false;
  /** Open rooms from the server, and what's drawn for them */
  private rooms: RoomSummary[] = [];
  private listItems: Phaser.GameObjects.GameObject[] = [];
  private listShown = false;
  private joinRoom: ((code: string) => void) | null = null;
  /** Code of the room we're waiting in (null: choosing) */
  private waitingCode: string | null = null;
  /** The classroom tournament strip (stays while the panels change) */
  private tourney: TourneyStudentView | null = null;
  private tourneyItems: Phaser.GameObjects.GameObject[] = [];

  constructor() {
    super('Lobby');
  }

  create() {
    startMusic('menu');
    this.net = null;
    this.leaving = false;
    this.panel = [];
    this.rooms = [];
    this.listItems = [];
    this.listShown = false;
    this.waitingCode = null;
    this.tourney = null;
    this.tourneyItems = [];
    drawArtBackground(this, 'backgrounds/pvp_arena', GAME_WIDTH, 0);
    this.add.rectangle(0, 0, GAME_WIDTH, GAME_HEIGHT, 0x0b0c1f, 0.55).setOrigin(0);
    this.add.text(GAME_WIDTH / 2, 50, 'เล่นกับเพื่อน (ออนไลน์)', text(40, '#ffcc33')).setOrigin(0.5);
    this.status = this.add.text(GAME_WIDTH / 2 + 60, GAME_HEIGHT - 44, 'กำลังเชื่อมต่อ...', text(22, '#bfe8ff')).setOrigin(0.5);
    addTextButton(this, 120, GAME_HEIGHT - 44, 'กลับ', () => this.back(), { width: 180, height: 58, fontSize: 24, color: 0x3a8dde });
    this.events.once('shutdown', () => {
      // Leaving the lobby for anything but a match closes the connection
      if (this.leaving) this.net?.close();
    });
    void this.connect();
  }

  private async connect() {
    try {
      this.net = await Net.connect();
    } catch {
      this.status.setText('เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ ลองใหม่อีกครั้ง (ต้องเปิดด้วย npm run dev)').setColor('#ff9a9a');
      addTextButton(this, GAME_WIDTH / 2, GAME_HEIGHT - 180, 'ลองใหม่', () => this.scene.restart(), { width: 220, height: 58, fontSize: 24 });
      return;
    }
    this.hello();
    this.net.onClose = () => this.status.setText('การเชื่อมต่อหลุด กด "กลับ" แล้วเข้าใหม่').setColor('#ff9a9a');
    this.status.setText('');
    this.showChoices();
    void this.listen();
  }

  /** Two cards: make a room (pick the mode), or join one from the list / with a code */
  private showChoices() {
    this.clearPanel();
    this.waitingCode = null;
    const save = loadSave();
    const card = (x: number, title: string) => {
      const g = this.add.graphics();
      g.fillStyle(0x1b1d3a, 0.85).fillRoundedRect(x - 290, 100, 580, 470, 24);
      g.lineStyle(4, 0xffcc33, 1).strokeRoundedRect(x - 290, 100, 580, 470, 24);
      this.panel.push(g, this.add.text(x, 138, title, text(28, '#ffcc33')).setOrigin(0.5));
    };

    // Left: name, mode, Quiz Duel, create
    card(330, 'สร้างห้องใหม่');
    this.panel.push(this.add.text(70, 194, 'ชื่อที่เพื่อนจะเห็น', text(20)).setOrigin(0, 0.5));
    const name = addTextInput(this, 420, 194, { width: 290, fontSize: 26, maxLength: 16, value: this.currentName(save.nickname), placeholder: 'ชื่อเล่น' });
    this.panel.push(this.add.text(330, 250, 'เลือกโหมด', text(20)).setOrigin(0.5));
    const hint = this.add.text(330, 352, MODE_HINTS[this.mode], text(17, '#bfe8ff')).setOrigin(0.5);
    this.panel.push(hint);
    const modeButtons: Phaser.GameObjects.Container[] = [];
    const drawModes = () => {
      modeButtons.forEach((b) => b.destroy());
      modeButtons.length = 0;
      ROOM_MODES.forEach((m, i) => {
        const b = addTextButton(
          this,
          150 + i * 180,
          302,
          MODE_NAMES[m],
          () => {
            this.mode = m;
            hint.setText(MODE_HINTS[m]);
            drawModes();
          },
          { width: 170, height: 52, fontSize: 19, color: this.mode === m ? 0xff8a1f : 0x4a4f75 },
        );
        modeButtons.push(b);
        this.panel.push(b);
      });
    };
    drawModes();
    const toggle = this.add.text(330, 402, '', text(21)).setOrigin(0.5).setInteractive({ useHandCursor: true });
    const drawToggle = () => toggle.setText(`${this.quizDuel ? '[x]' : '[ ]'} Quiz Duel: ตอบคำถามก่อนยิงทุกตา`);
    drawToggle();
    toggle.on('pointerup', () => {
      this.quizDuel = !this.quizDuel;
      drawToggle();
    });
    this.panel.push(toggle, this.add.text(330, 434, 'ตอบถูก ยิงแรงขึ้น 15% และเติมเกจไม้ตาย', text(16, '#bfe8ff')).setOrigin(0.5));
    this.panel.push(
      addTextButton(
        this,
        330,
        510,
        'สร้างห้อง',
        async () => {
          if (await this.saveName(name.value)) this.net?.send({ t: 'create', quizDuel: this.quizDuel, mode: this.mode });
        },
        { width: 300, color: 0x2fbf5b },
      ),
    );

    // Right: rooms that are open now, and joining with a code
    card(950, 'ห้องที่เปิดอยู่');
    this.panel.push(this.add.text(950, 450, `หรือใส่รหัสห้อง ${ROOM_CODE_LENGTH} ตัว`, text(19)).setOrigin(0.5));
    const code = addTextInput(this, 860, 510, { width: 230, fontSize: 36, maxLength: ROOM_CODE_LENGTH, uppercase: true, placeholder: 'ABCDE' });
    const join = async (value: string) => {
      if (value.trim().length !== ROOM_CODE_LENGTH) {
        this.status.setText(`รหัสห้องต้องมี ${ROOM_CODE_LENGTH} ตัว`).setColor('#ff9a9a');
        return;
      }
      if (!(await this.saveName(name.value))) return;
      this.net?.send({ t: 'join', code: value.trim() });
      this.status.setText('กำลังเข้าห้อง...').setColor('#bfe8ff');
    };
    this.joinRoom = (c) => void join(c);
    code.addEventListener('keydown', (e) => e.key === 'Enter' && void join(code.value));
    this.panel.push(addTextButton(this, 1090, 510, 'เข้าห้อง', () => void join(code.value), { width: 180, height: 60, fontSize: 24, color: 0x8a5cf6 }));
    this.listShown = true;
    this.drawRoomList();
    this.net?.send({ t: 'list' });
  }

  /** The open rooms (the server sends a new list whenever it changes) */
  private drawRoomList() {
    this.listItems.forEach((o) => o.destroy());
    this.listItems = [];
    if (!this.listShown) return;
    const rooms = this.rooms.slice(0, 4);
    if (rooms.length === 0) {
      this.listItems.push(this.add.text(950, 280, 'ยังไม่มีห้องที่รอเพื่อนอยู่', text(20, '#bbbbcc')).setOrigin(0.5), this.add.text(950, 314, 'สร้างห้องใหม่ แล้วชวนเพื่อนกดเข้า!', text(18, '#bbbbcc')).setOrigin(0.5));
      return;
    }
    rooms.forEach((r, i) => {
      const y = 196 + i * 62;
      const g = this.add.graphics();
      g.fillStyle(0x2b2f5a, 0.95).fillRoundedRect(680, y - 27, 540, 54, 14);
      this.listItems.push(
        g,
        this.add.text(700, y - 10, `ห้องของ ${r.host}`, text(19)).setOrigin(0, 0.5),
        this.add.text(700, y + 13, `${MODE_NAMES[r.mode]} · ${r.players}/${r.seats} คน${r.quizDuel ? ' · Quiz Duel' : ''}`, text(15, '#bfe8ff')).setOrigin(0, 0.5),
        addTextButton(this, 1150, y, 'เข้า', () => this.joinRoom?.(r.code), { width: 110, height: 44, fontSize: 20, color: 0x8a5cf6 }),
      );
    });
  }

  /** Students go by their account nickname; guests by the one saved on this device */
  private currentName(saved: string): string {
    return isStudent() ? session.nickname : saved;
  }

  /** Tell the server who we are (it reads the name, look and weapon from this) */
  private hello() {
    const save = loadSave();
    this.net?.send({
      t: 'hello',
      name: this.currentName(save.nickname) || 'ผู้เล่น',
      character: save.character,
      outfit: save.outfit,
      level: save.level,
      weaponId: weaponDef(equippedWeapon(save).id).id,
      token: session.token ?? undefined,
    });
  }

  /** Check and keep the typed name; false (with a message) if it isn't allowed */
  private async saveName(value: string): Promise<boolean> {
    const nickname = value.trim();
    if (nickname === this.currentName(loadSave().nickname)) return true;
    const problem = isStudent() ? await setNickname(nickname) : nicknameProblem(nickname);
    if (problem) {
      this.status.setText(problem).setColor('#ff9a9a');
      return false;
    }
    if (!isStudent()) updateSave((d) => (d.nickname = nickname));
    this.hello();
    return true;
  }

  /** Waiting room: the code big, who's in (and on which team), empty seats */
  private showWaiting(msg: RoomState) {
    const fresh = this.waitingCode !== msg.code;
    this.clearPanel();
    this.waitingCode = msg.code;
    const g = this.add.graphics();
    g.fillStyle(0x1b1d3a, 0.9).fillRoundedRect(GAME_WIDTH / 2 - 400, 100, 800, 480, 26);
    g.lineStyle(5, 0xffcc33, 1).strokeRoundedRect(GAME_WIDTH / 2 - 400, 100, 800, 480, 26);
    const codeText = this.add.text(GAME_WIDTH / 2, 205, msg.code, text(92, '#ffffff')).setOrigin(0.5);
    this.panel.push(g, this.add.text(GAME_WIDTH / 2, 132, `รหัสห้อง · ${MODE_NAMES[msg.mode]}${msg.quizDuel ? ' · Quiz Duel' : ''}`, text(24, '#ffcc33')).setOrigin(0.5), codeText);

    // Seats: names on their team's side (co-op: everyone in one row)
    if (msg.mode === 'team') {
      this.panel.push(this.add.text(GAME_WIDTH / 2 - 190, 276, 'ทีมฟ้า', text(20, '#7cc4ff')).setOrigin(0.5), this.add.text(GAME_WIDTH / 2 + 190, 276, 'ทีมแดง', text(20, '#ff9a9a')).setOrigin(0.5));
    }
    for (let i = 0; i < msg.seats; i++) {
      const p = msg.players[i];
      let x: number;
      let y: number;
      if (msg.mode === 'coop') {
        x = GAME_WIDTH / 2 - 285 + i * 190;
        y = 330;
      } else if (msg.mode === 'team') {
        x = GAME_WIDTH / 2 + (i % 2 === 0 ? -190 : 190);
        y = 318 + Math.floor(i / 2) * 50;
      } else {
        x = GAME_WIDTH / 2 + (i === 0 ? -190 : 190);
        y = 330;
      }
      const label = p ? `${p.name}${p.id === msg.host ? ' (หัวห้อง)' : ''}${p.id === this.net?.id ? ' *' : ''}` : 'ว่าง...';
      this.panel.push(this.add.text(x, y, label, text(21, p ? '#ffffff' : '#777799')).setOrigin(0.5));
    }
    const isHost = msg.host === this.net?.id;
    const missing = msg.seats - msg.players.length;
    const info = msg.mode === 'coop' ? (isHost ? 'ให้เพื่อนเข้าห้อง แล้วกด "เริ่มเลย" (เล่นได้ 1–4 คน)' : 'รอหัวห้องกดเริ่ม...') : `บอกรหัสให้เพื่อน รออีก ${missing} คน ครบแล้วเริ่มเอง`;
    this.panel.push(this.add.text(GAME_WIDTH / 2, 440, info, text(22)).setOrigin(0.5));
    const canStart = msg.mode === 'coop' && isHost;
    if (canStart) {
      this.panel.push(addTextButton(this, GAME_WIDTH / 2 + 130, 515, 'เริ่มเลย', () => this.net?.send({ t: 'begin' }), { width: 220, height: 58, fontSize: 24, color: 0x2fbf5b }));
    }
    this.panel.push(
      addTextButton(
        this,
        GAME_WIDTH / 2 - (canStart ? 130 : 0),
        515,
        'ออกจากห้อง',
        () => {
          this.net?.send({ t: 'leave' });
          this.showChoices();
        },
        { width: 220, height: 58, fontSize: 24, color: 0xe5484d },
      ),
    );
    if (fresh) this.tweens.add({ targets: codeText, scale: 1.06, duration: 700, yoyo: true, repeat: -1, ease: 'Sine.inOut' });
  }

  private async listen() {
    const net = this.net!;
    for (;;) {
      const msg: ServerMessage = await net.next();
      if (!this.scene.isActive()) return;
      if (msg.t === 'room') {
        this.status.setText('');
        this.showWaiting(msg);
      } else if (msg.t === 'roomList') {
        this.rooms = msg.rooms;
        this.drawRoomList();
      } else if (msg.t === 'tourney') {
        this.tourney = msg.view;
        this.drawTourney();
      } else if (msg.t === 'error') this.status.setText(msg.message).setColor('#ff9a9a');
      else if (msg.t === 'start') {
        this.scene.start('Online', { net, start: msg });
        return;
      }
    }
  }

  /** Strip under the cards: the tournament the teacher opened, and where we stand in it */
  private drawTourney() {
    this.tourneyItems.forEach((o) => o.destroy());
    this.tourneyItems = [];
    const v = this.tourney;
    if (!v) return;
    const y = 612;
    const g = this.add.graphics();
    g.fillStyle(0x5b2a86, 0.92).fillRoundedRect(GAME_WIDTH / 2 - 440, y - 28, 880, 56, 18);
    g.lineStyle(3, 0xffcc33, 1).strokeRoundedRect(GAME_WIDTH / 2 - 440, y - 28, 880, 56, 18);
    this.tourneyItems.push(g);
    const round = `รอบที่ ${v.round}/${v.rounds}`;
    let msg: string;
    let button: { label: string; send: 'tjoin' | 'tleave' } | null = null;
    if (v.status === 'signup') {
      msg = v.joined ? `ลงชื่อทัวร์นาเมนต์แล้ว รอครูกดเริ่ม (${v.players} คน)` : `ครูเปิดทัวร์นาเมนต์! ลงชื่อแล้ว ${v.players} คน`;
      button = v.joined ? { label: 'ถอนชื่อ', send: 'tleave' } : { label: 'เข้าร่วม', send: 'tjoin' };
    } else if (v.status === 'done') {
      msg = v.me === 'champion' ? 'คุณคือแชมป์ทัวร์นาเมนต์!' : `แชมป์ทัวร์นาเมนต์: ${v.champion ?? '-'}`;
    } else if (v.me === 'waiting') {
      msg = `ทัวร์นาเมนต์ ${round}: เจอกับ ${v.opponent ?? '?'} เกมจะเริ่มเองเมื่ออยู่ในห้องรอทั้งคู่`;
    } else if (v.me === 'playing') {
      msg = `ทัวร์นาเมนต์ ${round}: กำลังเริ่มเกม...`;
    } else if (v.me === 'through') {
      msg = `ผ่านเข้ารอบแล้ว! รอคู่ถัดไป (${round})`;
    } else if (v.me === 'out') {
      msg = 'คุณตกรอบแล้ว ดูการแข่งต่อบนจอของครูได้';
    } else {
      msg = `ทัวร์นาเมนต์ของห้องกำลังแข่ง (${round})`;
    }
    this.tourneyItems.push(this.add.text(GAME_WIDTH / 2 - 410, y, msg, text(20, '#ffffff')).setOrigin(0, 0.5));
    if (button) {
      const b = button;
      this.tourneyItems.push(addTextButton(this, GAME_WIDTH / 2 + 360, y, b.label, () => this.net?.send({ t: b.send }), { width: 140, height: 42, fontSize: 20, color: b.send === 'tjoin' ? 0x2fbf5b : 0x8a8fa8 }));
    }
  }

  private clearPanel() {
    for (const o of [...this.panel, ...this.listItems]) o.destroy();
    this.panel = [];
    this.listItems = [];
    this.listShown = false;
    // Text boxes live in Phaser DOM elements
    this.children.list.filter((c) => c instanceof Phaser.GameObjects.DOMElement).forEach((c) => c.destroy());
  }

  private back() {
    this.leaving = true;
    this.scene.start('Menu');
  }
}
