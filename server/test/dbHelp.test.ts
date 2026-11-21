// Run with: npm test -w server
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { explainDbError } from '../src/dbHelp';

const URL = 'postgresql://postgres.abc:s3cretPass@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres';

test('a wrong database password is explained, and the password is never shown', () => {
  const err = Object.assign(new Error(`password authentication failed for user "postgres.abc" (${URL})`), { code: '28P01' });
  const text = explainDbError(err, URL);
  assert.match(text, /รหัสผ่านใน DATABASE_URL ผิด/);
  assert.ok(!text.includes('s3cretPass'), 'password hidden');
});

test('the copied-but-not-filled-in connection string is spotted', () => {
  const text = explainDbError(new Error('whatever'), URL.replace('s3cretPass', '[YOUR-PASSWORD]'));
  assert.match(text, /\[YOUR-PASSWORD\]/);
});

test('a wrong user name and an unreachable host get their own hints', () => {
  assert.match(explainDbError(new Error('Tenant or user not found'), URL), /ชื่อผู้ใช้/);
  // Newer Supabase wording (with a misleading ENOTFOUND inside): a paused or missing project
  const paused = explainDbError(Object.assign(new Error('(ENOTFOUND) tenant/user postgres.abc not found'), { code: 'XX000' }), URL);
  assert.match(paused, /Restore/);
  assert.doesNotMatch(paused, /ชื่อเซิร์ฟเวอร์/);
  assert.match(explainDbError(Object.assign(new Error('getaddrinfo ENOTFOUND x'), { code: 'ENOTFOUND' }), URL), /ชื่อเซิร์ฟเวอร์/);
});
