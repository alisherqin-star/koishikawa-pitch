# 小石川運動場 空き枠ウォッチャー

文京区「[施設予約ねっと](https://www.shisetsu.city.bunkyo.lg.jp/user/Home)」から
**小石川運動場グラウンド**の空き状況を定期取得し、新しく空いたコマ・抽選申込ができるように
なったコマを macOS の通知で知らせる。依存パッケージなし（Node 20+ の標準機能のみ）。

サッカーに使えるのは 小石川運動場 の「グラウンド」。1日は 2 時間 × 7 コマ
（Ａ 6:30 / Ｂ 8:30 / Ｃ 10:30 / Ｄ 12:30 / Ｅ 14:30 / Ｆ 16:30 / Ｇ 18:30）。

## 使い方

いま空いている枠を見る（表を出して `report.html` も更新）:

```bash
node bin/check.mjs
```

常駐して監視し、変化があれば通知する:

```bash
node bin/watch.mjs
```

同じネットワークの人にも見せる（[他の人に見せる](#他の人に見せる)）:

```bash
node bin/serve.mjs
```

その他:

```bash
node bin/check.mjs --all        # 満杯の日も含めて全日表示
node bin/check.mjs --days 30    # 期間を上書き
node bin/check.mjs --json       # 生データを JSON で出力
node bin/watch.mjs --once       # 1回だけ実行して終了（cron / launchd 用）
node bin/watch.mjs --interval 15   # 全件走査の間隔（分）
node bin/watch.mjs --reset      # 状態を捨てて基準を取り直す
node bin/test-notify.mjs        # 通知の疎通確認（テストメッセージを送る）
node bin/build-page.mjs         # 公開ページだけ作り直す
node --test 'test/*.test.mjs'   # 通知判定のテスト
```

`report.html` をブラウザで開くと、上に空き数のサマリと申込めるコマの一覧、下に
「1日 = 6:30〜20:30 の帯」を縦に並べたボードが出る。表ではなく帯にしてあるのは、
コマが 2 時間ごとに隙間なく並んでいて時間割そのものだから。
「すべての日 / 週末・祝日 / 空き・抽選のある日」で絞り込める。

## 表の読み方

端末の表とボードで記号は違うが、意味は同じ。ボードでは緑＝今すぐ申込める、
琥珀＝抽選（数字は申込件数、枠線付きは 0 件）、斜線＝空いているが受付前、
べた塗り＝空きなし。

| 記号（端末） | 意味 |
| --- | --- |
| `○` | **今すぐ申込める**（先着受付中で空き） |
| `抽N` | 抽選申込ができる。N は現時点の申込件数で、少ないほど当たりやすい |
| `未` | 場所は空いているが、まだ受付が始まっていない |
| `×` | 空きなし |
| `公` | 公用（行政利用） |
| `·` `休` | 申込期間外 / 休館 |

`○` と `未` の区別が重要。サイトの生データでは受付前の日も「空き」扱いで返ってくるため、
その 100 件超をそのまま通知すると毎回誤報になる。このツールは
`Status='vacant' かつ Disabled=false` のときだけ「申込める」と判定している
（`IsVacant` フィールドは常に false で返るので使えない）。

通知が飛ぶのは次の 2 つ:

- **空きが出た** — キャンセルなどで先着枠が開いた
- **抽選申込が可能になった** — その日が抽選受付に入った

受付は月単位で開くので、そのタイミングでは一度に百件以上のイベントが出る
（11月ぶんが9月に開く、など）。8 件以上になったら個別に並べず、月ごとに
まとめた1通にして、申込が少ないコマを数件だけ添える。

同じ理由で、まだ受付が始まっていない月はボードでも 1 行に折り畳んでいる。
押せないコマを30行ぶん並べても情報が増えないため。受付が始まればその月は
自動的に展開され、抽選なら申込件数が入る。

## 設定 `config.json`

| キー | 説明 |
| --- | --- |
| `facility.code` | 施設コード。`44` = 小石川運動場。存在しないコードを入れると一覧がエラーに出る |
| `facility.objects` | 室場の候補名。実在する最初のものが対象になる。**監視できるのは 1 室場だけ**（小石川なら「グラウンド」か「会議室」）。空配列なら施設の先頭の室場 |
| `daysAhead` | 何日先まで見るか。既定 120（サイトの公開範囲はおよそ 4 ヶ月先まで） |
| `notifyOn.weekdays` | 通知したい曜日 `[0=日 … 6=土]`。空配列なら全曜日。祝日は常に対象 |
| `notifyOn.timeFrom` / `timeTo` | 通知したい時間帯。`1800`, `2030` のような HHMM 整数 |
| `notifyOn.includeLottery` | 抽選の通知を出すか |
| `intervalMinutes` | 全件走査の間隔。表とレポートを作り直す |
| `quickIntervalMinutes` | 軽い巡回の間隔。日単位のステータスだけ見て、対象の曜日が満杯から動いていたらすぐ全件走査に入る。キャンセルは数分で消えるのでここが実質の反応速度 |
| `quickDaysAhead` | 軽い巡回で見る日数。受付開始の瞬間を捉えたいので既定は `daysAhead` と同じ |
| `quietHours` | `[23, 7]` なら 23:00〜07:00(JST) は通知しない（ログには残る） |
| `notify.webhookUrl` | 入れると Slack / Discord の incoming webhook にも流す。**これは認証情報**なので公開リポジトリに入れないこと（`config.json` は `.gitignore` 済み）。環境変数 `KOISHIKAWA_WEBHOOK_URL` でも渡せる |
| `notify.onLotteryCountChange` | 抽選の申込件数が減ったときも通知する |

土日の朝だけ知りたい、なら例えば:

```json
"notifyOn": { "weekdays": [0, 6], "timeFrom": 630, "timeTo": 1230, "includeLottery": true }
```

## バックグラウンドで動かす

常駐させたくない場合は launchd に登録して 30 分おきに `--once` を叩かせる。
パスは実行時に埋めるので、テンプレートに個人のパスは残らない。

```bash
bash bin/setup-launchd.sh
```

止めるとき:

```bash
bash bin/setup-launchd.sh --remove
```

## 仕組み

サイトは Vue + axios で、画面遷移も `axios.post` → 返ってきた URL へ `location.href`
という作りになっている。ページ末尾に画面モデルが `model: JSON.parse("…")` の形で
丸ごと埋め込まれているので、HTML を解析せずに構造化データが取れる。
ブラウザ自動化もログインも不要。

```
GET  /user/Home                                          Cookie と antiforgery token
POST /user/Home/SearchByFacilityCategory                 facilityCategoryCode=4（スポーツ施設）
POST /user/AvailabilityCheckApplySelectFacility/Next     SelectFacilities.Selected[0]=44
POST /user/AvailabilityCheckApplySelectDays/SearchCondition   日単位の空き（最大1ヶ月ぶん）
POST /user/AvailabilityCheckApplySelectDays/Next         詳細を見たい日にチェックを立てる
GET  /user/AvailabilityCheckApplySelectTime              コマ単位の空き・抽選申込件数
```

2 段構えにしている理由: 日単位のスキャンは 1 ヶ月ぶんまとめて取れるが、コマ単位の詳細は
**一度に 10 コマまで**しか指定できない（超えると `E-203-000018`）。そこで
「空き」「一部空き」「抽選」の日だけを 10 日ずつ深掘りし、終日満杯の日は詳細を取りに行かない。
120 日ぶんで約 50 秒、リクエスト間隔は 350ms 空けている。

監視も同じ発想で 2 段階になっている。キャンセルは数分で他人に取られてしまうので短い間隔で
見に行きたいが、毎回 50 秒かけるわけにはいかない。そこで日単位のステータスだけを見る
巡回（120 日ぶんで約 10 秒）を `quickIntervalMinutes` ごとに回し、対象の曜日が
「空きなし」から動いたときだけ全件走査に切り替える。

## 注意

- **予約はしない。** このツールは読み取り専用で、ログインもしない。空き状況は公開情報で、
  ログインが要るのは実際の申込と抽選申込のときだけ。`○` を見つけたら自分でサイトから取る。
- 施設の利用には団体登録が必要（都内在住・在勤・在学）。営利目的の利用は不可。
- 巡回間隔は落とし過ぎない。区の公開サーバーなので、既定（軽い巡回 5 分・全件 30 分）で
  1 日あたり 3000 リクエスト弱。これ以上詰めるだけの価値はまずない。

## 他の人に見せる

**同じネットワークにいる人に**（常に最新、自動更新）:

```bash
node bin/serve.mjs
```

起動すると LAN 用の URL（`http://192.168.x.x:8787`）が表示される。`intervalMinutes` ごとに
裏で取り直し、ページ側にも自動リロードがかかる。自分の端末だけに閉じたいときは
`--host 127.0.0.1`、ポートを変えるなら `--port 9000`。

**チームのグループチャットに**（見に行かせるのではなく、こちらから流す）:
`config.json` の `notify.webhookUrl` に Discord か Slack の incoming webhook を入れるだけ。
送り先ごとに受け付ける形が違う（Discord は `content` のみ、余計なキーがあると 400、
Slack は `text` + `blocks`）ので、URL のホスト名で自動的に振り分けている。

**ネットワーク外の人に**: `report.html` は外部リソースを一切参照しない単体 HTML なので、
そのまま送れば相手のブラウザで開ける。ただし送った時点のスナップショットになる。

`renderHtml(result, { fragment: true })` は doctype と meta を省いた断片を返す。
head を自前で持つ配信先（claude.ai の Artifact など）に貼るとき用。

## セットアップ

```bash
cp config.example.json config.json
```

`config.json` は個人設定なので追跡していない（webhook URL が認証情報のため）。

### GitHub Pages で公開する

公開ページ <https://alisherqin-star.github.io/koishikawa-pitch/> は
**GitHub Actions が30分ごとに更新する**（`.github/workflows/update-page.yml`）。
Mac の電源が入っていなくても止まらない。役割分担は次のとおり:

| | 担当 | 動く条件 |
| --- | --- | --- |
| `bin/watch.mjs`（ローカル） | 通知（macOS / webhook） | Mac が起きている間 |
| GitHub Actions | 公開ページの更新 | 常時 |

そのためローカルの `publish.git` は `false` にしてある。両方から push すると
ぶつかるため（衝突しても `pull --rebase` で復帰はする）。ローカルだけで運用したい
場合は `true` に戻し、ワークフローを無効化すればよい。

注意: **公開リポジトリの scheduled workflow は、リポジトリに60日間なんの活動も無いと
GitHub に自動で止められる**。このワークフロー自身が commit を作り続けるので通常は
問題にならないが、長期間まったく変化が無い場合は Actions タブを見ておくとよい。

### グループチャットに流す

Discord なら「サーバー設定 → 連携サービス → ウェブフック」、Slack なら
「api.slack.com/apps → Incoming Webhooks」で URL を作り、`config.json` の
`notify.webhookUrl` に入れる。疎通確認:

```bash
node bin/test-notify.mjs
```

実際の空き状況とは無関係のテストメッセージが飛ぶ。**この URL は認証情報**（知っていれば
誰でもそのチャンネルに投稿できる）なので公開リポジトリに置かないこと。
`config.json` は追跡対象外にしてあり、環境変数 `KOISHIKAWA_WEBHOOK_URL` でも渡せる。
