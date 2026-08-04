// 通知の出口。macOS の通知センター、任意の Webhook、ログファイル。

import { execFile } from 'node:child_process';
import { appendFile } from 'node:fs/promises';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * macOS の通知センターに出す。
 * AppleScript のリテラルに値を埋め込まず argv 経由で渡すので、
 * 施設名などに引用符が入っていても壊れない。
 */
export async function notifyMacos({ title, subtitle, body, sound }) {
  const script = [
    'on run argv',
    'display notification (item 1 of argv) with title (item 2 of argv)' +
      ' subtitle (item 3 of argv)' +
      (sound ? ' sound name (item 4 of argv)' : ''),
    'end run',
  ];
  const args = script.flatMap((line) => ['-e', line]);
  await run('osascript', [...args, body, title, subtitle ?? '', sound || 'Glass']);
}

const BOOKING_URL = 'https://www.shisetsu.city.bunkyo.lg.jp/user/Home';

/**
 * 送り先ごとに受け付ける形が違う。Discord は `content`（余計なキーがあると 400）、
 * Slack は `text`。判別できない相手には両方入れた汎用の形を送る。
 * @returns {object} JSON ボディ
 */
export function webhookPayload(url, { title, body, payload }) {
  const host = (() => {
    try {
      return new URL(url).hostname;
    } catch {
      return '';
    }
  })();
  const text = `**${title}**\n${body}\n${BOOKING_URL}`;

  if (/(^|\.)discord(app)?\.com$/.test(host)) {
    return { content: text.slice(0, 2000), allowed_mentions: { parse: [] } };
  }
  if (/(^|\.)slack\.com$/.test(host)) {
    return {
      text: `${title} — ${body.split('\n')[0]}`,
      blocks: [
        { type: 'section', text: { type: 'mrkdwn', text: `*${title}*\n${body}` } },
        {
          type: 'context',
          elements: [{ type: 'mrkdwn', text: `<${BOOKING_URL}|文京区 施設予約ねっと で申し込む>` }],
        },
      ],
    };
  }
  return { text, content: text, title, body, url: BOOKING_URL, ...payload };
}

/** 汎用 Webhook。Slack / Discord の incoming webhook にそのまま流せる形にしている。 */
export async function notifyWebhook(url, { title, body, payload }) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(webhookPayload(url, { title, body, payload })),
  });
  if (!res.ok) {
    throw new Error(`webhook -> HTTP ${res.status} ${(await res.text()).slice(0, 120)}`);
  }
}

export async function appendLog(path, line) {
  await appendFile(path, `${new Date().toISOString()}  ${line}\n`, 'utf8');
}

/**
 * Webhook URL は認証情報（知っていれば誰でもそのチャンネルに投稿できる）。
 * 環境変数を優先し、設定ファイルに書かずに済む逃げ道を用意しておく。
 */
export const webhookUrlFrom = (config) =>
  process.env.KOISHIKAWA_WEBHOOK_URL || config.notify?.webhookUrl || '';

/** 設定に従って有効な出口すべてに送る。1つ失敗しても他は止めない。 */
export async function dispatch(config, message) {
  const errors = [];
  if (config.notify?.macos && process.platform === 'darwin') {
    await notifyMacos({ ...message, sound: config.notify.sound ? 'Glass' : null }).catch((e) =>
      errors.push(`macos: ${e.message}`),
    );
  }
  const hook = webhookUrlFrom(config);
  if (hook) {
    await notifyWebhook(hook, message).catch((e) => errors.push(`webhook: ${e.message}`));
  }
  return errors;
}
