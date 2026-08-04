#!/usr/bin/env node
// 1回だけ空き状況を取得して、端末に表を出し HTML レポートを書き出す。
//
//   node bin/check.mjs            空き・抽選のある日だけ表示
//   node bin/check.mjs --all      全日表示
//   node bin/check.mjs --days 90  期間を上書き
//   node bin/check.mjs --json     生データを JSON で出力

import { readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scan } from '../src/scan.mjs';
import { renderTable, renderHtml } from '../src/format.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const value = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

const config = JSON.parse(await readFile(resolve(root, 'config.json'), 'utf8'));
if (value('days')) config.daysAhead = Number(value('days'));

const verbose = !flag('json');
const result = await scan(config, (m) => verbose && console.error(m));

if (flag('json')) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log();
  console.log(renderTable(result, { all: flag('all') }));
}

if (config.reportPath) {
  const path = resolve(root, config.reportPath);
  await writeFile(path, renderHtml(result), 'utf8');
  if (verbose) console.error(`\nレポート: ${path}`);
}
