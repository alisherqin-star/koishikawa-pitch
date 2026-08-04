// GitHub Pages 向けの書き出しと push。
//
// Pages は main ブランチの /docs をそのまま配信できるので、branch も Actions も要らない。
// report.html と同じレンダラの出力を docs/index.html に置くだけ。

import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { promisify } from 'node:util';
import { renderHtml } from './format.mjs';

const run = promisify(execFile);

const git = (args, cwd) => run('git', args, { cwd, maxBuffer: 1 << 20 });

/** 公開用ページを書き出す。docs/.nojekyll も置いて Jekyll の処理を止める。 */
export async function writePage(path, result, { note = '' } = {}) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, renderHtml(result, { note }), 'utf8');
  await writeFile(`${dirname(path)}/.nojekyll`, '', 'utf8');
}

/**
 * 変更があれば commit して push する。
 * remote が未設定なら何もしない（ローカルだけで使っている間は黙って通す）。
 * @returns {Promise<string>} 何をしたかの一言
 */
export async function pushPage(root, path, message) {
  try {
    await git(['rev-parse', '--git-dir'], root);
  } catch {
    return 'git リポジトリではないので push しません';
  }

  await git(['add', '--', path, `${dirname(path)}/.nojekyll`], root);
  const { stdout: staged } = await git(['diff', '--cached', '--name-only'], root);
  if (staged.trim() === '') return '内容に変更なし';

  await git(['commit', '-m', message], root);

  const { stdout: remotes } = await git(['remote'], root);
  if (remotes.trim() === '') return 'commit 済み（remote 未設定のため push なし）';

  const { stdout: branch } = await git(['rev-parse', '--abbrev-ref', 'HEAD'], root);
  await git(['push', 'origin', branch.trim()], root);
  return `push 完了 (${branch.trim()})`;
}
