// 日単位のスキャン → 空きがありそうな日だけコマ単位で深掘り、という2段構え。
// full の日を詳細取得から外すことで、リクエスト数を実際に空きのある日数ぶんに抑える。

import { BunkyoClient, MAX_DAYS_PER_DETAIL_REQUEST } from './client.mjs';
import { needsDetail, todayJst, addDays, weekdayOf } from './model.mjs';

/** 期間を「その月の1日」単位に割って、1ヶ月ぶんずつ取得できるようにする。 */
function monthWindows(from, to) {
  const windows = [];
  let cursor = from;
  while (cursor <= to) {
    const monthStart = `${cursor.slice(0, 7)}-01`;
    // 初回だけは from 当日から始めて、過去日を取りに行かないようにする。
    windows.push(windows.length === 0 ? cursor : monthStart);
    const [y, m] = cursor.split('-').map(Number);
    cursor = `${m === 12 ? y + 1 : y}-${String(m === 12 ? 1 : m + 1).padStart(2, '0')}-01`;
  }
  return windows;
}

const chunk = (arr, size) =>
  Array.from({ length: Math.ceil(arr.length / size) }, (_, i) => arr.slice(i * size, (i + 1) * size));

/**
 * 表示期間の終端。monthsAhead はカレンダーの月で数える（当月を含む）:
 * 8月に monthsAhead=4 なら 11/30 まで、9月に入れば自動で 12/31 まで進む。
 * 月替わりで前の月が落ち、次の月が入る——固定日数の窓と違い、
 * 「まだ意味のない遠い月の端」がはみ出さない。
 */
export function horizonEnd(from, config) {
  const months = config.monthsAhead;
  if (Number.isFinite(months) && months > 0) {
    const [y, m] = from.split('-').map(Number);
    const t = m - 1 + months - 1; // 最後に含める月（0始まり）
    const yy = y + Math.floor(t / 12);
    const mm = t % 12;
    const lastDay = new Date(Date.UTC(yy, mm + 1, 0)).getUTCDate();
    return `${yy}-${String(mm + 1).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
  }
  return addDays(from, config.daysAhead ?? 120);
}

/**
 * @param {object} config config.json の中身
 * @param {(msg: string) => void} [log]
 * @param {{detail?: boolean, daysAhead?: number}} [opts]
 *   detail=false なら日単位のステータスだけを取る（数リクエストで済む速い経路）。
 *   daysAhead を渡すと monthsAhead より優先される（--days 用）。
 * @returns {Promise<{facility: object, fetchedAt: string, days: object[]}>}
 */
export async function scan(config, log = () => {}, opts = {}) {
  const { detail = true } = opts;
  const { facility } = config;
  // 対象は 1 室場。config の objects は候補名の並びとして扱い、施設に実在する
  // 最初のものを使う（1 日 1 行のデータ構造なので、複数室場は混ざってしまう）。
  const candidates = facility.objects ?? [];
  let objectName = null;

  const client = new BunkyoClient({
    categoryCode: facility.categoryCode,
    facilityCode: facility.code,
  });
  await client.connect();
  log(`接続: ${client.facilityName} (code=${facility.code})`);

  const from = todayJst();
  const to = opts.daysAhead ? addDays(from, opts.daysAhead) : horizonEnd(from, config);
  const days = new Map(); // date -> { date, dayStatus, slots }

  for (const windowStart of monthWindows(from, to)) {
    const rows = await client.fetchMonth(windowStart);
    const facilityRows = rows.find((f) => String(f.FacilityCode) === String(facility.code));
    if (!facilityRows) continue;

    if (objectName === null) {
      const available = facilityRows.Rows.map((r) => r.ObjectName);
      objectName = candidates.find((n) => available.includes(n)) ?? available[0];
      if (candidates.length > 0 && !candidates.includes(objectName)) {
        throw new Error(
          `室場 ${candidates.join(' / ')} が ${client.facilityName} にありません。` +
            `利用可能: ${available.join(', ')}`,
        );
      }
      log(`対象室場: ${objectName}`);
    }

    for (const row of facilityRows.Rows) {
      if (row.ObjectName !== objectName) continue;
      for (const cell of row.Cells) {
        const date = cell.UseDate.slice(0, 10);
        if (date < from || date > to || days.has(date)) continue;
        days.set(date, {
          date,
          weekday: weekdayOf(date),
          isHoliday: Boolean(cell.IsHoliday),
          objectName: row.ObjectName,
          capacity: row.Capacity,
          dayStatus: cell.Status,
          slots: [],
        });
      }
    }

    if (!detail) continue;

    // この期間のうち、詳細を見る価値がある日だけを 10 日ずつ深掘りする。
    const detailDates = [...days.values()]
      .filter((d) => needsDetail(d.dayStatus) && d.slots.length === 0)
      .map((d) => d.date)
      .filter((d) => d >= windowStart && d < addDays(windowStart, 31));

    // 上限はセル数。1 室場に絞っているので 1 日 = 1 セルで数えられる。
    for (const batch of chunk(detailDates, MAX_DAYS_PER_DETAIL_REQUEST)) {
      const tables = await client.fetchSlots(windowStart, batch, [objectName]);
      log(`  詳細取得 ${batch[0]}〜${batch[batch.length - 1]} (${batch.length}日)`);
      for (const table of tables) {
        const date = table.UseDate.slice(0, 10);
        const day = days.get(date);
        if (!day) continue;
        for (const place of table.Places) {
          if (place.ObjectName !== objectName) continue;
          // IsVacant は常に false で返るので採用しない。空きかどうかは Status、
          // 「今すぐ申込めるか」は Disabled で判断する（model.mjs の isBookable）。
          day.slots = place.Cells.map((c) => ({
            from: c.TimeFrom,
            to: c.TimeTo,
            frame: c.FrameName.trim(),
            status: c.Status,
            disabled: Boolean(c.Disabled),
            // 抽選期間中はここに申込件数が入る。競争率の目安になる。
            lotApplications: c.LotUsedQuantity ?? 0,
          }));
        }
      }
    }
  }

  return {
    facility: {
      code: facility.code,
      name: client.facilityName,
      description: client.facilityDescription ?? '',
      guideUrl: client.facilityGuideUrl ?? '',
      objects: objectName ? [objectName] : [],
    },
    range: { from, to },
    fetchedAt: new Date().toISOString(),
    days: [...days.values()].sort((a, b) => a.date.localeCompare(b.date)),
  };
}
