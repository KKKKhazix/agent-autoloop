# Agent Autoloop

**コマンドラインのエージェントに、バックグラウンドで仕事を引き受けて最後までやり遂げさせましょう。自分で対処できるときは静かに進め、あなたが判断すべきときにだけカードを送ってきます。**

[中文](README.md) | [English](README.en.md) | **日本語**

[はじめに](#はじめに) · [レシピ](#すぐに使えるレシピ) · [プラグイン](#プラグインエコシステム-4-つの側面のどれでも差し替え可能) · [カーネル](#カーネルの-4-つの仕組み) · [ドキュメント](#ドキュメント)

![アーキテクチャ](docs/architecture.en.svg)

## どんな問題を解決するのか？

Claude Code や Codex のようなコマンドラインのエージェントを使うとき、たいていはターミナルに張り付いています。プロンプトを入力し、実行を見守り、質問に答える。ウィンドウを閉じたり席を離れたりすると、作業は止まってしまいます。

**Agent Autoloop** は、コマンドラインのエージェントをバックグラウンドのループに変えます。中心にあるのは、ランタイム依存ゼロの決定論的な **カーネル** です。その周りにあるイベントソース、エージェント、通知チャネル、さらには CI/CD のデリバリーパイプラインまで、すべてが差し替え可能な **プラグイン** です。

- **1 台のマシンに、1 つのインストールコマンドで。** Mac や Linux のマシンで動作します。クラウドのサーバーも、インバウンドのポートも必要ありません。
- **新しいエージェントは 1 行で接続。** SDK も、エージェントのソースコードのフォークも不要です。プロンプトを受け取って最終的な返答を出力する CLI ツールであれば、何でも接続できます。
- **Web のダッシュボードはありません。** あなたが必要なときには、Feishu、DingTalk、WeCom、Slack、Discord、またはデスクトップ通知でカードが届きます。それ以外のことは、すべてコマンド 1 つで済みます。

## はじめに

macOS と Linux で動作します。Node 24、Git、curl と、すでにサインイン済みのコマンドラインのエージェントが少なくとも 1 つ必要です。GitHub のアカウントは不要です。[インストールガイド](INSTALL.md)をエージェントに渡して、すべてをインストールしてもらうこともできます。

```bash
curl -fsSL https://raw.githubusercontent.com/KKKKhazix/agent-autoloop/main/install.sh | sh
```

次に、あなた自身のエージェントで実際のループを試してみましょう。質問させ、待っている間に終了し、判断を下し、再開します：

```bash
agent-autoloop try
```

> CLI の出力とデフォルトの通知の文言は、現在中国語です。

以下は、非対話型のターミナルで Codex を使ったときの実際の出力です：

```text
事件发出去了，Agent 开始干活……

Agent 结束了这一轮，问了你一个问题。它现在不占进程、不花 Token。

【等你决定】#1 试跑：选一个颜色
这是一次试跑，选哪个都行。
  1. 蓝色
  2. 绿色
回答：agent-autoloop answer 1 <序号>
答完运行 agent-autoloop status，能看到它接着把活干完。
```

対話型のターミナルでは、選択肢の番号を入力するだけです。非対話型のターミナルでは、`agent-autoloop answer 1 2` を実行して緑を選びます。その後 `agent-autoloop status` を実行すると、エージェントが会話を再開して作業を終えたことと、今日と過去 7 日間のラウンド数、トークン数、コストが表示されます（[集計方法](skills/agent-autoloop/SKILL.md#看情况回答)）。

## 仕事の流れ

番号は上の図と対応しています：

1. **イベントが届く。** 午前 9 時のスケジュール、GitHub の新しい Issue、本番環境のアラートなどが、標準のイベントとしてカーネルに送られます。
2. **ルールに従って振り分ける。** どのエージェントが、どのフォルダーで処理するかは、あなたのルールが決めます。キューにある間に同じ対象について届いた新しいイベントは、1 つのラウンドにまとめられます。
3. **1 ラウンド作業して終了する。** エージェントは結果を最終メッセージに書き、プロセスは終了します。
4. **必要なときにだけ尋ねる。** データの削除、サービスの再起動、お金を使うこと、人へのメッセージ送信といった慎重を要する操作では、カーネルが Feishu やデスクトップ通知でカードを送ってきます。あなたがゆっくり考えている間、エージェントのプロセスは動かず、トークンも消費されません。
5. **ワンタップで再開する。** あなたの回答によって元の会話が再開され、作業が完了します。

エージェントが自分だけで対処できることは、図の上部の自動ループを通ります。その場で完了するか、あなたを煩わせることなく、あとで確認するフォローアップ（たとえば 30 分後）を予約します。

## 日々の使い方

### ルールを書く (`rules.json`)

つなぎのコードは必要ありません。`~/.agent-autoloop/rules.json` を開き、`rules` の下に **何が起きたか、誰が処理するか、どこで作業するか** を宣言します。`to` には、`agents` の下にすでにある名前を指定します。たとえば、毎朝 9 時に要約を書く場合は次のとおりです：

```json
{
  "name": "Morning brief",
  "when": { "cron": "0 9 * * *" },
  "to": "codex",
  "cwd": "~/notes",
  "prompt": "Summarize yesterday's notes and commits into today's brief."
}
```

外部のイベントも、ソースを接続すれば同じように扱えます。GitHub の新しい Issue を Codex に渡すには、まず `sources` の下に `github` を登録します（[ガイド](skills/agent-autoloop/SKILL.md#接一个事件插件)）：

```json
{
  "name": "Handle issues",
  "when": { "source": "github", "types": ["issues.opened"] },
  "to": "codex",
  "cwd": "~/code/app",
  "skill": "handle-issue",
  "parallel": 3
}
```

変更は保存してから数秒以内に反映されます。検証するには `agent-autoloop check` を実行してください。間違いがあった場合、ハブは以前の有効なルールで動作し続け、エラーを指摘するカードを送ってきます。

### エージェントからハブへの返答の仕方

ハブがエージェントに求めることは 1 つだけです：**結果を最終メッセージに書くこと**。作業が終わったら、1 行の結論で十分です。あなたに何かを尋ねるときは、エージェントが `agent-autoloop` ブロックを末尾に付け加えます：

````text
Order checked. We have enough stock in the warehouse.

```agent-autoloop
{
  "ask": [{
    "title": "How should we ship it?",
    "text": "Both options can go out today.",
    "options": ["Courier", "Pickup"],
    "key": "shipping"
  }]
}
```
````

`ask` のほかに、レシートでは通知の送信（`notice`）、未解決のカードの解決（`resolve`）、フォローアップの確認の予約（`later`）、新しいイベントの発行（`events`）ができます。JSON が無効な場合、ハブは同じセッションの中で、完了済みの作業を繰り返すことなく、エージェントにその最終メッセージだけを書き直させます。書き直しにも失敗した場合は、元の結論を残したうえで、レシートが適用されなかったことを知らせます。

## すぐに使えるレシピ

各レシピには、ルール、タスクの Skill、セットアップの手順（中国語）が含まれています。

| タスク | 含まれるワークフロー |
|---|---|
| [朝のブリーフ](examples/recipes/morning-brief/README.md) | デフォルトで毎朝 8 時にローカルのメモと Git のコミットを要約し、`briefs/YYYY-MM-DD.md` に書き出します |
| [GitHub の Issue](examples/recipes/github-issues/README.md) | 5 分ごとに確認し、ローカルでコードを修正して、レビューするよう通知します。コミット、プッシュ、Issue への返信は行いません |
| [本番環境のアラート](examples/recipes/ops-alerts/README.md) | エラーを受け取ってローカルのコードを調査し、再起動の前に確認を求め、回答を受けて作業を続けます |
| [ユーザーのフィードバック](examples/recipes/feedback/README.md) | 現在のフィードバックを読み直して修正し、デリバリーと検証を行ってから返信を用意します。Feishu であなたに確認し、回答を受けて再開します |
| [Web サイトの監視](examples/recipes/website-watch/README.md) | 5 分ごとにステータスと期待されるコンテンツを確認します。新しい障害ではエージェントを起こし、継続中の障害では静かにして、復旧したらカードを更新します |
| [Feishu の週報とビジネスのブリーフ](examples/recipes/feishu-brief/README.md) | 日曜日の午後 6 時に、あなたの権限で選択したレポートや表を読み込みます。ローカルで要約し、短い要約だけを Feishu に送ります |
| [PR のデリバリー](skills/agent-autoloop/SKILL.md#交付流水线) | PR に `deliver` を付けると、レビュー、CI の待機、マージ、デプロイの待機、本番バージョンの検証を行います |

**有効にするには：** 手順を開き、タスクの Skill をエージェントの skills ディレクトリに置き、サンプルのルールを `~/.agent-autoloop/rules.json` にマージし、ワーカーの名前とパスを置き換えてから、`agent-autoloop check` を実行してください。

フィードバック、Web サイトの監視、Feishu のブリーフは、デフォルトで Asia/Shanghai のタイムゾーンを使い、所有者の Feishu の個人チャットにだけ送信します。サンプルのデータは架空のものです。スクリプトとレシートは、ローカルの HTTP と偽の Feishu CLI でのみ検証しており、実際のアカウントでエンドツーエンドで実行したことはありません。

その他：[Claude から Codex へのブラウザの引き継ぎ](examples/recipes/browser-handoff/README.md)、[毎週のコードのクリーンアップ](examples/skills/weekly-sweep/SKILL.md)、[PR の出荷](examples/skills/ship-pr/SKILL.md)。

## プラグインエコシステム: 4 つの側面のどれでも差し替え可能

組み込みのプラグインはプログラムに同梱されており、設定で有効にします。サードパーティのプラグインには `agent-autoloop add <git URL>` を使ってください。

| 側面 | 組み込み | セットアップ |
|---|---|---|
| **イベント**：仕事をどう見つけるか | [GitHub Webhook](plugins/github/source.ts)、[HTTP API](docs/protocol.md#来源把世界变成事件)、[cron のルール](skills/agent-autoloop/SKILL.md#改规则)、[Issue のポーリングスクリプト](examples/watch-github-issues.sh) | [ガイド](skills/agent-autoloop/SKILL.md#接一个事件插件) |
| **エージェント**：誰が作業するか | [Claude Code](plugins/claude/agent.ts)、[Codex](plugins/codex/agent.ts)、[ACP](plugins/acp/agent.ts)、[汎用コマンド](plugins/command/agent.ts) | [ガイド](skills/agent-autoloop/SKILL.md#接一个-agent) |
| **チャネル**：カードをどう届けるか | [デスクトップ通知](plugins/desktop/channel.ts)（デフォルトで有効）、[Feishu](plugins/feishu/channel.ts)、[DingTalk / WeCom / Slack / Discord](plugins/webhook/templates.ts) | [ガイド](skills/agent-autoloop/SKILL.md#接一个通道) |
| **デリバリー**：プラグインとしての CI/CD | [`delivery`](plugins/delivery/delivery.ts) | [ガイド](skills/agent-autoloop/SKILL.md#交付流水线) |

**テスト済みの内容：** Claude Code、Codex、ACP（公式の Codex ACP アダプターを使用）では、複数ターンの質疑応答と、プロセスをまたいだセッションの再開を実行しています。Feishu では、実際の配信、ボタンのコールバック、カードの更新を実行しています。4 つの Webhook のテンプレートは、ローカルのモックサーバーに対してのみ確認しています。これらのテキストチャネルはリンクを通じて回答するため、`hub.publicUrl` にあなたのスマートフォンやコンピューターからアクセスできる必要があります。

**その他の CLI エージェントも 1 行で接続できます。** `use: "command"` を設定し、コマンドの配列を渡します。`{prompt}` は単一の引数で、シェルのコードとして評価されることはありません。以下のコマンドは各ツールの公式ドキュメントから引用したもので、まだそれぞれを実行してはいません：

| エージェント | コマンド |
|---|---|
| [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cli-help.md#dsh-headless) | `dsh --profile headless {prompt}` |
| [pi](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/cli.md) | `pi --print {prompt}` |
| [OpenClaw](https://docs.openclaw.ai/cli/agent) | `openclaw agent exec {prompt}` |
| [Hermes](https://hermes-agent.nousresearch.com/docs/user-guide/cli) | `hermes chat -q {prompt}` |
| [Cursor](https://cursor.com/docs/cli/reference/parameters) | `agent -p --trust {prompt}` |
| [WorkBuddy / CodeBuddy](https://www.codebuddy.ai/docs/cli/headless) | `codebuddy -p {prompt}` |

**デリバリーパイプライン。** GitHub の PR に `deliver` のラベルを付けると、リリースまでやり遂げます：**レビュー → CI の待機 → マージ → デプロイの待機 → 本番バージョンの検証**。設定は `main` からのみ読み込まれ、PR のコードがワーカーのマシンでチェックアウトされたり実行されたりすることはありません。キューイング、並行処理、リトライはカーネルが担います。

**自分で書く。** 実行可能な[エージェント](examples/plugins/hello-agent/agent.ts)、[チャネル](examples/plugins/hello-channel/channel.ts)、[イベント](examples/plugins/hello-source/source.ts)のテンプレートと、[プラグインのガイド](docs/plugins.md)から始めてください。Web のタスクについては、まず[ブラウザの接続](docs/plugins.md#浏览器接入)をお読みください。CLI と [MCP](skills/agent-autoloop/SKILL.md#mcp-与密钥撤销) でも、カードを確認したり回答したりできます。

## カーネルの 4 つの仕組み

カーネルは約 1,650 行で、ランタイム依存はゼロです。時計を読まず、乱数を使わず、外向きのリクエストも行いません。プラグインのほうから接続し、認証情報はそれを使うプラグインにとどまります。同じ入力からは、常に同じ結果が得られます。カーネルは、実績のある 4 つのシステムのパターンをコマンドラインのエージェントに持ち込みます：

- **コストゼロの待機**：あなたの判断を待つ間、プロセスは終了し、待機の状態は SQLite に保存されるので、エージェントが起動し続けることはありません。3 日後に返信しても、その間エージェントのプロセスは動かず、トークンも消費されません。バックグラウンドで待つのは軽量なハブだけで、あなたの回答によって元の会話が再開されます。
- **イベントソーシング**：すべての状態は追記のみのファクトログから導出され、ハブが応答する前に、インデックスとともに同じ SQLite のトランザクションでコミットされます。確定したファクトは `SIGKILL` にも耐え（マシン全体の電源喪失は個別にテストしていません）、すべての実行をコマンド 1 つで追跡でき、形式が変わってもマイグレーションのスクリプトなしでログから再構築されます。
- **コードとデータの分離**：パラメーター化された SQL のようなものです。Issue のタイトルや本文などの外部のテキストは、ローカルのデータファイルにだけ書き込まれ、プロンプトには決して含まれません。プロンプトに含まれるのは、文字のチェックを経た種類、ID、リンクだけです。どのエージェントを、どのフォルダーで、どの権限で実行するかを決めるのは `rules.json` だけです。`cwd`、`agent`、`access` のフィールドを含むイベントは、そのまま拒否されます。
- **ホップ数のサーキットブレーカー**：ネットワークにおけるパケットの TTL のようなものです。エージェントが返したイベントはさらに別のエージェントを起動でき、ホップ数は、人への質問や予約されたフォローアップをまたいでも増え続け、エージェントがリセットすることはできません。8 ホップを超えると、カーネルはそのイベントを記録して振り分けを止め、通知のカードを送ってきます。

### 自分で確かめる

以下は `~/.agent-autoloop/app` から実行してください：

| 確認する内容 | コマンド |
|---|---|
| 任意のラウンドの経緯のすべて | `agent-autoloop why 1` |
| ネットワークの切断、パケットの損失、クラッシュ、重複したリクエストを 200,000 ステップシミュレーション。1 つのシードから再現可能 | `node sim/random.ts 24301 200000` |
| 1,000 回プロセスを強制終了しても、確認応答済みのレコードが失われないこと | `node sim/crash.ts 1000 12648430` |
| 以下のベンチマーク | `npm run benchmark` |

```text
第 1 轮 · 演示
11-03 20:47:25  规则版本 #1
11-03 20:47:25  触发事件：来源 local · 类型 demo.start · 对象 example
11-03 20:47:25  local 领取（演示程序）
11-03 20:47:25  结束：演示完成
```

### ベンチマーク

Apple M5 Pro、24 GB、Node 24.21.0。各書き込みは個別のリクエストで、トランザクションが永続化されてから初めて確認応答されます。`npm run benchmark` の合格の基準はこのマシンに合わせて設定されているため、別のマシンでは基準を満たさないと報告されることがあります。

| 指標 | 測定値 |
|---|---:|
| コールドスタート | 88.78 ms |
| アイドル時のメモリ | 59.94 MB RSS |
| 1,000 件の同時待機中のポーリング | 170.49 MB RSS |
| 永続的な書き込み | 2,394 events/s |
| 振り分けの p99 | 1.82 ms |
| 110 万件のファクトでの起動 | 99.8 ms |
| カーネルの行数（コメントと空行を含む） | 1,651 |
| ランタイム依存 | 0 |

履歴が増えるにつれて、ステータスの要約は遅くなり、ログとインデックスはディスクを使い続けます。形式が変わったあとの最初の起動ではログから再構築され、110 万件のファクトで 43.1 秒かかりました。[完全な数値と方法](docs/protocol.md#历史增长实测)（中国語）。

## 利用とプロバイダーの規約

ハブは、あなたのマシンにすでにインストールしてサインイン済みのコマンドラインのツールを呼び出します。それらの認証情報を読み取ったりエクスポートしたりすることはありません。モデルの利用料金は、各プロバイダーの規約に従って、あなた自身のアカウントに請求されます。

自動化されたワークロードには、一般にプロバイダーは個人のサブスクリプションの枠ではなく API キーの使用を推奨しています（個人のサブスクリプションは対話的な個人利用を前提に設計されています。[Anthropic](https://code.claude.com/docs/en/legal-and-compliance) と [OpenAI](https://learn.chatgpt.com/docs/auth) をご覧ください）。他の人のためにサービスを運用する場合は、API キーを使ってください。このプロジェクトは独立したものであり、これらのプロバイダーと提携しておらず、承認も受けていません。

## ドキュメント

- [インストールガイド](INSTALL.md)
- [設定とデリバリーパイプラインのマニュアル](skills/agent-autoloop/SKILL.md)
- [プラグインの書き方](docs/plugins.md)
- [HTTP プロトコルの完全な仕様](docs/protocol.md)
- [セキュリティの境界](SECURITY.md)
- [コントリビュートとコミュニティ](CONTRIBUTING.md)
- [開発のガイドライン](AGENTS.md)

<details>
<summary><strong>リポジトリの構成</strong></summary>

| 場所 | 内容 |
|---|---|
| `kernel/` | 判断、ファクトログ、プロジェクション、期限、ルールのマッチング、エンドポイントの動作、カードのフォーム |
| `host/` | Node の HTTP、ファイルと SQLite の接続、時計、設定、バックグラウンドのサービス、プラグインの読み込み |
| `protocol/` | ワイヤーフォーマット、JSON Schema、入力の検証、HTTP クライアント、適合性のチェック |
| `worker/` | 仕事の引き受け、エージェントの実行、ハートビートとキャンセルの処理、レシートの読み取りと提出 |
| `cli/`, `bin/` | ユーザーのコマンドとエントリーポイント：ステータス、回答、`why`、MCP、アップデート、アンインストール |
| `plugins/` | 組み込みのエージェント、イベント、チャネル、デリバリーのプラグイン |
| `examples/recipes/` | ルール、タスクの Skill、セットアップの手順を含む完全なレシピ |
| `examples/plugins/`, `examples/skills/`, `examples/*.sh` | 最小限のプラグインのテンプレート、単独のタスクのガイド、Shell の例 |
| `skills/agent-autoloop/` | ハブの設定と運用のマニュアル。インストール時にエージェントからも利用できるようになります |
| `docs/` | プロトコル、プラグインのガイド、中国語 / 英語のアーキテクチャ図 |
| `tests/`, `sim/` | 日常的な動作のテスト、シミュレーション、列挙、クラッシュテスト、ミューテーションのチェック |
| `scripts/`, `.github/workflows/` | パフォーマンスと実際のエージェントのチェック、インストールのスモークスクリプト、Linux / macOS の CI |
| ルートのドキュメントと `install.sh` | 中国語 / 英語の README、インストール、セキュリティ、開発のガイドライン、ライセンス、インストーラー |

`bin/agent-autoloop.ts` → `cli/main.ts` から読み始め、機能をたどって `host/`、`worker/`、`plugins/` に進んでください。カーネルの設計については[プロトコル](docs/protocol.md)をお読みください。似た名前のファイルは、異なるレイヤーを担っています：`host/http.ts` は Node のリクエストを適合させ、`kernel/http.ts` はエンドポイントの動作を定義します。`protocol/rules.ts` は入力を検証し、`kernel/rules.ts` はルールの種類とマッチングを定義します。

</details>

[MIT License](LICENSE)
