import * as Phaser from 'phaser';
import {
  ACHIEVEMENTS,
  DAILY_BONUS,
  achievementValue,
  dailyProgress,
  questText,
  type AchievementDef,
} from '@sciboom/shared';
import { sfx, startMusic } from '../audio/Sound';
import { FONT_FAMILY, GAME_HEIGHT, GAME_WIDTH, TEXT_STROKE } from '../config';
import { drawArtBackground } from '../game/background';
import { collectAchievement, collectDailyBonus, collectQuest } from '../progress';
import { loadSave } from '../save';
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

type Tab = 'daily' | 'badges';

/** Today's three quests (+ bonus for all three) and the achievement badges */
export class QuestScene extends Phaser.Scene {
  private tab: Tab = 'daily';
  private from = 'Menu';

  constructor() {
    super('Quests');
  }

  init(data: { tab?: Tab; from?: string }) {
    this.tab = data.tab ?? this.tab;
    this.from = data.from ?? this.from;
  }

  create() {
    startMusic('menu');
    drawArtBackground(this, 'backgrounds/menu_school', GAME_WIDTH, 0);
    this.add.rectangle(0, 0, GAME_WIDTH, GAME_HEIGHT, 0x0b0c1f, 0.55).setOrigin(0);
    this.add.text(GAME_WIDTH / 2, 44, 'ภารกิจและเหรียญรางวัล', text(40, '#ffcc33')).setOrigin(0.5);

    const save = loadSave();
    const coin = this.add.image(36, 44, 'ui/coin');
    coin.setScale(30 / coin.height);
    this.add.text(58, 44, `${save.coins}`, text(22)).setOrigin(0, 0.5);
    this.add.text(150, 44, `Lv ${save.level}`, text(22, '#7dff8a')).setOrigin(0, 0.5);

    const tabs: [Tab, string][] = [
      ['daily', 'ภารกิจวันนี้'],
      ['badges', 'เหรียญรางวัล'],
    ];
    tabs.forEach(([t, label], i) => {
      addTextButton(this, GAME_WIDTH / 2 + (i - 0.5) * 300, 112, label, () => this.scene.restart({ tab: t }), {
        width: 280,
        height: 58,
        fontSize: 24,
        color: this.tab === t ? 0xff8a1f : 0x4a4f75,
      });
    });

    if (this.tab === 'daily') this.daily();
    else this.badges();

    addTextButton(this, 130, GAME_HEIGHT - 48, 'กลับ', () => this.scene.start(this.from), { width: 200, height: 60, fontSize: 24, color: 0x3a8dde });
  }

  private daily() {
    const save = loadSave();
    const progress = dailyProgress(save.daily, save.stats);
    progress.forEach((q, i) => {
      const y = 210 + i * 108;
      this.card(170, y, GAME_WIDTH - 340, 92, q.complete ? 0x7dff8a : 0xffffff);
      this.add.text(200, y - 22, questText(q.quest), text(26)).setOrigin(0, 0.5);
      this.bar(200, y + 22, 460, q.done / q.quest.target, `${q.done}/${q.quest.target}`);
      this.add.text(700, y + 22, `เหรียญ +${q.quest.coins} · EXP +${q.quest.exp}`, text(20, '#ffcc33')).setOrigin(0, 0.5);
      this.claimButton(GAME_WIDTH - 280, y, q.claimed ? 'รับแล้ว' : 'รับรางวัล', q.complete && !q.claimed, () => collectQuest(i));
    });

    // All three: a bonus
    const y = 540;
    const allClaimed = save.daily.claimed.every(Boolean);
    this.card(170, y, GAME_WIDTH - 340, 80, 0xffcc33);
    this.add.text(200, y, `ทำครบ 3 ภารกิจ: โบนัส เหรียญ +${DAILY_BONUS.coins} · EXP +${DAILY_BONUS.exp}`, text(24, '#ffcc33')).setOrigin(0, 0.5);
    this.claimButton(GAME_WIDTH - 280, y, save.daily.bonusClaimed ? 'รับแล้ว' : 'รับโบนัส', allClaimed && !save.daily.bonusClaimed, () => collectDailyBonus());

    this.add.text(GAME_WIDTH / 2, 612, `ภารกิจใหม่ทุกวันตอนเที่ยงคืน (อีก ${untilMidnight()}) · ทุกคนในห้องได้ภารกิจเดียวกัน`, text(19, '#bfe8ff')).setOrigin(0.5);
  }

  /** One card per kind of badge: the next tier still to reach (or to collect) */
  private badges() {
    const save = loadSave();
    const groups = new Map<string, AchievementDef[]>();
    for (const a of ACHIEVEMENTS) groups.set(a.stat, [...(groups.get(a.stat) ?? []), a]);
    const got = save.achieved.length;
    this.add.text(GAME_WIDTH - 40, 44, `ได้แล้ว ${got}/${ACHIEVEMENTS.length}`, text(22, '#ffcc33')).setOrigin(1, 0.5);

    const cols = 4;
    const cw = 285;
    const ch = 108;
    [...groups.values()].forEach((tiers, i) => {
      const next = tiers.find((a) => !save.achieved.includes(a.id));
      const a = next ?? tiers[tiers.length - 1];
      const value = achievementValue(a, save.stats, save.level);
      const reached = value >= a.target;
      const x = GAME_WIDTH / 2 + ((i % cols) - (cols - 1) / 2) * (cw + 14);
      const y = 196 + Math.floor(i / cols) * (ch + 10);
      const done = !next;
      this.card(x - cw / 2, y, cw, ch - 4, done ? 0xffcc33 : reached ? 0x7dff8a : 0x8890b8);
      // Medal: gold once every tier is done
      const medal = this.add.circle(x - cw / 2 + 32, y - 12, 18, done ? 0xffcc33 : reached ? 0x7dff8a : 0x4a4f75).setStrokeStyle(3, 0x1b1d3a);
      this.add.text(medal.x, medal.y, String(tiers.filter((t) => save.achieved.includes(t.id)).length), text(16)).setOrigin(0.5);
      this.add.text(x - cw / 2 + 58, y - 26, a.name, text(19, done ? '#ffcc33' : '#ffffff')).setOrigin(0, 0.5);
      this.add.text(x - cw / 2 + 58, y + 2, a.desc, text(14, '#dddddd')).setOrigin(0, 0.5);
      if (done) {
        this.add.text(x, y + 32, 'สำเร็จครบทุกขั้น!', text(16, '#ffcc33')).setOrigin(0.5);
      } else if (reached) {
        this.claimButton(x, y + 30, `รับ ${a.coins} เหรียญ`, true, () => collectAchievement(a.id), 200, 36, 17);
      } else {
        this.bar(x - cw / 2 + 18, y + 32, cw - 36, value / a.target, `${value}/${a.target}`, 18);
      }
    });
  }

  private card(x: number, y: number, w: number, h: number, edge: number) {
    const g = this.add.graphics();
    g.fillStyle(0x1b1d3a, 0.88).fillRoundedRect(x, y - h / 2, w, h, 18);
    g.lineStyle(3, edge, 0.9).strokeRoundedRect(x, y - h / 2, w, h, 18);
  }

  private bar(x: number, y: number, w: number, frac: number, label: string, h = 22) {
    const g = this.add.graphics();
    g.fillStyle(0x0b0c1f, 0.9).fillRoundedRect(x, y - h / 2, w, h, h / 2);
    const fw = Math.max(0, Math.min(1, frac)) * w;
    if (fw > 2) g.fillStyle(frac >= 1 ? 0x4cd964 : 0x5fd4ff, 1).fillRoundedRect(x, y - h / 2, fw, h, Math.min(h / 2, fw / 2));
    g.lineStyle(2, 0xffffff, 0.6).strokeRoundedRect(x, y - h / 2, w, h, h / 2);
    this.add.text(x + w / 2, y, label, text(Math.round(h * 0.75))).setOrigin(0.5);
  }

  private claimButton(x: number, y: number, label: string, enabled: boolean, claim: () => unknown, w = 190, h = 56, size = 22) {
    const b = addTextButton(
      this,
      x,
      y,
      label,
      () => {
        if (!claim()) return;
        sfx.coin();
        this.scene.restart();
      },
      { width: w, height: h, fontSize: size, color: 0x2fbf5b, disabled: !enabled },
    );
    if (enabled) this.tweens.add({ targets: b, scale: 1.06, duration: 500, yoyo: true, repeat: -1, ease: 'Sine.inOut' });
  }
}

/** Time left until the quests change (midnight in Thailand) */
function untilMidnight(): string {
  const thai = Date.now() + 7 * 3600_000;
  const left = 86_400_000 - (thai % 86_400_000);
  const h = Math.floor(left / 3_600_000);
  const m = Math.floor((left % 3_600_000) / 60_000);
  return h > 0 ? `${h} ชม. ${m} นาที` : `${m} นาที`;
}
