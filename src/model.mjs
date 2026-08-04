// サイトが返すステータス語彙と、日付まわりの小さなヘルパー。

/** 施設別空き状況（日単位）のステータス。凡例の並びに対応。 */
export const DAY_STATUS = {
  vacant: { label: '空き', symbol: '○', detail: true },
  some: { label: '一部空き', symbol: '△', detail: true },
  full: { label: '空きなし', symbol: '×', detail: false },
  lot: { label: '抽選', symbol: '抽', detail: true },
  'time-over': { label: '申込期間外', symbol: '·', detail: false },
  closed: { label: '公開対象外', symbol: '-', detail: false },
};

/** 時間帯別空き状況（コマ単位）のステータス。 */
export const SLOT_STATUS = {
  vacant: { label: '空き', symbol: '○' },
  full: { label: '空きなし', symbol: '×' },
  lot: { label: '抽選', symbol: '抽' },
  official: { label: '公用', symbol: '公' },
  'time-over': { label: '申込期間外', symbol: '·' },
  closed: { label: '休館', symbol: '休' },
};

// サイトの Status だけでは「今すぐ申込めるか」は分からない。受付期間前の日は
// Status='vacant'（場所は空いている）のまま Disabled=true になる。
// IsVacant は常に false で返ってくるため判定に使えない。
export const isBookable = (slot) => slot.status === 'vacant' && !slot.disabled;
export const isLotteryOpen = (slot) => slot.status === 'lot' && !slot.disabled;

/** 表示記号。空きでも受付前なら「未」として先着可能な ○ と区別する。 */
export function slotSymbol(slot) {
  if (!slot) return '';
  if (slot.status === 'lot') return slot.disabled ? '抽-' : `抽${slot.lotApplications}`;
  if (slot.status === 'vacant') return slot.disabled ? '未' : '○';
  return SLOT_STATUS[slot.status]?.symbol ?? '?';
}

/** 表示上の分類。色分けと CSS クラスの両方で使う。 */
export function slotClass(slot) {
  if (!slot) return 'na';
  if (isBookable(slot)) return 'ok';
  if (isLotteryOpen(slot)) return 'lot';
  if (slot.status === 'vacant') return 'pending';
  if (slot.status === 'full') return 'no';
  return 'na';
}

/** 詳細（コマ単位）を取りに行く価値がある日か。 */
export const needsDetail = (dayStatus) => DAY_STATUS[dayStatus]?.detail === true;

const WEEKDAY_JA = ['日', '月', '火', '水', '木', '金', '土'];

// dateStr はすでに JST のカレンダー日付なので、UTC 正午として解釈して
// getUTCDay() を読む。実行環境の TZ にもオフセット計算にも左右されない。
const asUtc = (dateStr) => new Date(`${dateStr}T12:00:00Z`);

/** 曜日番号（0=日 … 6=土）。 */
export const weekdayOf = (dateStr) => asUtc(dateStr).getUTCDay();
export const weekdayJa = (dateStr) => WEEKDAY_JA[weekdayOf(dateStr)];

/**
 * 取得時刻を JST で表示する。GitHub Actions の runner は UTC なので、
 * toLocaleString('ja-JP') だけだと言語が変わるだけで時刻が 9 時間ずれる。
 */
export function formatJst(iso) {
  const parts = new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(iso));
  return `${parts} JST`;
}

/** 日本時間の「今日」を YYYY-MM-DD で返す。実行環境の TZ に依存しない。 */
export function todayJst() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

export function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** 630 -> "6:30" / 2030 -> "20:30" */
export const hhmm = (n) => `${Math.floor(n / 100)}:${String(n % 100).padStart(2, '0')}`;

/** サイトの時刻表記（HHMM 整数）を比較しやすい分に直す。 */
export const toMinutes = (n) => Math.floor(n / 100) * 60 + (n % 100);

/** 一意なコマ ID。差分検出のキーに使う。 */
export const slotKey = (date, from, to) => `${date} ${from}-${to}`;
