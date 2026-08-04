// node --test test/
//
// 通知判定はこのツールで一番壊れやすいところ。サイトは受付開始前の日も
// Status='vacant' で返すので、Disabled を見落とすと初回から百件単位で誤報が出る。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diff, changedDays, snapshot } from '../src/monitor.mjs';
import { isBookable, weekdayOf } from '../src/model.mjs';

const weekendOnly = { notifyOn: { weekdays: [0, 6], includeLottery: true } };

/** その日 1 コマだけを持つ最小の日レコード。 */
const day = (date, { status = 'vacant', disabled = false, lot = 0, isHoliday = false } = {}) => ({
  date,
  weekday: weekdayOf(date),
  isHoliday,
  dayStatus: 'some',
  slots: [{ from: 830, to: 1030, frame: 'Ｂ', status, disabled, lotApplications: lot }],
});

const prevWith = (slots = {}, dayStatus = {}) => ({ version: 2, slots, dayStatus });

test('満杯だった土曜が申込可になったら通知する', () => {
  const previous = prevWith({ '2026-09-12 830-1030': { status: 'full', disabled: true } });
  const events = diff(previous, { days: [day('2026-09-12')] }, weekendOnly);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'vacant');
});

test('対象外の曜日は通知しない', () => {
  const previous = prevWith({ '2026-09-14 830-1030': { status: 'full', disabled: true } });
  const events = diff(previous, { days: [day('2026-09-14')] }, weekendOnly);
  assert.equal(events.length, 0);
});

test('祝日は曜日指定に関わらず通知する', () => {
  const previous = prevWith({ '2026-11-23 830-1030': { status: 'vacant', disabled: true } });
  const events = diff(previous, { days: [day('2026-11-23', { isHoliday: true })] }, weekendOnly);
  assert.equal(events.length, 1);
});

test('受付開始前の空き（Disabled=true）は通知しない', () => {
  const events = diff(prevWith(), { days: [day('2026-11-14', { disabled: true })] }, weekendOnly);
  assert.equal(events.length, 0);
});

test('基準が空でも申込可なコマは通知する', () => {
  const events = diff(prevWith(), { days: [day('2026-11-14')] }, weekendOnly);
  assert.equal(events.length, 1);
});

test('同じ状態が続く間は繰り返し通知しない', () => {
  const previous = prevWith({ '2026-09-12 830-1030': { status: 'vacant', disabled: false } });
  const events = diff(previous, { days: [day('2026-09-12')] }, weekendOnly);
  assert.equal(events.length, 0);
});

test('抽選申込が可能になったら通知し、以後は繰り返さない', () => {
  const lotDay = day('2026-10-03', { status: 'lot', lot: 2 });
  const opened = diff(prevWith(), { days: [lotDay] }, weekendOnly);
  assert.equal(opened.length, 1);
  assert.equal(opened[0].type, 'lottery');

  const previous = prevWith({ '2026-10-03 830-1030': { status: 'lot', disabled: false, lot: 2 } });
  assert.equal(diff(previous, { days: [lotDay] }, weekendOnly).length, 0);
});

test('時間帯フィルタは範囲外のコマを落とす', () => {
  const config = { notifyOn: { weekdays: [], timeFrom: 1600, timeTo: 2030 } };
  assert.equal(diff(prevWith(), { days: [day('2026-09-12')] }, config).length, 0);
});

test('changedDays は対象曜日が満杯から動いたときだけ拾う', () => {
  const previous = prevWith({}, { '2026-11-14': 'full', '2026-11-16': 'full', '2026-11-21': 'full' });
  const result = {
    days: [
      { date: '2026-11-14', weekday: 6, isHoliday: false, dayStatus: 'some', slots: [] }, // 土・変化
      { date: '2026-11-16', weekday: 1, isHoliday: false, dayStatus: 'some', slots: [] }, // 月・対象外
      { date: '2026-11-21', weekday: 6, isHoliday: false, dayStatus: 'full', slots: [] }, // 土・変化なし
    ],
  };
  assert.deepEqual(changedDays(previous, result, weekendOnly), ['2026-11-14']);
});

test('changedDays は基準にない日を拾わない（初回に全部鳴らさない）', () => {
  const result = { days: [{ date: '2026-11-14', weekday: 6, isHoliday: false, dayStatus: 'some', slots: [] }] };
  assert.deepEqual(changedDays(prevWith(), result, weekendOnly), []);
});

test('snapshot はコマと日ステータスの両方を残す', () => {
  const state = snapshot({ days: [day('2026-09-12')] });
  assert.equal(state.version, 2);
  assert.equal(state.dayStatus['2026-09-12'], 'some');
  assert.deepEqual(state.slots['2026-09-12 830-1030'], {
    status: 'vacant',
    lot: 0,
    disabled: false,
  });
});

test('isBookable は Disabled を見る', () => {
  assert.equal(isBookable({ status: 'vacant', disabled: false }), true);
  assert.equal(isBookable({ status: 'vacant', disabled: true }), false);
  assert.equal(isBookable({ status: 'full', disabled: false }), false);
});

// --- 通知の送り先ごとの形 -----------------------------------------------------

test('Discord には content だけを送る（余計なキーがあると 400 になる）', async () => {
  const { webhookPayload } = await import('../src/notify.mjs');
  const p = webhookPayload('https://discord.com/api/webhooks/1/abc', {
    title: '空きが出ました',
    body: '09/12(土) 8:30–10:30',
    payload: { events: [{ type: 'vacant' }] },
  });
  assert.deepEqual(Object.keys(p).sort(), ['allowed_mentions', 'content']);
  assert.match(p.content, /09\/12/);
  assert.deepEqual(p.allowed_mentions, { parse: [] });
});

test('Slack には text と blocks を送る', async () => {
  const { webhookPayload } = await import('../src/notify.mjs');
  const p = webhookPayload('https://hooks.slack.com/services/T/B/x', {
    title: '空きが出ました',
    body: '09/12(土) 8:30–10:30',
    payload: {},
  });
  assert.ok(p.text);
  assert.equal(p.blocks.length, 2);
});

test('判別できない送り先には両方のキーを入れる', async () => {
  const { webhookPayload } = await import('../src/notify.mjs');
  const p = webhookPayload('https://example.test/hook', {
    title: 'T',
    body: 'B',
    payload: { events: [] },
  });
  assert.ok(p.text && p.content && p.events);
});

test('似せたホスト名を Discord と誤認しない', async () => {
  const { webhookPayload } = await import('../src/notify.mjs');
  const p = webhookPayload('https://discord.com.evil.test/hook', { title: 'T', body: 'B', payload: {} });
  assert.ok(p.text, 'discord 判定に落ちてはいけない');
});
