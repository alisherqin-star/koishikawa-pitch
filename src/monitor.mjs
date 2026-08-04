// 前回スキャンとの差分を取り、通知に値する変化だけを抜き出す。

import { readFile, writeFile } from 'node:fs/promises';
import { hhmm, isBookable, isLotteryOpen, slotKey, toMinutes, weekdayJa } from './model.mjs';

/** 状態ファイル。コマ単位の状態と、速い経路で使う日単位のステータス。 */
export function snapshot(result) {
  const slots = {};
  const dayStatus = {};
  for (const day of result.days) {
    dayStatus[day.date] = day.dayStatus;
    for (const slot of day.slots) {
      slots[slotKey(day.date, slot.from, slot.to)] = {
        status: slot.status,
        lot: slot.lotApplications,
        disabled: slot.disabled,
      };
    }
  }
  return { version: 2, slots, dayStatus };
}

export async function loadState(path) {
  try {
    const raw = JSON.parse(await readFile(path, 'utf8'));
    // v1 はコマ状態だけのフラットマップだった。日ステータスは次回の全件走査で埋まる。
    return raw?.version === 2 ? raw : { version: 2, slots: raw, dayStatus: {} };
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

/** その日に「申込める見込み」があるか。日単位ステータスだけで判断する。 */
const dayLooksOpen = (status) => status === 'vacant' || status === 'some' || status === 'lot';

/**
 * 日単位スキャンだけで、監視対象の日が「満杯」から動いたかを見る。
 * コマ単位の詳細を取らないぶん速く、短い間隔で回せる。
 * @returns {string[]} 詳細を確認すべき日付
 */
export function changedDays(previous, result, config) {
  const filter = config.notifyOn ?? {};
  const weekdays = filter.weekdays ?? [];
  const before = previous?.dayStatus ?? {};
  const hits = [];

  for (const day of result.days) {
    if (weekdays.length > 0 && !weekdays.includes(day.weekday) && !day.isHoliday) continue;
    const was = before[day.date];
    if (was === undefined) continue; // 基準がない日は次の全件走査に任せる
    if (was !== day.dayStatus && dayLooksOpen(day.dayStatus)) hits.push(day.date);
  }
  return hits;
}

export const saveState = (path, state) =>
  writeFile(path, JSON.stringify(state, null, 0), 'utf8');

/** notifyOn の条件（曜日・時間帯）に合うコマだけを通知対象にする。 */
function matchesFilter(filter, day, slot) {
  const weekdays = filter?.weekdays ?? [];
  if (weekdays.length > 0 && !weekdays.includes(day.weekday) && !day.isHoliday) return false;
  if (filter?.timeFrom != null && toMinutes(slot.from) < toMinutes(filter.timeFrom)) return false;
  if (filter?.timeTo != null && toMinutes(slot.to) > toMinutes(filter.timeTo)) return false;
  return true;
}

/**
 * 前回状態との差分。
 * - vacant : 先着で取れるようになった（キャンセルが出た）
 * - lottery: 抽選申込ができるようになった
 * - lot-drop: 抽選の申込件数が減った（config で任意）
 */
export function diff(previous, result, config) {
  const filter = config.notifyOn ?? {};
  const events = [];

  for (const day of result.days) {
    for (const slot of day.slots) {
      const key = slotKey(day.date, slot.from, slot.to);
      const before = previous?.slots?.[key];
      if (!matchesFilter(filter, day, slot)) continue;

      // 「空いている」だけでは通知しない。受付期間前の日は Status='vacant' の
      // まま何ヶ月も並んでいるので、それを拾うと初回から百件単位で誤報が出る。
      if (isBookable(slot) && !(before && isBookable(before))) {
        events.push({ type: 'vacant', day, slot, before });
        continue;
      }

      if (isLotteryOpen(slot) && filter.includeLottery !== false) {
        if (!(before && isLotteryOpen(before))) {
          events.push({ type: 'lottery', day, slot, before });
        } else if (config.notify?.onLotteryCountChange && slot.lotApplications < before.lot) {
          events.push({ type: 'lot-drop', day, slot, before });
        }
      }
    }
  }
  return events;
}

/**
 * 受付が月単位で開くと、コマ単位のイベントが一度に百件以上出る
 * （11月の抽選が9月1日に開く、など）。そのまま流すと通知が埋まるので、
 * 件数が多いときは月ごとにまとめた文面にする。
 *
 * @returns {{title: string, body: string}}
 */
export function summarizeEvents(events, facilityName) {
  const byMonth = new Map();
  for (const e of events) {
    const key = `${e.day.date.slice(0, 7)}|${e.type}`;
    if (!byMonth.has(key)) {
      byMonth.set(key, { month: e.day.date.slice(0, 7), type: e.type, slots: 0, days: new Set() });
    }
    const g = byMonth.get(key);
    g.slots++;
    g.days.add(e.day.date);
  }

  const groups = [...byMonth.values()].sort((a, b) => a.month.localeCompare(b.month));
  const lines = groups.map((g) => {
    const month = `${Number(g.month.slice(5))}月`;
    const scale = `${g.days.size}日分 ${g.slots}コマ`;
    return g.type === 'lottery'
      ? `${month} 抽選申込が開始（${scale}）`
      : g.type === 'vacant'
        ? `${month} 空きが出ました（${scale}）`
        : `${month} ${scale}`;
  });

  // 抽選なら申込が少ない順、先着なら日付順に、動くべき候補を数件だけ添える。
  const picks = [...events]
    .sort(
      (a, b) =>
        a.slot.lotApplications - b.slot.lotApplications || a.day.date.localeCompare(b.day.date),
    )
    .slice(0, 5)
    .map((e) => `  ${describeEvent(e)}`);

  return {
    title: `${facilityName} ${lines[0]}`,
    body: [...lines, '', '狙い目:', ...picks].join('\n'),
  };
}

export function describeEvent(e) {
  const when = `${e.day.date.slice(5).replace('-', '/')}(${weekdayJa(e.day.date)}) ${hhmm(
    e.slot.from,
  )}–${hhmm(e.slot.to)}`;
  switch (e.type) {
    case 'vacant':
      return `${when} 空きが出ました`;
    case 'lottery':
      return `${when} 抽選申込が可能（現在 ${e.slot.lotApplications} 件）`;
    case 'lot-drop':
      return `${when} 抽選の申込が ${e.before.lot} → ${e.slot.lotApplications} 件に減少`;
    default:
      return when;
  }
}

/** quietHours: [23, 7] なら 23:00〜07:00(JST) は通知を出さない。 */
export function inQuietHours(quietHours) {
  if (!Array.isArray(quietHours) || quietHours.length !== 2) return false;
  const [start, end] = quietHours;
  const hour = Number(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Tokyo',
      hour: '2-digit',
      hour12: false,
    }).format(new Date()),
  );
  return start <= end ? hour >= start && hour < end : hour >= start || hour < end;
}
