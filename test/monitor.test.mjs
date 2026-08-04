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

// --- 大量イベントの要約 -------------------------------------------------------

test('月単位で受付が開いたときは1通にまとめる', async () => {
  const { summarizeEvents } = await import('../src/monitor.mjs');
  const events = [];
  for (let d = 1; d <= 28; d++) {
    for (let i = 0; i < 5; i++) {
      events.push({
        type: 'lottery',
        day: { date: `2026-11-${String(d).padStart(2, '0')}` },
        slot: { from: 630 + i * 200, to: 830 + i * 200, lotApplications: (d + i) % 4 },
      });
    }
  }
  const { title, body } = summarizeEvents(events, '小石川運動場');
  assert.match(title, /11月 抽選申込が開始/);
  assert.match(body, /28日分 140コマ/);
  // 個別の140行ではなく、狙い目を数件だけ添える
  assert.ok(body.split('\n').length < 12, `要約が長すぎる: ${body.split('\n').length}行`);
  assert.match(body, /狙い目/);
});

test('要約では申込が少ないコマを先に挙げる', async () => {
  const { summarizeEvents } = await import('../src/monitor.mjs');
  const mk = (date, lot) => ({
    type: 'lottery',
    day: { date },
    slot: { from: 830, to: 1030, lotApplications: lot },
  });
  const { body } = summarizeEvents([mk('2026-11-01', 5), mk('2026-11-02', 0), mk('2026-11-03', 3)], 'X');
  const picks = body.split('狙い目:')[1].trim().split('\n');
  assert.match(picks[0], /11\/02/, '申込0件が先頭に来るべき');
});

test('月をまたぐ変化は月ごとに行を分ける', async () => {
  const { summarizeEvents } = await import('../src/monitor.mjs');
  const { body } = summarizeEvents(
    [
      { type: 'vacant', day: { date: '2026-09-12' }, slot: { from: 830, to: 1030, lotApplications: 0 } },
      { type: 'lottery', day: { date: '2026-11-01' }, slot: { from: 830, to: 1030, lotApplications: 0 } },
    ],
    'X',
  );
  assert.match(body, /9月 空きが出ました/);
  assert.match(body, /11月 抽選申込が開始/);
});

// --- 月ごとの要約と折り畳み ---------------------------------------------------

test('全コマ埋まった月は「空きなし」、取得漏れと区別できる', async () => {
  const { monthSummary } = await import('../src/format.mjs');
  const days = [
    { date: '2026-08-05', dayStatus: 'full', slots: [] },
    { date: '2026-08-06', dayStatus: 'full', slots: [] },
  ];
  const [aug] = monthSummary(days);
  assert.equal(aug.label, '空きなし');
  assert.equal(aug.days, 2);
});

test('受付開始前の月は1行に折り畳まれる', async () => {
  const { renderHtml } = await import('../src/format.mjs');
  const days = [];
  for (let d = 1; d <= 20; d++) {
    days.push({
      date: `2026-11-${String(d).padStart(2, '0')}`,
      weekday: d % 7,
      isHoliday: false,
      dayStatus: 'some',
      slots: [{ from: 830, to: 1030, frame: 'Ｂ', status: 'vacant', disabled: true, lotApplications: 0 }],
    });
  }
  const html = renderHtml({
    facility: { name: 'X', objects: ['グラウンド'], description: '', guideUrl: '' },
    range: { from: '2026-11-01', to: '2026-11-20' },
    fetchedAt: new Date().toISOString(),
    days,
  });
  assert.equal((html.match(/row folded/g) ?? []).length, 1);
  assert.equal((html.match(/<div class="row /g) ?? []).length, 1, '20日ぶんの行を出してはいけない');
  assert.doesNotMatch(html, /<\/div>,<div/, '配列の join 漏れ');
});
