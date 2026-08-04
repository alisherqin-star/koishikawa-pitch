#!/usr/bin/env node
// 常駐して定期的に空き状況を取得し、新しく空いたコマ／抽選申込が可能になったコマを通知する。
//
//   node bin/watch.mjs                 config.json の intervalMinutes 間隔で監視
//   node bin/watch.mjs --interval 15   間隔を上書き（分）
//   node bin/watch.mjs --once          1回だけ実行して終了（cron / launchd 向け）
//   node bin/watch.mjs --reset         状態ファイルを捨てて基準を取り直す

import { readFile, writeFile, unlink } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scan } from '../src/scan.mjs';
import { renderHtml } from '../src/format.mjs';
import {
  snapshot,
  loadState,
  saveState,
  diff,
  changedDays,
  describeEvent,
  summarizeEvents,
  inQuietHours,
} from '../src/monitor.mjs';
import { isBookable, isLotteryOpen } from '../src/model.mjs';
import { dispatch, appendLog } from '../src/notify.mjs';
import { writePage, pushPage } from '../src/publish.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const value = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

const config = JSON.parse(await readFile(resolve(root, 'config.json'), 'utf8'));
if (value('interval')) config.intervalMinutes = Number(value('interval'));
const statePath = resolve(root, config.statePath ?? 'state.json');
const logPath = resolve(root, config.logPath ?? 'watch.log');

if (flag('reset')) {
  await unlink(statePath).catch(() => {});
  console.log('状態をリセットしました。');
}

const stamp = () => new Date().toLocaleTimeString('ja-JP');
const say = (msg) => console.log(`[${stamp()}] ${msg}`);

async function runOnce() {
  const previous = await loadState(statePath);
  const result = await scan(config, (m) => say(m));
  const events = diff(previous, result, config);

  if (config.reportPath) {
    await writeFile(
      resolve(root, config.reportPath),
      renderHtml(result, { refreshSeconds: (config.intervalMinutes ?? 30) * 60 }),
      'utf8',
    );
  }
  if (config.publish?.path) {
    const page = resolve(root, config.publish.path);
    await writePage(page, result, {
      note: `${config.intervalMinutes ?? 30}分ごとに自動更新しています。申込は必ず予約サイトで最新の状況を確認してください。`,
    });
    if (config.publish.git) {
      const at = new Date().toISOString().replace('T', ' ').slice(0, 16);
      await pushPage(root, config.publish.path, `空き状況 ${at}`)
        .then((r) => say(`公開: ${r}`))
        .catch((e) => say(`公開に失敗: ${e.message.split('\n')[0]}`));
    }
  }
  await saveState(statePath, snapshot(result));

  // 受付開始前の「空き」は数に入れない（今すぐ動ける件数だけを出す）。
  const bookable = result.days.reduce((n, d) => n + d.slots.filter(isBookable).length, 0);
  const lottery = result.days.reduce((n, d) => n + d.slots.filter(isLotteryOpen).length, 0);
  const tally = `申込可 ${bookable} コマ / 抽選申込可 ${lottery} コマ`;

  if (previous === null) {
    say(`初回スキャン完了。${tally}。ここを基準に、次回以降の変化を通知します。`);
    await appendLog(logPath, `baseline: ${tally}`);
    return;
  }

  if (events.length === 0) {
    say(`変化なし（${tally}）`);
    return;
  }

  const lines = events.map(describeEvent);
  for (const line of lines) say(`★ ${line}`);
  await appendLog(logPath, events.map((e) => `${e.type} ${describeEvent(e)}`).join(' | '));

  if (inQuietHours(config.quietHours)) {
    say(`（静音時間帯のため通知は送りません）`);
    return;
  }

  // 受付が月単位で開くと一度に百件超えるので、多いときは要約に切り替える。
  const BULK = 8;
  const message =
    events.length >= BULK
      ? summarizeEvents(events, result.facility.name)
      : {
          title: `${result.facility.name} に空きが出ました`,
          body: lines.join('\n'),
        };

  const errors = await dispatch(config, {
    ...message,
    subtitle: `${events.length} 件の変化`,
    payload: {
      events: events.map((e) => ({ type: e.type, date: e.day.date, from: e.slot.from, to: e.slot.to })),
    },
  });
  for (const err of errors) say(`通知失敗 ${err}`);
}

/**
 * 速い経路。日単位のステータスだけ見て、監視対象の日が満杯から動いていたら
 * true を返す（そのとき呼び出し側が全件走査に切り替える）。
 * キャンセルは数分で拾われてしまうので、この軽い巡回を短い間隔で回す。
 */
async function quickPoll() {
  const previous = await loadState(statePath);
  if (previous === null) return true; // 基準がなければ全件走査へ
  const result = await scan(config, () => {}, {
    detail: false,
    daysAhead: config.quickDaysAhead ?? config.daysAhead,
  });
  const hits = changedDays(previous, result, config);
  if (hits.length === 0) return false;
  say(`変化を検知: ${hits.join(', ')} — 詳細を確認します`);
  return true;
}

async function main() {
  if (flag('once')) {
    await runOnce();
    return;
  }
  const fullEvery = (config.intervalMinutes ?? 30) * 60_000;
  const quickEvery = (config.quickIntervalMinutes ?? 5) * 60_000;
  const watched = config.notifyOn?.weekdays ?? [];
  say(
    `監視開始: ${config.facility.name}` +
      `${watched.length ? ` / 対象曜日 ${watched.map((d) => '日月火水木金土'[d]).join('')}+祝` : ''}` +
      ` / 全件 ${config.intervalMinutes ?? 30}分・巡回 ${config.quickIntervalMinutes ?? 5}分 / Ctrl+C で終了`,
  );

  let lastFull = 0;
  for (;;) {
    try {
      const dueForFull = Date.now() - lastFull >= fullEvery;
      if (dueForFull || (await quickPoll())) {
        await runOnce();
        lastFull = Date.now();
      }
    } catch (e) {
      say(`エラー: ${e.message}`);
      await appendLog(logPath, `error: ${e.stack ?? e.message}`);
    }
    await new Promise((r) => setTimeout(r, quickEvery));
  }
}

await main();
