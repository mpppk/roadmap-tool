---
name: roadmap-cli
description: Use the roadmap-tool CLI to list, add, or rename roadmap features and members. Use when managing roadmap-tool data.
---

# roadmap-tool CLI

roadmap-toolはロードマップの機能やメンバーのキャパシティ管理を行うためのツールです。

最初にroadmap-toolコマンドが存在するかを確認してください。
存在しない場合、`bun install -g github:mpppk/roadmap-tool`でインストールしてください。

CLIの利用手順は`roadmap-tool --help`で確認できます。

# Terminology

## Epics

Featureをまとめる上位カテゴリです。各Featureは必ず1つのEpicに属します。未分類のFeatureは既定のEpic（例: `未分類`）に入ります。

## Features

ロードマップ上の機能・作業項目です。開発や計画の単位として扱い、Epicに紐づけて管理します。CLIでは名前、説明、リンク、所属Epic、並び順などを操作します。

## Members

チームメンバーまたはリソースを表します。Featureへのキャパシティ割り当て対象です。Memberには月次の上限キャパシティ（`max_capacity`）を設定できます。

## Capacity

MemberがFeatureに割り当てる稼働量です。月次では `1.0` がそのMemberのフルキャパシティ、`0.5` は半分、`0` は未割り当てを表します。Quarter表示では配下3ヶ月分を合計して扱います。

## Quarters

計画対象の四半期です。1つのQuarterは3つのMonthを持ち、UIやCLIでは `2026 Q1` のような単位で表示・集計されます。

## Months

キャパシティが実際に保存される月次の期間です。Quarter単位の操作は、配下3ヶ月のMonthデータへ分配または集計されます。

## Allocations

Memberを特定のFeatureとMonthに割り当てたキャパシティです。同じMemberの同じMonthにおける割り当て合計は、通常そのMemberの上限を超えないように扱います。

## Total Capacity

Featureが特定のMonthまたはQuarterで必要とする合計キャパシティです。MemberごとのAllocation合計とは別に管理されます。

## Unassigned Capacity

Total CapacityからMemberに割り当て済みのCapacityを引いた残りです。必要キャパシティはあるが担当Memberがまだ決まっていない状態を表します。

## Max Capacity

Memberごとの月次上限キャパシティです。未設定の場合は通常 `1.0` が上限として扱われ、`0.8` のように設定するとそのMemberの月次上限を調整できます。

## Links

EpicやFeatureに紐づく参考URLです。仕様書、Issue、デザイン、議事録など、計画や実装判断に必要な外部情報を保持します。

