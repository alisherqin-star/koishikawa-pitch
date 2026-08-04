#!/usr/bin/env node
// 通知経路の疎通確認。実際の空き状況とは無関係のテストメッセージを送る。
//
//   node bin/test-notify.mjs
//   KOISHIKAWA_WEBHOOK_URL='https://...' node bin/test-notify.mjs
//
// Webhook URL は認証情報なので、この画面には全体を出さない。

import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { notifyMacos, notifyWebhook, webhookUrlFrom, webhookPayload } from '../src/notify.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(await readFile(resolve(root, 'config.json'), 'utf8'));

const message = {
  title: `${config.facility.name} 通知テスト`,
  subtitle: '疎通確認',
  body: '09/12(土) 8:30–10:30 空きが出ました\n（これはテストです。実際の空き状況ではありません）',
  payload: { test: true },
};

if (config.notify?.macos && process.platform === 'darwin') {
  await notifyMacos({ ...message, sound: config.notify.sound ? 'Glass' : null })
    .then(() => console.log('macOS 通知: 送信しました（通知センターを確認してください）'))
    .catch((e) => console.log(`macOS 通知: 失敗 ${e.message}`));
} else {
  console.log('macOS 通知: 無効');
}

const url = webhookUrlFrom(config);
if (!url) {
  console.log('Webhook: 未設定');
  console.log('  config.json の notify.webhookUrl に入れるか、環境変数 KOISHIKAWA_WEBHOOK_URL で渡してください。');
  console.log('  Discord: サーバー設定 → 連携サービス → ウェブフック → 新しいウェブフック');
  console.log('  Slack  : api.slack.com/apps → Incoming Webhooks');
  process.exit(0);
}

const host = (() => {
  try {
    return new URL(url).hostname;
  } catch {
    return '(URL として解釈できません)';
  }
})();
const shape = Object.keys(webhookPayload(url, message)).join(', ');
console.log(`Webhook: ${host} 宛（送る形: ${shape}）`);

await notifyWebhook(url, message)
  .then(() => console.log('Webhook: 送信しました。チャンネルを確認してください。'))
  .catch((e) => {
    console.log(`Webhook: 失敗 ${e.message}`);
    console.log('  401/404 なら URL が間違っているか無効化されています。');
    console.log('  400 なら送信先の判定が外れています（ホスト名を確認してください）。');
    process.exitCode = 1;
  });
