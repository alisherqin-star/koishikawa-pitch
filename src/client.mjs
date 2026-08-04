// 文京区「施設予約ねっと」の空き状況を取得するクライアント。
//
// 画面遷移はすべて axios の POST で行われ、レスポンスで次の URL が返る仕組みなので、
// ブラウザを使わずに fetch だけで同じ流れを再現できる。ログインは不要
// （空き状況は公開情報。ログインが要るのは実際の予約申込と抽選申込のみ）。

const BASE = 'https://www.shisetsu.city.bunkyo.lg.jp';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// 時間帯別画面へ一度に持ち込める日数の上限（超えると E-203-000018）。
export const MAX_DAYS_PER_DETAIL_REQUEST = 10;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** ASP.NET MVC のモデルバインダが解釈する form field 名に展開する。 */
function serialize(prefix, value, out = []) {
  if (value === null || value === undefined) return out;
  if (Array.isArray(value)) {
    value.forEach((v, i) => serialize(`${prefix}[${i}]`, v, out));
    return out;
  }
  if (typeof value === 'object') {
    for (const key of Object.keys(value)) {
      serialize(prefix ? `${prefix}.${key}` : key, value[key], out);
    }
    return out;
  }
  out.push([prefix, String(value)]);
  return out;
}

/** ページ末尾の `model: JSON.parse("…")` に埋め込まれた画面モデルを取り出す。 */
function extractModel(html) {
  const marker = 'model: JSON.parse(';
  const at = html.indexOf(marker + '"');
  if (at < 0) return null;
  let i = at + marker.length + 1;
  let literal = '';
  while (i < html.length) {
    const ch = html[i];
    if (ch === '\\') {
      literal += html[i] + html[i + 1];
      i += 2;
      continue;
    }
    if (ch === '"') break;
    literal += ch;
    i++;
  }
  return JSON.parse(JSON.parse(`"${literal}"`));
}

const antiforgeryToken = (html) =>
  (html.match(/name="__RequestVerificationToken"[^>]*value="([^"]+)"/) || [])[1];

export class SiteError extends Error {
  constructor(messageId, param) {
    super(`${messageId}${param ? ` (${param})` : ''}`);
    this.name = 'SiteError';
    this.messageId = messageId;
    this.param = param;
  }
}

export class BunkyoClient {
  #cookies = new Map();
  #token = null;
  #searchCondition = null;

  constructor({ categoryCode = 4, facilityCode, delayMs = 350 } = {}) {
    this.categoryCode = categoryCode;
    this.facilityCode = facilityCode;
    this.delayMs = delayMs;
  }

  get #cookieHeader() {
    return [...this.#cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  #absorb(res) {
    for (const cookie of res.headers.getSetCookie?.() ?? []) {
      const pair = cookie.split(';')[0];
      const eq = pair.indexOf('=');
      if (eq > 0) this.#cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }

  async #get(path) {
    await sleep(this.delayMs);
    const res = await fetch(BASE + path, {
      headers: { 'User-Agent': UA, 'Accept-Language': 'ja', Cookie: this.#cookieHeader },
    });
    this.#absorb(res);
    if (!res.ok) throw new Error(`GET ${path} -> HTTP ${res.status}`);
    return res.text();
  }

  async #post(path, fields) {
    await sleep(this.delayMs);
    const body = new FormData();
    for (const [k, v] of fields) body.append(k, String(v));
    const res = await fetch(BASE + path, {
      method: 'POST',
      headers: { 'User-Agent': UA, 'Accept-Language': 'ja', Cookie: this.#cookieHeader },
      body,
    });
    this.#absorb(res);
    if (!res.ok) throw new Error(`POST ${path} -> HTTP ${res.status}`);
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
      // Next 系は JSON 文字列を二重にくるんで返してくる。
      if (typeof json === 'string') {
        try {
          json = JSON.parse(json);
        } catch {
          /* 素の文字列（遷移先 URL）だった */
        }
      }
    } catch {
      /* HTML が返るケース */
    }
    return { text, json };
  }

  /**
   * Home → 施設種類で絞り込み → 施設選択 → 施設別空き状況、まで進める。
   * セッションに施設が保持されるので、以降は日付条件を変えるだけで再取得できる。
   */
  async connect() {
    const home = await this.#get('/user/Home');
    await this.#post('/user/Home/SearchByFacilityCategory', [
      ['facilityCategoryCode', this.categoryCode],
      ['__RequestVerificationToken', antiforgeryToken(home)],
    ]);

    const selectFacility = await this.#get('/user/AvailabilityCheckApplySelectFacility');
    const model = extractModel(selectFacility);
    const known = model?.SelectFacilities?.Facilities ?? [];
    const match = known.find((f) => String(f.SelectedFacility.Value) === String(this.facilityCode));
    if (!match) {
      const list = known.map((f) => `${f.SelectedFacility.Value}:${f.SelectedFacility.Text}`);
      throw new Error(
        `施設コード ${this.facilityCode} が見つかりません。利用可能: ${list.join(', ')}`,
      );
    }
    this.facilityName = match.SelectedFacility.Text;

    const next = await this.#post('/user/AvailabilityCheckApplySelectFacility/Next', [
      ['SelectFacilities.Selected[0]', this.facilityCode],
      ['__RequestVerificationToken', antiforgeryToken(selectFacility)],
    ]);
    if (next.json?.Result !== 'Ok') throw new SiteError(next.json?.Information);

    const days = await this.#get('/user/AvailabilityCheckApplySelectDays');
    this.#token = antiforgeryToken(days);
    this.#searchCondition = extractModel(days).SearchCondition;
    return this;
  }

  /**
   * 施設別空き状況（日単位）。1 回で最大 1 ヶ月ぶん。
   * @returns {Array<{ObjectName: string, Capacity: number, Cells: object[]}>} 室場ごとの行
   */
  async fetchMonth(startDate) {
    if (!this.#token) throw new Error('connect() を先に呼んでください');
    const condition = {
      ...this.#searchCondition,
      StartDate: `${startDate}T00:00:00`,
      DisplayTerm: 4, // 1ヶ月
    };
    const res = await this.#post('/user/AvailabilityCheckApplySelectDays/SearchCondition', [
      ...serialize('SearchCondition', condition, []),
      ['__RequestVerificationToken', this.#token],
    ]);
    const status = res.json?.[0];
    if (status?.Result !== 'Ok') throw new SiteError(status?.Information);
    this.lastDayModel = res.json[1].AvailabilitySelectDays;
    return this.lastDayModel;
  }

  /**
   * 時間帯別空き状況。指定した日のコマ単位データを返す。
   *
   * 上限の 10 は「日数」ではなく「チェックしたセル数」に効くので、対象室場を絞らずに
   * 呼ぶと（小石川なら グラウンド と 会議室 の 2 行ぶん）半分の日数で上限に当たる。
   *
   * @param {string[]} objectNames 対象室場名。空なら全室場。
   */
  async fetchSlots(startDate, dates, objectNames = []) {
    if (dates.length === 0) return [];
    // 直前の SearchCondition の結果を土台にする（セッション状態も同時に巻き戻る）。
    const dayModel = structuredClone(await this.fetchMonth(startDate));
    const wanted = new Set(dates);
    const targets = new Set(objectNames);
    let checked = 0;
    for (const facility of dayModel) {
      for (const row of facility.Rows) {
        if (targets.size > 0 && !targets.has(row.ObjectName)) continue;
        for (const cell of row.Cells) {
          if (wanted.has(cell.UseDate.slice(0, 10)) && !cell.Disabled) {
            cell.IsChecked = true;
            checked++;
          }
        }
      }
    }
    if (checked === 0) return [];
    if (checked > MAX_DAYS_PER_DETAIL_REQUEST) {
      throw new Error(
        `選択コマ数 ${checked} が上限 ${MAX_DAYS_PER_DETAIL_REQUEST} を超えています ` +
          `(${dates.length}日 × 室場${targets.size || '全'})`,
      );
    }

    const condition = {
      ...this.#searchCondition,
      StartDate: `${startDate}T00:00:00`,
      DisplayTerm: 4,
    };
    const res = await this.#post('/user/AvailabilityCheckApplySelectDays/Next', [
      ...serialize('SearchCondition', condition, []),
      ...serialize('AvailabilitySelectDays', dayModel, []),
      ['__RequestVerificationToken', this.#token],
    ]);
    if (res.json?.Result !== 'Ok') {
      throw new SiteError(res.json?.Information?.MessageId, res.json?.Information?.Param);
    }

    const html = await this.#get('/user/AvailabilityCheckApplySelectTime');
    const model = extractModel(html);
    const facility = model?.AvailabilityTime?.FacilityList?.[0];
    this.facilityDescription = facility?.FacilityDescription ?? '';
    this.facilityGuideUrl = facility?.FacilityGuideUrl ?? '';
    return facility?.Tables ?? [];
  }
}
