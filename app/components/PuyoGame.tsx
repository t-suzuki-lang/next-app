'use client'

import { useReducer, useEffect, useMemo, useRef } from 'react'

// ─── Types ────────────────────────────────────────────────────────────────────

const COLORS = ['red', 'green', 'blue', 'yellow', 'purple'] as const
type PuyoColor = (typeof COLORS)[number]
type Cell = PuyoColor | null
type Rotation = 0 | 1 | 2 | 3

const COLS = 6
const ROWS = 13 // row 0 is hidden spawn row; rows 1–12 are visible
const VISIBLE = 12
const CELL = 44
const GAP = 2

interface Pair {
  mainColor: PuyoColor
  subColor: PuyoColor
  row: number
  col: number
  rotation: Rotation // 0=sub above, 1=sub right, 2=sub below, 3=sub left
}

interface NextColors {
  mainColor: PuyoColor
  subColor: PuyoColor
}

interface LandParticle {
  id: number
  cx: number; cy: number
  dx: number; dy: number
  color: string
  size: number
}

interface GameState {
  board: Cell[][]
  current: Pair | null
  next: NextColors
  score: number
  best: number
  gameOver: boolean
  started: boolean
  chainFlash: { count: number; generation: number } | null
  lockSeq: number // increments on each chain-free lock → triggers lock sound
  lockEffect: { cells: Array<{ row: number; col: number; color: PuyoColor }>; gen: number } | null
}

type Action =
  | { type: 'START' }
  | { type: 'TICK' }
  | { type: 'LEFT' }
  | { type: 'RIGHT' }
  | { type: 'DOWN' }
  | { type: 'ROTATE_CW' }
  | { type: 'ROTATE_CCW' }
  | { type: 'DROP' }
  | { type: 'CLEAR_FLASH' }
  | { type: 'INITIALIZE'; best: number; next: NextColors }

// ─── Pure game logic ──────────────────────────────────────────────────────────

const rng = (): PuyoColor => COLORS[Math.floor(Math.random() * COLORS.length)]
const randNext = (): NextColors => ({ mainColor: rng(), subColor: rng() })
const emptyBoard = (): Cell[][] =>
  Array.from({ length: ROWS }, () => Array<Cell>(COLS).fill(null))

function subPos(p: Pair): [number, number] {
  if (p.rotation === 0) return [p.row - 1, p.col]
  if (p.rotation === 1) return [p.row, p.col + 1]
  if (p.rotation === 2) return [p.row + 1, p.col]
  return [p.row, p.col - 1]
}

function inBounds(r: number, c: number) {
  return r >= 0 && r < ROWS && c >= 0 && c < COLS
}

function fits(board: Cell[][], p: Pair): boolean {
  const [sr, sc] = subPos(p)
  return (
    inBounds(p.row, p.col) &&
    inBounds(sr, sc) &&
    !board[p.row][p.col] &&
    !board[sr][sc]
  )
}

function tryRotate(board: Cell[][], p: Pair, dir: 'cw' | 'ccw'): Pair {
  const rot = ((p.rotation + (dir === 'cw' ? 1 : 3)) % 4) as Rotation
  const next = { ...p, rotation: rot }
  if (fits(board, next)) return next
  for (const kick of [-1, 1]) {
    const kicked = { ...next, col: next.col + kick }
    if (fits(board, kicked)) return kicked
  }
  return p
}

function lockToBoard(board: Cell[][], p: Pair): Cell[][] {
  const b = board.map((r) => [...r])
  const [sr, sc] = subPos(p)
  b[p.row][p.col] = p.mainColor
  b[sr][sc] = p.subColor
  return b
}

function applyGravity(board: Cell[][]): Cell[][] {
  const b = board.map((r) => [...r])
  for (let c = 0; c < COLS; c++) {
    let w = ROWS - 1
    for (let r = ROWS - 1; r >= 0; r--) {
      if (b[r][c]) {
        b[w][c] = b[r][c]
        if (w !== r) b[r][c] = null
        w--
      }
    }
  }
  return b
}

function findGroups(board: Cell[][]): [number, number][][] {
  const seen = Array.from({ length: ROWS }, () => Array(COLS).fill(false))
  const result: [number, number][][] = []
  const dirs: [number, number][] = [
    [0, 1],
    [0, -1],
    [1, 0],
    [-1, 0],
  ]
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      if (seen[r][c] || !board[r][c]) continue
      const color = board[r][c]
      const cells: [number, number][] = []
      const q: [number, number][] = [[r, c]]
      seen[r][c] = true
      while (q.length) {
        const [cr, cc] = q.shift()!
        cells.push([cr, cc])
        for (const [dr, dc] of dirs) {
          const [nr, nc] = [cr + dr, cc + dc]
          if (inBounds(nr, nc) && !seen[nr][nc] && board[nr][nc] === color) {
            seen[nr][nc] = true
            q.push([nr, nc])
          }
        }
      }
      if (cells.length >= 4) result.push(cells)
    }
  }
  return result
}

function resolveChains(initial: Cell[][]): { board: Cell[][]; gained: number; chains: number } {
  let board = initial
  let gained = 0
  let chain = 0
  for (;;) {
    const gs = findGroups(board)
    if (!gs.length) break
    chain++
    let cleared = 0
    const b = board.map((r) => [...r])
    for (const g of gs) {
      for (const [r, c] of g) {
        b[r][c] = null
        cleared++
      }
    }
    board = applyGravity(b)
    gained += cleared * 10 * (1 << (chain - 1))
  }
  return { board, gained, chains: chain }
}

function spawnPair(colors: NextColors): Pair {
  return { ...colors, row: 1, col: 2, rotation: 0 }
}

function lockAndAdvance(state: GameState): GameState {
  if (!state.current) return state
  const cur = state.current
  const [sr, sc] = subPos(cur)
  const lockCells: Array<{ row: number; col: number; color: PuyoColor }> = [
    { row: cur.row, col: cur.col, color: cur.mainColor },
    { row: sr, col: sc, color: cur.subColor },
  ]
  const lockEffect = {
    cells: lockCells.filter(({ row }) => row >= 1),
    gen: (state.lockEffect?.gen ?? 0) + 1,
  }
  const locked = lockToBoard(state.board, cur)
  const settled = applyGravity(locked) // settle any floating puyos before resolving chains
  const { board, gained, chains } = resolveChains(settled)
  const score = state.score + gained
  const best = Math.max(state.best, score)
  const newCurrent = spawnPair(state.next)
  const newNext = randNext()
  const chainFlash =
    chains > 0
      ? { count: chains, generation: (state.chainFlash?.generation ?? 0) + 1 }
      : null
  const lockSeq = chains === 0 ? state.lockSeq + 1 : state.lockSeq
  if (!fits(board, newCurrent)) {
    return { ...state, board, score, best, gameOver: true, current: null, chainFlash, lockSeq, lockEffect }
  }
  return {
    board, current: newCurrent, next: newNext, score, best,
    gameOver: false, started: true, chainFlash, lockSeq, lockEffect,
  }
}

// ─── Reducer ──────────────────────────────────────────────────────────────────

function reducer(state: GameState, action: Action): GameState {
  // CLEAR_FLASH must be handled before the gameOver guard so it works post-game-over
  if (action.type === 'CLEAR_FLASH') return { ...state, chainFlash: null }

  if (action.type === 'INITIALIZE') {
    return {
      ...state,
      best: action.best,
      next: action.next,
    }
  }

  if (action.type === 'START') {
    return {
      board: emptyBoard(),
      current: spawnPair(randNext()),
      next: randNext(),
      score: 0,
      best: state.best,
      gameOver: false,
      started: true,
      chainFlash: null,
      lockSeq: 0,
      lockEffect: null,
    }
  }
  if (state.gameOver || !state.current) return state
  switch (action.type) {
    case 'LEFT': {
      const p = { ...state.current, col: state.current.col - 1 }
      return fits(state.board, p) ? { ...state, current: p } : state
    }
    case 'RIGHT': {
      const p = { ...state.current, col: state.current.col + 1 }
      return fits(state.board, p) ? { ...state, current: p } : state
    }
    case 'TICK':
    case 'DOWN': {
      const p = { ...state.current, row: state.current.row + 1 }
      return fits(state.board, p) ? { ...state, current: p } : lockAndAdvance(state)
    }
    case 'ROTATE_CW':
      return { ...state, current: tryRotate(state.board, state.current, 'cw') }
    case 'ROTATE_CCW':
      return { ...state, current: tryRotate(state.board, state.current, 'ccw') }
    case 'DROP': {
      let p = state.current
      while (fits(state.board, { ...p, row: p.row + 1 })) p = { ...p, row: p.row + 1 }
      return lockAndAdvance({ ...state, current: p })
    }
    default:
      return state
  }
}

function init(): GameState {
  return {
    board: emptyBoard(),
    current: null,
    next: { mainColor: 'red', subColor: 'red' }, // Deterministic initial colors
    score: 0,
    best: 0,
    gameOver: true,
    started: false,
    chainFlash: null,
    lockSeq: 0,
    lockEffect: null,
  }
}

// ─── Sound engine ─────────────────────────────────────────────────────────────

interface SoundEngine {
  playLock(): void
  playClear(chains: number): void
  playGameOver(): void
}

function createSoundEngine(): SoundEngine {
  const ctx = new AudioContext()

  function playTone(
    freq: number,
    type: OscillatorType,
    peak: number,
    attack: number,
    decay: number,
    offset = 0,
  ) {
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.connect(gain)
    gain.connect(ctx.destination)
    osc.type = type
    osc.frequency.setValueAtTime(freq, ctx.currentTime + offset)
    gain.gain.setValueAtTime(0, ctx.currentTime + offset)
    gain.gain.linearRampToValueAtTime(peak, ctx.currentTime + offset + attack)
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + offset + attack + decay)
    osc.start(ctx.currentTime + offset)
    osc.stop(ctx.currentTime + offset + attack + decay + 0.05)
  }

  return {
    playLock() {
      playTone(80, 'sine', 0.4, 0.005, 0.12)
    },
    playClear(chains: number) {
      const n = Math.min(chains, 4)
      for (let i = 0; i < n; i++) {
        // Ascending by a perfect fourth (~4/3) per chain step, base = C4 (261 Hz)
        playTone(261 * Math.pow(1.334, i), 'triangle', 0.35, 0.01, 0.25, i * 0.18)
      }
    },
    playGameOver() {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.connect(gain)
      gain.connect(ctx.destination)
      osc.type = 'sawtooth'
      osc.frequency.setValueAtTime(440, ctx.currentTime)
      osc.frequency.exponentialRampToValueAtTime(110, ctx.currentTime + 0.8)
      gain.gain.setValueAtTime(0.3, ctx.currentTime)
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.85)
      osc.start()
      osc.stop(ctx.currentTime + 0.9)
    },
  }
}

// ─── Visual styles ────────────────────────────────────────────────────────────

const PUYO_STYLE: Record<PuyoColor, React.CSSProperties> = {
  red: {
    background: 'radial-gradient(circle at 35% 30%, #ff9999 0%, #cc0000 100%)',
    boxShadow: '0 0 14px #ff000055, inset 0 1px 4px rgba(255,200,200,0.5)',
  },
  green: {
    background: 'radial-gradient(circle at 35% 30%, #99ff99 0%, #007700 100%)',
    boxShadow: '0 0 14px #00ff0055, inset 0 1px 4px rgba(200,255,200,0.5)',
  },
  blue: {
    background: 'radial-gradient(circle at 35% 30%, #aaccff 0%, #0033cc 100%)',
    boxShadow: '0 0 14px #0055ff55, inset 0 1px 4px rgba(200,220,255,0.5)',
  },
  yellow: {
    background: 'radial-gradient(circle at 35% 30%, #ffff88 0%, #cc8800 100%)',
    boxShadow: '0 0 14px #ffcc0055, inset 0 1px 4px rgba(255,255,180,0.5)',
  },
  purple: {
    background: 'radial-gradient(circle at 35% 30%, #dd99ff 0%, #6600bb 100%)',
    boxShadow: '0 0 14px #9900ff55, inset 0 1px 4px rgba(220,190,255,0.5)',
  },
}

const CHAIN_COLOR: Record<number, string> = { 1: '#ffffff', 2: '#00eeff', 3: '#ffee00' }
const chainColor = (n: number) => CHAIN_COLOR[n] ?? '#ffaa00'

const PARTICLE_COLOR: Record<PuyoColor, string> = {
  red:    'rgba(255,110,90,0.92)',
  green:  'rgba(90,230,90,0.92)',
  blue:   'rgba(90,190,255,0.92)',
  yellow: 'rgba(255,240,70,0.92)',
  purple: 'rgba(200,90,255,0.92)',
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function PuyoFace({ color }: { color: PuyoColor }) {
  const s: React.CSSProperties = { position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }
  switch (color) {
    case 'red':
      return (
        <svg viewBox="0 0 44 44" style={s}>
          {/* Angry eyebrows — angled inward */}
          <line x1="8" y1="13" x2="20" y2="17" stroke="#1a1a2e" strokeWidth="2.5" strokeLinecap="round" />
          <line x1="24" y1="17" x2="36" y2="13" stroke="#1a1a2e" strokeWidth="2.5" strokeLinecap="round" />
          {/* Eye whites */}
          <ellipse cx="15" cy="22" rx="6" ry="6.5" fill="white" opacity="0.95" />
          <ellipse cx="29" cy="22" rx="6" ry="6.5" fill="white" opacity="0.95" />
          {/* Pupils — shifted down under brows */}
          <circle cx="16" cy="23" r="3.8" fill="#1a1a2e" />
          <circle cx="30" cy="23" r="3.8" fill="#1a1a2e" />
          {/* Shines */}
          <circle cx="17.5" cy="21" r="1.8" fill="white" />
          <circle cx="31.5" cy="21" r="1.8" fill="white" />
          {/* Tight determined smile */}
          <path d="M 16 31 Q 22 34 28 31" stroke="rgba(0,0,0,0.5)" strokeWidth="2" fill="none" strokeLinecap="round" />
        </svg>
      )
    case 'green':
      return (
        <svg viewBox="0 0 44 44" style={s}>
          {/* Happy crescent arch eyes */}
          <path d="M 9 20 Q 15 12 21 20" stroke="#1a1a2e" strokeWidth="2.8" fill="none" strokeLinecap="round" />
          <path d="M 23 20 Q 29 12 35 20" stroke="#1a1a2e" strokeWidth="2.8" fill="none" strokeLinecap="round" />
          {/* Big wide smile */}
          <path d="M 12 27 Q 22 38 32 27" stroke="rgba(0,0,0,0.5)" strokeWidth="2.5" fill="none" strokeLinecap="round" />
          {/* Big rosy cheeks */}
          <ellipse cx="8" cy="29" rx="6.5" ry="4.5" fill="rgba(255,100,130,0.45)" />
          <ellipse cx="36" cy="29" rx="6.5" ry="4.5" fill="rgba(255,100,130,0.45)" />
        </svg>
      )
    case 'blue':
      return (
        <svg viewBox="0 0 44 44" style={s}>
          {/* Sad eyebrows — raised inner corners */}
          <path d="M 8 16 Q 14 12 20 16" stroke="#1a1a2e" strokeWidth="2.2" fill="none" strokeLinecap="round" />
          <path d="M 24 16 Q 30 12 36 16" stroke="#1a1a2e" strokeWidth="2.2" fill="none" strokeLinecap="round" />
          {/* Eye whites */}
          <ellipse cx="15" cy="22" rx="6" ry="7" fill="white" opacity="0.95" />
          <ellipse cx="29" cy="22" rx="6" ry="7" fill="white" opacity="0.95" />
          {/* Pupils */}
          <circle cx="15" cy="23" r="3.8" fill="#1a1a2e" />
          <circle cx="29" cy="23" r="3.8" fill="#1a1a2e" />
          {/* Shines */}
          <circle cx="16.5" cy="21" r="1.8" fill="white" />
          <circle cx="30.5" cy="21" r="1.8" fill="white" />
          {/* Frown */}
          <path d="M 15 32 Q 22 27 29 32" stroke="rgba(0,0,0,0.45)" strokeWidth="2" fill="none" strokeLinecap="round" />
          {/* Teardrops */}
          <ellipse cx="11" cy="30" rx="2" ry="3" fill="rgba(100,180,255,0.7)" />
          <ellipse cx="33" cy="30" rx="2" ry="3" fill="rgba(100,180,255,0.7)" />
        </svg>
      )
    case 'yellow':
      return (
        <svg viewBox="0 0 44 44" style={s}>
          {/* Raised eyebrows high */}
          <path d="M 8 12 Q 15 9 21 12" stroke="#1a1a2e" strokeWidth="2" fill="none" strokeLinecap="round" />
          <path d="M 23 12 Q 29 9 36 12" stroke="#1a1a2e" strokeWidth="2" fill="none" strokeLinecap="round" />
          {/* Wide surprised eyes */}
          <ellipse cx="15" cy="22" rx="7" ry="8" fill="white" opacity="0.95" />
          <ellipse cx="29" cy="22" rx="7" ry="8" fill="white" opacity="0.95" />
          {/* Pupils — smaller to look wide-eyed */}
          <circle cx="15" cy="22" r="3.5" fill="#1a1a2e" />
          <circle cx="29" cy="22" r="3.5" fill="#1a1a2e" />
          {/* Large shines */}
          <circle cx="17" cy="20" r="2.2" fill="white" />
          <circle cx="31" cy="20" r="2.2" fill="white" />
          {/* O-shaped open mouth */}
          <ellipse cx="22" cy="33" rx="4" ry="4.5" fill="rgba(200,30,30,0.75)" />
          {/* Dot blush marks */}
          <circle cx="8" cy="29" r="2.5" fill="rgba(255,120,140,0.5)" />
          <circle cx="36" cy="29" r="2.5" fill="rgba(255,120,140,0.5)" />
        </svg>
      )
    case 'purple':
      return (
        <svg viewBox="0 0 44 44" style={s}>
          {/* Left brow — slightly raised mischievous */}
          <path d="M 8 15 Q 14 12 20 15" stroke="#1a1a2e" strokeWidth="2.2" fill="none" strokeLinecap="round" />
          {/* Right brow — arched high */}
          <path d="M 24 13 Q 30 9 36 14" stroke="#1a1a2e" strokeWidth="2.2" fill="none" strokeLinecap="round" />
          {/* Left eye — normal open */}
          <ellipse cx="15" cy="22" rx="6" ry="7" fill="white" opacity="0.95" />
          <circle cx="15.5" cy="23" r="3.8" fill="#1a1a2e" />
          <circle cx="17" cy="21" r="1.8" fill="white" />
          {/* Right eye — winking crescent */}
          <path d="M 23 22 Q 29 30 35 22" stroke="#1a1a2e" strokeWidth="2.8" fill="none" strokeLinecap="round" />
          {/* Asymmetric smirk */}
          <path d="M 15 31 Q 22 35 30 29" stroke="rgba(0,0,0,0.5)" strokeWidth="2" fill="none" strokeLinecap="round" />
          {/* Small tongue */}
          <ellipse cx="24" cy="34" rx="3" ry="2.2" fill="rgba(255,100,130,0.75)" />
        </svg>
      )
  }
}

function PuyoCircle({ color, size }: { color: Cell | 'ghost'; size: number }) {
  if (!color) {
    return (
      <div
        style={{ width: size, height: size, borderRadius: '50%', background: 'rgba(15,15,40,0.5)' }}
      />
    )
  }
  if (color === 'ghost') {
    return (
      <div
        style={{
          width: size,
          height: size,
          borderRadius: '50%',
          border: '2px dashed rgba(180,180,255,0.25)',
          boxSizing: 'border-box',
        }}
      />
    )
  }
  return (
    <div
      style={{
        position: 'relative',
        width: size,
        height: size,
        borderRadius: '50%',
        overflow: 'hidden',
        ...PUYO_STYLE[color],
      }}
    >
      <PuyoFace color={color} />
    </div>
  )
}

function InfoCard({ label, value }: { label: string; value: string }) {
  return (
    <div
      style={{
        background: 'rgba(8,8,30,0.85)',
        border: '1px solid rgba(90,90,180,0.4)',
        borderRadius: 10,
        padding: '10px 14px',
        minWidth: 110,
      }}
    >
      <div
        style={{
          color: '#7777bb',
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: '0.12em',
          marginBottom: 4,
          textTransform: 'uppercase',
        }}
      >
        {label}
      </div>
      <div
        style={{
          color: '#fff',
          fontSize: 22,
          fontWeight: 700,
          fontFamily: 'monospace',
          letterSpacing: '0.04em',
        }}
      >
        {value}
      </div>
    </div>
  )
}

function ScorePanel({ score, best, level }: { score: number; best: number; level: number }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 120 }}>
      <InfoCard label="Score" value={score.toLocaleString()} />
      <InfoCard label="Best" value={best.toLocaleString()} />
      <InfoCard label="Level" value={String(level)} />
    </div>
  )
}

function RightPanel({ next }: { next: NextColors }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 110 }}>
      <div
        style={{
          background: 'rgba(8,8,30,0.85)',
          border: '1px solid rgba(90,90,180,0.4)',
          borderRadius: 10,
          padding: '10px 14px',
        }}
      >
        <div
          style={{
            color: '#7777bb',
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: '0.12em',
            marginBottom: 10,
            textTransform: 'uppercase',
          }}
        >
          Next
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
          <PuyoCircle color={next.subColor} size={36} />
          <PuyoCircle color={next.mainColor} size={36} />
        </div>
      </div>
      <div
        style={{
          background: 'rgba(8,8,30,0.85)',
          border: '1px solid rgba(90,90,180,0.4)',
          borderRadius: 10,
          padding: '10px 14px',
          fontSize: 11,
          color: '#6666aa',
          lineHeight: 2,
        }}
      >
        <div style={{ fontWeight: 700, color: '#9999cc', marginBottom: 2, fontSize: 10, letterSpacing: '0.1em' }}>
          CONTROLS
        </div>
        <div>← → 移動</div>
        <div>↓ 軟着地</div>
        <div>↑ / Z 右回転</div>
        <div>X 左回転</div>
        <div>Space 急降下</div>
        <div>Enter リスタート</div>
      </div>
    </div>
  )
}

function GameBoard({ board }: { board: (Cell | 'ghost')[][] }) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: `repeat(${COLS}, ${CELL}px)`,
        gap: GAP,
        padding: 10,
        background: 'rgba(4,4,18,0.92)',
        borderRadius: 14,
        border: '1px solid rgba(70,70,150,0.5)',
        boxShadow:
          '0 0 50px rgba(70,70,200,0.12), 0 0 0 1px rgba(50,50,100,0.3), inset 0 0 40px rgba(0,0,10,0.8)',
      }}
    >
      {board.map((row, r) =>
        row.map((cell, c) => <PuyoCircle key={`${r}-${c}`} color={cell} size={CELL} />)
      )}
    </div>
  )
}

function ChainFlashOverlay({ flash }: { flash: { count: number; generation: number } }) {
  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        pointerEvents: 'none',
        zIndex: 10,
      }}
    >
      <div className="chain-flash-text" style={{ color: chainColor(flash.count) }}>
        {flash.count}連鎖！
      </div>
    </div>
  )
}

function GameOverlay({
  started,
  score,
  onStart,
}: {
  started: boolean
  score: number
  onStart: () => void
}) {
  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: 14,
        background: 'rgba(0,0,12,0.88)',
        backdropFilter: 'blur(6px)',
        gap: 12,
        zIndex: 20,
      }}
    >
      {started && (
        <>
          <div style={{ color: '#8888bb', fontSize: 11, letterSpacing: '0.12em', textTransform: 'uppercase' }}>
            Score
          </div>
          <div style={{ color: '#fff', fontSize: 32, fontWeight: 700, fontFamily: 'monospace', marginTop: -8 }}>
            {score.toLocaleString()}
          </div>
        </>
      )}
      <div
        style={{
          color: '#cc88ff',
          fontSize: started ? 22 : 28,
          fontWeight: 800,
          letterSpacing: '0.06em',
          textShadow: '0 0 20px rgba(180,100,255,0.8)',
          marginTop: started ? 4 : 0,
        }}
      >
        {started ? 'GAME OVER' : 'ぷよぷよ'}
      </div>
      <button
        onClick={onStart}
        style={{
          background: 'linear-gradient(135deg, #5533cc 0%, #aa33ff 100%)',
          color: '#fff',
          border: 'none',
          borderRadius: 8,
          padding: '12px 32px',
          fontSize: 14,
          fontWeight: 700,
          cursor: 'pointer',
          boxShadow: '0 0 24px rgba(140,70,255,0.55)',
          letterSpacing: '0.08em',
          marginTop: 4,
          transition: 'transform 0.1s ease',
        }}
        onMouseDown={(e) => (e.currentTarget.style.transform = 'scale(0.96)')}
        onMouseUp={(e) => (e.currentTarget.style.transform = 'scale(1)')}
      >
        {started ? 'RETRY' : 'START'}
      </button>
      <div style={{ color: '#44446a', fontSize: 11 }}>or press Enter</div>
    </div>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function PuyoGame() {
  const [state, dispatch] = useReducer(reducer, undefined, init)

  const soundEngineRef = useRef<SoundEngine | null>(null)
  const prevGenerationRef = useRef(-1)
  const prevLockSeqRef = useRef(0)
  const prevGameOverRef = useRef(false)

  function ensureSoundEngine() {
    if (!soundEngineRef.current) soundEngineRef.current = createSoundEngine()
    return soundEngineRef.current
  }

  const level = Math.floor(state.score / 1000) + 1
  const tickMs = Math.max(200, 800 - (level - 1) * 40)

  // Client-side initialization to avoid hydration mismatch
  useEffect(() => {
    const savedBest = parseInt(localStorage.getItem('puyo-best') ?? '0', 10) || 0
    dispatch({ type: 'INITIALIZE', best: savedBest, next: randNext() })
  }, [])

  // Game tick
  useEffect(() => {
    if (state.gameOver) return
    const id = setInterval(() => dispatch({ type: 'TICK' }), tickMs)
    return () => clearInterval(id)
  }, [state.gameOver, tickMs])

  // Keyboard input
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      switch (e.code) {
        case 'ArrowLeft':
          e.preventDefault()
          dispatch({ type: 'LEFT' })
          break
        case 'ArrowRight':
          e.preventDefault()
          dispatch({ type: 'RIGHT' })
          break
        case 'ArrowDown':
          e.preventDefault()
          dispatch({ type: 'DOWN' })
          break
        case 'ArrowUp':
        case 'KeyZ':
          e.preventDefault()
          dispatch({ type: 'ROTATE_CW' })
          break
        case 'KeyX':
          e.preventDefault()
          dispatch({ type: 'ROTATE_CCW' })
          break
        case 'Space':
          e.preventDefault()
          dispatch({ type: 'DROP' })
          break
        case 'Enter':
          if (state.gameOver) {
            ensureSoundEngine()
            dispatch({ type: 'START' })
          }
          break
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [state.gameOver])

  // Persist best score
  useEffect(() => {
    localStorage.setItem('puyo-best', String(state.best))
  }, [state.best])

  // Sound effects: compare prev-refs to detect state transitions
  useEffect(() => {
    const engine = soundEngineRef.current
    if (!engine) return

    if (state.gameOver && !prevGameOverRef.current) engine.playGameOver()
    prevGameOverRef.current = state.gameOver

    if (state.chainFlash && state.chainFlash.generation !== prevGenerationRef.current) {
      prevGenerationRef.current = state.chainFlash.generation
      engine.playClear(state.chainFlash.count)
    }

    if (state.lockSeq !== prevLockSeqRef.current) {
      prevLockSeqRef.current = state.lockSeq
      engine.playLock()
    }
  }, [state.chainFlash, state.lockSeq, state.gameOver])

  // Chain flash auto-dismiss after 1.5s
  // Extract generation as a primitive so consecutive same-count flashes each get a fresh timer
  const flashGeneration = state.chainFlash?.generation
  useEffect(() => {
    if (flashGeneration === undefined) return
    const id = setTimeout(() => dispatch({ type: 'CLEAR_FLASH' }), 1500)
    return () => clearTimeout(id)
  }, [flashGeneration])

  // Derive landing particles from lockEffect (no useState/useEffect needed; CSS handles fade)
  const particles = useMemo((): LandParticle[] => {
    if (!state.lockEffect) return []
    const { cells, gen } = state.lockEffect
    const result: LandParticle[] = []
    let idx = 0
    for (const { row, col, color } of cells) {
      const vr = row - 1
      if (vr < 0 || vr >= VISIBLE) continue
      const cx = 10 + col * (CELL + GAP) + CELL / 2
      const cy = 10 + vr * (CELL + GAP) + CELL / 2
      for (let i = 0; i < 8; i++) {
        const angle = (i / 8) * Math.PI * 2
        // Deterministic pseudo-random: varies per lock, position, and particle index
        const seed = Math.abs(Math.sin(gen * 31 + col * 7 + row * 13 + i * 19))
        const dist = 15 + seed * 13
        result.push({
          id: gen * 200 + idx++,
          cx, cy,
          dx: Math.cos(angle) * dist,
          dy: Math.sin(angle) * dist,
          color: PARTICLE_COLOR[color],
          size: 2.5 + seed * 1.5,
        })
      }
    }
    return result
  }, [state.lockEffect])

  // Build display board: locked board + ghost + current piece (visible rows only)
  const { board: stateBoard, current: stateCurrent, gameOver: stateGameOver } = state
  const displayBoard = useMemo(() => {
    const board: (Cell | 'ghost')[][] = stateBoard
      .slice(1)
      .map((r) => [...r] as (Cell | 'ghost')[])

    if (!stateCurrent || stateGameOver) return board

    const toVis = (r: number) => r - 1 // internal row → visible row index

    // Calculate ghost drop position
    let ghost = stateCurrent
    while (fits(stateBoard, { ...ghost, row: ghost.row + 1 })) {
      ghost = { ...ghost, row: ghost.row + 1 }
    }

    const placeGhost = (r: number, c: number) => {
      const vr = toVis(r)
      if (vr >= 0 && vr < VISIBLE && c >= 0 && c < COLS && board[vr][c] === null)
        board[vr][c] = 'ghost'
    }
    placeGhost(ghost.row, ghost.col)
    const [gsr, gsc] = subPos(ghost)
    placeGhost(gsr, gsc)

    const placePiece = (r: number, c: number, color: PuyoColor) => {
      const vr = toVis(r)
      if (vr >= 0 && vr < VISIBLE && c >= 0 && c < COLS) board[vr][c] = color
    }
    placePiece(stateCurrent.row, stateCurrent.col, stateCurrent.mainColor)
    const [sr, sc] = subPos(stateCurrent)
    placePiece(sr, sc, stateCurrent.subColor)

    return board
  }, [stateBoard, stateCurrent, stateGameOver])

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
        background: 'radial-gradient(ellipse at 50% 40%, #0c0c2e 0%, #020208 100%)',
        fontFamily: "'Segoe UI', system-ui, sans-serif",
      }}
    >
      <h1
        style={{
          color: '#fff',
          fontSize: 36,
          fontWeight: 800,
          marginBottom: 20,
          letterSpacing: '0.08em',
          textShadow: '0 0 24px rgba(160,100,255,0.7), 0 2px 8px rgba(0,0,0,0.5)',
        }}
      >
        ぷよぷよ
      </h1>

      <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
        <ScorePanel score={state.score} best={state.best} level={level} />

        <div style={{ position: 'relative' }}>
          <GameBoard board={displayBoard} />
          {particles.map(p => (
            <div
              key={p.id}
              style={{
                position: 'absolute',
                left: p.cx,
                top: p.cy,
                width: p.size * 2,
                height: p.size * 2,
                borderRadius: '50%',
                background: p.color,
                boxShadow: `0 0 ${p.size * 2}px ${p.color}`,
                animation: 'droplet-burst 0.45s ease-out forwards',
                '--pdx': `${p.dx}px`,
                '--pdy': `${p.dy}px`,
                pointerEvents: 'none',
                zIndex: 5,
              } as React.CSSProperties}
            />
          ))}
          {state.chainFlash && (
            <ChainFlashOverlay
              key={state.chainFlash.generation}
              flash={state.chainFlash}
            />
          )}
          {state.gameOver && (
            <GameOverlay
              started={state.started}
              score={state.score}
              onStart={() => {
                ensureSoundEngine()
                dispatch({ type: 'START' })
              }}
            />
          )}
        </div>

        <RightPanel next={state.next} />
      </div>
    </div>
  )
}
