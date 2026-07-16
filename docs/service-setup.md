# サーバ常駐化 (systemd user service)

`shift server` を毎回手で起動する代わりに systemd user service として常駐させる手順です。Linux ネイティブ / WSL2 (`systemd=true`) で動作します。

> macOS の launchd と Windows native (nssm / Task Scheduler) は未検証です。参考リンクは [ROADMAP.md](../ROADMAP.md) 末尾を見てください。

## 前提

- `shift add <account>` で 1 アカウント以上登録済み ([docs/account-setup.md](account-setup.md))
- Node.js v20 以上 (`which node` で場所を控える)
- `systemctl --user` が使えること
  - WSL2 は `/etc/wsl.conf` に以下を書いて `wsl --shutdown` した後に再起動する必要があります。

    ```ini
    [boot]
    systemd=true
    ```

## 0. 既存の手動 server を止める (必要な場合のみ)

`./shift.sh server` を裏で走らせたことがある人は、そのプロセスを止めてポート 19867 を空けてから次に進みます。

```bash
ss -tlnp 2>/dev/null | grep 19867 || echo 'port 19867 free'
```

何も表示されなければ次章へ。プロセスが居る場合は shift.sh (親 bash) と node (子) の両方を止めます。**親だけ kill すると子 node が PPID=1 で残り続けます。**

```bash
pkill -f 'shift.sh server'          # 親 bash
pkill -f 'cli/server.js'            # 子 node (孤児化していても効く)
sleep 2
ss -tlnp 2>/dev/null | grep 19867 || echo 'port 19867 free'
```

## 1. Unit ファイルを配置

repo 内の [contrib/systemd/claude-shift.service](../contrib/systemd/claude-shift.service) をテンプレートとして使います。`NODE_BIN` と `REPO_PATH` を自分の環境に置換してからユーザー systemd ディレクトリへコピーします。ポーリング間隔を明示したい場合は `POLL_MINUTES=5` の行もここで有効化します (未指定なら unit のデフォルトどおり `~/.claude-shift/config.json` の保存値、それも無ければ 10 分)。

```bash
cd claude-shift
NODE_BIN="$(command -v node)"
REPO_PATH="$(pwd)"
POLL_MINUTES=5                       # 好みの間隔 (分)。省略したい場合は下の sed 3 段目を外す
mkdir -p ~/.config/systemd/user
sed \
  -e "s|NODE_BIN|${NODE_BIN}|" \
  -e "s|REPO_PATH|${REPO_PATH}|g" \
  -e "s|^# Environment=CLAUDE_SHIFT_POLL_MINUTES=10|Environment=CLAUDE_SHIFT_POLL_MINUTES=${POLL_MINUTES}|" \
  contrib/systemd/claude-shift.service \
  > ~/.config/systemd/user/claude-shift.service
```

置換後の `ExecStart` / `WorkingDirectory` / `Environment=` が絶対パス・意図した値になっているか確認します。

```bash
grep -E 'ExecStart|WorkingDirectory|Environment=' ~/.config/systemd/user/claude-shift.service
```

> **pollMinutes の優先順位**: server.js は `CLI引数 (--interval)` > `環境変数 (CLAUDE_SHIFT_POLL_MINUTES)` > `~/.claude-shift/config.json` の `pollMinutes` > デフォルト 10 分、の順で解決します。unit で `Environment=` を明示しておくと保存済み設定が古くても意図した間隔で動くので確実です。

## 2. 起動

```bash
systemctl --user daemon-reload
systemctl --user enable --now claude-shift.service
```

ログアウト後も走らせ続けたい場合は linger を有効化します (WSL2 では不要)。既に有効なら sudo は省略できます。

```bash
loginctl show-user "$USER" | grep -q 'Linger=yes' \
  && echo 'linger already enabled' \
  || sudo loginctl enable-linger "$USER"
```

## 3. 動作確認

```bash
systemctl --user status claude-shift.service   # active (running) を確認
journalctl --user -u claude-shift.service -f   # 起動ログと fetch ログを追う
curl -s http://127.0.0.1:19867/usage | head    # API 応答が返ること
curl -s http://127.0.0.1:19867/config          # {"pollMinutes":N} で意図した間隔か確認
```

Chrome 拡張 / Local Web UI からも接続できるはずです。

## 更新

repo を更新した後にサービスを再起動します。

```bash
cd claude-shift
git pull
npm install                                     # 依存に変更があれば
systemctl --user restart claude-shift.service
```

Unit ファイル自体を書き換えた場合は `systemctl --user daemon-reload` を挟んでから restart。

## アンインストール

```bash
systemctl --user disable --now claude-shift.service
rm ~/.config/systemd/user/claude-shift.service
systemctl --user daemon-reload
```

`~/.claude-shift/` (アカウントスナップショットと SQLite) は削除しません。手動で消したい場合のみ `rm -rf ~/.claude-shift/`。

他に user service を常駐させていない場合は linger も外して良いです。

```bash
sudo loginctl disable-linger "$USER"
```

## トラブルシュート

### `status: exited (code=203/EXEC)`

`ExecStart` の `node` パスが見つからない状態です。`command -v node` の結果と `~/.config/systemd/user/claude-shift.service` の `ExecStart` を突き合わせて再度 sed 置換します。nvm を使っていて node が `~/.nvm/versions/...` にある場合、または [Volta](https://volta.sh/) を使っていて node が `~/.volta/tools/image/node/<version>/bin/node` にある場合はそのフルパスを指定します。

### ポート競合 (`EADDRINUSE`)

別プロセスがすでに 19867 を掴んでいます。§0 の手順で `shift.sh` / `cli/server.js` を両方止めるか、`~/.config/systemd/user/claude-shift.service` の `Environment=CLAUDE_SHIFT_PORT=...` を有効化して別ポートに逃がします。Chrome 拡張 / Local Web UI 側の接続先も合わせて更新してください。

### `journalctl --user -u claude-shift.service` が `No journal files were found` や空を返す

一般ユーザーはデフォルトで自 unit のログしか見えないうえ、ディストロによってはそれも `systemd-journal` グループ所属が必要です。ユーザーをグループに追加して再ログインしてください。

```bash
sudo usermod -aG systemd-journal "$USER"
# ここで一度ログアウト→再ログイン (SSH セッションも張り直し)
journalctl --user -u claude-shift.service -n 20
```

再ログイン前に急いでログを見たい場合は PID 指定でも読めます。

```bash
journalctl _PID="$(systemctl --user show -p MainPID --value claude-shift.service)" -n 50
```

### fetch が失敗し続ける

`journalctl --user -u claude-shift.service -f` に `fetch error: ...` が出続ける場合は、そのアカウントの token が失効している可能性があります。Claude Code で `/login` し直したうえで `shift add <account>` をやり直すのが確実です ([docs/account-setup.md](account-setup.md))。

### WSL2 でサービスがログアウト後に止まる

WSL は Windows 側で `wsl.exe` が終了するとユーザーセッションごと落ちるため、systemd の `enable-linger` では救えません。Windows タスクスケジューラで `wsl -d <distro> -u <user> --exec true` を定期実行するなど、WSL 自体を起こし続ける対策とセットで運用します。
