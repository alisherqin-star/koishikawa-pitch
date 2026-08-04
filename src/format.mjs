// 端末用のテキスト表と、ブラウザで開く HTML レポート。

import {
  DAY_STATUS,
  formatJst,
  hhmm,
  isBookable,
  isLotteryOpen,
  slotClass,
  slotSymbol,
  weekdayJa,
} from './model.mjs';

const C = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
};

const paint = (on) => (code, s) => (on ? code + s + C.reset : s);

// 端末の桁数。CJK と全角英数だけを 2 桁扱いにする。○(U+25CB) や ×(U+00D7) は
// East Asian Ambiguous で、多くの端末の既定では 1 桁で描画されるため 1 と数える。
const WIDE =
  /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︰-﹯＀-｠￠-￦]/;
const displayWidth = (s) => [...s].reduce((n, ch) => n + (WIDE.test(ch) ? 2 : 1), 0);

/** 全日程に現れるコマ（開始-終了）の集合を列として並べる。 */
export function slotColumns(days) {
  const seen = new Map();
  for (const day of days) {
    for (const slot of day.slots) {
      const key = `${slot.from}-${slot.to}`;
      if (!seen.has(key)) seen.set(key, { from: slot.from, to: slot.to, frame: slot.frame });
    }
  }
  return [...seen.values()].sort((a, b) => a.from - b.from);
}

const TERM_COLOR = {
  ok: C.green + C.bold,
  lot: C.yellow,
  pending: C.dim,
  no: C.dim,
  na: C.dim,
};

/**
 * 月ごとの要約。満杯の月は表から折り畳まれて消えるので、
 * 「取得できていない」のか「取れる枠が無い」のかが分かるようにする。
 */
export function monthSummary(days) {
  const months = new Map();
  for (const day of days) {
    const key = day.date.slice(0, 7);
    if (!months.has(key)) {
      months.set(key, { month: key, days: 0, bookable: 0, lottery: 0, pending: 0, full: 0, closed: 0 });
    }
    const m = months.get(key);
    m.days++;
    if (day.dayStatus === 'full') m.full++;
    if (day.dayStatus === 'closed' || day.dayStatus === 'time-over') m.closed++;
    for (const slot of day.slots) {
      if (isBookable(slot)) m.bookable++;
      else if (isLotteryOpen(slot)) m.lottery++;
      else if (slot.status === 'vacant') m.pending++;
    }
  }
  return [...months.values()].map((m) => ({
    ...m,
    label:
      m.bookable > 0 || m.lottery > 0
        ? [m.bookable && `申込可 ${m.bookable}コマ`, m.lottery && `抽選 ${m.lottery}コマ`]
            .filter(Boolean)
            .join(' / ')
        : m.pending > 0
          ? `受付開始前（空き ${m.pending}コマ）`
          : m.closed === m.days
            ? '申込期間外'
            : '空きなし',
  }));
}

/**
 * 端末向けの表。
 * @param {object} result scan() の戻り値
 * @param {{all?: boolean, color?: boolean}} [opts] all=true で満杯の日も表示
 */
export function renderTable(result, { all = false, color = process.stdout.isTTY } = {}) {
  const c = paint(color);
  const cols = slotColumns(result.days);
  const out = [];

  const { facility, range } = result;
  out.push(
    c(C.bold, `${facility.name} ${facility.objects.join('/')}`) +
      c(C.dim, `  ${range.from} 〜 ${range.to}`),
  );
  out.push(c(C.dim, `取得: ${formatJst(result.fetchedAt)}`));
  out.push('');
  const summary = monthSummary(result.days);
  for (const m of summary) {
    const hot = m.bookable > 0 || m.lottery > 0;
    out.push(
      c(C.dim, `  ${m.month.slice(5)}月 `) +
        (hot ? c(C.green, m.label) : c(C.dim, m.label)) +
        c(C.dim, `  (${m.days}日)`),
    );
  }
  out.push('');

  if (cols.length === 0) {
    out.push(c(C.dim, '  この期間に空き・抽選のコマはありません。'));
    return out.join('\n');
  }

  const W = 6; // 1列の幅（"抽10" まで収まる）
  const LABEL_W = 9; // "09/07 月 " ぶん
  const pad = (s, w = W) => ' '.repeat(Math.max(0, w - displayWidth(s))) + s;
  const padEnd = (s, w) => s + ' '.repeat(Math.max(0, w - displayWidth(s)));

  const head1 = ' '.repeat(LABEL_W) + cols.map((s) => pad(s.frame)).join('');
  const head2 = ' '.repeat(LABEL_W) + cols.map((s) => pad(hhmm(s.from))).join('');
  out.push(c(C.dim, head1));
  out.push(c(C.dim, head2));

  const skipped = [];
  // ボードと同じく、受付開始前の月は「未」を並べず1行にたたむ。
  const pendingMonths = new Set(
    summary.filter((m) => m.bookable === 0 && m.lottery === 0 && m.pending > 0).map((m) => m.month),
  );
  const foldedShown = new Set();
  for (const day of result.days) {
    const month = day.date.slice(0, 7);
    if (!all && pendingMonths.has(month)) {
      if (!foldedShown.has(month)) {
        foldedShown.add(month);
        const info = summary.find((m) => m.month === month);
        out.push(
          padEnd(`${Number(month.slice(5))}月`, LABEL_W) +
            c(C.dim, `受付開始前 ${info.days}日分（--all で全日表示）`),
        );
      }
      continue;
    }
    if (day.slots.length === 0) {
      if (!all) {
        skipped.push(day);
        continue;
      }
    }
    const wd = weekdayJa(day.date);
    const isWeekend = day.weekday === 0 || day.weekday === 6 || day.isHoliday;
    const label = padEnd(`${day.date.slice(5).replace('-', '/')} ${wd}`, LABEL_W);
    const head = isWeekend ? c(C.cyan, label) : label;

    if (day.slots.length === 0) {
      const meta = DAY_STATUS[day.dayStatus];
      out.push(head + c(C.dim, meta?.label ?? day.dayStatus));
      continue;
    }

    const cells = cols.map((col) => {
      const slot = day.slots.find((s) => s.from === col.from && s.to === col.to);
      const text = pad(slotSymbol(slot));
      if (!slot) return text;
      const cls = slotClass(slot);
      // 申込ゼロの抽選コマは狙い目なので、空きと同じ色で目立たせる。
      const code = cls === 'lot' && slot.lotApplications === 0 ? C.green : TERM_COLOR[cls];
      return c(code, text);
    });
    out.push(head + cells.join(''));
  }

  if (skipped.length > 0) {
    const byStatus = {};
    for (const d of skipped) byStatus[d.dayStatus] = (byStatus[d.dayStatus] ?? 0) + 1;
    const summary = Object.entries(byStatus)
      .map(([s, n]) => `${DAY_STATUS[s]?.label ?? s} ${n}日`)
      .join(' / ');
    out.push('');
    out.push(c(C.dim, `  ほか ${skipped.length}日: ${summary}   （--all で全日表示）`));
  }

  const pending = result.days.reduce(
    (n, d) => n + d.slots.filter((s) => s.status === 'vacant' && s.disabled).length,
    0,
  );

  out.push('');
  out.push(
    c(C.dim, '凡例: ') +
      c(C.green + C.bold, '○') +
      c(C.dim, ' 今すぐ申込可  × 空きなし  ') +
      c(C.yellow, '抽N') +
      c(C.dim, ' 抽選(申込N件)  未 空きだが受付前  公 公用  · 期間外  休 休館'),
  );
  if (pending > 0) {
    out.push(
      c(C.dim, `      「未」の ${pending} コマは場所は空いていますが、まだ受付が始まっていません。`),
    );
  }
  return out.join('\n');
}

const esc = (s) =>
  String(s).replace(
    /[&<>"]/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch],
  );


// ---------------------------------------------------------------------------
// 共有用の HTML ボード。
//
// 表ではなく「1日 = 6:30〜20:30 の帯」として描く。コマは 2 時間ごとに隙間なく
// 並んでいるので、格子より時間割そのものに近い形になり、空きが目に飛び込む。
// 外部リソースなし・単体で完結（Artifact / LAN 配信 / ローカル保存の共通出力）。
// ---------------------------------------------------------------------------

const FRAME_TITLE = {
  ok: '今すぐ申込めます',
  lot: '抽選申込ができます',
  pending: '空いていますが受付開始前です',
  no: '空きなし',
  na: '申込期間外 / 休館',
};

function segments(day, cols) {
  return cols.map((col) => {
    if (day.slots.length === 0) {
      const cls = day.dayStatus === 'full' ? 'no' : 'na';
      return { cls, label: '', title: DAY_STATUS[day.dayStatus]?.label ?? '', col };
    }
    const slot = day.slots.find((s) => s.from === col.from && s.to === col.to);
    if (!slot) return { cls: 'na', label: '', title: '', col };
    const cls = slotClass(slot);
    const label = cls === 'ok' ? hhmm(slot.from) : cls === 'lot' ? String(slot.lotApplications) : '';
    const title =
      cls === 'lot'
        ? `${hhmm(slot.from)}–${hhmm(slot.to)} 抽選 申込${slot.lotApplications}件`
        : `${hhmm(slot.from)}–${hhmm(slot.to)} ${FRAME_TITLE[cls] ?? ''}`;
    return { cls, label, title, col, cold: cls === 'lot' && slot.lotApplications === 0 };
  });
}

/**
 * @param {object} result scan() の戻り値
 * @param {{refreshSeconds?: number, live?: boolean, fragment?: boolean, note?: string}} [opts]
 *   live=true なら「自動更新中」と表示する（LAN 配信用）。
 *   fragment=true なら doctype と meta を出さない（head を自前で持つ配信先向け）。
 *   note を渡すとフッターに一行添える。
 */
export function renderHtml(result, { refreshSeconds = 0, live = false, fragment = false, note = '' } = {}) {
  const cols = slotColumns(result.days);
  const { facility, range } = result;

  const bookable = result.days.flatMap((d) => d.slots.filter(isBookable).map((s) => ({ d, s })));
  const lotOpen = result.days.flatMap((d) => d.slots.filter(isLotteryOpen).map((s) => ({ d, s })));
  const pending = result.days.reduce(
    (n, d) => n + d.slots.filter((s) => s.status === 'vacant' && s.disabled).length,
    0,
  );
  const bestLot = [...lotOpen]
    .sort((a, b) => a.s.lotApplications - b.s.lotApplications || a.d.date.localeCompare(b.d.date))
    .slice(0, 8);

  const when = ({ d, s }) =>
    `<b>${d.date.slice(5).replace('-', '/')}</b><i>${weekdayJa(d.date)}</i>${hhmm(s.from)}–${hhmm(s.to)}`;

  // まだ受付が始まっていない月は、日ごとに並べても押せるコマが1つも無い。
  // 30行の斜線を出しても情報量が増えないので、1行にたたんで理由だけ書く。
  const pendingMonths = new Set(
    monthSummary(result.days)
      .filter((m) => m.bookable === 0 && m.lottery === 0 && m.pending > 0)
      .map((m) => m.month),
  );

  const renderDay = (day) => {
      const rest = day.weekday === 0 || day.weekday === 6 || day.isHoliday;
      const open = day.slots.some((s) => isBookable(s) || isLotteryOpen(s));
      const cls = [rest ? 'rest' : '', open ? 'open' : 'shut', day.weekday === 0 || day.isHoliday ? 'sun' : day.weekday === 6 ? 'sat' : '']
        .filter(Boolean)
        .join(' ');
      const segs = segments(day, cols)
        .map(
          (g) =>
            `<span class="seg ${g.cls}${g.cold ? ' cold' : ''}" title="${esc(g.title)}">${esc(g.label)}</span>`,
        )
        .join('');
      return `<div class="row ${cls}"><div class="date"><b>${day.date
        .slice(5)
        .replace('-', '/')}</b><i>${weekdayJa(day.date)}</i>${
        day.isHoliday ? '<u>祝</u>' : ''
      }</div><div class="strip">${segs}</div></div>`;
  };

  const rows = [];
  const seenPending = new Set();
  for (const day of result.days) {
    const month = day.date.slice(0, 7);
    if (pendingMonths.has(month)) {
      if (seenPending.has(month)) continue;
      seenPending.add(month);
      const info = monthSummary(result.days).find((m) => m.month === month);
      rows.push(
        `<div class="row folded"><div class="date"><b>${Number(month.slice(5))}月</b></div>` +
          `<div class="fold">受付開始前 — ${info.days}日分 ${info.pending}コマが空いていますが、` +
          `まだ申込めません。受付が始まると通知します。</div></div>`,
      );
      continue;
    }
    rows.push(renderDay(day));
  }

  const head = fragment
    ? ''
    : `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
${refreshSeconds > 0 ? `<meta http-equiv="refresh" content="${refreshSeconds}">` : ''}`;

  return `${head}
<title>${esc(facility.name)} 空き状況</title>
<style>
  :root {
    --ground:#f6f7f9; --surface:#ffffff; --ink:#171a21; --muted:#6b7280; --hair:#e2e6ec;
    --indigo:#22406e; --ok:#0e7a45; --ok-fill:#d6efe0; --lot:#8a5c00; --lot-fill:#f8ecce;
    --taken:#ced3db; --dormant:#e9ecf1; --rest:#f0f3f8;
    --sans:"Hiragino Sans","Noto Sans JP",-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
    --mono:ui-monospace,"SF Mono",Menlo,Consolas,monospace;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --ground:#111319; --surface:#181b23; --ink:#e6eaf0; --muted:#8b93a1; --hair:#272c36;
      --indigo:#8aabdd; --ok:#4ec081; --ok-fill:#123724; --lot:#d9a63f; --lot-fill:#3a2e12;
      --taken:#333944; --dormant:#20242c; --rest:#1c202a;
    }
  }
  :root[data-theme="dark"] {
    --ground:#111319; --surface:#181b23; --ink:#e6eaf0; --muted:#8b93a1; --hair:#272c36;
    --indigo:#8aabdd; --ok:#4ec081; --ok-fill:#123724; --lot:#d9a63f; --lot-fill:#3a2e12;
    --taken:#333944; --dormant:#20242c; --rest:#1c202a;
  }
  :root[data-theme="light"] {
    --ground:#f6f7f9; --surface:#ffffff; --ink:#171a21; --muted:#6b7280; --hair:#e2e6ec;
    --indigo:#22406e; --ok:#0e7a45; --ok-fill:#d6efe0; --lot:#8a5c00; --lot-fill:#f8ecce;
    --taken:#ced3db; --dormant:#e9ecf1; --rest:#f0f3f8;
  }

  * { box-sizing:border-box; }
  body { margin:0; padding:32px 24px 64px; background:var(--ground); color:var(--ink);
         font-family:var(--sans); font-size:14px; line-height:1.55;
         -webkit-font-smoothing:antialiased; }
  .page { max-width:960px; margin:0 auto; display:flex; flex-direction:column; gap:28px; }

  header { display:flex; flex-wrap:wrap; gap:16px; align-items:flex-end;
           justify-content:space-between; border-bottom:2px solid var(--indigo); padding-bottom:14px; }
  h1 { margin:0; font-size:26px; font-weight:700; letter-spacing:-0.02em; text-wrap:balance; }
  h1 small { display:block; font-size:13px; font-weight:500; color:var(--muted); letter-spacing:0; margin-top:3px; }
  .stamp { font-family:var(--mono); font-size:12px; color:var(--muted); text-align:right;
           font-variant-numeric:tabular-nums; }
  .stamp .live { color:var(--ok); font-weight:600; }

  .stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:12px; }
  .stat { background:var(--surface); border:1px solid var(--hair); border-radius:6px;
          padding:14px 16px; display:flex; flex-direction:column; gap:2px; }
  .stat b { font-family:var(--mono); font-size:30px; font-weight:700; line-height:1;
            font-variant-numeric:tabular-nums; }
  .stat span { font-size:12px; color:var(--muted); }
  .stat.s-ok b { color:var(--ok); }
  .stat.s-ok { border-left:3px solid var(--ok); }
  .stat.s-lot b { color:var(--lot); }
  .stat.s-lot { border-left:3px solid var(--lot); }
  .stat.s-dorm b { color:var(--muted); }

  /* 月ごとの要約。満杯の月は表から折り畳まれて消えるので、
     「取れていない」のか「取れる枠が無い」のかをここで示す。 */
  .months { display:flex; flex-wrap:wrap; gap:8px; }
  .month { display:flex; align-items:baseline; gap:8px; padding:6px 12px; border-radius:4px;
           background:var(--surface); border:1px solid var(--hair); font-size:12px; }
  .month b { font-family:var(--mono); font-size:13px; }
  .month span { color:var(--muted); }
  .month.hot { border-color:var(--ok); }
  .month.hot span { color:var(--ok); font-weight:600; }
  .month.warm { border-color:var(--lot); }
  .month.warm span { color:var(--lot); font-weight:600; }

  .picks { display:grid; grid-template-columns:repeat(auto-fit,minmax(280px,1fr)); gap:20px; }
  .pick h2 { margin:0 0 8px; font-size:11px; font-weight:700; letter-spacing:.09em;
             text-transform:uppercase; color:var(--muted); }
  .pick ul { margin:0; padding:0; list-style:none; display:flex; flex-direction:column; gap:1px; }
  .pick li { font-family:var(--mono); font-size:13px; font-variant-numeric:tabular-nums;
             padding:3px 0; border-bottom:1px solid var(--hair); }
  .pick li b { font-weight:700; }
  .pick li i { font-style:normal; color:var(--muted); margin:0 8px 0 6px; font-family:var(--sans); }
  .pick li em { font-style:normal; color:var(--muted); margin-left:8px; font-family:var(--sans); font-size:12px; }
  .pick .none { color:var(--muted); font-size:13px; }
  .pick.p-ok li b { color:var(--ok); }

  .filters { display:flex; gap:8px; flex-wrap:wrap; align-items:center; }
  .filters button { font:inherit; font-size:12px; padding:5px 12px; border-radius:999px;
                    border:1px solid var(--hair); background:var(--surface); color:var(--muted);
                    cursor:pointer; }
  .filters button:hover { border-color:var(--indigo); color:var(--ink); }
  .filters button[aria-pressed="true"] { background:var(--indigo); border-color:var(--indigo);
                                         color:var(--surface); font-weight:600; }
  .filters button:focus-visible { outline:2px solid var(--indigo); outline-offset:2px; }

  .board { background:var(--surface); border:1px solid var(--hair); border-radius:6px;
           overflow-x:auto; }
  .inner { min-width:600px; }
  .ruler { display:grid; grid-template-columns:88px 1fr; position:sticky; top:0; z-index:2;
           background:var(--surface); border-bottom:1px solid var(--hair); }
  .ruler .ticks { display:grid; grid-template-columns:repeat(${cols.length},1fr); }
  .ruler .ticks span { font-family:var(--mono); font-size:11px; color:var(--muted);
                       padding:8px 0 7px; text-align:center; border-left:1px solid var(--hair);
                       font-variant-numeric:tabular-nums; }
  .ruler .corner { padding:8px 12px; font-size:11px; color:var(--muted); letter-spacing:.06em; }

  .row { display:grid; grid-template-columns:88px 1fr; border-bottom:1px solid var(--hair); }
  .row:last-child { border-bottom:0; }
  .row.rest { background:var(--rest); }
  .date { font-family:var(--mono); font-size:12px; padding:0 10px; display:flex; align-items:center;
          gap:5px; font-variant-numeric:tabular-nums; }
  .date i { font-style:normal; font-family:var(--sans); color:var(--muted); }
  .date u { text-decoration:none; font-family:var(--sans); font-size:10px; color:var(--lot); }
  .row.sat .date i { color:#3b82f6; }
  .row.sun .date i, .row.sun .date u { color:#e05252; }

  .strip { display:grid; grid-template-columns:repeat(${cols.length},1fr); gap:1px;
           padding:3px 3px 3px 0; }
  .seg { display:flex; align-items:center; justify-content:center; height:26px; border-radius:2px;
         font-family:var(--mono); font-size:11px; font-weight:700; font-variant-numeric:tabular-nums; }
  .seg.no { background:var(--taken); }
  .seg.na { background:transparent; border:1px dashed var(--hair); }
  /* 空いてはいるが受付前。明度差だけだと「空きなし」と見分けがつかないので
     斜線で「空だが閉じている」ことを形で示す。 */
  .seg.pending { background:repeating-linear-gradient(-45deg,
                   var(--dormant) 0 3px, transparent 3px 6px);
                 box-shadow:inset 0 0 0 1px var(--dormant); }
  .seg.ok { background:var(--ok-fill); color:var(--ok); box-shadow:inset 0 0 0 1px var(--ok); }
  .seg.lot { background:var(--lot-fill); color:var(--lot); }
  .seg.lot.cold { box-shadow:inset 0 0 0 1px var(--lot); }

  .row.folded { background:var(--ground); }
  .fold { display:flex; align-items:center; padding:10px 12px; font-size:12px; color:var(--muted); }
  body.f-rest .row:not(.rest):not(.folded) { display:none; }
  body.f-open .row.shut { display:none; }

  footer { display:flex; flex-direction:column; gap:10px; font-size:12px; color:var(--muted); }
  .legend { display:flex; flex-wrap:wrap; gap:6px 18px; align-items:center; }
  .legend span { display:inline-flex; align-items:center; gap:6px; }
  .key { width:22px; height:13px; border-radius:2px; display:inline-block; }
  .key.ok { background:var(--ok-fill); box-shadow:inset 0 0 0 1px var(--ok); }
  .key.lot { background:var(--lot-fill); }
  .key.pending { background:repeating-linear-gradient(-45deg,
                   var(--dormant) 0 3px, transparent 3px 6px);
                 box-shadow:inset 0 0 0 1px var(--dormant); }
  .key.no { background:var(--taken); }
  footer a { color:var(--indigo); }
  @media (prefers-reduced-motion: reduce) { * { transition:none !important; animation:none !important; } }
</style>
<div class="page">
  <header>
    <h1>${esc(facility.name)}<small>${esc(facility.objects.join(' / '))} ・ ${esc(
      (facility.description || '').split('に利用')[0],
    )}</small></h1>
    <div class="stamp">${
      live ? '<span class="live">● 自動更新中</span><br>' : ''
    }取得 ${esc(formatJst(result.fetchedAt))}<br>${esc(range.from)} → ${esc(range.to)}</div>
  </header>

  <section class="stats">
    <div class="stat s-ok"><b>${bookable.length}</b><span>今すぐ申込めるコマ</span></div>
    <div class="stat s-lot"><b>${lotOpen.length}</b><span>抽選で申込めるコマ</span></div>
    <div class="stat s-dorm"><b>${pending}</b><span>受付開始前の空き</span></div>
  </section>

  <section class="months">
    ${monthSummary(result.days)
      .map(
        (m) =>
          `<div class="month${m.bookable > 0 ? ' hot' : m.lottery > 0 ? ' warm' : ''}">
        <b>${esc(m.month.slice(5))}月</b><span>${esc(m.label)}</span></div>`,
      )
      .join('')}
  </section>

  <section class="picks">
    <div class="pick p-ok">
      <h2>今すぐ申込める</h2>
      ${
        bookable.length
          ? `<ul>${bookable.slice(0, 10).map((v) => `<li>${when(v)}</li>`).join('')}${
              bookable.length > 10
                ? `<li style="border:0;color:var(--muted)">ほか ${bookable.length - 10} 件</li>`
                : ''
            }</ul>`
          : '<p class="none">現在ありません。キャンセルが出るとここに並びます。</p>'
      }
    </div>
    <div class="pick">
      <h2>抽選 ・ 申込が少ない順</h2>
      ${
        bestLot.length
          ? `<ul>${bestLot
              .map((v) => `<li>${when(v)}<em>申込 ${v.s.lotApplications} 件</em></li>`)
              .join('')}</ul>`
          : '<p class="none">抽選申込ができるコマはありません。</p>'
      }
    </div>
  </section>

  <div class="filters">
    <button type="button" data-filter="" aria-pressed="true">すべての日</button>
    <button type="button" data-filter="f-rest" aria-pressed="false">週末・祝日</button>
    <button type="button" data-filter="f-open" aria-pressed="false">空き・抽選のある日</button>
  </div>

  <section class="board">
    <div class="inner">
      <div class="ruler">
        <div class="corner">日付</div>
        <div class="ticks">${cols
          .map((s) => `<span>${esc(hhmm(s.from))}</span>`)
          .join('')}</div>
      </div>
${rows.join('\n')}
    </div>
  </section>

  <footer>
    <div class="legend">
      <span><i class="key ok"></i>今すぐ申込める（数字は開始時刻）</span>
      <span><i class="key lot"></i>抽選申込可（数字は現在の申込件数）</span>
      <span><i class="key pending"></i>空いているが受付開始前</span>
      <span><i class="key no"></i>空きなし</span>
    </div>
    <p style="margin:0">
      各コマは 2 時間。予約は文京区「施設予約ねっと」から（団体登録が必要）。
      ${facility.guideUrl ? `<a href="${esc(facility.guideUrl)}">施設案内</a> ・ ` : ''}
      <a href="https://www.shisetsu.city.bunkyo.lg.jp/user/Home">予約サイト</a>
    </p>
    ${note ? `<p style="margin:0">${esc(note)}</p>` : ''}
  </footer>
</div>
<script>
  const buttons = [...document.querySelectorAll('.filters button')];
  buttons.forEach((btn) => btn.addEventListener('click', () => {
    document.body.classList.remove('f-rest', 'f-open');
    if (btn.dataset.filter) document.body.classList.add(btn.dataset.filter);
    buttons.forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
  }));
</script>
`;
}
