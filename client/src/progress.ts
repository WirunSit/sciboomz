// Counting what the player does for daily quests and achievements, and telling
// them when one is done ("ภารกิจสำเร็จ!" toasts). Rules are in @sciboom/shared (quests.ts).
import type * as Phaser from 'phaser';
import { addExp, claimAchievement, claimDailyBonus, claimQuest, questText, recordEvent, rewardsWaiting, type GameEvent } from '@sciboom/shared';
import { sfx } from './audio/Sound';
import { loadSave, updateSave } from './save';
import { showToast } from './ui/Toast';

/** Record something that happened; shows a toast for each quest or achievement it completes */
export function track(scene: Phaser.Scene | null, event: GameEvent) {
  let result: ReturnType<typeof recordEvent> | null = null;
  updateSave((d) => {
    result = recordEvent(d, event);
  });
  if (!scene || !result) return;
  const { quests, achievements } = result as ReturnType<typeof recordEvent>;
  for (const q of quests) showToast(scene, 'ภารกิจรายวันสำเร็จ!', questText(q), '#7dff8a');
  for (const a of achievements) showToast(scene, `เหรียญรางวัลใหม่: ${a.name}`, a.desc, '#ffcc33');
  if (quests.length + achievements.length > 0) sfx.item();
}

/** Things waiting to be collected (shown as a red number on the menu buttons) */
export function waitingRewards(): number {
  return rewardsWaiting(loadSave());
}

type Reward = { coins: number; exp?: number } | null;

function pay(get: (d: ReturnType<typeof loadSave>) => Reward): Reward {
  let reward: Reward = null;
  updateSave((d) => {
    reward = get(d);
    if (!reward) return;
    d.coins += reward.coins;
    if (reward.exp) {
      const lv = addExp(d, reward.exp);
      d.level = lv.level;
      d.exp = lv.exp;
    }
  });
  return reward;
}

export const collectQuest = (index: number) => pay((d) => claimQuest(d, index));
export const collectDailyBonus = () => pay((d) => claimDailyBonus(d));
export const collectAchievement = (id: string) => pay((d) => claimAchievement(d, id));
