#!/bin/bash
# テンプレートから launchd の plist を作って登録する。
# パスは実行時に埋めるので、リポジトリには個人のパスが残らない。
#
#   bash bin/setup-launchd.sh          登録
#   bash bin/setup-launchd.sh --remove 解除

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
label="com.koishikawa.watch"
plist="$root/$label.plist"
installed="$HOME/Library/LaunchAgents/$label.plist"

if [ "${1:-}" = "--remove" ]; then
  launchctl unload "$installed" 2>/dev/null || true
  rm -f "$installed"
  echo "解除しました: $installed"
  exit 0
fi

node_bin="$(command -v node)"
if [ -z "$node_bin" ]; then
  echo "node が見つかりません。PATH を確認してください。" >&2
  exit 1
fi

sed -e "s|__PROJECT_DIR__|$root|g" -e "s|__NODE__|$node_bin|g" \
  "$root/$label.plist.template" > "$plist"

mkdir -p "$HOME/Library/LaunchAgents"
cp "$plist" "$installed"
launchctl unload "$installed" 2>/dev/null || true
launchctl load "$installed"

echo "登録しました: $installed"
echo "  node: $node_bin"
echo "  dir : $root"
echo "解除するには: bash bin/setup-launchd.sh --remove"
