#!/usr/bin/env node
// 公開ページ（docs/index.html）だけを作る。通知も状態ファイルも触らない。
// GitHub Actions から呼ぶ用。commit と push はワークフロー側の仕事。
//
//   node bin/build-page.mjs

import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scan } from '../src/scan.mjs';
import { writePage } from '../src/publish.mjs';
import { isBookable, isLotteryOpen } from '../src/model.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Actions のチェックアウトには config.json（個人設定なので追跡外）が無い。
const configPath = await readFile(resolve(root, 'config.json'), 'utf8').catch(() =>
  readFile(resolve(root, 'config.example.json'), 'utf8'),
);
const config = JSON.parse(configPath);

const result = await scan(config, (m) => console.log(m));
const out = resolve(root, config.publish?.path ?? 'docs/index.html');

await writePage(out, result, {
  note: '30分ごとに GitHub Actions が自動更新しています。申込は必ず予約サイトで最新の状況を確認してください。',
});

const bookable = result.days.reduce((n, d) => n + d.slots.filter(isBookable).length, 0);
const lottery = result.days.reduce((n, d) => n + d.slots.filter(isLotteryOpen).length, 0);
console.log(`書き出し: ${out}`);
console.log(`申込可 ${bookable} コマ / 抽選申込可 ${lottery} コマ`);
