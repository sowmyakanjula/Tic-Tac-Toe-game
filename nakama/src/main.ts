const MODULE_NAME = 'lila_tictactoe'
const LEADERBOARD_ID = 'tic_tac_toe_global'
const RPC_CREATE_MATCH = 'create_match'
const RPC_LIST_MATCHES = 'list_matches'
const RPC_GET_LEADERBOARD = 'get_leaderboard'
const OP_STATE = 1
const OP_ERROR = 2
const OP_MOVE = 10
const TICK_RATE = 2
const IDLE_TIMEOUT_TICKS = 120
const RECONNECT_GRACE_TICKS = 20

type GameMode = 'classic' | 'timed'
type MatchStatus = 'waiting' | 'playing' | 'finished'
type Mark = 'X' | 'O'
type ResultType = 'win' | 'loss' | 'draw'

interface PlayerState {
  userId: string
  username: string
  mark: Mark | null
  connected: boolean
  presence: nkruntime.Presence | null
  disconnectDeadlineTick: number | null
}

interface MatchLabel {
  open: number
  mode: GameMode
}

interface MatchState {
  matchId: string
  mode: GameMode
  status: MatchStatus
  board: Array<Mark | null>
  players: {[userId: string]: PlayerState}
  order: string[]
  reservedUserIds: string[]
  currentTurn: Mark | null
  winnerMark: Mark | null
  winnerUserId: string | null
  winnerReason: string | null
  winningLine: number[]
  turnEndsAt: number | null
  idleTicks: number
  label: MatchLabel
  message: string
  finishedStatsPersisted: boolean
}

interface MatchMessagePayload {
  position: number
}

interface StatsSummary {
  wins: number
  losses: number
  draws: number
  streak: number
  bestStreak: number
  gamesPlayed: number
}

interface RpcCreateMatchPayload {
  mode?: GameMode
}

interface RpcListMatchesPayload {
  mode?: GameMode
}

function InitModule(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, initializer: nkruntime.Initializer) {
  try {
    nk.leaderboardCreate(LEADERBOARD_ID, true, nkruntime.SortOrder.DESCENDING, nkruntime.Operator.BEST, null, {game: 'tic-tac-toe'}, true)
  } catch (error) {
    logger.debug('Leaderboard create skipped: %v', error)
  }

  initializer.registerRpc(RPC_CREATE_MATCH, rpcCreateMatch)
  initializer.registerRpc(RPC_LIST_MATCHES, rpcListMatches)
  initializer.registerRpc(RPC_GET_LEADERBOARD, rpcGetLeaderboard)
  initializer.registerMatch(MODULE_NAME, {
    matchInit: matchInit,
    matchJoinAttempt: matchJoinAttempt,
    matchJoin: matchJoin,
    matchLeave: matchLeave,
    matchLoop: matchLoop,
    matchTerminate: matchTerminate,
    matchSignal: matchSignal,
  })
  initializer.registerMatchmakerMatched(matchmakerMatched)

  logger.info('Lila Tic-Tac-Toe runtime loaded.')
}

function rpcCreateMatch(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
  if (!ctx.userId) {
    throw {message: 'Authentication required.', code: nkruntime.Codes.UNAUTHENTICATED}
  }

  var parsed = payload ? JSON.parse(payload) as RpcCreateMatchPayload : {}
  var mode = sanitizeMode(parsed.mode)
  var matchId = nk.matchCreate(MODULE_NAME, {mode: mode, reservedUserIds: []})
  logger.info('Created room %s in %s mode for user %s.', matchId, mode, ctx.userId)
  return JSON.stringify({matchId: matchId})
}

function rpcListMatches(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
  var parsed = payload ? JSON.parse(payload) as RpcListMatchesPayload : {}
  var mode = sanitizeMode(parsed.mode)
  var query = '+label.open:1 +label.mode:' + mode
  var matches = nk.matchList(20, true, null, 0, 1, query)
  var result = []

  for (var i = 0; i < matches.length; i++) {
    var label = parseLabel(matches[i].label)
    result.push({
      matchId: matches[i].matchId,
      size: matches[i].size,
      open: label.open === 1,
      mode: label.mode,
    })
  }

  return JSON.stringify({matches: result})
}

function rpcGetLeaderboard(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
  var records = nk.leaderboardRecordsList(LEADERBOARD_ID, undefined, 10)
  var recordRows = records.records || []
  var readRequests: nkruntime.StorageReadRequest[] = []

  for (var i = 0; i < recordRows.length; i++) {
    readRequests.push({
      collection: 'player_stats',
      key: 'summary',
      userId: recordRows[i].ownerId,
    })
  }

  var summaries = nk.storageRead(readRequests)
  var summaryMap: {[userId: string]: StatsSummary} = {}
  for (var j = 0; j < summaries.length; j++) {
    summaryMap[summaries[j].userId] = summaries[j].value as StatsSummary
  }

  var entries = []
  for (var k = 0; k < recordRows.length; k++) {
    var record = recordRows[k]
    var stats = summaryMap[record.ownerId] || emptyStats()
    entries.push({
      rank: record.rank,
      userId: record.ownerId,
      username: record.username,
      wins: stats.wins,
      losses: stats.losses,
      draws: stats.draws,
      streak: stats.streak,
      bestStreak: stats.bestStreak,
    })
  }

  return JSON.stringify({entries: entries})
}

function matchmakerMatched(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, matches: nkruntime.MatchmakerResult[]): string {
  var reservedUserIds: string[] = []
  var mode: GameMode = 'classic'

  for (var i = 0; i < matches.length; i++) {
    reservedUserIds.push(matches[i].presence.userId)
    if (matches[i].properties.mode === 'timed') {
      mode = 'timed'
    }
  }

  return nk.matchCreate(MODULE_NAME, {
    mode: mode,
    reservedUserIds: reservedUserIds,
  })
}

var matchInit: nkruntime.MatchInitFunction<MatchState> = function (ctx, logger, nk, params) {
  var mode = sanitizeMode(params.mode as GameMode)
  var reserved = (params.reservedUserIds as string[]) || []
  var state: MatchState = {
    matchId: '',
    mode: mode,
    status: 'waiting',
    board: emptyBoard(),
    players: {},
    order: [],
    reservedUserIds: reserved,
    currentTurn: null,
    winnerMark: null,
    winnerUserId: null,
    winnerReason: null,
    winningLine: [],
    turnEndsAt: null,
    idleTicks: 0,
    label: {
      open: 1,
      mode: mode,
    },
    message: 'Waiting for players to join.',
    finishedStatsPersisted: false,
  }

  return {
    state: state,
    tickRate: TICK_RATE,
    label: JSON.stringify(state.label),
  }
}

var matchJoinAttempt: nkruntime.MatchJoinAttemptFunction<MatchState> = function (ctx, logger, nk, dispatcher, tick, state, presence, metadata) {
  var existing = state.players[presence.userId]
  if (existing) {
    return {state: state, accept: true}
  }

  if (state.reservedUserIds.length > 0 && state.reservedUserIds.indexOf(presence.userId) === -1) {
    return {state: state, accept: false, rejectMessage: 'match reserved for matched players'}
  }

  if (state.order.length >= 2) {
    return {state: state, accept: false, rejectMessage: 'match full'}
  }

  return {state: state, accept: true}
}

var matchJoin: nkruntime.MatchJoinFunction<MatchState> = function (ctx, logger, nk, dispatcher, tick, state, presences) {
  for (var i = 0; i < presences.length; i++) {
    var presence = presences[i]
    if (!state.players[presence.userId]) {
      state.players[presence.userId] = {
        userId: presence.userId,
        username: presence.username,
        mark: null,
        connected: true,
        presence: presence,
        disconnectDeadlineTick: null,
      }
      state.order.push(presence.userId)
    } else {
      state.players[presence.userId].connected = true
      state.players[presence.userId].presence = presence
      state.players[presence.userId].username = presence.username
      state.players[presence.userId].disconnectDeadlineTick = null
    }
  }

  updateLabel(dispatcher, state)

  if (state.order.length === 2 && state.status === 'waiting') {
    startMatch(dispatcher, state)
  } else {
    sendState(dispatcher, state)
  }

  return {state: state}
}

var matchLeave: nkruntime.MatchLeaveFunction<MatchState> = function (ctx, logger, nk, dispatcher, tick, state, presences) {
  for (var i = 0; i < presences.length; i++) {
    var presence = presences[i]
    var player = state.players[presence.userId]
    if (!player) {
      continue
    }

    if (state.status === 'playing') {
      player.connected = false
      player.presence = null
      player.disconnectDeadlineTick = tick + RECONNECT_GRACE_TICKS
      state.message = player.username + ' disconnected. Waiting for reconnect...'
    } else {
      removePlayer(state, presence.userId)
      state.message = 'A player left. Room is open again.'
    }
  }

  updateLabel(dispatcher, state)
  sendState(dispatcher, state)
  return {state: state}
}

var matchLoop: nkruntime.MatchLoopFunction<MatchState> = function (ctx, logger, nk, dispatcher, tick, state, messages) {
  state.matchId = ctx.matchId || ''

  if (connectedCount(state) === 0 && state.order.length === 0) {
    state.idleTicks += 1
    if (state.idleTicks >= IDLE_TIMEOUT_TICKS) {
      return null
    }
  } else {
    state.idleTicks = 0
  }

  purgeWaitingDisconnects(state)

  if (state.status === 'waiting' && state.order.length === 2 && bothPlayersConnected(state)) {
    startMatch(dispatcher, state)
  }

  if (state.status === 'playing') {
    if (state.mode === 'timed' && state.turnEndsAt !== null && unixNow() >= state.turnEndsAt) {
      finishByForfeit(dispatcher, state, state.currentTurn as Mark, 'timeout')
      return {state: state}
    }

    var forfeitedUserId = findExpiredDisconnect(state, tick)
    if (forfeitedUserId) {
      finishByUserIdForfeit(dispatcher, state, forfeitedUserId, 'disconnect')
      return {state: state}
    }

    processMessages(nk, dispatcher, state, messages)
  }

  if (state.status === 'finished' && !state.finishedStatsPersisted) {
    persistFinishedStats(nk, state)
    state.finishedStatsPersisted = true
  }

  return {state: state}
}

var matchTerminate: nkruntime.MatchTerminateFunction<MatchState> = function (ctx, logger, nk, dispatcher, tick, state, graceSeconds) {
  state.message = 'Server terminated the match.'
  sendState(dispatcher, state)
  return {state: state}
}

var matchSignal: nkruntime.MatchSignalFunction<MatchState> = function (ctx, logger, nk, dispatcher, tick, state, data) {
  return {state: state, data: data}
}

function processMessages(nk: nkruntime.Nakama, dispatcher: nkruntime.MatchDispatcher, state: MatchState, messages: nkruntime.MatchMessage[]) {
  for (var i = 0; i < messages.length; i++) {
    var message = messages[i]
    if (message.opCode !== OP_MOVE) {
      continue
    }

    var player = state.players[message.sender.userId]
    if (!player || !player.mark) {
      sendError(dispatcher, player ? player.presence : null, 'You are not part of this match.')
      continue
    }

    if (state.currentTurn !== player.mark) {
      sendError(dispatcher, player.presence, 'It is not your turn.')
      continue
    }

    var payload: MatchMessagePayload
    try {
      payload = JSON.parse(nk.binaryToString(message.data)) as MatchMessagePayload
    } catch (error) {
      sendError(dispatcher, player.presence, 'Move payload was invalid.')
      continue
    }

    if (payload.position < 0 || payload.position > 8 || state.board[payload.position] !== null) {
      sendError(dispatcher, player.presence, 'That square is unavailable.')
      continue
    }

    state.board[payload.position] = player.mark
    var winningLine = getWinningLine(state.board)
    if (winningLine.length > 0) {
      state.winnerMark = player.mark
      state.winnerUserId = player.userId
      state.winnerReason = 'play'
      state.winningLine = winningLine
      state.status = 'finished'
      state.currentTurn = null
      state.turnEndsAt = null
      state.message = player.username + ' won the match.'
      sendState(dispatcher, state)
      return
    }

    if (boardFull(state.board)) {
      state.status = 'finished'
      state.currentTurn = null
      state.turnEndsAt = null
      state.winnerMark = null
      state.winnerUserId = null
      state.winnerReason = 'draw'
      state.winningLine = []
      state.message = 'The match ended in a draw.'
      sendState(dispatcher, state)
      return
    }

    state.currentTurn = player.mark === 'X' ? 'O' : 'X'
    state.turnEndsAt = deadlineForMode(state.mode)
    state.message = player.username + ' played square ' + payload.position + '.'
    sendState(dispatcher, state)
  }
}

function startMatch(dispatcher: nkruntime.MatchDispatcher, state: MatchState) {
  var first = state.players[state.order[0]]
  var second = state.players[state.order[1]]
  if (!first || !second) {
    return
  }

  state.status = 'playing'
  state.board = emptyBoard()
  state.winnerMark = null
  state.winnerUserId = null
  state.winnerReason = null
  state.winningLine = []
  state.currentTurn = 'X'
  state.turnEndsAt = deadlineForMode(state.mode)
  state.finishedStatsPersisted = false
  first.mark = 'X'
  second.mark = 'O'
  state.message = 'Match started. ' + first.username + ' goes first.'
  updateLabel(dispatcher, state)
  sendState(dispatcher, state)
}

function finishByForfeit(dispatcher: nkruntime.MatchDispatcher, state: MatchState, forfeitingMark: Mark, reason: string) {
  var winnerMark: Mark = forfeitingMark === 'X' ? 'O' : 'X'
  var winnerId = findUserIdByMark(state, winnerMark)
  state.status = 'finished'
  state.currentTurn = null
  state.turnEndsAt = null
  state.winnerMark = winnerMark
  state.winnerUserId = winnerId
  state.winnerReason = reason
  state.winningLine = []
  state.message = (winnerId ? state.players[winnerId].username : 'Opponent') + ' won by ' + reason + '.'
  sendState(dispatcher, state)
}

function finishByUserIdForfeit(dispatcher: nkruntime.MatchDispatcher, state: MatchState, forfeitingUserId: string, reason: string) {
  var loser = state.players[forfeitingUserId]
  if (!loser || !loser.mark) {
    return
  }
  finishByForfeit(dispatcher, state, loser.mark, reason)
}

function persistFinishedStats(nk: nkruntime.Nakama, state: MatchState) {
  if (state.status !== 'finished') {
    return
  }

  if (!state.winnerUserId) {
    for (var i = 0; i < state.order.length; i++) {
      updateStats(nk, state.players[state.order[i]], 'draw')
    }
    return
  }

  var winner = state.players[state.winnerUserId]
  if (winner) {
    updateStats(nk, winner, 'win')
  }

  for (var j = 0; j < state.order.length; j++) {
    if (state.order[j] !== state.winnerUserId) {
      updateStats(nk, state.players[state.order[j]], 'loss')
    }
  }
}

function updateStats(nk: nkruntime.Nakama, player: PlayerState, result: ResultType) {
  if (!player) {
    return
  }

  var existing = nk.storageRead([{
    collection: 'player_stats',
    key: 'summary',
    userId: player.userId,
  }])
  var stats = existing.length > 0 ? existing[0].value as StatsSummary : emptyStats()

  stats.gamesPlayed += 1
  if (result === 'win') {
    stats.wins += 1
    stats.streak += 1
    if (stats.streak > stats.bestStreak) {
      stats.bestStreak = stats.streak
    }
  } else if (result === 'loss') {
    stats.losses += 1
    stats.streak = 0
  } else {
    stats.draws += 1
    stats.streak = 0
  }

  nk.storageWrite([{
    collection: 'player_stats',
    key: 'summary',
    userId: player.userId,
    value: stats,
    permissionRead: 2,
    permissionWrite: 0,
  }])

  nk.leaderboardRecordWrite(
    LEADERBOARD_ID,
    player.userId,
    player.username,
    stats.wins,
    stats.bestStreak,
    {
      losses: stats.losses,
      draws: stats.draws,
      gamesPlayed: stats.gamesPlayed,
    },
    nkruntime.OverrideOperator.BEST,
  )
}

function sendState(dispatcher: nkruntime.MatchDispatcher, state: MatchState) {
  var players = []
  for (var userId in state.players) {
    players.push({
      userId: state.players[userId].userId,
      username: state.players[userId].username,
      mark: state.players[userId].mark,
      connected: state.players[userId].connected,
    })
  }

  var presences = connectedPresences(state)
  for (var i = 0; i < presences.length; i++) {
    var presence = presences[i]
    var payload = {
      matchId: state.matchId,
      status: state.status === 'waiting' && state.order.length === 0 ? 'idle' : state.status,
      mode: state.mode,
      board: state.board,
      currentTurn: state.currentTurn,
      winnerMark: state.winnerMark,
      winnerUserId: state.winnerUserId,
      winnerReason: state.winnerReason,
      winningLine: state.winningLine,
      turnEndsAt: state.turnEndsAt,
      players: players,
      yourUserId: presence.userId,
      yourMark: state.players[presence.userId] ? state.players[presence.userId].mark : null,
      canMove: canUserMove(state, presence.userId),
      open: state.label.open === 1,
      message: state.message,
    }

    dispatcher.broadcastMessage(OP_STATE, JSON.stringify(payload), [presence], null, true)
  }
}

function sendError(dispatcher: nkruntime.MatchDispatcher, presence: nkruntime.Presence | null, message: string) {
  if (!presence) {
    return
  }

  dispatcher.broadcastMessage(OP_ERROR, JSON.stringify({message: message}), [presence], null, true)
}

function updateLabel(dispatcher: nkruntime.MatchDispatcher, state: MatchState) {
  state.label.open = state.status === 'waiting' && state.order.length < 2 ? 1 : 0
  dispatcher.matchLabelUpdate(JSON.stringify(state.label))
}

function removePlayer(state: MatchState, userId: string) {
  delete state.players[userId]
  var nextOrder = []
  for (var i = 0; i < state.order.length; i++) {
    if (state.order[i] !== userId) {
      nextOrder.push(state.order[i])
    }
  }
  state.order = nextOrder
}

function purgeWaitingDisconnects(state: MatchState) {
  if (state.status !== 'waiting') {
    return
  }

  var toRemove = []
  for (var userId in state.players) {
    if (!state.players[userId].connected) {
      toRemove.push(userId)
    }
  }

  for (var i = 0; i < toRemove.length; i++) {
    removePlayer(state, toRemove[i])
  }
}

function connectedCount(state: MatchState): number {
  var total = 0
  for (var userId in state.players) {
    if (state.players[userId].connected) {
      total += 1
    }
  }
  return total
}

function bothPlayersConnected(state: MatchState): boolean {
  if (state.order.length !== 2) {
    return false
  }

  return Boolean(
    state.players[state.order[0]] &&
      state.players[state.order[0]].connected &&
      state.players[state.order[1]] &&
      state.players[state.order[1]].connected,
  )
}

function connectedPresences(state: MatchState): nkruntime.Presence[] {
  var results: nkruntime.Presence[] = []
  for (var userId in state.players) {
    if (state.players[userId].connected && state.players[userId].presence) {
      results.push(state.players[userId].presence as nkruntime.Presence)
    }
  }
  return results
}

function findUserIdByMark(state: MatchState, mark: Mark): string | null {
  for (var userId in state.players) {
    if (state.players[userId].mark === mark) {
      return userId
    }
  }
  return null
}

function findExpiredDisconnect(state: MatchState, tick: number): string | null {
  for (var userId in state.players) {
    if (!state.players[userId].connected && state.players[userId].disconnectDeadlineTick !== null && tick >= (state.players[userId].disconnectDeadlineTick as number)) {
      return userId
    }
  }
  return null
}

function canUserMove(state: MatchState, userId: string): boolean {
  var player = state.players[userId]
  if (!player || !player.connected || !player.mark) {
    return false
  }
  return state.status === 'playing' && player.mark === state.currentTurn
}

function deadlineForMode(mode: GameMode): number | null {
  if (mode !== 'timed') {
    return null
  }
  return unixNow() + 30
}

function sanitizeMode(mode?: GameMode): GameMode {
  return mode === 'timed' ? 'timed' : 'classic'
}

function parseLabel(label?: string): MatchLabel {
  if (!label) {
    return {open: 0, mode: 'classic'}
  }

  try {
    var parsed = JSON.parse(label) as MatchLabel
    return {
      open: parsed.open === 1 ? 1 : 0,
      mode: sanitizeMode(parsed.mode),
    }
  } catch (error) {
    return {open: 0, mode: 'classic'}
  }
}

function emptyBoard(): Array<Mark | null> {
  return [null, null, null, null, null, null, null, null, null]
}

function emptyStats(): StatsSummary {
  return {
    wins: 0,
    losses: 0,
    draws: 0,
    streak: 0,
    bestStreak: 0,
    gamesPlayed: 0,
  }
}

function boardFull(board: Array<Mark | null>): boolean {
  for (var i = 0; i < board.length; i++) {
    if (board[i] === null) {
      return false
    }
  }
  return true
}

function getWinningLine(board: Array<Mark | null>): number[] {
  var lines = [
    [0, 1, 2],
    [3, 4, 5],
    [6, 7, 8],
    [0, 3, 6],
    [1, 4, 7],
    [2, 5, 8],
    [0, 4, 8],
    [2, 4, 6],
  ]

  for (var i = 0; i < lines.length; i++) {
    var a = lines[i][0]
    var b = lines[i][1]
    var c = lines[i][2]
    if (board[a] !== null && board[a] === board[b] && board[a] === board[c]) {
      return lines[i]
    }
  }
  return []
}

function unixNow(): number {
  return Math.floor(Date.now() / 1000)
}
