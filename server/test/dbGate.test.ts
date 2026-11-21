// Run with: npm test -w server
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DbGate } from '../src/dbGate';

test('the database gate keeps trying until the database opens, and logs each reason once', async () => {
  let calls = 0;
  const logs: string[] = [];
  let readyWith: string | null = null;
  const gate = new DbGate<string>({
    open: async () => {
      calls++;
      if (calls < 4) throw new Error('paused');
      return 'db';
    },
    onReady: (db) => (readyWith = db),
    explain: () => 'เปิดฐานข้อมูลไม่ได้\nสาเหตุ: โปรเจคถูกพัก',
    log: (t) => logs.push(t),
    delays: [5, 5],
  });
  await gate.start();
  assert.equal(gate.ready, false, 'the server goes on without it');
  assert.equal(gate.problem, 'สาเหตุ: โปรเจคถูกพัก');
  for (let i = 0; i < 100 && !gate.ready; i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal(gate.ready, true);
  assert.equal(readyWith, 'db');
  assert.equal(calls, 4);
  assert.equal(logs.filter((l) => l.includes('โปรเจคถูกพัก')).length, 1, 'the same reason is printed once');
  assert.ok(logs.some((l) => l.includes('ต่อฐานข้อมูลได้แล้ว')));
  gate.stop();
});
