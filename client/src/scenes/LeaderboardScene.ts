import * as Phaser from 'phaser';
import type { Leaderboard, LeaderboardRow } from '@sciboom/shared';
import { startMusic } from '../audio/Sound';
import { FONT_FAMILY, GAME_HEIGHT, GAME_WIDTH, TEXT_STROKE } from '../config';
import { drawArtBackground } from '../game/background';
import { api, ApiError } from '../net/api';
import { isStudent, session } from '../net/session';
import { syncSave } from '../save';
import { addTextButton } from '../ui/TextButton';

const text = (size: number, color = '#ffffff'): Phaser.Types.GameObjects.Text.TextStyle => ({
  fontFamily: FONT_FAMILY,
  fontSize: `${size}px`,
  fontStyle: '700',
  color,
  stroke: TEXT_STROKE,
  strokeThickness: Math.max(3, size / 6),
  padding: { top: 6 },
});

type Board = 'weekCorrect' | 'level' | 'pvpWins' | 'badges';
const BOARDS: { key: Board; tab: string; unit: string }[] = [
  { key: 'weekCorrect', tab: 'ตอบถูกสัปดาห์นี้', unit: 'ข้อ' },
  { key: 'level', tab: 'เลเวล', unit: '' },
  { key: 'pvpWins', tab: 'ชนะออนไลน์', unit: 'ครั้ง' },
  { key: 'badges', tab: 'เหรียญรางวัล', unit: 'เหรียญ' },
];
const SHOWN = 10;
const MEDALS = [0xffcc33, 0xd8dde8, 0xd8894a];

/** Classmates ranked (students with an account only) */
export class LeaderboardScene extends Phaser.Scene {
  private board: Board = 'weekCorrect';
  private loaded: Leaderboard | null = null;

  constructor() {
    super('Leaderboard');
  }

  init(data: { board?: Board; keep?: boolean }) {
    this.board = data.board ?? this.board;
    if (!data.keep) this.loaded = null;
  }

  create() {
    startMusic('menu');
    drawArtBackground(this, 'backgrounds/menu_school', GAME_WIDTH, 0);
    this.add.rectangle(0, 0, GAME_WIDTH, GAME_HEIGHT, 0x0b0c1f, 0.6).setOrigin(0);
    this.add.text(GAME_WIDTH / 2, 44, 'อันดับในห้องเรียน', text(40, '#ffcc33')).setOrigin(0.5);
    addTextButton(this, 130, GAME_HEIGHT - 48, 'กลับเมนู', () => this.scene.start('Menu'), { width: 200, height: 60, fontSize: 24, color: 0x3a8dde });

    if (!isStudent()) {
      this.message('เข้าสู่ระบบด้วยรหัสห้องเรียนก่อน แล้วจะเห็นอันดับของเพื่อนในห้อง');
      addTextButton(this, GAME_WIDTH / 2, 440, 'เข้าสู่ระบบ', () => this.scene.start('Login'), { width: 260, color: 0xff8a1f });
      return;
    }
    BOARDS.forEach((b, i) => {
      addTextButton(this, GAME_WIDTH / 2 + (i - 1.5) * 280, 112, b.tab, () => this.scene.restart({ board: b.key, keep: true }), {
        width: 264,
        height: 54,
        fontSize: 21,
        color: this.board === b.key ? 0xff8a1f : 0x4a4f75,
      });
    });
    if (this.loaded) this.draw(this.loaded);
    else void this.fetchBoard();
  }

  private async fetchBoard() {
    const wait = this.message('กำลังโหลด...');
    try {
      // Our newest progress first, so we're shown up to date
      await syncSave();
      this.loaded = await api<Leaderboard>('GET', 'student/leaderboard');
      if (!this.scene.isActive()) return;
      wait.destroy();
      this.draw(this.loaded);
    } catch (e) {
      if (!this.scene.isActive()) return;
      wait.setText(e instanceof ApiError ? e.message : 'โหลดอันดับไม่ได้ ลองใหม่อีกครั้ง');
    }
  }

  private message(msg: string) {
    return this.add.text(GAME_WIDTH / 2, 340, msg, text(26, '#bfe8ff')).setOrigin(0.5);
  }

  private draw(data: Leaderboard) {
    const meta = BOARDS.find((b) => b.key === this.board)!;
    const me = session.profile?.id;
    const ranked = [...data.rows].sort((a, b) => b[this.board] - a[this.board] || a.number - b.number);
    this.add.text(GAME_WIDTH - 40, 44, data.classroom, text(22, '#bfe8ff')).setOrigin(1, 0.5);
    if (ranked.length === 0) {
      this.message('ยังไม่มีใครในห้องเล่นเลย มาเป็นคนแรกกัน!');
      return;
    }
    // Ties share a place
    const place = (i: number) => ranked.findIndex((r) => r[this.board] === ranked[i][this.board]) + 1;
    const top = ranked.slice(0, SHOWN);
    top.forEach((r, i) => this.row(r, place(i), 182 + i * 46, r.id === me, meta.unit));
    const mine = ranked.findIndex((r) => r.id === me);
    if (mine >= SHOWN) this.row(ranked[mine], place(mine), 182 + SHOWN * 46 + 8, true, meta.unit);
    if (this.board === 'weekCorrect') this.add.text(GAME_WIDTH / 2 + 120, GAME_HEIGHT - 48, 'นับใหม่ทุกวันจันทร์ · ตอบถูกในเกมผจญภัยและออนไลน์', text(18, '#bfe8ff')).setOrigin(0.5);
  }

  private row(r: LeaderboardRow, place: number, y: number, mine: boolean, unit: string) {
    const x0 = 200;
    const w = GAME_WIDTH - 400;
    const g = this.add.graphics();
    g.fillStyle(mine ? 0x8a5cf6 : 0x1b1d3a, mine ? 0.9 : 0.8).fillRoundedRect(x0, y - 20, w, 40, 14);
    if (mine) g.lineStyle(3, 0xffcc33, 1).strokeRoundedRect(x0, y - 20, w, 40, 14);
    const medal = MEDALS[place - 1];
    if (medal !== undefined) this.add.circle(x0 + 34, y, 16, medal).setStrokeStyle(3, 0x1b1d3a);
    this.add.text(x0 + 34, y, String(place), text(20, medal !== undefined ? '#1b1d3a' : '#ffffff')).setOrigin(0.5).setStroke(medal !== undefined ? '#ffffff' : TEXT_STROKE, 3);
    this.add.text(x0 + 76, y, `${r.nickname}${mine ? ' (คุณ)' : ''}`, text(21)).setOrigin(0, 0.5);
    this.add.text(x0 + 470, y, `เลขที่ ${r.number} · Lv ${r.level}`, text(17, '#cfd3ff')).setOrigin(0, 0.5);
    this.add.text(x0 + w - 24, y, `${r[this.board]} ${unit}`.trim(), text(22, '#ffcc33')).setOrigin(1, 0.5);
  }
}
