#!/usr/bin/env node
// 同じネットワークの人にそのまま見せるための小さな HTTP サーバー。
// 起動時に1回取得し、以降は intervalMinutes ごとに裏で更新してメモリから配る。
// スキャンに数十秒かかるのでリクエストごとには取りに行かない。
//
//   node bin/serve.mjs                 0.0.0.0:8787（LAN の他の端末から見える）
//   node bin/serve.mjs --port 9000
//   node bin/serve.mjs --host 127.0.0.1 自分の端末だけ

import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scan } from '../src/scan.mjs';
import { renderHtml } from '../src/format.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const value = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};

const config = JSON.parse(await readFile(resolve(root, 'config.json'), 'utf8'));
const port = Number(value('port', 8787));
const host = value('host', '0.0.0.0');
const intervalMs = (config.intervalMinutes ?? 30) * 60_000;

const stamp = () => new Date().toLocaleTimeString('ja-JP');
const say = (m) => console.log(`[${stamp()}] ${m}`);

let page = '<!doctype html><meta charset="utf-8"><p>取得中です。しばらくお待ちください。</p>';
let updatedAt = null;

async function refresh() {
  try {
    const result = await scan(config);
    // ページ側にも自動更新をかけて、開きっぱなしでも古い表を見せない。
    page = renderHtml(result, { refreshSeconds: config.intervalMinutes * 60, live: true });
    updatedAt = new Date();
    const open = result.days.reduce(
      (n, d) => n + d.slots.filter((s) => s.status === 'vacant' && !s.disabled).length,
      0,
    );
    say(`更新: 申込可 ${open} コマ`);
  } catch (e) {
    say(`取得に失敗: ${e.message}（前回の表を出し続けます）`);
  }
}

const server = createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, updatedAt }));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(page);
});

server.listen(port, host, () => {
  const lan = Object.values(networkInterfaces())
    .flat()
    .filter((n) => n && n.family === 'IPv4' && !n.internal)
    .map((n) => n.address);
  say(`起動しました  http://localhost:${port}`);
  if (host === '0.0.0.0' && lan.length > 0) {
    say(`同じネットワークの人はこちら: ${lan.map((a) => `http://${a}:${port}`).join('  ')}`);
  }
  say(`${config.intervalMinutes ?? 30}分ごとに自動更新 / Ctrl+C で終了`);
});

await refresh();
setInterval(refresh, intervalMs);
