import { useEffect, useRef, useState, useCallback } from 'react';
import { BagSide, CornholeGame, GameState } from './CornholeGame';

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

    return () => {
      game.dispose();
      gameRef.current = null;
    };
  }, [gameSession, handleStateChange, handleScoreUpdate, hasStartedGame]);

  useEffect(() => {
    gameRef.current?.setCinematicCameraEnabled(cinematicCameraEnabled);
  }, [cinematicCameraEnabled]);

  useEffect(() => {
    if (!gameState.gameOver) return;

    setHasStartedGame(false);
    setPower(65);
    setScoreHighlightPlayer(0);
    previousScoresRef.current = { player1: 0, player2: 0 };
    setGameState(initialGameState);
  }, [gameState.gameOver]);

  const handleStartGame = useCallback(() => {
    setPower(65);
    setScoreHighlightPlayer(0);
    previousScoresRef.current = { player1: 0, player2: 0 };
    setGameState(initialGameState);
    setGameSession((session) => session + 1);
    setHasStartedGame(true);
  }, []);

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
        ? (gameState.isDragging ? gameState.message : `${currentPlayerLabel}'s turn`)
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

  return (
    <div className="relative h-screen w-full overflow-hidden bg-black select-none">
      <canvas
        ref={canvasRef}
        className={`absolute inset-0 h-full w-full ${hasStartedGame ? 'cursor-crosshair' : 'pointer-events-none opacity-30 blur-[1px]'}`}
      />

      {!hasStartedGame && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-[radial-gradient(circle_at_top,_rgba(37,99,235,0.18),_transparent_38%),linear-gradient(180deg,_rgba(0,0,0,0.72),_rgba(0,0,0,0.9))] px-6">
          <div className="w-full max-w-xl rounded-[32px] border border-white/10 bg-black/60 px-10 py-12 text-center shadow-[0_30px_80px_rgba(0,0,0,0.55)] backdrop-blur-md">
            <div className="mb-3 text-sm font-bold uppercase tracking-[0.35em] text-white/45">Cornhole</div>
            <h1 className="mb-4 text-5xl font-black text-white">Backyard Showdown</h1>
            <p className="mx-auto mb-8 max-w-md text-sm text-gray-300">
              Sink bags, land on the board, and race to 21. Use the arrow keys to move, hold C to inspect the hole, pull to throw, and press F to flip the bag side.
            </p>
            <button
              type="button"
              onClick={handleStartGame}
              className="inline-flex items-center justify-center rounded-full bg-blue-500 px-8 py-3 text-sm font-black uppercase tracking-[0.2em] text-white shadow-[0_15px_35px_rgba(59,130,246,0.45)] transition-transform duration-200 hover:scale-105 hover:bg-blue-400"
            >
              Play
            </button>
          </div>
        </div>
      )}

      <div className="pointer-events-none absolute left-6 top-[28vh] z-20 h-[43.2vh] max-h-[432px] w-[31.2vw] max-w-[336px] rounded-[28px] border border-white/15 bg-black/12 shadow-[0_20px_45px_rgba(0,0,0,0.28)] backdrop-blur-[1px]">
        <div className="absolute left-4 top-3 rounded-full border border-white/12 bg-black/40 px-3 py-1 text-[11px] font-bold uppercase tracking-[0.24em] text-white/75">
          Board Cam
        </div>
      </div>

      {dragLine && (
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

      {speedBubble && (
        <div
          className="pointer-events-none absolute z-30 -translate-x-full -translate-y-full"
          style={{
            left: `calc(${speedBubble.left} - 84px)`,
            top: `calc(${speedBubble.top} - 18px)`,
          }}
        >
          <div className="min-w-[150px] rounded-2xl border border-white/15 bg-black/78 px-4 py-3 shadow-[0_16px_35px_rgba(0,0,0,0.45)] backdrop-blur-sm">
            <div className="text-center text-[10px] font-bold uppercase tracking-[0.28em] text-white/55">Trajectory</div>
            <div className="mt-2 h-2.5 overflow-hidden rounded-full bg-white/12">
              <div
                className="h-full rounded-full transition-none"
                style={{
                  width: `${power}%`,
                  background: 'linear-gradient(90deg, #22c55e, #eab308, #ef4444)',
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
              Left/right arrows move. Hold C to inspect the hole. F flips the bag. T changes throw style. Pull for distance, release to lock speed
            </span>
          </div>
        </div>
      )}

    </div>
  );
}

export default App;
