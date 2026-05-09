# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev        # Start dev server (Turbopack by default)
npm run build      # Build for production (does NOT run lint automatically)
npm run lint       # Run ESLint manually
npm run start      # Start production server
```

To use Webpack instead of Turbopack: `next dev --webpack`

## Stack

- **Next.js 16** — read `node_modules/next/dist/docs/` before writing any Next.js code; APIs differ from earlier versions
- **React 19**
- **TypeScript** (strict mode; `@/*` resolves to the project root, not `src/`)
- **Tailwind CSS v4** — CSS-first config, no `tailwind.config.js`

## Architecture

### Routing

File-system routing under `app/`. `app/layout.tsx` is the required root layout (must contain `<html>` and `<body>`). `app/page.tsx` renders at `/`.

### Server vs Client Components

All `app/` files are Server Components by default. Add `'use client'` at the top of any file that needs:
- `useState`, `useEffect`, `useReducer`, or other hooks
- Event handlers (`onClick`, `onChange`, etc.)
- Browser APIs (`localStorage`, `window`, etc.)

Pass Server Component subtrees as `children` props into Client Components to avoid pulling server-rendered content into the client bundle unnecessarily.

### Tailwind v4 (breaking change from v3)

Custom design tokens go in `app/globals.css` using `@theme inline { ... }` — **not** in a `tailwind.config.js` file (which does not exist). The CSS entry point uses `@import "tailwindcss"` (not `@tailwind base/components/utilities`).

### Breaking changes vs older Next.js

- **Dynamic route params are Promises**: `params` and `searchParams` props in `page.tsx` and `layout.tsx` are now `Promise<...>` — use `await params` before accessing properties.
- **`next build` does not lint**: Run `npm run lint` separately in CI.
- **Turbopack is default**: `next dev` uses Turbopack; pass `--webpack` to opt out.
- **ESLint flat config**: Uses `eslint.config.mjs` (flat config format), not `.eslintrc`.

---

## ぷよぷよ 要件定義

### 概要

本アプリはブラウザ上で動作するぷよぷよ風落ち物パズルゲーム。  
実装ファイル: `app/components/PuyoGame.tsx`（全ロジック・UIを1ファイルに集約した Client Component）

---

### ゲームボード

| 項目 | 仕様 |
|------|------|
| 列数 | 6列 |
| 表示行数 | 12行 |
| 内部行数 | 13行（row 0 は非表示のスポーン領域） |
| 座標系 | row 0 が最上部（非表示）、row 12 が最下部 |

---

### ぷよ（パーツ）

| 項目 | 仕様 |
|------|------|
| 色の種類 | 赤・緑・青・黄・紫の5色 |
| 出現単位 | 2個1組のペア（メイン + サブ） |
| スポーン位置 | row=1, col=2、回転=0（サブが上） |

**回転定義**（pivot = mainぷよ）

| rotation値 | サブの位置 |
|------------|-----------|
| 0 | mainの上 (row-1, col) |
| 1 | mainの右 (row, col+1) |
| 2 | mainの下 (row+1, col) |
| 3 | mainの左 (row, col-1) |

---

### 操作

| キー | 動作 |
|------|------|
| `←` / `→` | 左右移動 |
| `↓` | 1マス下降 |
| `↑` / `Z` | 時計回り回転 |
| `X` | 反時計回り回転 |
| `Space` | 急降下（ハードドロップ） |
| `Enter` | スタート / リスタート |

- 回転時に壁際で干渉する場合は左右に±1のウォールキックを試みる
- ゴーストピース（着地予測位置）を点線円で表示する

---

### 消去ルール

- 同色のぷよが上下左右に **4個以上** 連結した場合、まとめて消去
- 消去後、空中に浮いたぷよは重力で落下（列ごとに下詰め）
- 落下後に再び4個以上連結していれば連続消去（**連鎖**）
- 連鎖は何段でも続く

---

### スコア計算

```
得点 = 消去数 × 10 × 2^(連鎖数 - 1)
```

| 連鎖数 | 倍率 |
|--------|------|
| 1連鎖 | ×1 |
| 2連鎖 | ×2 |
| 3連鎖 | ×4 |
| n連鎖 | ×2^(n-1) |

- ベストスコアは `localStorage` の `puyo-best` キーに永続化

---

### レベル・速度

| レベル | 必要スコア | 落下間隔 |
|--------|-----------|----------|
| 1 | 0〜999 | 500ms |
| 2 | 1000〜1999 | 460ms |
| 3 | 2000〜2999 | 420ms |
| … | … | … |
| 最大 | — | 80ms（下限） |

計算式: `Math.max(80, 500 - (level - 1) * 40)` ms

---

### ゲームオーバー

新しいペアのスポーン位置（row=1, col=2 およびサブ位置）が既存ぷよと重なった場合にゲームオーバー。

---

### UI・ビジュアル

| 要素 | 仕様 |
|------|------|
| テーマ | スペース/コスモス系ダーク背景（放射状グラデーション） |
| ぷよ形状 | 円形、放射状グラデーション + グロー（`box-shadow`） |
| 空マス | 暗色の半透明円 |
| ゴースト | 白系破線円（20〜25%透明度） |
| 左パネル | Score / Best / Level の3カード |
| 右パネル | Next（次のペアを縦2個で表示）+ 操作説明 |
| オーバーレイ | 初回=「ぷよぷよ + START」、ゲームオーバー時=「スコア + GAME OVER + RETRY」 |
| スタイル手法 | Tailwindはレイアウト系のみ使用。ぷよの色・グロー・背景は全て `style` prop（インライン）で実装 |

---

### 実装上の制約・方針

- **単一ファイル原則**: ゲームロジック・型定義・Reactコンポーネント全てを `PuyoGame.tsx` に集約する
- **純粋関数分離**: `fits()`, `resolveChains()`, `applyGravity()` 等のゲームロジックは副作用なしの純粋関数として実装
- **状態管理**: `useReducer` で一元管理。アクション型: `START | TICK | LEFT | RIGHT | DOWN | ROTATE_CW | ROTATE_CCW | DROP | CLEAR_FLASH`
- **連鎖は同期処理**: 連鎖結果はreducer内で即時計算（フラッシュ表示は別途 `chainFlash` state で管理）
- **ゲームループ**: `setInterval` + `TICK` アクション。レベル変化時にインターバルを再生成
- **入力**: `window` の `keydown` イベントリスナー（`useEffect` で登録・クリーンアップ）
- **Tailwindの動的クラス禁止**: ぷよ色に動的Tailwindクラスは使わない（スキャン時に検出されないため）

---

### 連鎖フラッシュ表示

- 連鎖発生時、ボード中央に「n連鎖！」を1.5秒表示する（`ChainFlashOverlay` コンポーネント）
- `GameState.chainFlash: { count: number; generation: number } | null`
  - `count`: 連鎖数、`generation`: 同一連鎖数の連続再トリガーに使うカウンタ
- `<ChainFlashOverlay key={generation}>` とすることで世代ごとにDOMを再マウント → CSSアニメーションが毎回リセット
- タイマー: `useEffect` 内の `setTimeout(1500ms)` で `CLEAR_FLASH` をディスパッチ。依存値は `generation`（primitive）のみ
- 色: 1連鎖=white `#ffffff`、2連鎖=cyan `#00eeff`、3連鎖=yellow `#ffee00`、4連鎖以上=gold `#ffaa00`
- CSSアニメーション: `globals.css` の `.chain-flash-text` クラスで定義
  - `chain-scale-in` (0.35s) → 表示 (0.75s) → `chain-fade-out` (0.4s) = 合計1.5s

---

### サウンドエフェクト（Web Audio API）

- 外部ファイル不使用。`createSoundEngine()` 関数が `AudioContext` を生成してエンジンオブジェクトを返す
- `AudioContext` は初回ユーザーインタラクション（START / RETRY ボタンまたは Enter キー）後に生成（autoplay policy 対応）
- エンジンは `soundEngineRef = useRef<SoundEngine | null>(null)` で保持し、`ensureSoundEngine()` で遅延初期化
- **ロック音** (`chains=0` のロック): sine 80 Hz、attack 5ms、decay 120ms
  - `GameState.lockSeq: number` が chains=0 のロックごとにインクリメント → sound `useEffect` がトリガー
- **連鎖音** (chains>0): triangle 波、C4(261Hz)から完全4度(×1.334)ずつ上昇するトーンを連鎖数分（最大4音）、各0.18s遅延で順次再生
  - `GameState.chainFlash.generation` の変化を prev-ref と比較してトリガー
- **ゲームオーバー音**: sawtooth 440→110 Hz のピッチグライド、0.85s
  - `state.gameOver` の `false→true` 遷移を prev-ref で検出してトリガー
- 全音トリガーは単一の `useEffect([state.chainFlash, state.lockSeq, state.gameOver])` 内で処理
