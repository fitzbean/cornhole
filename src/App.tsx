import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { BagSide, CornholeGame, GameState } from './CornholeGame';
import { useRoom } from './net/useRoom';
import {
  buildRoomUrl,
  clearRoomFromUrl,
  clearStoredRoleForRoom,
  generateRoomCode,
  getRoomFromUrl,
  getStoredRoleForRoom,
  rememberRoleForRoom,
} from './net/roomCode';
import { transportMode } from './net/transport';
import type { Role } from './net/types';

const initialGameState: GameState = {
  bagsRemaining: 4,
  player1BagsLeft: 4,
  player2BagsLeft: 4,
  isAiming: true,
  isThrowing: false,
  isSettling: false,
  isDragging: false,
  dragStartX: 0.5,
  dragStartY: 0.5,
  dragCurrentX: 0.5,
  dragCurrentY: 0.5,
  message: 'Use left/right arrows to move. Hold C to inspect the hole. Pull for distance, release to lock speed.',
  player1Score: 0,
  player2Score: 0,
  player1Ppr: 0,
  player2Ppr: 0,
  player1RoundScore: 0,
  player2RoundScore: 0,
  currentPlayer: 1,
  turnIndicatorPlayer: 1,
  throwingPlayer: null,
  inning: 1,
  bagsThisInning: 0,
  showResult: false,
  resultMessage: '',
  gameOver: false,
  lastPoints: 0,
  lastResult: '',
  aimPower: 0.65,
  throwDistanceFeet: 0,
  selectedBagSide: 'sticky',
  bagPreviewSide: 'sticky',
  throwStyle: 'slide',
  timeOfDayLabel: '6:00 PM',
  temperatureF: 68,
  windMph: 6,
  windDirection: 'E',
  humidityPct: 52,
  weatherEnabled: true,
};

function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const gameRef = useRef<CornholeGame | null>(null);
  const scoreHighlightTimeoutRef = useRef<number | null>(null);
  const previousScoresRef = useRef({ player1: 0, player2: 0 });
  const [gameState, setGameState] = useState<GameState>(initialGameState);
  const [power, setPower] = useState(65);
  const [scoreHighlightPlayer, setScoreHighlightPlayer] = useState<0 | 1 | 2>(0);
  const [cinematicCameraEnabled, setCinematicCameraEnabled] = useState(false);
  const [hasStartedGame, setHasStartedGame] = useState(false);
  const [gameSession, setGameSession] = useState(0);
  const [gameInstance, setGameInstance] = useState<CornholeGame | null>(null);
  const [matchResult, setMatchResult] = useState<
    { player1Score: number; player2Score: number; winner: 1 | 2 } | null
  >(null);

  // Multiplayer state
  const initialOnline = useMemo(() => {
    const roomId = getRoomFromUrl();
    if (!roomId) return null;
    // A tab that previously created/joined this room remembers its role so a
    // refresh doesn't downgrade a host into a second guest.
    const storedRole = getStoredRoleForRoom(roomId);
    const role: Role = storedRole ?? 'guest';
    return { roomId, role };
  }, []);
  const [online, setOnline] = useState<{ roomId: string; role: Role } | null>(initialOnline);
  const [copyFeedback, setCopyFeedback] = useState(false);
  const localPlayerSlot: 1 | 2 = online?.role === 'guest' ? 2 : 1;
  const netMode = transportMode();

  const handleStateChange = useCallback((state: GameState) => {
    setGameState(state);
    setPower(Math.round(state.aimPower * 100));
  }, []);

  const handleScoreUpdate = useCallback(() => {}, []);

  useEffect(() => {
    if (!hasStartedGame || !canvasRef.current) return;

    const canvas = canvasRef.current;
    const game = new CornholeGame(canvas, handleStateChange, handleScoreUpdate);
    game.setCinematicCameraEnabled(cinematicCameraEnabled);
    game.setupControls(canvas);

    gameRef.current = game;
    setGameInstance(game);

    return () => {
      game.dispose();
      gameRef.current = null;
      setGameInstance(null);
    };
  }, [gameSession, handleStateChange, handleScoreUpdate, hasStartedGame]);

  useEffect(() => {
    gameRef.current?.setCinematicCameraEnabled(cinematicCameraEnabled);
  }, [cinematicCameraEnabled]);

  useEffect(() => {
    if (!gameState.gameOver) {
      // A fresh game started (either locally or a rematch snapshot arrived).
      // Clear any lingering rematch modal.
      if (matchResult !== null && hasStartedGame) setMatchResult(null);
      return;
    }

    // Capture final scores the instant the match ends so the rematch modal
    // doesn't flicker when the game's own resetBags() runs a couple seconds later.
    const winner: 1 | 2 = gameState.player1Score >= gameState.player2Score ? 1 : 2;
    setMatchResult({
      player1Score: gameState.player1Score,
      player2Score: gameState.player2Score,
      winner,
    });

    if (online) {
      // Stay connected — the rematch modal lives on top of the running game.
      return;
    }

    setHasStartedGame(false);
    setPower(65);
    setScoreHighlightPlayer(0);
    previousScoresRef.current = { player1: 0, player2: 0 };
    setGameState(initialGameState);
  }, [gameState.gameOver, gameState.player1Score, gameState.player2Score, online, hasStartedGame, matchResult]);

  const handleStartGame = useCallback(() => {
    setPower(65);
    setScoreHighlightPlayer(0);
    previousScoresRef.current = { player1: 0, player2: 0 };
    setGameState(initialGameState);
    setGameSession((session) => session + 1);
    setHasStartedGame(true);
  }, []);

  const handleHostOnline = useCallback(() => {
    const roomId = generateRoomCode();
    const url = new URL(window.location.href);
    url.searchParams.set('room', roomId);
    window.history.replaceState({}, '', url.toString());
    rememberRoleForRoom(roomId, 'host');
    setOnline({ roomId, role: 'host' });
    handleStartGame();
  }, [handleStartGame]);

  const handleJoinOnline = useCallback(() => {
    if (!online) return;
    rememberRoleForRoom(online.roomId, online.role);
    setPower(65);
    setScoreHighlightPlayer(0);
    previousScoresRef.current = { player1: 0, player2: 0 };
    setGameState(initialGameState);
    setGameSession((session) => session + 1);
    setHasStartedGame(true);
  }, [online]);

  const handleCopyLink = useCallback(async () => {
    if (!online) return;
    const url = buildRoomUrl(online.roomId);
    try {
      await navigator.clipboard.writeText(url);
      setCopyFeedback(true);
      window.setTimeout(() => setCopyFeedback(false), 1500);
    } catch {
      window.prompt('Copy this link to share:', url);
    }
  }, [online]);

  const handleLeaveOnline = useCallback(() => {
    if (online) clearStoredRoleForRoom(online.roomId);
    clearRoomFromUrl();
    setOnline(null);
    setHasStartedGame(false);
    setMatchResult(null);
  }, [online]);

  const handleRematch = useCallback(() => {
    if (!gameInstance) return;
    setPower(65);
    setScoreHighlightPlayer(0);
    previousScoresRef.current = { player1: 0, player2: 0 };
    setMatchResult(null);
    gameInstance.restartMatch();
  }, [gameInstance]);

  const room = useRoom({
    roomId: online?.roomId ?? '',
    role: online?.role ?? 'host',
    localPlayerSlot,
    game: online && hasStartedGame ? gameInstance : null,
  });

  useEffect(() => {
    const previousScores = previousScoresRef.current;
    const player1Delta = gameState.player1Score - previousScores.player1;
    const player2Delta = gameState.player2Score - previousScores.player2;
    const highlightedPlayer: 0 | 1 | 2 = player1Delta > 0 ? 1 : player2Delta > 0 ? 2 : 0;

    if (highlightedPlayer !== 0) {
      setScoreHighlightPlayer(highlightedPlayer);
      if (scoreHighlightTimeoutRef.current !== null) {
        window.clearTimeout(scoreHighlightTimeoutRef.current);
      }
      scoreHighlightTimeoutRef.current = window.setTimeout(() => {
        setScoreHighlightPlayer(0);
        scoreHighlightTimeoutRef.current = null;
      }, 1400) as unknown as number;
    }

    previousScoresRef.current = {
      player1: gameState.player1Score,
      player2: gameState.player2Score,
    };
  }, [gameState.player1Score, gameState.player2Score]);

  const dragLine = gameState.isDragging && gameState.isAiming && !gameState.isThrowing
    ? {
        x1: `${gameState.dragStartX * 100}%`,
        y1: `${gameState.dragStartY * 100}%`,
        x2: `${gameState.dragCurrentX * 100}%`,
        y2: `${gameState.dragCurrentY * 100}%`,
      }
    : null;
  const speedBubble = gameState.isDragging && gameState.isAiming && !gameState.isThrowing
    ? {
        left: `${gameState.dragStartX * 100}%`,
        top: `${gameState.dragStartY * 100}%`,
      }
    : null;
  // In multiplayer, the opponent's drag UI (pull-back line + trajectory bubble)
  // is private to whoever is throwing — don't leak their aim to the other side.
  const hideOpponentAim = online !== null && gameState.currentPlayer !== localPlayerSlot;

  const visualTurnPlayer = gameState.isThrowing && gameState.throwingPlayer !== null
    ? gameState.throwingPlayer
    : gameState.turnIndicatorPlayer;
  const currentPlayerLabel = visualTurnPlayer === 1 ? 'Player 1' : 'Player 2';
  const selectedSide: BagSide = gameState.bagPreviewSide;
  const sideLabel = selectedSide === 'sticky' ? 'Sticky Side' : 'Slick Side';
  const throwStyleLabel = gameState.throwStyle === 'roll' ? 'Roll' : 'Slide';
  const canceledRoundLabel = gameState.player1RoundScore === gameState.player2RoundScore
    ? 'NO BLOOD'
    : gameState.player1RoundScore > gameState.player2RoundScore
      ? `RED +${gameState.player1RoundScore - gameState.player2RoundScore}`
      : `BLUE +${gameState.player2RoundScore - gameState.player1RoundScore}`;
  const windArrowRotation: Record<string, string> = {
    N: 'rotate(0deg)',
    NE: 'rotate(45deg)',
    E: 'rotate(90deg)',
    SE: 'rotate(135deg)',
    S: 'rotate(180deg)',
    SW: 'rotate(225deg)',
    W: 'rotate(270deg)',
    NW: 'rotate(315deg)',
  };
  const renderBagDots = (count: number, activeClasses: string) => (
    <div className="flex gap-1.5">
      {Array.from({ length: 4 }).map((_, i) => (
        <div
          key={i}
          className={`h-4 w-4 rounded-full border transition-all duration-300 ${
            i < count ? activeClasses : 'border-gray-600 bg-gray-700'
          }`}
        />
      ))}
    </div>
  );
  const displayMessage = gameState.showResult || gameState.gameOver
    ? gameState.message
    : gameState.isThrowing
      ? 'Bag in flight...'
      : gameState.isAiming
        ? (gameState.isDragging
            ? (hideOpponentAim ? `${currentPlayerLabel} is throwing...` : gameState.message)
            : `${currentPlayerLabel}'s turn`)
        : gameState.message;
  const player1CardClass = scoreHighlightPlayer === 1
    ? 'border-yellow-300 bg-red-950/75 shadow-[0_0_24px_rgba(250,204,21,0.55),0_0_50px_rgba(239,68,68,0.28)] scale-110'
    : visualTurnPlayer === 1
      ? 'border-red-500 bg-red-950/60 shadow-[0_0_20px_rgba(239,68,68,0.4),0_0_40px_rgba(239,68,68,0.15)] scale-105'
      : 'border-gray-700 bg-black/60 opacity-70';
  const player2CardClass = scoreHighlightPlayer === 2
    ? 'border-yellow-300 bg-blue-950/75 shadow-[0_0_24px_rgba(250,204,21,0.55),0_0_50px_rgba(59,130,246,0.28)] scale-110'
    : visualTurnPlayer === 2
      ? 'border-blue-500 bg-blue-950/60 shadow-[0_0_20px_rgba(59,130,246,0.4),0_0_40px_rgba(59,130,246,0.15)] scale-105'
      : 'border-gray-700 bg-black/60 opacity-70';

  const myTurnInOnline =
    online !== null &&
    hasStartedGame &&
    !room.rejected &&
    gameState.currentPlayer === localPlayerSlot &&
    !gameState.gameOver;
  const turnFrameColor = localPlayerSlot === 1 ? 'rgba(239,68,68,0.55)' : 'rgba(59,130,246,0.55)';
  const turnFrameGlow = localPlayerSlot === 1 ? 'rgba(239,68,68,0.18)' : 'rgba(59,130,246,0.18)';

  return (
    <div className="relative h-screen w-full overflow-hidden bg-black select-none">
      <canvas
        ref={canvasRef}
        className={`absolute inset-0 h-full w-full ${hasStartedGame ? 'cursor-crosshair' : 'pointer-events-none opacity-30 blur-[1px]'}`}
      />

      {myTurnInOnline && (
        <div
          className="pointer-events-none absolute inset-0 z-[45] transition-opacity duration-300"
          style={{
            boxShadow: `inset 0 0 0 3px ${turnFrameColor}, inset 0 0 60px ${turnFrameGlow}`,
          }}
        />
      )}

      {!hasStartedGame && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-[radial-gradient(circle_at_top,_rgba(37,99,235,0.18),_transparent_38%),linear-gradient(180deg,_rgba(0,0,0,0.72),_rgba(0,0,0,0.9))] px-6">
          <div className="w-full max-w-xl rounded-[32px] border border-white/10 bg-black/60 px-10 py-12 text-center shadow-[0_30px_80px_rgba(0,0,0,0.55)] backdrop-blur-md">
            <div className="mb-3 text-sm font-bold uppercase tracking-[0.35em] text-white/45">Cornhole</div>
            <h1 className="mb-4 text-5xl font-black text-white">Backyard Showdown</h1>
            {online ? (
              <>
                <p className="mx-auto mb-2 max-w-md text-sm text-gray-300">
                  {online.role === 'host' ? 'Rejoining your hosted room ' : "You've been invited to room "}
                  <span className="font-mono font-bold text-white">{online.roomId}</span>.
                </p>
                <p className="mx-auto mb-8 max-w-md text-xs text-gray-400">
                  {online.role === 'host'
                    ? 'Reconnecting as Player 1 (Red). Match state resets on host rejoin.'
                    : "You'll play as Player 2 (Blue). Host controls when the match starts."}
                </p>
                <div className="flex items-center justify-center gap-3">
                  <button
                    type="button"
                    onClick={handleJoinOnline}
                    className="inline-flex items-center justify-center rounded-full bg-blue-500 px-8 py-3 text-sm font-black uppercase tracking-[0.2em] text-white shadow-[0_15px_35px_rgba(59,130,246,0.45)] transition-transform duration-200 hover:scale-105 hover:bg-blue-400"
                  >
                    {online.role === 'host' ? 'Rejoin match' : 'Join match'}
                  </button>
                  <button
                    type="button"
                    onClick={handleLeaveOnline}
                    className="inline-flex items-center justify-center rounded-full border border-white/20 px-6 py-3 text-xs font-bold uppercase tracking-[0.2em] text-white/70 hover:bg-white/10"
                  >
                    Cancel
                  </button>
                </div>
              </>
            ) : (
              <>
                <p className="mx-auto mb-8 max-w-md text-sm text-gray-300">
                  Sink bags, land on the board, and race to 21. Use the arrow keys to move, hold C to inspect the hole, pull to throw, and press F to flip the bag side.
                </p>
                <div className="flex flex-col items-center gap-3">
                  <button
                    type="button"
                    onClick={handleStartGame}
                    className="inline-flex items-center justify-center rounded-full bg-blue-500 px-8 py-3 text-sm font-black uppercase tracking-[0.2em] text-white shadow-[0_15px_35px_rgba(59,130,246,0.45)] transition-transform duration-200 hover:scale-105 hover:bg-blue-400"
                  >
                    Play local (2 players)
                  </button>
                  <button
                    type="button"
                    onClick={handleHostOnline}
                    className="inline-flex items-center justify-center rounded-full border border-white/25 bg-white/5 px-6 py-2.5 text-xs font-bold uppercase tracking-[0.2em] text-white/85 hover:bg-white/15"
                  >
                    Play online — host a room
                  </button>
                  {netMode === 'broadcast' && (
                    <div className="mt-1 text-[10px] uppercase tracking-[0.22em] text-amber-300/70">
                      No Supabase configured — only same-browser tabs can connect
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {online && room.rejected && (
        <div className="absolute inset-0 z-[60] flex items-center justify-center bg-black/80 px-6 backdrop-blur-sm">
          <div className="w-full max-w-md rounded-2xl border border-red-500/40 bg-black/80 px-8 py-10 text-center shadow-[0_20px_60px_rgba(239,68,68,0.25)]">
            <div className="mb-2 text-xs font-bold uppercase tracking-[0.35em] text-red-300/80">Room full</div>
            <h2 className="mb-3 text-2xl font-black text-white">This match is already underway.</h2>
            <p className="mx-auto mb-6 max-w-xs text-sm text-gray-300">
              Room <span className="font-mono font-bold text-white">{online.roomId}</span> already has two players connected. Ask the host for a new invite link.
            </p>
            <button
              type="button"
              onClick={handleLeaveOnline}
              className="inline-flex items-center justify-center rounded-full bg-white/10 px-6 py-2.5 text-xs font-bold uppercase tracking-[0.2em] text-white hover:bg-white/20"
            >
              Leave
            </button>
          </div>
        </div>
      )}

      {online && matchResult && !room.rejected && (
        <div className="absolute inset-0 z-[55] flex items-center justify-center bg-black/80 px-6 backdrop-blur-sm">
          <div className="w-full max-w-md rounded-2xl border border-white/15 bg-black/85 px-8 py-10 text-center shadow-[0_20px_60px_rgba(0,0,0,0.5)]">
            <div className="mb-3 text-xs font-bold uppercase tracking-[0.35em] text-white/50">Match over</div>
            <h2
              className={`mb-6 text-3xl font-black ${
                matchResult.winner === 1 ? 'text-red-300' : 'text-blue-300'
              }`}
            >
              {matchResult.winner === localPlayerSlot ? 'You win!' : `Player ${matchResult.winner} wins!`}
            </h2>
            <div className="mb-8 grid grid-cols-2 gap-3">
              <div className={`rounded-xl border px-4 py-3 ${matchResult.winner === 1 ? 'border-red-400 bg-red-950/60' : 'border-white/10 bg-white/5'}`}>
                <div className="text-[11px] font-bold uppercase tracking-[0.2em] text-red-300/80">Player 1</div>
                <div className="text-4xl font-black text-white">{matchResult.player1Score}</div>
              </div>
              <div className={`rounded-xl border px-4 py-3 ${matchResult.winner === 2 ? 'border-blue-400 bg-blue-950/60' : 'border-white/10 bg-white/5'}`}>
                <div className="text-[11px] font-bold uppercase tracking-[0.2em] text-blue-300/80">Player 2</div>
                <div className="text-4xl font-black text-white">{matchResult.player2Score}</div>
              </div>
            </div>
            <div className="flex items-center justify-center gap-3">
              {online.role === 'host' ? (
                <button
                  type="button"
                  onClick={handleRematch}
                  className="inline-flex items-center justify-center rounded-full bg-blue-500 px-8 py-3 text-sm font-black uppercase tracking-[0.2em] text-white shadow-[0_15px_35px_rgba(59,130,246,0.45)] transition-transform duration-200 hover:scale-105 hover:bg-blue-400"
                >
                  Rematch
                </button>
              ) : (
                <div className="rounded-full border border-white/20 px-6 py-3 text-xs font-bold uppercase tracking-[0.2em] text-white/60">
                  Waiting for host to start a rematch...
                </div>
              )}
              <button
                type="button"
                onClick={handleLeaveOnline}
                className="inline-flex items-center justify-center rounded-full border border-white/20 px-6 py-3 text-xs font-bold uppercase tracking-[0.2em] text-white/70 hover:bg-white/10"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {online && hasStartedGame && !room.rejected && (
        <div className="pointer-events-auto absolute right-4 top-1/2 z-30 w-[280px] -translate-y-1/2 rounded-xl border border-white/15 bg-black/75 px-4 py-3 text-xs backdrop-blur-sm">
          <div className="mb-2 flex items-center justify-between">
            <span className="font-bold uppercase tracking-[0.2em] text-white/70">
              {online.role === 'host' ? 'Hosting' : 'Joined'} · {online.roomId}
            </span>
            <span
              className={`rounded-full px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider ${
                room.peerConnected
                  ? 'bg-emerald-500/25 text-emerald-300 shadow-[0_0_10px_rgba(16,185,129,0.35)]'
                  : room.status === 'connected'
                    ? 'bg-amber-500/20 text-amber-300'
                    : 'bg-red-500/20 text-red-300'
              }`}
            >
              {room.peerConnected
                ? 'Both connected'
                : room.status === 'connected'
                  ? 'Waiting for opponent...'
                  : room.status}
            </span>
          </div>
          <div className="mb-2 flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-2.5 py-1.5">
            <span
              className={`inline-block h-2 w-2 rounded-full ${
                room.status === 'connected' ? 'bg-emerald-400 shadow-[0_0_6px_rgba(74,222,128,0.9)]' : 'bg-gray-500'
              }`}
            />
            <span className="text-[11px] font-semibold text-white/85">
              {online.role === 'host' ? 'You (Player 1, Red)' : 'You (Player 2, Blue)'}
            </span>
          </div>
          <div className="mb-2 flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-2.5 py-1.5">
            <span
              className={`inline-block h-2 w-2 rounded-full ${
                room.peerConnected ? 'bg-emerald-400 shadow-[0_0_6px_rgba(74,222,128,0.9)]' : 'bg-gray-500 animate-pulse'
              }`}
            />
            <span className="text-[11px] font-semibold text-white/85">
              {online.role === 'host' ? 'Opponent (Player 2, Blue)' : 'Host (Player 1, Red)'}
            </span>
            {!room.peerConnected && (
              <span className="ml-auto text-[10px] uppercase tracking-wider text-amber-300/80">Not joined</span>
            )}
          </div>
          <div className="mt-1 text-[11px] text-gray-400">
            {gameState.currentPlayer === localPlayerSlot ? 'Your turn' : 'Waiting on opponent'}
          </div>
          {online.role === 'host' && (
            <div className="mt-3 flex items-center gap-2">
              <button
                type="button"
                onClick={handleCopyLink}
                className="flex-1 rounded-md border border-white/15 bg-white/5 px-3 py-1.5 text-[11px] font-bold uppercase tracking-[0.14em] text-white/80 hover:bg-white/15"
              >
                {copyFeedback ? 'Copied!' : 'Copy invite link'}
              </button>
              <button
                type="button"
                onClick={handleLeaveOnline}
                className="rounded-md border border-white/15 bg-white/5 px-3 py-1.5 text-[11px] font-bold uppercase tracking-[0.14em] text-white/60 hover:bg-red-500/25 hover:text-red-200"
                title="Leave match"
              >
                Leave
              </button>
            </div>
          )}
          {online.role === 'guest' && (
            <button
              type="button"
              onClick={handleLeaveOnline}
              className="mt-2 w-full rounded-md border border-white/15 bg-white/5 px-3 py-1.5 text-[11px] font-bold uppercase tracking-[0.14em] text-white/60 hover:bg-red-500/25 hover:text-red-200"
            >
              Leave match
            </button>
          )}
        </div>
      )}

      <div className="pointer-events-none absolute left-6 top-[28vh] z-20 h-[43.2vh] max-h-[432px] w-[31.2vw] max-w-[336px] rounded-[28px] border border-white/15 bg-black/12 shadow-[0_20px_45px_rgba(0,0,0,0.28)] backdrop-blur-[1px]">
        <div className="absolute left-4 top-3 rounded-full border border-white/12 bg-black/40 px-3 py-1 text-[11px] font-bold uppercase tracking-[0.24em] text-white/75">
          Board Cam
        </div>
      </div>

      {dragLine && !hideOpponentAim && (
        <svg className="pointer-events-none absolute inset-0 z-20 h-full w-full">
          <defs>
            <linearGradient id="pullback-line" x1="0%" y1="0%" x2="100%" y2="0%">
              <stop offset="0%" stopColor="#fde68a" />
              <stop offset="50%" stopColor="#fb7185" />
              <stop offset="100%" stopColor="#f97316" />
            </linearGradient>
          </defs>
          <line
            x1={dragLine.x1}
            y1={dragLine.y1}
            x2={dragLine.x2}
            y2={dragLine.y2}
            stroke="url(#pullback-line)"
            strokeWidth="6"
            strokeLinecap="round"
            opacity="0.95"
          />
          <circle cx={dragLine.x1} cy={dragLine.y1} r="8" fill="#fef3c7" opacity="0.9" />
          <circle cx={dragLine.x2} cy={dragLine.y2} r="10" fill="#fb7185" opacity="0.85" />
        </svg>
      )}

      {speedBubble && !hideOpponentAim && (
        <div
          className="pointer-events-none absolute z-30 -translate-x-full -translate-y-full"
          style={{
            left: `calc(${speedBubble.left} - 84px)`,
            top: `calc(${speedBubble.top} - 18px)`,
          }}
        >
          <div className="min-w-[175px] rounded-2xl border border-white/15 bg-black/78 px-4 py-3 shadow-[0_16px_35px_rgba(0,0,0,0.45)] backdrop-blur-sm">
            <div className="flex items-center justify-between text-[10px] font-bold uppercase tracking-[0.28em] text-white/55">
              <span className="flex-1 text-center">Trajectory</span>
              <span className="tabular-nums text-white/70">&nbsp;{Math.min(Math.round((gameState.throwDistanceFeet / 30) * 100), 500)}%</span>
            </div>
            <div className="mt-2 h-2.5 overflow-hidden rounded-full bg-white/12 relative">
              <div
                className="absolute top-0 bottom-0 w-1 rounded-full transition-none"
                style={{
                  left: `${power}%`,
                  background: 'linear-gradient(180deg, #22c55e, #eab308, #ef4444)',
                  transform: 'translateX(-50%)',
                }}
              />
            </div>
            <div className="mt-2 flex items-center justify-between text-[10px] font-semibold uppercase tracking-[0.16em] text-white/48">
              <span>Arc</span>
              <span>Line Drive</span>
            </div>
          </div>
        </div>
      )}

      <div className="pointer-events-none absolute left-0 right-0 top-0 z-10">
        <div className="grid grid-cols-[minmax(160px,1fr)_auto_minmax(160px,1fr)] items-start gap-4 p-4">
          <div className={`justify-self-start rounded-xl border-2 px-5 py-3 backdrop-blur-sm transition-all duration-300 ${player1CardClass}`}>
            <div className="text-xs font-bold uppercase tracking-wider text-red-400">Player 1</div>
            <div className="text-3xl font-black text-white">{gameState.player1Score}</div>
            <div className="mt-1 text-[11px] font-bold uppercase tracking-[0.18em] text-red-200/75">PPR {gameState.player1Ppr.toFixed(2)}</div>
            <div className="mt-3 text-[11px] font-bold uppercase tracking-wider text-gray-200">Bags Left</div>
            <div className="mt-2">{renderBagDots(gameState.player1BagsLeft, 'border-red-400 bg-red-500')}</div>
          </div>

          <div className="flex items-center gap-3 rounded-xl border border-gray-700 bg-black/60 px-4 py-3 text-center backdrop-blur-sm">
            <div className="min-w-[62px] rounded-lg border border-red-500/25 bg-red-950/35 px-3 py-2">
              <div className="text-[10px] font-bold uppercase tracking-[0.2em] text-red-300/80">Score</div>
              <div className="text-2xl font-black text-red-200">{gameState.player1RoundScore}</div>
            </div>
            <div className="px-2">
              <div className="text-xs font-bold uppercase tracking-wider text-gray-200">Round</div>
              <div className="text-2xl font-black text-white">{gameState.inning}</div>
              <div className="mt-1 text-xs font-semibold text-gray-400">{canceledRoundLabel}</div>
            </div>
            <div className="min-w-[62px] rounded-lg border border-blue-500/25 bg-blue-950/35 px-3 py-2">
              <div className="text-[10px] font-bold uppercase tracking-[0.2em] text-blue-300/80">Score</div>
              <div className="text-2xl font-black text-blue-200">{gameState.player2RoundScore}</div>
            </div>
          </div>

          <div className={`justify-self-end rounded-xl border-2 px-5 py-3 backdrop-blur-sm transition-all duration-300 ${player2CardClass}`}>
            <div className="text-xs font-bold uppercase tracking-wider text-blue-400">Player 2</div>
            <div className="text-3xl font-black text-white">{gameState.player2Score}</div>
            <div className="mt-1 text-[11px] font-bold uppercase tracking-[0.18em] text-blue-200/75">PPR {gameState.player2Ppr.toFixed(2)}</div>
            <div className="mt-3 text-[11px] font-bold uppercase tracking-wider text-gray-200">Bags Left</div>
            <div className="mt-2">{renderBagDots(gameState.player2BagsLeft, 'border-blue-400 bg-blue-500')}</div>
          </div>
        </div>
      </div>

      <div className="pointer-events-none absolute bottom-0 left-0 right-0 z-10">
        <div className="flex items-end justify-between p-4">
          <div className="max-w-md rounded-xl border border-gray-700 bg-black/60 px-6 py-3 text-center backdrop-blur-sm">
            <div className="text-lg font-bold text-white">{displayMessage}</div>
          </div>

          <div className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full border border-white/12 bg-black/55 px-5 py-2 text-center backdrop-blur-sm">
            <div className="flex items-center gap-4 text-[11px] font-bold uppercase tracking-[0.2em] text-white/70">
              <span>Time {gameState.timeOfDayLabel}</span>
              <span className="text-white/28">|</span>
              <span>Temp <span className="text-amber-200">{gameState.temperatureF}F</span></span>
              <span className="text-white/28">|</span>
              <span className="inline-flex items-center gap-1.5">
                Wind <span className="text-cyan-200">{gameState.windMph} mph</span>
                <span
                  className="inline-block text-cyan-200"
                  style={{ transform: windArrowRotation[gameState.windDirection] ?? 'rotate(0deg)' }}
                >
                  ↑
                </span>
              </span>
              <span className="text-white/28">|</span>
              <span>Humidity <span className="text-emerald-200">{gameState.humidityPct}%</span></span>
              <span className="text-white/28">|</span>
              <span
                className={`cursor-pointer rounded px-1.5 py-0.5 text-xs font-bold uppercase tracking-wider transition-colors ${gameState.weatherEnabled ? 'bg-cyan-500/20 text-cyan-300' : 'bg-gray-700/60 text-gray-500 line-through'}`}
                title="Press W to toggle weather"
              >
                Weather {gameState.weatherEnabled ? 'ON' : 'OFF'}
              </span>
            </div>
          </div>

          <div className="w-[220px]" />
        </div>
      </div>

      <div className="absolute bottom-4 right-4 z-10 w-[220px] rounded-xl border border-gray-700 bg-black/68 px-5 py-4 backdrop-blur-[1px]">
        <div className="mb-3 text-left">
          <div className="text-xs font-bold uppercase tracking-wider text-gray-400">Throw Style</div>
          <div className="text-sm font-semibold text-white">{throwStyleLabel}</div>
          <div className="text-[11px] text-gray-400">Press T to toggle style</div>
        </div>
        <div className="mb-3 text-left">
          <div className="text-xs font-bold uppercase tracking-wider text-gray-400">Bag Side</div>
          <div className="text-sm font-semibold text-white">{sideLabel}</div>
          <div className="text-[11px] text-gray-400">Press F to flip sides</div>
        </div>
        <div
          id="bag-preview-viewport"
          className="mb-4 h-[132px] rounded-[22px] border border-white/10 bg-black/8 shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]"
        />
        <label className="mb-3 flex cursor-pointer items-center gap-3 text-left">
          <input
            type="checkbox"
            checked={cinematicCameraEnabled}
            onChange={(event) => setCinematicCameraEnabled(event.target.checked)}
            className="h-4 w-4 rounded border-gray-500 bg-black/40 text-blue-400"
          />
          <span>
            <div className="text-xs font-bold uppercase tracking-wider text-gray-400">Cinematic Camera</div>
            <div className="text-[11px] text-gray-400">Follow the bag after release</div>
          </span>
        </label>
        <div className="text-[11px] text-gray-400">Speed now appears above your pull point while aiming.</div>
      </div>

      {gameState.isAiming && !gameState.isThrowing && gameState.bagsRemaining > 0 && !gameState.gameOver && (
        <div className="pointer-events-none absolute bottom-24 left-1/2 z-20 -translate-x-1/2">
          <div className="rounded-full border border-white/20 bg-black/70 px-6 py-2 backdrop-blur-sm">
            <span className="text-sm font-medium text-white/80">
              ←/→ to move. Hold C to inspect the hole. Click and drag back for power, release to lock angle
            </span>
          </div>
        </div>
      )}

    </div>
  );
}

export default App;
