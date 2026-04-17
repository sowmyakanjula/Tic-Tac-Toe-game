import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Client,
  type MatchData,
  type MatchmakerMatched,
  type Session,
  type Socket,
} from '@heroiclabs/nakama-js'
import './App.css'

const host = import.meta.env.VITE_NAKAMA_HOST ?? '127.0.0.1'
const port = String(import.meta.env.VITE_NAKAMA_PORT ?? 7350)
const serverKey = import.meta.env.VITE_NAKAMA_SERVER_KEY ?? 'defaultkey'
const useSSL = String(import.meta.env.VITE_NAKAMA_USE_SSL ?? 'false') === 'true'

const STORAGE_KEYS = {
  deviceId: 'lila-device-id',
  username: 'lila-username',
}

const OP_CODES = {
  state: 1,
  error: 2,
  move: 10,
} as const

type GameMode = 'classic' | 'timed'
type MatchStatus = 'idle' | 'waiting' | 'playing' | 'finished'
type Mark = 'X' | 'O'

type PlayerSnapshot = {
  userId: string
  username: string
  mark: Mark | null
  connected: boolean
}

type MatchSnapshot = {
  matchId: string
  status: MatchStatus
  mode: GameMode
  board: Array<Mark | null>
  currentTurn: Mark | null
  winnerMark: Mark | null
  winnerUserId: string | null
  winnerReason: string | null
  winningLine: number[]
  turnEndsAt: number | null
  players: PlayerSnapshot[]
  yourUserId: string | null
  yourMark: Mark | null
  canMove: boolean
  open: boolean
  message: string
}

type RoomItem = {
  matchId: string
  size: number
  mode: GameMode
  open: boolean
}

type LeaderboardEntry = {
  rank: number
  userId: string
  username: string
  wins: number
  losses: number
  draws: number
  streak: number
  bestStreak: number
}

type RpcEnvelope<T> = {
  payload?: string
} & T

const initialMatch: MatchSnapshot = {
  matchId: '',
  status: 'idle',
  mode: 'classic',
  board: Array<Mark | null>(9).fill(null),
  currentTurn: null,
  winnerMark: null,
  winnerUserId: null,
  winnerReason: null,
  winningLine: [],
  turnEndsAt: null,
  players: [],
  yourUserId: null,
  yourMark: null,
  canMove: false,
  open: false,
  message: 'Create a room or join matchmaking to begin.',
}

function randomId(prefix: string) {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`
}

function loadOrCreateDeviceId() {
  const existing = window.localStorage.getItem(STORAGE_KEYS.deviceId)
  if (existing) {
    return existing
  }

  const next = randomId('device')
  window.localStorage.setItem(STORAGE_KEYS.deviceId, next)
  return next
}

function loadOrCreateUsername() {
  const existing = window.localStorage.getItem(STORAGE_KEYS.username)
  if (existing) {
    return existing
  }

  const next = `Lila-${Math.random().toString(36).slice(2, 6)}`
  window.localStorage.setItem(STORAGE_KEYS.username, next)
  return next
}

function parsePayload<T>(value: unknown, fallback: T): T {
  if (!value || typeof value !== 'object' || !('payload' in value)) {
    return fallback
  }

  const payload = (value as RpcEnvelope<T>).payload
  if (!payload) {
    return fallback
  }

  try {
    return JSON.parse(payload) as T
  } catch {
    return fallback
  }
}

function App() {
  const clientRef = useRef<Client | null>(null)
  const socketRef = useRef<Socket | null>(null)
  const sessionRef = useRef<Session | null>(null)
  const mountedRef = useRef(true)
  const initialConnectDoneRef = useRef(false)
  const [username, setUsername] = useState(loadOrCreateUsername)
  const [mode, setMode] = useState<GameMode>('classic')
  const [connecting, setConnecting] = useState(false)
  const [connected, setConnected] = useState(false)
  const [notice, setNotice] = useState('Connecting to Nakama...')
  const [rooms, setRooms] = useState<RoomItem[]>([])
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([])
  const [matchState, setMatchState] = useState<MatchSnapshot>(initialMatch)
  const [matchmaking, setMatchmaking] = useState(false)
  const [lastUpdated, setLastUpdated] = useState('Not synced yet')
  const [timeNow, setTimeNow] = useState(Date.now())

  const activeTurnCountdown = useMemo(() => {
    if (!matchState.turnEndsAt) {
      return null
    }

    return Math.max(0, Math.ceil(matchState.turnEndsAt - timeNow / 1000))
  }, [matchState.turnEndsAt, timeNow])

  const refreshLobby = useCallback(async () => {
    const client = clientRef.current
    const session = sessionRef.current

    if (!client || !session) {
      return
    }

    try {
      const [roomsResponse, leaderboardResponse] = await Promise.all([
        client.rpc(session, 'list_matches', { mode }),
        client.rpc(session, 'get_leaderboard', {}),
      ])

      const roomPayload = parsePayload<{ matches: RoomItem[] }>(roomsResponse, { matches: [] })
      const leaderboardPayload = parsePayload<{ entries: LeaderboardEntry[] }>(leaderboardResponse, { entries: [] })
      setRooms(roomPayload.matches)
      setLeaderboard(leaderboardPayload.entries)
      setLastUpdated(new Date().toLocaleTimeString())
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown refresh error'
      setNotice(`Refresh failed: ${message}`)
    }
  }, [mode])

  const joinMatchedPair = useCallback(async (matched: MatchmakerMatched) => {
    const socket = socketRef.current
    if (!socket) {
      return
    }

    try {
      const match = await socket.joinMatch(undefined, matched.token)
      setMatchState((current) => ({
        ...current,
        matchId: match.match_id,
        mode,
      }))
      setNotice('Authoritative match joined.')
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown matchmaking join error'
      setNotice(`Could not join matchmade room: ${message}`)
    }
  }, [mode])

  const connect = useCallback(async () => {
    if (connecting) {
      return
    }

    setConnecting(true)
    setNotice('Connecting to Nakama...')

    try {
      const client = new Client(serverKey, host, port, useSSL)
      clientRef.current = client

      const nextUsername = username.trim() || loadOrCreateUsername()
      window.localStorage.setItem(STORAGE_KEYS.username, nextUsername)

      const session = await client.authenticateDevice(loadOrCreateDeviceId(), true, nextUsername)
      const socket = client.createSocket(useSSL, false)

      socket.ondisconnect = () => {
        if (!mountedRef.current) {
          return
        }

        setConnected(false)
        setNotice('Socket disconnected. Reconnect to continue.')
      }

      socket.onmatchdata = (message) => {
        handleMatchData(message)
      }

      socket.onmatchmakermatched = async (matched) => {
        setMatchmaking(false)
        setNotice('Opponent found. Joining authoritative match...')
        await joinMatchedPair(matched)
      }

      await socket.connect(session, true)

      sessionRef.current = session
      socketRef.current = socket

      if (!mountedRef.current) {
        return
      }

      setConnected(true)
      setNotice(`Connected as ${session.username}.`)
      setUsername(session.username ?? nextUsername)
      await refreshLobby()
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown connection error'
      setNotice(`Unable to connect: ${message}`)
      setConnected(false)
    } finally {
      if (mountedRef.current) {
        setConnecting(false)
      }
    }
  }, [connecting, joinMatchedPair, refreshLobby, username])

  useEffect(() => {
    mountedRef.current = true
    if (!initialConnectDoneRef.current) {
      initialConnectDoneRef.current = true
      void connect()
    }

    return () => {
      mountedRef.current = false
      socketRef.current?.disconnect(true)
    }
  }, [connect])

  useEffect(() => {
    if (!connected) {
      return
    }

    const intervalId = window.setInterval(() => {
      void refreshLobby()
      setTimeNow(Date.now())
    }, 4000)

    return () => window.clearInterval(intervalId)
  }, [connected, refreshLobby])

  useEffect(() => {
    const intervalId = window.setInterval(() => setTimeNow(Date.now()), 500)
    return () => window.clearInterval(intervalId)
  }, [])

  function handleMatchData(message: MatchData) {
    const decoded = new TextDecoder().decode(message.data)

    if (message.op_code === OP_CODES.error) {
      if (decoded) {
        try {
          const payload = JSON.parse(decoded) as { message?: string }
          setNotice(payload.message ?? 'Server rejected the action.')
        } catch {
          setNotice('Server rejected the action.')
        }
      }
      return
    }

    if (message.op_code !== OP_CODES.state) {
      return
    }

    try {
      const nextState = JSON.parse(decoded) as MatchSnapshot
      setMatchState(nextState)
      setNotice(nextState.message)
    } catch {
      setNotice('Received malformed match update from the server.')
    }
  }

  async function createRoom() {
    const client = clientRef.current
    const session = sessionRef.current
    const socket = socketRef.current
    if (!client || !session || !socket) {
      return
    }

    try {
      const response = await client.rpc(session, 'create_match', { mode })
      const payload = parsePayload<{ matchId: string }>(response, { matchId: '' })
      if (!payload.matchId) {
        throw new Error('Server did not return a match id.')
      }

      const match = await socket.joinMatch(payload.matchId)
      setMatchState((current) => ({
        ...current,
        matchId: match.match_id,
        mode,
      }))
      setNotice('Room created. Waiting for an opponent...')
      await refreshLobby()
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown room creation error'
      setNotice(`Could not create room: ${message}`)
    }
  }

  async function joinRoom(matchId: string) {
    const socket = socketRef.current
    if (!socket) {
      return
    }

    try {
      await socket.joinMatch(matchId)
      setNotice('Joined room successfully.')
      await refreshLobby()
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown join error'
      setNotice(`Could not join room: ${message}`)
    }
  }

  async function enterMatchmaking() {
    const socket = socketRef.current
    if (!socket) {
      return
    }

    try {
      setMatchmaking(true)
      await socket.addMatchmaker('*', 2, 2, { mode }, {})
      setNotice(`Matchmaking started for ${mode} mode.`)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown matchmaking error'
      setMatchmaking(false)
      setNotice(`Could not start matchmaking: ${message}`)
    }
  }

  async function sendMove(position: number) {
    const socket = socketRef.current
    if (!socket || !matchState.matchId || !matchState.canMove || matchState.board[position]) {
      return
    }

    try {
      await socket.sendMatchState(matchState.matchId, OP_CODES.move, JSON.stringify({ position }))
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown move error'
      setNotice(`Move failed: ${message}`)
    }
  }

  async function leaveMatch() {
    const socket = socketRef.current
    if (!socket || !matchState.matchId) {
      return
    }

    try {
      await socket.leaveMatch(matchState.matchId)
    } finally {
      setMatchState(initialMatch)
      setNotice('Left the current match.')
      await refreshLobby()
    }
  }

  const localPlayer = matchState.players.find((player) => player.userId === matchState.yourUserId) ?? null
  const opponent = matchState.players.find((player) => player.userId !== matchState.yourUserId) ?? null

  return (
    <main className="shell">
      <section className="hero">
        <div className="hero-copy">
          <p className="eyebrow">Lila Backend Assignment</p>
          <h1>Server-authoritative Tic-Tac-Toe with Nakama.</h1>
          <p className="lead">
            Create rooms, quick-match live opponents, and play in classic or timed mode with
            all move validation handled on the server.
          </p>
        </div>

        <div className="hero-card">
          <label className="field">
            <span>Player name</span>
            <input
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              placeholder="Enter a display name"
            />
          </label>

          <div className="mode-switch">
            <button
              className={mode === 'classic' ? 'active' : ''}
              onClick={() => setMode('classic')}
              type="button"
            >
              Classic
            </button>
            <button
              className={mode === 'timed' ? 'active' : ''}
              onClick={() => setMode('timed')}
              type="button"
            >
              Timed
            </button>
          </div>

          <div className="actions">
            <button onClick={() => void connect()} disabled={connecting} type="button">
              {connected ? 'Reconnect' : connecting ? 'Connecting...' : 'Connect'}
            </button>
            <button onClick={() => void createRoom()} disabled={!connected} type="button">
              Create room
            </button>
            <button onClick={() => void enterMatchmaking()} disabled={!connected || matchmaking} type="button">
              {matchmaking ? 'Finding opponent...' : 'Quick match'}
            </button>
          </div>

          <div className="status-strip">
            <span className={connected ? 'dot online' : 'dot offline'} />
            <span>{notice}</span>
          </div>
        </div>
      </section>

      <section className="dashboard">
        <article className="panel board-panel">
          <div className="panel-header">
            <div>
              <p className="panel-kicker">Live Match</p>
              <h2>{matchState.matchId ? 'Authoritative room active' : 'No active room yet'}</h2>
            </div>
            {matchState.matchId ? (
              <button className="secondary" onClick={() => void leaveMatch()} type="button">
                Leave match
              </button>
            ) : null}
          </div>

          <div className="match-meta">
            <div className="chip">Mode: {matchState.mode}</div>
            <div className="chip">Status: {matchState.status}</div>
            <div className="chip">
              Turn: {matchState.currentTurn ? `${matchState.currentTurn}` : 'Waiting'}
            </div>
            {activeTurnCountdown !== null ? <div className="chip">Timer: {activeTurnCountdown}s</div> : null}
          </div>

          <div className="players">
            <div className="player-card">
              <span className="player-label">You</span>
              <strong>{localPlayer?.username ?? 'Waiting...'}</strong>
              <span>{localPlayer?.mark ? `Mark ${localPlayer.mark}` : 'No mark assigned yet'}</span>
              <span>{localPlayer?.connected === false ? 'Disconnected' : 'Connected'}</span>
            </div>
            <div className="player-card">
              <span className="player-label">Opponent</span>
              <strong>{opponent?.username ?? 'Open slot'}</strong>
              <span>{opponent?.mark ? `Mark ${opponent.mark}` : 'Waiting for player'}</span>
              <span>{opponent?.connected === false ? 'Disconnected' : opponent ? 'Connected' : 'Pending'}</span>
            </div>
          </div>

          <div className="board">
            {matchState.board.map((cell, index) => (
              <button
                key={index}
                className={`tile ${matchState.winningLine.includes(index) ? 'winner' : ''}`}
                disabled={!matchState.canMove || Boolean(cell)}
                onClick={() => void sendMove(index)}
                type="button"
              >
                {cell}
              </button>
            ))}
          </div>

          <div className="summary">
            <p>{matchState.message}</p>
            {matchState.status === 'finished' ? (
              <p className="outcome">
                {matchState.winnerUserId
                  ? `${matchState.players.find((player) => player.userId === matchState.winnerUserId)?.username ?? 'A player'} won${matchState.winnerReason ? ` by ${matchState.winnerReason}` : ''}.`
                  : 'The match ended in a draw.'}
              </p>
            ) : null}
          </div>
        </article>

        <article className="panel">
          <div className="panel-header">
            <div>
              <p className="panel-kicker">Room Discovery</p>
              <h2>Open authoritative rooms</h2>
            </div>
            <button className="secondary" onClick={() => void refreshLobby()} type="button">
              Refresh
            </button>
          </div>

          <p className="meta-note">Last synced at {lastUpdated}</p>

          <div className="room-list">
            {rooms.length === 0 ? (
              <div className="empty-state">No open rooms for this mode right now.</div>
            ) : (
              rooms.map((room) => (
                <div key={room.matchId} className="room-row">
                  <div>
                    <strong>{room.mode === 'timed' ? 'Timed room' : 'Classic room'}</strong>
                    <p>{room.matchId}</p>
                  </div>
                  <div className="room-side">
                    <span>{room.size}/2 players</span>
                    <button onClick={() => void joinRoom(room.matchId)} type="button">
                      Join
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </article>

        <article className="panel">
          <div className="panel-header">
            <div>
              <p className="panel-kicker">Leaderboard</p>
              <h2>Top players</h2>
            </div>
          </div>

          <div className="leaderboard">
            {leaderboard.length === 0 ? (
              <div className="empty-state">Play a completed match to seed the rankings.</div>
            ) : (
              leaderboard.map((entry) => (
                <div key={entry.userId} className="leader-row">
                  <div>
                    <strong>
                      #{entry.rank} {entry.username}
                    </strong>
                    <p>
                      {entry.wins}W / {entry.losses}L / {entry.draws}D
                    </p>
                  </div>
                  <div className="leader-stats">
                    <span>Streak {entry.streak}</span>
                    <span>Best {entry.bestStreak}</span>
                  </div>
                </div>
              ))
            )}
          </div>
        </article>
      </section>
    </main>
  )
}

export default App
