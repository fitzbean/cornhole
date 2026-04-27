import * as THREE from 'three';
import * as CANNON from 'cannon-es';

// ====== CONSTANTS ======
const BOARD_W = 2.0;
const BOARD_L = 4.0;
const BOARD_THICKNESS = 0.28;
const HOLE_RADIUS = 0.3;
const HOLE_Z = -1.25; // hole position along board (local Z)
// Bag center must sink BELOW this board-local Y to register as a cornhole.
// Lower (more negative) = bag has to go deeper before it counts.
const HOLE_CAPTURE_Y = -0.05;
const HOLE_CAPTURE_RADIUS = HOLE_RADIUS * 0.84;
const HOLE_FUNNEL_RADIUS = HOLE_RADIUS * 0.96;
const BOARD_TILT = 0.18;
const FRONT_EDGE_TOP_HEIGHT = 0.26;
const TOP_PANEL_THICKNESS = 0.06;
const SIDE_APRON_THICKNESS = 0.08;
const REAR_LEG_LENGTH = 0.86;
const REAR_LEG_THICKNESS = 0.22;
const BAG_SIZE = 0.22;
const BAG_MASS = 1.25;
const PITCH_LENGTH = 27; // feet in real game, we use scaled units
const GRAVITY = -9.81;
const PLAYER_OUTER_X = 2.4;
const MIN_THROW_DRAG_DISTANCE = 0.08;
const FREE_ROAM_CAMERA_SPEED = 6;
const DAWN_TIME = 6;
const DUSK_TIME = 19;
const INSPECT_CAMERA_MIN_DISTANCE = 2.2;
const INSPECT_CAMERA_MAX_DISTANCE = 7.5;
// Guest renders `now - GUEST_RENDER_DELAY` so there's almost always a future
// snapshot to interpolate toward. Adds a small perceived latency but removes
// the arrive-and-wait stepping that straight-to-latest lerping produces.
const GUEST_RENDER_DELAY = 0.08;
const BROADCAST_INTERVAL = 0.025; // 20Hz cap
const PLAYER_DEFAULT_X: Record<1 | 2, number> = {
  1: -1.15,
  2: 1.15,
};
const BOARD_TEXTURE_FILES = [
  '/audio/imgs/board-texture-1.png',
  '/audio/imgs/board-texture-2.png',
  '/audio/imgs/board-texture-3.png',
  '/audio/imgs/board-texture-4.png',
  '/audio/imgs/board-texture-5.png',
] as const;

// ====== PHYSICS MATERIAL CONSTANTS ======
const FRICTION = {
  STICKY_GROUND: 0.45,
  STICKY_BOARD: 0.05,
  SLICK_GROUND: 0.1,
  SLICK_BOARD: 0.025,
  SETTLED_GROUND: 0.06,
  SETTLED_BOARD: 0.018,
  STICKY_STICKY: 0.48,
  SLICK_SLICK: 0.56,
  STICKY_SLICK: 0.38,
  SETTLED_SETTLED: 0.04,
  SETTLED_STICKY: 0.05,
  SETTLED_SLICK: 0.04,
} as const;

const RESTITUTION = {
  GROUND: 0.001,
  BOARD: 0.0002,
  BAG_BAG: 0.001,
} as const;

export type BagSide = 'sticky' | 'slick';
export type ThrowStyle = 'slide' | 'roll';

interface BagVisualState {
  squash: number;
  impactSquash: number;
  wobbleTime: number;
  wobbleAmplitude: number;
  wobblePhase: number;
  wobbleAxisX: number;
  wobbleAxisZ: number;
  lastVelocityY: number;
  lastImpactAt: number;
  // Per-vertex deformation
  deformAmount: number;
  deformContactY: number;   // -1 = bottom contact, +1 = top contact
  deformDirX: number;       // lateral impact direction
  deformDirZ: number;
  // Fill shifting
  fillOffsetX: number;
  fillOffsetY: number;
  fillOffsetZ: number;
  // Deformation tracking
  isDeforming: boolean;
  prevSettled: boolean;
}

declare global {
  interface Window {
    render_game_to_text?: () => string;
    advanceTime?: (ms: number) => void;
  }
}

export interface GameState {
  bagsRemaining: number;
  player1BagsLeft: number;
  player2BagsLeft: number;
  isAiming: boolean;
  isThrowing: boolean;
  isSettling: boolean;
  isDragging: boolean;
  dragStartX: number;
  dragStartY: number;
  dragCurrentX: number;
  dragCurrentY: number;
  message: string;
  player1Score: number;
  player2Score: number;
  player1Ppr: number;
  player2Ppr: number;
  player1RoundScore: number;
  player2RoundScore: number;
  currentPlayer: 1 | 2;
  turnIndicatorPlayer: 1 | 2;
  throwingPlayer: 1 | 2 | null;
  inning: number;
  bagsThisInning: number; // 0-7 (each player throws 4)
  showResult: boolean;
  resultMessage: string;
  gameOver: boolean;
  lastPoints: number;
  lastResult: string;
  aimPower: number;
  throwDistanceFeet: number;
  selectedBagSide: BagSide;
  bagPreviewSide: BagSide;
  throwStyle: ThrowStyle;
  timeOfDayLabel: string;
  temperatureF: number;
  windMph: number;
  windDirection: string;
  humidityPct: number;
  weatherEnabled: boolean;
}

export class CornholeGame {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  boardCamera: THREE.OrthographicCamera;
  previewScene: THREE.Scene;
  previewCamera: THREE.OrthographicCamera;
  previewBag!: THREE.Mesh;
  previewPlayer: 1 | 2 = 1;
  renderer: THREE.WebGLRenderer;
  world: CANNON.World;
  clock = new THREE.Clock();
  ambientLight!: THREE.AmbientLight;
  hemisphereLight!: THREE.HemisphereLight;
  sunLight!: THREE.DirectionalLight;
  fillLight!: THREE.DirectionalLight;
  skyMaterial?: THREE.MeshBasicMaterial;
  stickyBagMaterial!: CANNON.Material;
  slickBagMaterial!: CANNON.Material;
  settledBagMaterial!: CANNON.Material;
  timeOfDay = DAWN_TIME;
  temperatureF = 68;
  windMph = 6;
  humidityPct = 52;
  windVector = new THREE.Vector3(1, 0, 0);
  windDirection = 'E';
  weatherEnabled = true;

  // Game objects
  boardGroup!: THREE.Group;
  boardBody!: CANNON.Body;
  groundBody!: CANNON.Body;
  boardTopMaterial!: THREE.MeshStandardMaterial;
  boardTopTextures: THREE.Texture[] = [];
  boardTextureIndex = 0;
  bags: THREE.Mesh[] = [];
  bagBodies: CANNON.Body[] = [];
  bagSides: BagSide[] = Array(8).fill('sticky');
  bagThrowStyles: ThrowStyle[] = Array(8).fill('slide');
  bagInHole: boolean[] = Array(8).fill(false);
  bagInHoleDetectedAt: number[] = Array(8).fill(0); // Timestamp when hole was first detected
  bagPendingHoleCleanup: boolean[] = Array(8).fill(false);
  bagHoleCleanupReadyAt: number[] = Array(8).fill(0);
  pullLine!: THREE.Line;
  trailPoints: THREE.Vector3[] = [];
  trailLine!: THREE.Line;
  clouds: THREE.Group[] = [];
  cloudShadows: THREE.Mesh[] = [];
  bagVisualStates: BagVisualState[] = [];
  bagRestPosePositions: Float32Array[] = [];
  bagVisualWorldPos = new THREE.Vector3();
  bagVisualLocalPos = new THREE.Vector3();
  bagVisualEuler = new THREE.Euler();
  bagVisualQuat = new THREE.Quaternion();

  // State
  state: GameState = {
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
    message: 'Pull for distance, release to lock speed.',
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

  // Aiming
  aimX = 0;
  aimPower = 0.65;
  pullDistance = 0.3;
  playerX = PLAYER_DEFAULT_X[1];
  moveLeftPressed = false;
  moveRightPressed = false;
  moveUpPressed = false;
  moveDownPressed = false;
  selectedBagSide: BagSide = 'sticky';
  throwStyle: ThrowStyle = 'slide';
  playerBagSides: Record<1 | 2, BagSide> = { 1: 'sticky', 2: 'sticky' };
  playerThrowStyles: Record<1 | 2, ThrowStyle> = { 1: 'slide', 2: 'slide' };
  playerPositions: Record<1 | 2, number> = { ...PLAYER_DEFAULT_X };
  playerBagsThrown: Record<1 | 2, number> = { 1: 0, 2: 0 };
  inningBaseScores: Record<1 | 2, number> = { 1: 0, 2: 0 };
  cumulativeRoundPoints: Record<1 | 2, number> = { 1: 0, 2: 0 };
  nextInningStarter: 1 | 2 = 1;
  animationFrameId: number | null = null;
  isDisposed = false;
  currentTurnBagReady = false;
  dragStart = new THREE.Vector2();
  dragCurrent = new THREE.Vector2();
  isDragging = false;
  totalTime = 0;
  freeRoamCameraEnabled = false;
  inspectCameraHeld = false;
  inspectCameraDistance = 1.75;
  cameraPosition = new THREE.Vector3(0, 1.95, 12);
  cameraLookTarget = new THREE.Vector3(0, 1.05, -8);
  turnStartCameraPosition = new THREE.Vector3(0, 1.95, 12);
  turnStartCameraLookTarget = new THREE.Vector3(0, 1.05, -8);
  freeRoamLookActive = false;
  freeRoamLookLastPointer = new THREE.Vector2();
  freeRoamYaw = 0;
  freeRoamPitch = -0.18;
  cinematicCameraEnabled = false;
  holeColliderDebug: THREE.Object3D | null = null;
  physicsDebugGroup: THREE.Group | null = null;
  physicsDebugVisible = false;
  physicsDebugMeshes: Array<{
    body: CANNON.Body;
    shapeIndex: number;
    mesh: THREE.Object3D;
  }> = [];
  activeThrownBagIndex: number | null = null;
  slowMotionEnabled = false;

  // Multiplayer
  guestMode = false;
  onlineHostMode = false;
  localPlayerSlot: 1 | 2 = 1;
  snapshotSeq = 0;
  onSnapshot: ((snapshot: import('./net/types').Snapshot) => void) | null = null;
  onLocalIntent: ((intent: import('./net/types').Intent) => void) | null = null;
  suppressRemoteDragUntil = 0;
  // Unified broadcast throttle: at most one snapshot send per 50ms, no matter
  // which code path asks. Multiple requests within a window collapse into a
  // single trailing send where a queued FULL request wins over FLIGHT (we'd
  // rather lose motion-smoothing samples than a real state transition).
  private lastBroadcastAt = 0;
  private queuedBroadcast: 'full' | 'flight' | null = null;
  private queuedBroadcastTimer: number | null = null;
  // Guest-only interpolation state. Each bag keeps a short buffer of recent
  // snapshots (sample time + pose). Each render frame we render at
  // `now - GUEST_RENDER_DELAY`, picking the two samples that bracket that time
  // and interpolating between them. This is "render-delayed interpolation" —
  // by rendering in the past by a fixed amount we always have a future sample
  // to head toward, eliminating the arrive-and-wait stepping you get when
  // lerping to the newest sample directly.
  private guestBagSamples: {
    t: number;
    pos: THREE.Vector3;
    quat: THREE.Quaternion;
  }[][] = [];
  private guestFirstSnapshotAt = 0;

  // Callbacks
  onStateChange: (state: GameState) => void;
  onScoreUpdate: (points: number, result: string, player: 1 | 2, inning: number) => void;
  onInningComplete: ((inning: number, player1Points: number, player2Points: number) => void) | null = null;

  // Particles
  particleSystems: { points: THREE.Points; velocities: THREE.Vector3[]; life: number }[] = [];
  stickyFaceNormal = new CANNON.Vec3(0, 1, 0);

  // Audio
  audioContext: AudioContext | null = null;
  cornholeSoundPlayed: boolean[] = Array(8).fill(false);
  pointSoundPlayed: boolean[] = Array(8).fill(false);
  impactSoundPlayed: boolean[] = Array(8).fill(false);
  boardHitSounds: AudioBuffer[] = [];
  bagOnBagSounds: AudioBuffer[] = [];
  cornholeSounds: AudioBuffer[] = [];

  // Hole detection - track previous positions for trajectory crossing
  bagPrevPositions: THREE.Vector3[] = Array(8).fill(null).map(() => new THREE.Vector3());

  // Bag throw animation
  throwStartTime = 0;
  throwDuration = 0;
  throwStartPos = new THREE.Vector3();
  throwEndPos = new THREE.Vector3();
  throwArcHeight = 0;
  settlingTimer = 0;
  bagSettled = false;

  constructor(
    canvas: HTMLCanvasElement,
    onStateChange: (state: GameState) => void,
    onScoreUpdate: (points: number, result: string, player: 1 | 2, inning: number) => void
  ) {
    this.onStateChange = onStateChange;
    this.onScoreUpdate = onScoreUpdate;

    // Three.js
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x6BA3D6);
    this.scene.fog = new THREE.FogExp2(0x6BA3D6, 0.008);
    this.timeOfDay = THREE.MathUtils.randFloat(DAWN_TIME, DUSK_TIME);
    this.rollEnvironment();

    this.camera = new THREE.PerspectiveCamera(55, canvas.clientWidth / canvas.clientHeight, 0.1, 200);
    this.camera.position.copy(this.cameraPosition);
    this.camera.lookAt(this.cameraLookTarget);

    this.boardCamera = new THREE.OrthographicCamera(-2.4, 2.4, 3.2, -3.2, 0.1, 50);
    this.boardCamera.position.set(0, 7.5, -10);
    this.boardCamera.up.set(0, 0, -1);
    this.boardCamera.lookAt(0, 0.7, -10);

    this.previewScene = new THREE.Scene();
    this.previewCamera = new THREE.OrthographicCamera(-1.4, 1.4, 1.1, -1.1, 0.1, 20);
    this.previewCamera.position.set(0, 0, 3);
    this.previewCamera.lookAt(0, 0, 0);

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setSize(canvas.clientWidth, canvas.clientHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.1;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    // Cannon.js
    this.world = new CANNON.World({
      gravity: new CANNON.Vec3(0, GRAVITY, 0),
    });
    this.world.broadphase = new CANNON.SAPBroadphase(this.world);

    // Materials
    const groundMat = new CANNON.Material('ground');
    const boardMat = new CANNON.Material('board');
    this.stickyBagMaterial = new CANNON.Material('sticky-bag');
    this.slickBagMaterial = new CANNON.Material('slick-bag');
    this.settledBagMaterial = new CANNON.Material('settled-bag');

    const bagMats = [
      { key: 'STICKY', mat: this.stickyBagMaterial },
      { key: 'SLICK', mat: this.slickBagMaterial },
      { key: 'SETTLED', mat: this.settledBagMaterial },
    ] as const;

    const surfaceMats = [
      // NOTE: settled-vs-board intentionally uses GROUND restitution (keeps settled bags from popping off).
      { key: 'GROUND', mat: groundMat, restitution: RESTITUTION.GROUND },
      { key: 'BOARD', mat: boardMat, restitutionFor: (bag: string) => bag === 'SETTLED' ? RESTITUTION.GROUND : RESTITUTION.BOARD },
    ] as const;

    const addContact = (a: CANNON.Material, b: CANNON.Material, friction: number, restitution: number) => {
      this.world.addContactMaterial(new CANNON.ContactMaterial(a, b, { friction, restitution }));
    };

    // Bag vs surface
    for (const bag of bagMats) {
      for (const surface of surfaceMats) {
        const friction = (FRICTION as Record<string, number>)[`${bag.key}_${surface.key}`];
        const restitution = 'restitution' in surface ? surface.restitution : surface.restitutionFor(bag.key);
        addContact(bag.mat, surface.mat, friction, restitution);
      }
    }

    // Bag vs bag (unordered pairs incl. self). FRICTION key may be declared in either order.
    const frictionTable = FRICTION as Record<string, number>;
    for (let i = 0; i < bagMats.length; i++) {
      for (let j = i; j < bagMats.length; j++) {
        const a = bagMats[i];
        const b = bagMats[j];
        const friction = frictionTable[`${a.key}_${b.key}`] ?? frictionTable[`${b.key}_${a.key}`];
        addContact(a.mat, b.mat, friction, RESTITUTION.BAG_BAG);
      }
    }

    this.createLights();
    this.createGround(groundMat);
    this.createBoard(boardMat);
    this.createBags(this.stickyBagMaterial);
    this.createEnvironment();
    this.createPullLine();
    this.createBagPreview();
    this.initAudio(); // Load audio files asynchronously
    this.startTurn(1);

    window.addEventListener('resize', this.handleResize);
    this.installTestingHooks();

    this.animate();
  }

  // ====== SCENE CREATION ======

  createLights() {
    this.ambientLight = new THREE.AmbientLight(0x405070, 0.6);
    this.scene.add(this.ambientLight);

    this.hemisphereLight = new THREE.HemisphereLight(0x87CEEB, 0x3a6b2a, 0.7);
    this.scene.add(this.hemisphereLight);

    this.sunLight = new THREE.DirectionalLight(0xFFE8C0, 1.8);
    this.sunLight.position.set(8, 25, 12);
    this.sunLight.castShadow = true;
    this.sunLight.shadow.mapSize.set(2048, 2048);
    this.sunLight.shadow.camera.near = 1;
    this.sunLight.shadow.camera.far = 80;
    this.sunLight.shadow.camera.left = -15;
    this.sunLight.shadow.camera.right = 15;
    this.sunLight.shadow.camera.top = 15;
    this.sunLight.shadow.camera.bottom = -15;
    this.sunLight.shadow.bias = -0.0002;
    this.sunLight.shadow.normalBias = 0.008;
    this.scene.add(this.sunLight);

    this.fillLight = new THREE.DirectionalLight(0xC0D8FF, 0.3);
    this.fillLight.position.set(-8, 10, -5);
    this.scene.add(this.fillLight);

    this.applyTimeOfDayLighting();
  }

  applyTimeOfDayLighting() {
    const dayProgress = THREE.MathUtils.clamp((this.timeOfDay - DAWN_TIME) / (DUSK_TIME - DAWN_TIME), 0, 1);
    const sunArc = dayProgress * Math.PI;
    const sunHeight = Math.sin(sunArc);
    const warmEdge = 1 - Math.sin(dayProgress * Math.PI);

    const skyColor = new THREE.Color()
      .lerpColors(new THREE.Color(0xF4B183), new THREE.Color(0x7FC6FF), Math.pow(sunHeight, 0.55));
    const fogColor = new THREE.Color()
      .lerpColors(new THREE.Color(0xE9B07A), new THREE.Color(0xA9D4F5), Math.pow(sunHeight, 0.7));
    const groundColor = new THREE.Color()
      .lerpColors(new THREE.Color(0x5c4730), new THREE.Color(0x3a6b2a), Math.pow(sunHeight, 0.7));
    const sunColor = new THREE.Color()
      .lerpColors(new THREE.Color(0xFFB45E), new THREE.Color(0xFFF3D1), 1 - warmEdge * 0.85);
    const fillColor = new THREE.Color()
      .lerpColors(new THREE.Color(0xF6BE86), new THREE.Color(0xC0D8FF), Math.pow(sunHeight, 0.8));

    this.scene.background = skyColor.clone();
    this.scene.fog = new THREE.FogExp2(fogColor, THREE.MathUtils.lerp(0.012, 0.0065, sunHeight));

    this.ambientLight.color.copy(new THREE.Color().lerpColors(new THREE.Color(0x5C4A3B), new THREE.Color(0xB8C6D8), Math.pow(sunHeight, 0.75)));
    this.ambientLight.intensity = THREE.MathUtils.lerp(0.35, 0.62, sunHeight);

    this.hemisphereLight.color.copy(skyColor);
    this.hemisphereLight.groundColor.copy(groundColor);
    this.hemisphereLight.intensity = THREE.MathUtils.lerp(0.35, 0.9, sunHeight);

    this.sunLight.color.copy(sunColor);
    this.sunLight.intensity = THREE.MathUtils.lerp(0.75, 1.5, sunHeight);
    this.sunLight.position.set(
      THREE.MathUtils.lerp(-18, 18, dayProgress),
      THREE.MathUtils.lerp(7, 28, sunHeight),
      THREE.MathUtils.lerp(18, 8, dayProgress)
    );
    this.sunLight.target.position.set(0, 0, -10);
    this.scene.add(this.sunLight.target);

    this.fillLight.color.copy(fillColor);
    this.fillLight.intensity = THREE.MathUtils.lerp(0.18, 0.42, sunHeight);
    this.fillLight.position.set(
      THREE.MathUtils.lerp(12, -10, dayProgress),
      THREE.MathUtils.lerp(6, 12, sunHeight),
      THREE.MathUtils.lerp(-12, -4, dayProgress)
    );

    this.updateSkyTint();
  }

  // Tints the static blue sky dome toward warm dawn/dusk tones so late-afternoon
  // games don't look midday-blue. The dome texture is a static gradient, so we
  // multiply it via the material's color.
  updateSkyTint() {
    if (!this.skyMaterial) return;
    const dayProgress = THREE.MathUtils.clamp((this.timeOfDay - DAWN_TIME) / (DUSK_TIME - DAWN_TIME), 0, 1);
    const sunHeight = Math.sin(dayProgress * Math.PI);
    // Warm tint at horizon end of the day, neutral at midday.
    // Evening side (dayProgress > 0.5) gets a stronger orange pull than dawn.
    const isEvening = dayProgress > 0.5;
    const warmColor = new THREE.Color(isEvening ? 0xFFB07A : 0xFFC49A);
    const neutralColor = new THREE.Color(0xFFFFFF);
    const warmth = Math.pow(1 - sunHeight, 1.4);
    const tint = new THREE.Color().lerpColors(neutralColor, warmColor, warmth);
    this.skyMaterial.color.copy(tint);
  }

  rollEnvironment() {
    const dayProgress = THREE.MathUtils.clamp((this.timeOfDay - DAWN_TIME) / (DUSK_TIME - DAWN_TIME), 0, 1);
    const warmthCurve = Math.sin(dayProgress * Math.PI);
    this.temperatureF = Math.round(THREE.MathUtils.clamp(54 + warmthCurve * 30 + THREE.MathUtils.randFloatSpread(8), 48, 94));
    this.humidityPct = Math.round(THREE.MathUtils.clamp(74 - warmthCurve * 18 + THREE.MathUtils.randFloatSpread(16), 34, 92));
    this.windMph = Math.round(THREE.MathUtils.clamp(THREE.MathUtils.randFloat(0, 10), 0, 20));

    const windAngle = THREE.MathUtils.randFloat(-Math.PI * 0.82, Math.PI * 0.82);
    this.windVector.set(Math.sin(windAngle), 0, -Math.cos(windAngle)).normalize();
    this.windDirection = this.getCompassDirection(this.windVector);
  }

  getCompassDirection(direction: THREE.Vector3) {
    const headings = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
    const angle = Math.atan2(direction.x, -direction.z);
    const index = ((Math.round(angle / (Math.PI / 4)) % 8) + 8) % 8;
    return headings[index];
  }

  formatTimeOfDayLabel() {
    const totalMinutes = Math.round(this.timeOfDay * 60);
    let hours = Math.floor(totalMinutes / 60) % 24;
    const minutes = totalMinutes % 60;
    const suffix = hours >= 12 ? 'PM' : 'AM';
    hours = hours % 12;
    if (hours === 0) hours = 12;
    return `${hours}:${minutes.toString().padStart(2, '0')} ${suffix}`;
  }

  // Weather effects on throws (all gated by weatherEnabled):
  //   Temperature — multiplies launch speed via getTemperatureSpeedFactor().
  //     48°F → 0.96x (cold air is denser, bags feel slower),
  //     94°F → 1.04x (hot air is thinner).
  //     Range is intentionally narrow (±4%) so temp is a subtle trim, not a dominant factor.
  //   Humidity — divides launch speed via getHumidityDragFactor() (higher humidity = more drag).
  //     34% → 0.98x drag, 92% → 1.08x drag. Kept subtle so wind dominates the "weather feel."
  //     Also scales post-landing friction via getSurfaceDampingMultiplier() (damp surface grips more).
  //   Wind — applied every physics tick to in-flight bags via applyWeatherWindToBag().
  //     Tailwind/headwind (along ±Z, the throw axis) dominates: boosts or shortens distance.
  //     Crosswind (along ±X) pushes the bag sideways, affecting aim.
  getTemperatureSpeedFactor() {
    if (!this.weatherEnabled) return 1;
    return THREE.MathUtils.mapLinear(this.temperatureF, 48, 94, 0.96, 1.04);
  }

  getHumidityDragFactor() {
    if (!this.weatherEnabled) return 1;
    return THREE.MathUtils.mapLinear(this.humidityPct, 34, 92, 0.98, 1.08);
  }

  getSurfaceDampingMultiplier() {
    if (!this.weatherEnabled) return 1;
    const humidityFactor = THREE.MathUtils.mapLinear(this.humidityPct, 34, 92, 0.92, 1.24);
    const temperatureFactor = THREE.MathUtils.mapLinear(this.temperatureF, 48, 94, 1.08, 0.92);
    return THREE.MathUtils.clamp(humidityFactor * temperatureFactor, 0.84, 1.28);
  }

  applyWeatherWindToBag(body: CANNON.Body, dt: number) {
    if (!this.weatherEnabled) return;
    const boardTopY = this.boardGroup.position.y + 0.45;
    const inFlight = body.position.y > boardTopY || Math.abs(body.velocity.y) > 1.1;
    if (!inFlight) return;

    // Along-axis wind (Z) is weighted more heavily than crosswind (X) so tailwind/headwind
    // has enough authority to overcome the humidity drag penalty on launch speed.
    const windStrength = this.windMph / 12;
    body.velocity.x += this.windVector.x * windStrength * dt * 1.8;
    body.velocity.z += this.windVector.z * windStrength * dt * 2.4;
  }

  createGround(material: CANNON.Material) {
    // Grass
    const grassGeo = new THREE.PlaneGeometry(80, 100);
    const grassTex = this.createGrassTexture();
    const grassMat = new THREE.MeshStandardMaterial({
      map: grassTex,
      color: 0xccddc8,
      roughness: 0.85,
      metalness: 0.05,
    });
    const grass = new THREE.Mesh(grassGeo, grassMat);
    grass.rotation.x = -Math.PI / 2;
    grass.position.set(0, 0, 10);
    grass.receiveShadow = true;
    this.scene.add(grass);

    // Pitch (dirt path)
    const pitchGeo = new THREE.PlaneGeometry(5, PITCH_LENGTH + 5);
    const pitchTex = this.createDirtTexture();
    const pitchAlphaMap = this.createPitchAlphaMap();
    const pitchMat = new THREE.MeshStandardMaterial({
      map: pitchTex,
      alphaMap: pitchAlphaMap,
      transparent: true,
      roughness: 1.0,
      metalness: 0.0,
    });
    const pitch = new THREE.Mesh(pitchGeo, pitchMat);
    pitch.rotation.x = -Math.PI / 2;
    pitch.position.set(0, 0.003, 2);
    pitch.receiveShadow = true;
    this.scene.add(pitch);

    // Foul line
    const lineLength = 18;
    const lineGeo = new THREE.PlaneGeometry(0.11, lineLength);
    const lineMat = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.24 });
    const line = new THREE.Mesh(lineGeo, lineMat);
    line.rotation.x = -Math.PI / 2;
    line.position.set(0, 0.006, 10.25 - lineLength / 2);
    this.scene.add(line);

    // Physics ground
    this.groundBody = new CANNON.Body({ mass: 0, material });
    this.groundBody.addShape(new CANNON.Plane());
    this.groundBody.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
    this.world.addBody(this.groundBody);
  }

  createBoard(material: CANNON.Material) {
    this.boardGroup = new THREE.Group();

    const woodTex = this.createWoodTexture();
    this.boardTopMaterial = new THREE.MeshStandardMaterial({
      map: this.getBoardTopTexture(this.boardTextureIndex),
      roughness: 0.72,
      metalness: 0.02,
    });
    const boardVisMat = new THREE.MeshStandardMaterial({
      map: woodTex,
      roughness: 0.65,
      metalness: 0.05,
    });

    // Main board surface
    const boardShape = new THREE.Shape();
    boardShape.moveTo(-BOARD_W / 2, -BOARD_L / 2);
    boardShape.lineTo(BOARD_W / 2, -BOARD_L / 2);
    boardShape.lineTo(BOARD_W / 2, BOARD_L / 2);
    boardShape.lineTo(-BOARD_W / 2, BOARD_L / 2);
    boardShape.lineTo(-BOARD_W / 2, -BOARD_L / 2);

    const holePath = new THREE.Path();
    holePath.absellipse(0, HOLE_Z, HOLE_RADIUS, HOLE_RADIUS, 0, Math.PI * 2, false, 0);
    boardShape.holes.push(holePath);

    const topPanelGeo = new THREE.ExtrudeGeometry(boardShape, {
      depth: TOP_PANEL_THICKNESS,
      bevelEnabled: false,
      curveSegments: 48,
    });
    topPanelGeo.translate(0, 0, -TOP_PANEL_THICKNESS / 2);
    topPanelGeo.rotateX(Math.PI / 2);
    this.normalizeBoardTopUvs(topPanelGeo);
    topPanelGeo.computeVertexNormals();
    const topPanelMesh = new THREE.Mesh(topPanelGeo, [this.boardTopMaterial, boardVisMat]);
    topPanelMesh.position.y = BOARD_THICKNESS / 2 - TOP_PANEL_THICKNESS / 2;
    topPanelMesh.castShadow = true;
    topPanelMesh.receiveShadow = true;
    this.boardGroup.add(topPanelMesh);

    const apronDepth = BOARD_THICKNESS - TOP_PANEL_THICKNESS;
    const leftApron = new THREE.Mesh(new THREE.BoxGeometry(SIDE_APRON_THICKNESS, apronDepth, BOARD_L), boardVisMat);
    leftApron.position.set(-BOARD_W / 2 + SIDE_APRON_THICKNESS / 2, -TOP_PANEL_THICKNESS / 2, 0);
    leftApron.castShadow = true;
    leftApron.receiveShadow = true;
    this.boardGroup.add(leftApron);

    const rightApron = new THREE.Mesh(new THREE.BoxGeometry(SIDE_APRON_THICKNESS, apronDepth, BOARD_L), boardVisMat);
    rightApron.position.set(BOARD_W / 2 - SIDE_APRON_THICKNESS / 2, -TOP_PANEL_THICKNESS / 2, 0);
    rightApron.castShadow = true;
    rightApron.receiveShadow = true;
    this.boardGroup.add(rightApron);

    const frontApron = new THREE.Mesh(new THREE.BoxGeometry(BOARD_W, apronDepth, SIDE_APRON_THICKNESS), boardVisMat);
    frontApron.position.set(0, -TOP_PANEL_THICKNESS / 2, BOARD_L / 2 - SIDE_APRON_THICKNESS / 2);
    frontApron.castShadow = true;
    frontApron.receiveShadow = true;
    this.boardGroup.add(frontApron);

    const rearApron = new THREE.Mesh(new THREE.BoxGeometry(BOARD_W, apronDepth, SIDE_APRON_THICKNESS), boardVisMat);
    rearApron.position.set(0, -TOP_PANEL_THICKNESS / 2, -BOARD_L / 2 + SIDE_APRON_THICKNESS / 2);
    rearApron.castShadow = true;
    rearApron.receiveShadow = true;
    this.boardGroup.add(rearApron);

    const holeInnerWall = new THREE.Mesh(
      new THREE.CylinderGeometry(HOLE_RADIUS, HOLE_RADIUS, TOP_PANEL_THICKNESS, 40, 1, true),
      new THREE.MeshStandardMaterial({ color: 0x171717, roughness: 0.92, metalness: 0.02, side: THREE.DoubleSide })
    );
    holeInnerWall.position.set(0, BOARD_THICKNESS / 2 - TOP_PANEL_THICKNESS / 2, HOLE_Z);
    holeInnerWall.castShadow = false;
    holeInnerWall.receiveShadow = true;
    this.boardGroup.add(holeInnerWall);

    // Hole rim ring
    const rimGeo = new THREE.RingGeometry(HOLE_RADIUS - 0.015, HOLE_RADIUS + 0.015, 32);
    const rimMat = new THREE.MeshStandardMaterial({ color: 0x888888, roughness: 0.4, metalness: 0.3 });
    const rim = new THREE.Mesh(rimGeo, rimMat);
    rim.rotation.x = -Math.PI / 2;
    rim.position.set(0, BOARD_THICKNESS / 2 + 0.003, HOLE_Z);
    this.boardGroup.add(rim);

    // Debug: visualize the hole collider used for cornhole detection.
    // Detection fires when a bag's center is within HOLE_CAPTURE_RADIUS in
    // board-local XZ AND has sunk below the HOLE_CAPTURE_Y plane.
    const debugGroup = new THREE.Group();
    const debugRadius = HOLE_CAPTURE_RADIUS;
    const debugCylBottomY = HOLE_CAPTURE_Y - BAG_SIZE * 1.2;
    const debugCylHeight = HOLE_CAPTURE_Y - debugCylBottomY;
    const debugMat = new THREE.MeshBasicMaterial({
      color: 0xff3366,
      transparent: true,
      opacity: 0.22,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const debugCyl = new THREE.Mesh(
      new THREE.CylinderGeometry(debugRadius, debugRadius, debugCylHeight, 32, 1, true),
      debugMat,
    );
    debugCyl.position.set(0, debugCylBottomY + debugCylHeight / 2, HOLE_Z);
    debugGroup.add(debugCyl);
    // Trigger plane ring (sits at HOLE_CAPTURE_Y)
    const debugRingMat = new THREE.MeshBasicMaterial({
      color: 0xff3366,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const debugRing = new THREE.Mesh(
      new THREE.RingGeometry(debugRadius - 0.012, debugRadius + 0.012, 48),
      debugRingMat,
    );
    debugRing.rotation.x = -Math.PI / 2;
    debugRing.position.set(0, HOLE_CAPTURE_Y, HOLE_Z);
    debugGroup.add(debugRing);
    debugGroup.visible = false;
    this.boardGroup.add(debugGroup);
    this.holeColliderDebug = debugGroup;

    // Legs
    const legGeo = new THREE.BoxGeometry(REAR_LEG_THICKNESS, REAR_LEG_LENGTH, REAR_LEG_THICKNESS * 1.17);
    const legMat = new THREE.MeshStandardMaterial({ color: 0x555555, roughness: 0.5, metalness: 0.4 });

    const legPositions = [
      [-BOARD_W / 2 + 0.24, -REAR_LEG_LENGTH / 2 - BOARD_THICKNESS / 2, -BOARD_L / 2 + 0.14],
      [BOARD_W / 2 - 0.24, -REAR_LEG_LENGTH / 2 - BOARD_THICKNESS / 2, -BOARD_L / 2 + 0.14],
    ];

    for (const lp of legPositions) {
      const leg = new THREE.Mesh(legGeo, legMat);
      leg.position.set(lp[0], lp[1], lp[2]);
      leg.rotation.x = BOARD_TILT * 0.92;
      leg.castShadow = true;
      this.boardGroup.add(leg);
    }

    // Position board at far end, tilted
    const boardCenterY = FRONT_EDGE_TOP_HEIGHT + Math.sin(BOARD_TILT) * (BOARD_L / 2) - (BOARD_THICKNESS / 2) * Math.cos(BOARD_TILT);
    this.boardGroup.position.set(0, boardCenterY, -10);
    this.boardGroup.rotation.x = BOARD_TILT; // ~10 degree tilt
    this.scene.add(this.boardGroup);

    // Physics body — split into 4 segments leaving a gap at the hole
    this.boardBody = new CANNON.Body({ mass: 0, material });

    const physicsBoardHalfThickness = BOARD_THICKNESS / 2;
    const holeRowMinZ = HOLE_Z - HOLE_RADIUS;
    const holeRowMaxZ = HOLE_Z + HOLE_RADIUS;

    // Front section: from board front edge to hole row
    const frontHalfZ = (BOARD_L / 2 - holeRowMaxZ) / 2;
    this.boardBody.addShape(
      new CANNON.Box(new CANNON.Vec3(BOARD_W / 2, physicsBoardHalfThickness, frontHalfZ)),
      new CANNON.Vec3(0, 0, holeRowMaxZ + frontHalfZ)
    );

    // Back section: from hole row to board back edge
    const backHalfZ = (-BOARD_L / 2 - holeRowMinZ) / -2;
    this.boardBody.addShape(
      new CANNON.Box(new CANNON.Vec3(BOARD_W / 2, physicsBoardHalfThickness, backHalfZ)),
      new CANNON.Vec3(0, 0, holeRowMinZ - backHalfZ)
    );

    // Left strip alongside hole
    const sideStripHalfX = (BOARD_W / 2 - HOLE_RADIUS) / 2;
    const holeRowHalfZ = HOLE_RADIUS;
    this.boardBody.addShape(
      new CANNON.Box(new CANNON.Vec3(sideStripHalfX, physicsBoardHalfThickness, holeRowHalfZ)),
      new CANNON.Vec3(-HOLE_RADIUS - sideStripHalfX, 0, HOLE_Z)
    );

    // Right strip alongside hole
    this.boardBody.addShape(
      new CANNON.Box(new CANNON.Vec3(sideStripHalfX, physicsBoardHalfThickness, holeRowHalfZ)),
      new CANNON.Vec3(HOLE_RADIUS + sideStripHalfX, 0, HOLE_Z)
    );

    const bp = this.boardGroup.position;
    this.boardBody.position.set(bp.x, bp.y, bp.z);
    this.boardBody.quaternion.setFromEuler(BOARD_TILT, 0, 0);
    this.world.addBody(this.boardBody);
  }

  // Prevent bags from catching on the edges of the physics hole cutout.
  // The physics hole is a square (front/back sections + left/right strips),
  // but the visual hole is circular. Bags whose centers are within the hole's
  // circular radius should pass through cleanly, even if part of their volume
  // is still overlapping the square's strip edges that bound the cutout.
  suppressBagHoleRimBounce() {
    const boardWorldPos = new THREE.Vector3();
    this.boardGroup.getWorldPosition(boardWorldPos);
    const boardWorldQuat = new THREE.Quaternion();
    this.boardGroup.getWorldQuaternion(boardWorldQuat);
    const invBoardQuat = boardWorldQuat.clone().invert();
    const tmp = new THREE.Vector3();

    for (let i = 0; i < this.bagBodies.length; i++) {
      const bag = this.bagBodies[i];
      // Check bag position in board-local space
      tmp.set(bag.position.x, bag.position.y, bag.position.z);
      tmp.sub(boardWorldPos).applyQuaternion(invBoardQuat);
      const holeDist = Math.hypot(tmp.x, tmp.z - HOLE_Z);

      // If the bag's center is within the hole circle, the bag should pass
      // through cleanly. Zero out any board-outward (up along board normal)
      // velocity the solver just applied from clipping into rim strip edges.
      if (holeDist < HOLE_RADIUS) {
        // Board's "up" normal in world space (Y axis rotated by board tilt)
        const upLocal = new CANNON.Vec3(0, 1, 0);
        const bq = new CANNON.Quaternion(
          this.boardBody.quaternion.x,
          this.boardBody.quaternion.y,
          this.boardBody.quaternion.z,
          this.boardBody.quaternion.w,
        );
        const upWorld = bq.vmult(upLocal);

        const v = bag.velocity;
        const vUp = v.x * upWorld.x + v.y * upWorld.y + v.z * upWorld.z;
        // Only cancel upward (out of board) component. Keep downward momentum
        // so the bag keeps falling into the hole.
        if (vUp > 0) {
          v.x -= vUp * upWorld.x;
          v.y -= vUp * upWorld.y;
          v.z -= vUp * upWorld.z;
        }
      }
    }
  }

  applyHoleCaptureAssist(dt: number) {
    const boardWorldPos = new THREE.Vector3();
    this.boardGroup.getWorldPosition(boardWorldPos);
    const boardWorldQuat = new THREE.Quaternion();
    this.boardGroup.getWorldQuaternion(boardWorldQuat);
    const invBoardQuat = boardWorldQuat.clone().invert();
    const localPos = new THREE.Vector3();
    const localVel = new THREE.Vector3();
    const boardTopY = BOARD_THICKNESS / 2;

    for (let i = 0; i < this.bagBodies.length; i++) {
      if (!this.bags[i]?.visible || this.bagInHole[i]) continue;

      const body = this.bagBodies[i];
      localPos.set(body.position.x, body.position.y, body.position.z)
        .sub(boardWorldPos)
        .applyQuaternion(invBoardQuat);

      const holeDx = localPos.x;
      const holeDz = localPos.z - HOLE_Z;
      const holeDist = Math.hypot(holeDx, holeDz);
      if (holeDist > HOLE_FUNNEL_RADIUS) continue;

      const nearBoardSurface = localPos.y < boardTopY + BAG_SIZE * 0.65
        && localPos.y > HOLE_CAPTURE_Y - BAG_SIZE * 0.4;
      if (!nearBoardSurface) continue;

      const rawAssist = THREE.MathUtils.clamp(
        (HOLE_FUNNEL_RADIUS - holeDist) / (HOLE_FUNNEL_RADIUS - HOLE_CAPTURE_RADIUS * 0.5),
        0,
        1,
      );
      const assist = rawAssist * rawAssist * rawAssist;

      localVel.set(body.velocity.x, body.velocity.y, body.velocity.z).applyQuaternion(invBoardQuat);
      const centering = (1.65 + assist * 3.15) * assist * dt;
      localVel.x += -holeDx * centering;
      localVel.z += -holeDz * centering;

      // The visible bag can compress through a round hole, but the physics body
      // is a rigid box. Pull centered bags down through the artificial rim so
      // they do not hover on the hidden rectangular collision strips.
      if (localVel.y > 0) localVel.y *= 0.18;
      const targetSinkSpeed = THREE.MathUtils.lerp(0.21, 0.94, assist);
      if (-localVel.y < targetSinkSpeed) {
        localVel.y = -targetSinkSpeed;
      }

      localVel.applyQuaternion(boardWorldQuat);
      body.velocity.set(localVel.x, localVel.y, localVel.z);
      body.angularVelocity.scale(THREE.MathUtils.clamp(1 - assist * 4 * dt, 0.68, 1), body.angularVelocity);

      if (holeDist < HOLE_CAPTURE_RADIUS && localPos.y < boardTopY + BAG_SIZE * 0.34) {
        this.markBagInHole(i, boardWorldQuat);
      }
    }
  }

  // Zero out the outward-normal velocity component when a bag contacts the
  // board's front face, so it drops instead of bouncing back toward the thrower.
  // Why: the front face is near-vertical; even with tiny restitution the solver
  // redirects incoming horizontal momentum into a visible rebound.
  suppressFrontEdgeBounce() {
    // Front-face outward normal in world space (board rotated +BOARD_TILT about X).
    const frontNx = 0;
    const frontNy = -Math.sin(BOARD_TILT);
    const frontNz = Math.cos(BOARD_TILT);

    const contacts = this.world.contacts;
    for (let c = 0; c < contacts.length; c++) {
      const eq = contacts[c];
      let bag: CANNON.Body | null = null;
      let normalSign = 1;
      if (eq.bi === this.boardBody && this.bagBodies.includes(eq.bj)) {
        bag = eq.bj;
        normalSign = 1; // ni points from boardBody (bi) to bag (bj) — outward from board
      } else if (eq.bj === this.boardBody && this.bagBodies.includes(eq.bi)) {
        bag = eq.bi;
        normalSign = -1; // ni points from bag (bi) to board (bj) — flip to get outward-from-board
      } else {
        continue;
      }

      const nx = eq.ni.x * normalSign;
      const ny = eq.ni.y * normalSign;
      const nz = eq.ni.z * normalSign;

      // Dot with front-face outward normal; require strong alignment so we
      // don't affect top-surface or hole-edge contacts.
      const alignment = nx * frontNx + ny * frontNy + nz * frontNz;
      if (alignment < 0.7) continue;

      const v = bag.velocity;
      const vn = v.x * nx + v.y * ny + v.z * nz;
      if (vn <= 0) continue; // already moving into the board, nothing to cancel

      v.x -= vn * nx;
      v.y -= vn * ny;
      v.z -= vn * nz;
    }
  }

  async initAudio() {
    try {
      this.audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();

      // Load board hit sounds
      const soundFiles = ['bag-on-board-1.mp3', 'bag-on-board-2.mp3', 'bag-on-board-3.mp3'];
      for (const file of soundFiles) {
        try {
          const response = await fetch(`/audio/${file}`);
          const arrayBuffer = await response.arrayBuffer();
          const audioBuffer = await this.audioContext.decodeAudioData(arrayBuffer);
          this.boardHitSounds.push(audioBuffer);
        } catch (e) {
          console.warn(`Failed to load audio file: ${file}`, e);
        }
      }

      // Load bag-on-bag impact sounds
      const bagOnBagFiles = [
        'bag-on-bag-1.mp3',
        'bag-on-bag-2.mp3',
        'bag-on-bag-3.mp3',
        'bag-on-bag-4.mp3',
        'bag-on-bag-5.mp3',
      ];
      for (const file of bagOnBagFiles) {
        try {
          const response = await fetch(`/audio/${file}`);
          const arrayBuffer = await response.arrayBuffer();
          const audioBuffer = await this.audioContext.decodeAudioData(arrayBuffer);
          this.bagOnBagSounds.push(audioBuffer);
        } catch (e) {
          console.warn(`Failed to load audio file: ${file}`, e);
        }
      }

      // Load cornhole sounds
      const cornholeFiles = ['cornhole-1.mp3', 'cornhole-2.mp3'];
      for (const file of cornholeFiles) {
        try {
          const response = await fetch(`/audio/${file}`);
          const arrayBuffer = await response.arrayBuffer();
          const audioBuffer = await this.audioContext.decodeAudioData(arrayBuffer);
          this.cornholeSounds.push(audioBuffer);
        } catch (e) {
          console.warn(`Failed to load audio file: ${file}`, e);
        }
      }
    } catch (e) {
      console.warn('Web Audio API not supported');
    }
  }

  playCornholeSound() {
    if (!this.audioContext) return;
    if (this.audioContext.state === 'suspended') {
      this.audioContext.resume();
    }

    // Play a random cornhole sound if loaded, otherwise fall back to synthesized sound
    if (this.cornholeSounds.length > 0) {
      const randomSound = this.cornholeSounds[Math.floor(Math.random() * this.cornholeSounds.length)];
      const source = this.audioContext.createBufferSource();
      source.buffer = randomSound;
      source.connect(this.audioContext.destination);
      source.start(0);
    } else {
      // Fallback to synthesized sound if audio files aren't loaded
      const ctx = this.audioContext;
      const now = ctx.currentTime;

      // Create a satisfying "swish + thud" sound for cornhole
      // Noise burst for swish
      const noiseBuffer = ctx.createBuffer(1, ctx.sampleRate * 0.15, ctx.sampleRate);
      const noiseData = noiseBuffer.getChannelData(0);
      for (let i = 0; i < noiseData.length; i++) {
        noiseData[i] = Math.random() * 2 - 1;
      }
      const noise = ctx.createBufferSource();
      noise.buffer = noiseBuffer;
      const noiseGain = ctx.createGain();
      noiseGain.gain.setValueAtTime(0.3, now);
      noiseGain.gain.exponentialRampToValueAtTime(0.01, now + 0.15);
      const noiseFilter = ctx.createBiquadFilter();
      noiseFilter.type = 'bandpass';
      noiseFilter.frequency.value = 800;
      noise.connect(noiseFilter);
      noiseFilter.connect(noiseGain);
      noiseGain.connect(ctx.destination);
      noise.start(now);
      noise.stop(now + 0.15);

      // Low thud for bag hitting bottom
      const thudOsc = ctx.createOscillator();
      thudOsc.type = 'sine';
      thudOsc.frequency.setValueAtTime(150, now);
      thudOsc.frequency.exponentialRampToValueAtTime(60, now + 0.2);
      const thudGain = ctx.createGain();
      thudGain.gain.setValueAtTime(0.4, now);
      thudGain.gain.exponentialRampToValueAtTime(0.01, now + 0.3);
      thudOsc.connect(thudGain);
      thudGain.connect(ctx.destination);
      thudOsc.start(now);
      thudOsc.stop(now + 0.3);
    }
  }

  playBagOnBagSound() {
    if (!this.audioContext) return;
    if (this.audioContext.state === 'suspended') {
      this.audioContext.resume();
    }

    if (this.bagOnBagSounds.length > 0) {
      const randomSound = this.bagOnBagSounds[Math.floor(Math.random() * this.bagOnBagSounds.length)];
      const source = this.audioContext.createBufferSource();
      source.buffer = randomSound;
      source.connect(this.audioContext.destination);
      source.start(0);
    } else {
      const ctx = this.audioContext;
      const now = ctx.currentTime;

      const osc = ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(210, now);
      osc.frequency.exponentialRampToValueAtTime(85, now + 0.12);
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.22, now);
      gain.gain.exponentialRampToValueAtTime(0.01, now + 0.16);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.16);
    }
  }

  playPointSound() {
    if (!this.audioContext) return;
    if (this.audioContext.state === 'suspended') {
      this.audioContext.resume();
    }

    // Play a random board hit sound if loaded, otherwise fall back to synthesized sound
    if (this.boardHitSounds.length > 0) {
      const randomSound = this.boardHitSounds[Math.floor(Math.random() * this.boardHitSounds.length)];
      const source = this.audioContext.createBufferSource();
      source.buffer = randomSound;
      source.connect(this.audioContext.destination);
      source.start(0);
    } else {
      // Fallback to synthesized sound if audio files aren't loaded
      const ctx = this.audioContext;
      const now = ctx.currentTime;

      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(400, now);
      osc.frequency.exponentialRampToValueAtTime(200, now + 0.1);
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.2, now);
      gain.gain.exponentialRampToValueAtTime(0.01, now + 0.15);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.15);
    }
  }

  createBags(material: CANNON.Material) {
    // 4 red (player 1), 4 blue (player 2)
    const bagColors = [0xCC2222, 0xCC2222, 0xCC2222, 0xCC2222, 0x2244CC, 0x2244CC, 0x2244CC, 0x2244CC];

    for (let i = 0; i < 8; i++) {
      const geo = this.createBagGeometry();
      const materials = this.createBagMeshMaterials(bagColors[i]);

      const mesh = new THREE.Mesh(geo, materials);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.visible = false;
      mesh.scale.set(1, 1, 1);
      this.scene.add(mesh);
      this.bags.push(mesh);

      // Physics
      const body = new CANNON.Body({
        mass: BAG_MASS,
        material,
        shape: new CANNON.Box(new CANNON.Vec3(BAG_SIZE, BAG_SIZE * 0.26, BAG_SIZE)),
        linearDamping: 0.55,
        angularDamping: 0.75,
      });
      body.position.set(0, -20, 0);
      this.world.addBody(body);
      this.bagBodies.push(body);
      this.bagVisualStates.push(this.createBagVisualState());
      // Store rest-pose vertex positions for deformation blending
      const restPose = new Float32Array((geo.attributes.position as THREE.BufferAttribute).array);
      this.bagRestPosePositions.push(restPose);
    }
  }

  createBagMeshMaterials(teamColor: number): THREE.MeshStandardMaterial[] {
    const edgeTex = this.createFabricTexture(teamColor);
    const isBlueTeam = ((teamColor >> 16) & 0xff) < ((teamColor >> 8) & 0xff) + ((teamColor >> 0) & 0xff);
    const stickyTex = this.createBagFaceTexture(
      isBlueTeam ? this.shadeColor(teamColor, 0.18) : this.shadeColor(teamColor, 0.08),
      isBlueTeam ? this.tintColor(teamColor, 0.35) : this.tintColor(teamColor, 0.16),
      false
    );
    const slickTex = this.createBagFaceTexture(
      this.shadeColor(teamColor, isBlueTeam ? 0.2 : 0.14),
      this.tintColor(teamColor, isBlueTeam ? 0.42 : 0.28),
      true
    );

    return [
      new THREE.MeshStandardMaterial({ map: edgeTex, roughness: 0.88, metalness: 0.0 }),
      new THREE.MeshStandardMaterial({ map: edgeTex, roughness: 0.88, metalness: 0.0 }),
      new THREE.MeshStandardMaterial({ map: stickyTex, roughness: 0.96, metalness: 0.0 }),
      new THREE.MeshStandardMaterial({ map: slickTex, roughness: 0.82, metalness: 0.0 }),
      new THREE.MeshStandardMaterial({ map: edgeTex, roughness: 0.88, metalness: 0.0 }),
      new THREE.MeshStandardMaterial({ map: edgeTex, roughness: 0.88, metalness: 0.0 }),
    ];
  }

  createBagPreview() {
    const ambient = new THREE.AmbientLight(0xffffff, 0.95);
    this.previewScene.add(ambient);

    const keyLight = new THREE.DirectionalLight(0xffffff, 1.5);
    keyLight.position.set(2.2, 3.5, 3.2);
    this.previewScene.add(keyLight);

    const rimLight = new THREE.DirectionalLight(0xa8d8ff, 0.7);
    rimLight.position.set(-2.5, 1.8, -1.5);
    this.previewScene.add(rimLight);

    const bag = new THREE.Mesh(
      this.createBagGeometry(),
      this.createBagMeshMaterials(0xcc2222)
    );
    bag.scale.setScalar(2.2);
    bag.position.set(0, -0.04, 0);
    this.previewScene.add(bag);
    this.previewBag = bag;
    this.updatePreviewBagMaterials();
  }

  updatePreviewBagMaterials() {
    const previewPlayer = this.state.currentPlayer;
    if (this.previewPlayer === previewPlayer && this.previewBag.material) return;

    this.disposeBagMaterials(this.previewBag.material as THREE.Material | THREE.Material[]);
    const teamColor = previewPlayer === 1 ? 0xcc2222 : 0x2244cc;
    this.previewBag.material = this.createBagMeshMaterials(teamColor);
    this.previewPlayer = previewPlayer;
  }

  disposeBagMaterials(material: THREE.Material | THREE.Material[]) {
    const materials = Array.isArray(material) ? material : [material];
    for (const mat of materials) {
      const standardMat = mat as THREE.MeshStandardMaterial;
      if (standardMat.map) standardMat.map.dispose();
      standardMat.dispose();
    }
  }

  createBagGeometry(): THREE.BufferGeometry {
    const bagHeight = BAG_SIZE * 0.52;
    const geo = new THREE.BoxGeometry(BAG_SIZE * 2, bagHeight, BAG_SIZE * 2, 10, 4, 10);
    const pos = geo.attributes.position;

    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const y = pos.getY(i);
      const z = pos.getZ(i);
      const xNorm = THREE.MathUtils.clamp(Math.abs(x) / BAG_SIZE, 0, 1);
      const zNorm = THREE.MathUtils.clamp(Math.abs(z) / BAG_SIZE, 0, 1);
      const edgeBlend = Math.max(xNorm, zNorm);
      const centerWeight = Math.max(0, 1 - edgeBlend * edgeBlend);
      const cornerWeight = xNorm * zNorm;
      const seamDip = Math.pow(edgeBlend, 3) * 0.028;
      const centerBulge = centerWeight * 0.075;
      const cornLump = Math.sin((x / BAG_SIZE) * Math.PI * 1.2) * Math.sin((z / BAG_SIZE) * Math.PI * 1.15) * 0.012 * centerWeight;

      const faceDirection = y >= 0 ? 1 : -1;
      const faceBulge = centerBulge * (y >= 0 ? 1 : 0.82);
      const faceCornLump = cornLump * (y >= 0 ? 1 : 0.85);
      const faceSeamDip = seamDip * (y >= 0 ? 1 : 0.65);
      const faceCornerTuck = cornerWeight * (y >= 0 ? 0.02 : 0.016);

      pos.setY(i, y + faceDirection * (faceBulge + faceCornLump - faceSeamDip - faceCornerTuck));

      const sidePinch = (1 - Math.abs(y) / (bagHeight * 0.5)) * 0.018;
      pos.setX(i, x * (1 - zNorm * sidePinch));
      pos.setZ(i, z * (1 - xNorm * sidePinch));
    }

    geo.computeVertexNormals();
    return geo;
  }

  createBagVisualState(): BagVisualState {
    return {
      squash: 0,
      impactSquash: 0,
      wobbleTime: 0,
      wobbleAmplitude: 0,
      wobblePhase: 0,
      wobbleAxisX: 0,
      wobbleAxisZ: 0,
      lastVelocityY: 0,
      lastImpactAt: -Infinity,
      deformAmount: 0,
      deformContactY: -1,
      deformDirX: 0,
      deformDirZ: 0,
      fillOffsetX: 0,
      fillOffsetY: 0,
      fillOffsetZ: 0,
      isDeforming: false,
      prevSettled: false,
    };
  }

  resetBagVisualState(index: number) {
    const visual = this.bagVisualStates[index];
    if (!visual) return;

    visual.squash = 0;
    visual.impactSquash = 0;
    visual.wobbleTime = 0;
    visual.wobbleAmplitude = 0;
    visual.wobblePhase = 0;
    visual.wobbleAxisX = 0;
    visual.wobbleAxisZ = 0;
    visual.lastVelocityY = 0;
    visual.lastImpactAt = -Infinity;
    visual.deformAmount = 0;
    visual.deformContactY = -1;
    visual.deformDirX = 0;
    visual.deformDirZ = 0;
    visual.fillOffsetX = 0;
    visual.fillOffsetY = 0;
    visual.fillOffsetZ = 0;
    visual.isDeforming = false;
    visual.prevSettled = false;
    this.bags[index].scale.set(1, 1, 1);
    // Restore rest-pose vertices
    const restPose = this.bagRestPosePositions[index];
    if (restPose) {
      const pos = (this.bags[index].geometry as THREE.BufferGeometry).attributes.position as THREE.BufferAttribute;
      pos.array.set(restPose);
      pos.needsUpdate = true;
      this.bags[index].geometry.computeVertexNormals();
    }
  }

  createEnvironment() {
    // Sky dome
    const skyGeo = new THREE.SphereGeometry(90, 32, 16);
    const skyCanvas = document.createElement('canvas');
    skyCanvas.width = 512;
    skyCanvas.height = 512;
    const skyCtx = skyCanvas.getContext('2d')!;
    const grad = skyCtx.createLinearGradient(0, 0, 0, 512);
    grad.addColorStop(0, '#1a4a8a');
    grad.addColorStop(0.3, '#2a7ad0');
    grad.addColorStop(0.6, '#4a9aeb');
    grad.addColorStop(1, '#8ac0f5');
    skyCtx.fillStyle = grad;
    skyCtx.fillRect(0, 0, 512, 512);
    const skyTex = new THREE.CanvasTexture(skyCanvas);
    skyTex.wrapS = skyTex.wrapT = THREE.RepeatWrapping;
    const skyMat = new THREE.MeshBasicMaterial({ map: skyTex, side: THREE.BackSide });
    this.skyMaterial = skyMat;
    this.scene.add(new THREE.Mesh(skyGeo, skyMat));
    this.updateSkyTint();

    // Cloud layers distributed in full-ring (polar) so they surround the play
    // area rather than sitting only in front of the player. Clouds drift along
    // +X at constant Z/Y; wrap bounds are wider than the visible horizon and
    // paired with edge-fade so the loop isn't visible.
    const cloudLayers: Array<{
      count: number;
      rMin: number;
      rMax: number;
      yMin: number;
      yRange: number;
      scaleMin: number;
      scaleRange: number;
      speedMin: number;
      speedRange: number;
      baseOpacity: number;
      wrapX: number;
      fadeMargin: number;
    }> = [
      // Overhead layer — flies above the play field so shadows fall on land
      {
        count: 10, rMin: 0, rMax: 30, yMin: 34, yRange: 10,
        scaleMin: 1.4, scaleRange: 1.6, speedMin: 0.4, speedRange: 1.0,
        baseOpacity: 0.92, wrapX: 85, fadeMargin: 18,
      },
      // Near layer — still well above the player, ringing the field
      {
        count: 28, rMin: 45, rMax: 70, yMin: 28, yRange: 16,
        scaleMin: 1.5, scaleRange: 2, speedMin: 0.5, speedRange: 1.5,
        baseOpacity: 0.95, wrapX: 90, fadeMargin: 20,
      },
      // Mid-far layer — higher and further
      {
        count: 22, rMin: 60, rMax: 82, yMin: 38, yRange: 14,
        scaleMin: 0.8, scaleRange: 1, speedMin: 0.2, speedRange: 0.5,
        baseOpacity: 0.9, wrapX: 100, fadeMargin: 22,
      },
      // Horizon layer — low, ringing the sky dome near its radius (~90)
      {
        count: 34, rMin: 70, rMax: 86, yMin: 6, yRange: 10,
        scaleMin: 0.35, scaleRange: 0.45, speedMin: 0.05, speedRange: 0.15,
        baseOpacity: 0.55, wrapX: 115, fadeMargin: 30,
      },
    ];

    const shadowTex = this.createCloudShadowTexture();
    const shadowGeo = new THREE.PlaneGeometry(1, 1);

    for (const layer of cloudLayers) {
      for (let i = 0; i < layer.count; i++) {
        const cloud = this.createCloud();
        const angle = Math.random() * Math.PI * 2;
        const radius = layer.rMin + Math.random() * (layer.rMax - layer.rMin);
        cloud.position.set(
          Math.cos(angle) * radius,
          layer.yMin + Math.random() * layer.yRange,
          Math.sin(angle) * radius
        );
        const cloudScale = layer.scaleMin + Math.random() * layer.scaleRange;
        cloud.scale.setScalar(cloudScale);
        cloud.userData.speed = layer.speedMin + Math.random() * layer.speedRange;
        cloud.userData.baseOpacity = layer.baseOpacity;
        cloud.userData.wrapX = layer.wrapX;
        cloud.userData.fadeMargin = layer.fadeMargin;
        const mat = cloud.userData.material as THREE.MeshStandardMaterial;
        mat.opacity = layer.baseOpacity;
        this.scene.add(cloud);
        this.clouds.push(cloud);

        // Fake ground shadow disk — radius scales with cloud puff footprint.
        // Real puff span is ~12 units across (6 puffs * 2.5 spacing); shadow
        // reflects that, scaled by the cloud's overall scale.
        const shadowMat = new THREE.MeshBasicMaterial({
          map: shadowTex,
          transparent: true,
          opacity: 0.25,
          depthWrite: false,
          color: 0x000000,
        });
        const shadow = new THREE.Mesh(shadowGeo, shadowMat);
        shadow.rotation.x = -Math.PI / 2;
        shadow.scale.setScalar(14 * cloudScale);
        shadow.position.set(cloud.position.x, 0.02, cloud.position.z);
        shadow.renderOrder = 1;
        shadow.userData.baseOpacity = 0.6 * layer.baseOpacity;
        this.scene.add(shadow);
        this.cloudShadows.push(shadow);
      }
    }

    // Trees
    const treePositions: [number, number, number, number][] = [
      // [x, z, scale, rotation]
      [-12, -18, 1.0, 0.3], [14, -22, 1.1, 1.2], [-18, -8, 0.9, 2.1], [16, -12, 1.0, 0.8],
      [-10, -28, 1.2, 1.5], [20, -26, 0.95, 2.4], [-22, -18, 1.05, 0.6], [24, -20, 1.0, 1.9],
      [-8, -35, 1.15, 0.2], [12, -32, 0.9, 2.7],
      // Additional trees - sides and behind the player
      [-26, -5, 1.0, 1.1], [28, -8, 0.95, 0.4], [-30, -22, 1.1, 2.2], [30, -30, 1.05, 1.6],
      [-14, 4, 0.85, 0.9], [17, 6, 0.9, 2.5], [-24, 10, 1.0, 1.3], [26, 12, 0.95, 0.5],
      [-34, -14, 1.2, 1.8], [32, -18, 1.1, 0.7], [-20, -40, 1.25, 2.0], [22, -38, 1.15, 0.3],
    ];
    for (const [x, z, scale, rot] of treePositions) {
      const tree = this.createTree();
      tree.position.set(x, 0, z);
      tree.scale.setScalar(scale);
      tree.rotation.y = rot;
      this.scene.add(tree);
    }

    // Bushes - scattered lower greenery
    const bushPositions: [number, number, number][] = [
      [-6, 0, -16], [8, 0, -14], [-15, 0, -12], [13, 0, -18], [-9, 0, -24],
      [11, 0, -28], [-19, 0, -24], [19, 0, -14], [-7, 0, 3], [9, 0, 5],
      [-16, 0, 2], [18, 0, 0], [-28, 0, -10], [28, 0, -14], [-11, 0, -38],
      [15, 0, -36], [-25, 0, -30], [25, 0, -32],
    ];
    for (const [x, y, z] of bushPositions) {
      const bush = this.createBush();
      bush.position.set(x, y, z);
      bush.rotation.y = Math.random() * Math.PI * 2;
      bush.scale.setScalar(0.8 + Math.random() * 0.6);
      this.scene.add(bush);
    }

    // Rocks - scattered around
    /*
    const rockPositions: [number, number, number][] = [
      [-5, 0, -6], [6, 0, -8], [-13, 0, -4], [14, 0, -2], [-8, 0, 7],
      [10, 0, 8], [-21, 0, -14], [23, 0, -16], [-17, 0, -32], [18, 0, -30],
      [-4, 0, 10], [5, 0, 11],
    ];
    for (const [x, y, z] of rockPositions) {
      const rock = this.createRock();
      rock.position.set(x, y, z);
      rock.rotation.y = Math.random() * Math.PI * 2;
      rock.scale.setScalar(0.6 + Math.random() * 0.9);
      this.scene.add(rock);
    }
    // Flower patches
    for (let i = 0; i < 40; i++) {
      const angle = Math.random() * Math.PI * 2;
      const radius = 5 + Math.random() * 22;
      const x = Math.cos(angle) * radius;
      const z = Math.sin(angle) * radius - 8;
      // Keep flowers off the pitch
      if (Math.abs(x) < 3.2 && z > -14 && z < 8) continue;
      const flower = this.createFlower();
      flower.position.set(x, 0, z);
      flower.rotation.y = Math.random() * Math.PI * 2;
      this.scene.add(flower);
    }
    */

    // Grass tufts
    for (let i = 0; i < 60; i++) {
      const angle = Math.random() * Math.PI * 2;
      const radius = 4 + Math.random() * 26;
      const x = Math.cos(angle) * radius;
      const z = Math.sin(angle) * radius - 8;
      if (Math.abs(x) < 3.2 && z > -14 && z < 8) continue;
      const tuft = this.createGrassTuft();
      tuft.position.set(x, 0, z);
      tuft.rotation.y = Math.random() * Math.PI * 2;
      this.scene.add(tuft);
    }

    // Fence
    this.createFence();
  }

  createBush(): THREE.Group {
    const group = new THREE.Group();
    const bushMat = new THREE.MeshStandardMaterial({
      color: 0x2d6b28,
      roughness: 0.9,
    });
    const puffCount = 3 + Math.floor(Math.random() * 3);
    for (let i = 0; i < puffCount; i++) {
      const size = 0.35 + Math.random() * 0.35;
      const puff = new THREE.Mesh(
        new THREE.SphereGeometry(size, 8, 6),
        bushMat
      );
      puff.position.set(
        (Math.random() - 0.5) * 0.8,
        size * 0.85 + Math.random() * 0.15,
        (Math.random() - 0.5) * 0.8
      );
      puff.castShadow = true;
      puff.receiveShadow = true;
      group.add(puff);
    }
    return group;
  }

  createRock(): THREE.Group {
    const group = new THREE.Group();
    const rockMat = new THREE.MeshStandardMaterial({
      color: 0x7a7268,
      roughness: 0.95,
      metalness: 0.05,
    });
    const rockCount = 1 + Math.floor(Math.random() * 2);
    for (let i = 0; i < rockCount; i++) {
      const geo = new THREE.DodecahedronGeometry(0.25 + Math.random() * 0.35, 0);
      const pos = geo.attributes.position;
      for (let j = 0; j < pos.count; j++) {
        pos.setXYZ(
          j,
          pos.getX(j) * (0.85 + Math.random() * 0.3),
          pos.getY(j) * (0.6 + Math.random() * 0.3),
          pos.getZ(j) * (0.85 + Math.random() * 0.3)
        );
      }
      geo.computeVertexNormals();
      const rock = new THREE.Mesh(geo, rockMat);
      rock.position.set(
        (Math.random() - 0.5) * 0.4,
        0.15,
        (Math.random() - 0.5) * 0.4
      );
      rock.rotation.set(Math.random() * 0.5, Math.random() * Math.PI, Math.random() * 0.5);
      rock.castShadow = true;
      rock.receiveShadow = true;
      group.add(rock);
    }
    return group;
  }

  createFlower(): THREE.Group {
    const group = new THREE.Group();
    const stemMat = new THREE.MeshStandardMaterial({ color: 0x3e7a2e, roughness: 0.9 });
    const petalColors = [0xff4d6d, 0xffd23f, 0xf7f7f7, 0xd65db1, 0xf5a524, 0x9b5de5];
    const color = petalColors[Math.floor(Math.random() * petalColors.length)];
    const petalMat = new THREE.MeshStandardMaterial({ color, roughness: 0.7 });
    const centerMat = new THREE.MeshStandardMaterial({ color: 0xf2c94c, roughness: 0.7 });

    const clusterSize = 2 + Math.floor(Math.random() * 3);
    for (let i = 0; i < clusterSize; i++) {
      const stem = new THREE.Mesh(
        new THREE.CylinderGeometry(0.012, 0.012, 0.25, 5),
        stemMat
      );
      const offsetX = (Math.random() - 0.5) * 0.25;
      const offsetZ = (Math.random() - 0.5) * 0.25;
      stem.position.set(offsetX, 0.125, offsetZ);
      group.add(stem);

      const petals = new THREE.Mesh(new THREE.SphereGeometry(0.06, 6, 5), petalMat);
      petals.position.set(offsetX, 0.26, offsetZ);
      petals.scale.set(1, 0.55, 1);
      group.add(petals);

      const center = new THREE.Mesh(new THREE.SphereGeometry(0.025, 6, 5), centerMat);
      center.position.set(offsetX, 0.275, offsetZ);
      group.add(center);
    }
    return group;
  }

  createGrassTuft(): THREE.Group {
    const group = new THREE.Group();
    const grassMat = new THREE.MeshStandardMaterial({
      color: 0x4a8a3a,
      roughness: 0.95,
      side: THREE.DoubleSide,
    });
    const bladeCount = 4 + Math.floor(Math.random() * 4);
    for (let i = 0; i < bladeCount; i++) {
      const blade = new THREE.Mesh(
        new THREE.PlaneGeometry(0.05, 0.18 + Math.random() * 0.12),
        grassMat
      );
      blade.position.set(
        (Math.random() - 0.5) * 0.15,
        0.09 + Math.random() * 0.04,
        (Math.random() - 0.5) * 0.15
      );
      blade.rotation.y = Math.random() * Math.PI;
      blade.rotation.z = (Math.random() - 0.5) * 0.3;
      group.add(blade);
    }
    return group;
  }

  // Soft-edged circular alpha texture used for fake cloud shadows on the ground.
  createCloudShadowTexture(): THREE.CanvasTexture {
    const size = 128;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d')!;
    const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    grad.addColorStop(0, 'rgba(0,0,0,1)');
    grad.addColorStop(0.55, 'rgba(0,0,0,0.55)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);
    return new THREE.CanvasTexture(canvas);
  }

  createCloud(): THREE.Group {
    const group = new THREE.Group();
    const cloudMat = new THREE.MeshStandardMaterial({
      color: 0xFFFFFF,
      roughness: 1,
      transparent: true,
      opacity: 0.95,
    });
    const puffGeo = new THREE.SphereGeometry(2, 8, 6);
    for (let i = 0; i < 6; i++) {
      const puff = new THREE.Mesh(puffGeo, cloudMat);
      puff.position.set(i * 2.5 - 6, Math.random() * 1, Math.random() * 1.5);
      puff.scale.set(0.8 + Math.random() * 0.6, 0.5 + Math.random() * 0.4, 0.6 + Math.random() * 0.5);
      group.add(puff);
    }
    group.userData.material = cloudMat;
    return group;
  }

  createTree(): THREE.Group {
    const group = new THREE.Group();
    const trunkGeo = new THREE.CylinderGeometry(0.12, 0.2, 2.5, 6);
    const trunkMat = new THREE.MeshStandardMaterial({ color: 0x5C3A1E, roughness: 0.9 });
    const trunk = new THREE.Mesh(trunkGeo, trunkMat);
    trunk.position.y = 1.25;
    trunk.castShadow = true;
    group.add(trunk);

    const foliageMat = new THREE.MeshStandardMaterial({ color: 0x2D7D2D, roughness: 0.8 });
    const sizes = [1.8, 1.4, 1.0];
    const heights = [2.8, 3.6, 4.2];
    for (let i = 0; i < 3; i++) {
      const fGeo = new THREE.SphereGeometry(sizes[i], 8, 6);
      const foliage = new THREE.Mesh(fGeo, foliageMat);
      foliage.position.y = heights[i];
      foliage.castShadow = true;
      group.add(foliage);
    }
    return group;
  }

  createFence() {
    const fenceMat = new THREE.MeshStandardMaterial({ color: 0x8B7355, roughness: 0.9 });
    for (let x = -25; x <= 25; x += 2.5) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.08, 1.0, 0.08), fenceMat);
      post.position.set(x, 0.5, -28);
      post.castShadow = true;
      this.scene.add(post);

      if (x < 25) {
        const rail1 = new THREE.Mesh(new THREE.BoxGeometry(2.5, 0.06, 0.04), fenceMat);
        rail1.position.set(x + 1.25, 0.8, -28);
        this.scene.add(rail1);
        const rail2 = new THREE.Mesh(new THREE.BoxGeometry(2.5, 0.06, 0.04), fenceMat);
        rail2.position.set(x + 1.25, 0.4, -28);
        this.scene.add(rail2);
      }
    }
  }

  createPullLine() {
    const geo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(0, 0, 0),
    ]);
    const mat = new THREE.LineBasicMaterial({
      color: 0xfff3c4,
      transparent: true,
      opacity: 0.75,
    });
    this.pullLine = new THREE.Line(geo, mat);
    this.pullLine.visible = false;
    this.scene.add(this.pullLine);
  }

  // ====== TEXTURES ======

  createGrassTexture(): THREE.CanvasTexture {
    const c = document.createElement('canvas');
    c.width = 512;
    c.height = 512;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#3a7d3a';
    ctx.fillRect(0, 0, 512, 512);
    for (let i = 0; i < 12000; i++) {
      const x = Math.random() * 512;
      const y = Math.random() * 512;
      const s = Math.random() * 30 - 15;
      ctx.fillStyle = `rgb(${58 + s},${125 + s},${58 + s})`;
      ctx.fillRect(x, y, 1 + Math.random() * 2, 2 + Math.random() * 3);
    }
    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(12, 12);
    return tex;
  }

  createDirtTexture(): THREE.CanvasTexture {
    const c = document.createElement('canvas');
    c.width = 256;
    c.height = 256;
    const ctx = c.getContext('2d')!;

    // Parse RGB color
    const rgbMatch = 'rgb(97, 49, 4)'.match(/\d+/g);
    const baseR = parseInt(rgbMatch![0]);
    const baseG = parseInt(rgbMatch![1]);
    const baseB = parseInt(rgbMatch![2]);

    // Base color fill
    ctx.fillStyle = `rgb(${baseR}, ${baseG}, ${baseB})`;
    ctx.fillRect(0, 0, 256, 256);

    // Add organic dirt texture with varied particle sizes and colors
    for (let i = 0; i < 8000; i++) {
      const x = Math.random() * 256;
      const y = Math.random() * 256;
      const s = Math.random() * 30 - 15;
      const size = 1 + Math.random() * 4;

      const r = Math.max(0, Math.min(255, baseR + s + Math.random() * 1));
      const g = Math.max(0, Math.min(255, baseG + s + Math.random() * 1));
      const b = Math.max(0, Math.min(255, baseB + s + Math.random() * 1));

      ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;

      if (Math.random() > 0.5) {
        ctx.fillRect(x, y, size, size);
      } else {
        ctx.beginPath();
        ctx.arc(x, y, size / 2, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // Add some larger pebbles/rocks
    for (let i = 0; i < 200; i++) {
      const x = Math.random() * 256;
      const y = Math.random() * 256;
      const size = 2 + Math.random() * 6;
      const gray = 80 + Math.random() * 40;
      ctx.fillStyle = `rgb(${gray}, ${gray - 20}, ${gray - 30})`;
      ctx.beginPath();
      ctx.arc(x, y, size / 2, 0, Math.PI * 2);
      ctx.fill();
    }

    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(2, 12);
    return tex;
  }

  createPitchAlphaMap(): THREE.CanvasTexture {
    // Alpha map that fades the pitch edges with an irregular/organic border
    const c = document.createElement('canvas');
    c.width = 256;
    c.height = 512;
    const ctx = c.getContext('2d')!;

    // Start fully transparent
    ctx.fillStyle = 'black';
    ctx.fillRect(0, 0, 256, 512);

    // Draw opaque dirt area with irregular edges using many overlapping ellipses
    ctx.fillStyle = 'white';

    // Core solid region
    ctx.beginPath();
    ctx.ellipse(128, 256, 90, 230, 0, 0, Math.PI * 2);
    ctx.fill();

    // Add irregular blobs along the edge for organic border
    for (let i = 0; i < 60; i++) {
      const t = i / 60;
      const y = 20 + t * 472;
      const side = i % 2 === 0 ? 1 : -1;
      const edgeX = 128 + side * (85 + Math.random() * 25);
      const radius = 15 + Math.random() * 20;
      ctx.beginPath();
      ctx.arc(edgeX, y, radius, 0, Math.PI * 2);
      ctx.fill();
    }

    // Blur via feathered overlay - simulate soft edge by drawing gradient rings
    const imgData = ctx.getImageData(0, 0, 256, 512);
    const data = imgData.data;
    // Simple blur pass by averaging with neighbors
    const blurred = new Uint8ClampedArray(data);
    const radius = 6;
    for (let y = radius; y < 512 - radius; y++) {
      for (let x = radius; x < 256 - radius; x++) {
        let sum = 0;
        let count = 0;
        for (let dy = -radius; dy <= radius; dy += 2) {
          for (let dx = -radius; dx <= radius; dx += 2) {
            const idx = ((y + dy) * 256 + (x + dx)) * 4;
            sum += data[idx];
            count++;
          }
        }
        const avg = sum / count;
        const baseIdx = (y * 256 + x) * 4;
        blurred[baseIdx] = avg;
        blurred[baseIdx + 1] = avg;
        blurred[baseIdx + 2] = avg;
      }
    }
    ctx.putImageData(new ImageData(blurred, 256, 512), 0, 0);

    const tex = new THREE.CanvasTexture(c);
    return tex;
  }

  createWoodTexture(): THREE.CanvasTexture {
    const c = document.createElement('canvas');
    c.width = 512;
    c.height = 512;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#C4943B';
    ctx.fillRect(0, 0, 512, 512);

    // Grain
    for (let i = 0; i < 100; i++) {
      const y = (i / 100) * 512;
      const s = Math.random() * 40 - 20;
      ctx.strokeStyle = `rgba(${170 + s},${130 + s},${55 + s},0.25)`;
      ctx.lineWidth = 1 + Math.random() * 4;
      ctx.beginPath();
      ctx.moveTo(0, y);
      for (let x = 0; x < 512; x += 10) {
        ctx.lineTo(x, y + Math.sin(x * 0.015 + i) * 4 + Math.random() * 2);
      }
      ctx.stroke();
    }

    // Plank divisions
    for (let i = 1; i < 4; i++) {
      const x = (i / 4) * 512;
      ctx.strokeStyle = 'rgba(80, 50, 20, 0.4)';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, 512);
      ctx.stroke();
    }

    // Nails
    for (let px = 0; px < 4; px++) {
      for (let py = 0; py < 4; py++) {
        const nx = (px / 4) * 512 + 64;
        const ny = (py / 4) * 512 + 64;
        ctx.fillStyle = '#888';
        ctx.beginPath();
        ctx.arc(nx, ny, 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#aaa';
        ctx.beginPath();
        ctx.arc(nx - 1, ny - 1, 2, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    return tex;
  }

  getBoardTopTexture(index: number): THREE.Texture {
    if (this.boardTopTextures[index]) return this.boardTopTextures[index];

    const file = BOARD_TEXTURE_FILES[index] ?? BOARD_TEXTURE_FILES[0];
    const tex = new THREE.TextureLoader().load(file);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
    this.boardTopTextures[index] = tex;
    return tex;
  }

  cycleBoardTexture() {
    this.boardTextureIndex = (this.boardTextureIndex + 1) % BOARD_TEXTURE_FILES.length;
    if (this.boardTopMaterial) {
      this.boardTopMaterial.map = this.getBoardTopTexture(this.boardTextureIndex);
      this.boardTopMaterial.needsUpdate = true;
    }
    this.state.message = `Board texture ${this.boardTextureIndex + 1}/${BOARD_TEXTURE_FILES.length}`;
    this.emitState();
  }

  normalizeBoardTopUvs(geometry: THREE.BufferGeometry) {
    const pos = geometry.attributes.position as THREE.BufferAttribute;
    const uv = geometry.attributes.uv as THREE.BufferAttribute | undefined;
    if (!uv) return;

    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      const u = THREE.MathUtils.clamp((x + BOARD_W / 2) / BOARD_W, 0, 1);
      const v = THREE.MathUtils.clamp(1 - (z + BOARD_L / 2) / BOARD_L, 0, 1);
      uv.setXY(i, u, v);
    }
    uv.needsUpdate = true;
  }

  createFabricTexture(color: number): THREE.CanvasTexture {
    const c = document.createElement('canvas');
    c.width = 128;
    c.height = 128;
    const ctx = c.getContext('2d')!;
    const r = (color >> 16) & 0xFF;
    const g = (color >> 8) & 0xFF;
    const b = color & 0xFF;
    ctx.fillStyle = `rgb(${r},${g},${b})`;
    ctx.fillRect(0, 0, 128, 128);

    // Fabric weave
    for (let i = 0; i < 2000; i++) {
      const x = Math.random() * 128;
      const y = Math.random() * 128;
      const s = Math.random() * 25 - 12;
      ctx.fillStyle = `rgba(${r + s},${g + s},${b + s},0.5)`;
      ctx.fillRect(x, y, 1, 2);
    }

    // Stitching
    ctx.strokeStyle = `rgba(${Math.min(255, r + 60)},${Math.min(255, g + 60)},${Math.min(255, b + 60)},0.6)`;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 4]);
    ctx.strokeRect(8, 8, 112, 112);

    const tex = new THREE.CanvasTexture(c);
    return tex;
  }

  tintColor(color: number, amount: number): number {
    const r = (color >> 16) & 0xff;
    const g = (color >> 8) & 0xff;
    const b = color & 0xff;
    const mix = (channel: number) => Math.max(0, Math.min(255, Math.round(channel + (255 - channel) * amount)));
    return (mix(r) << 16) | (mix(g) << 8) | mix(b);
  }

  shadeColor(color: number, amount: number): number {
    const r = (color >> 16) & 0xff;
    const g = (color >> 8) & 0xff;
    const b = color & 0xff;
    const mix = (channel: number) => Math.max(0, Math.min(255, Math.round(channel * (1 - amount))));
    return (mix(r) << 16) | (mix(g) << 8) | mix(b);
  }

  createBagFaceTexture(baseColor: number, accentColor: number, glossy: boolean): THREE.CanvasTexture {
    const c = document.createElement('canvas');
    c.width = 128;
    c.height = 128;
    const ctx = c.getContext('2d')!;
    const base = `#${baseColor.toString(16).padStart(6, '0')}`;
    const accent = `#${accentColor.toString(16).padStart(6, '0')}`;

    ctx.fillStyle = base;
    ctx.fillRect(0, 0, 128, 128);

    if (glossy) {
      for (let i = -32; i < 160; i += 18) {
        ctx.strokeStyle = accent;
        ctx.lineWidth = 6;
        ctx.beginPath();
        ctx.moveTo(i, 0);
        ctx.lineTo(i + 40, 128);
        ctx.stroke();
      }
      ctx.fillStyle = 'rgba(255,255,255,0.14)';
      ctx.fillRect(10, 10, 108, 24);
    } else {
      ctx.strokeStyle = accent;
      ctx.lineWidth = 2;
      for (let i = 12; i < 128; i += 12) {
        ctx.beginPath();
        ctx.moveTo(i, 12);
        ctx.lineTo(i, 116);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(12, i);
        ctx.lineTo(116, i);
        ctx.stroke();
      }
    }

    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.lineWidth = 3;
    ctx.setLineDash([6, 4]);
    ctx.strokeRect(10, 10, 108, 108);

    return new THREE.CanvasTexture(c);
  }

  // ====== GAME LOGIC ======

  startTurn(player: 1 | 2) {
    this.state.currentPlayer = player;
    this.state.turnIndicatorPlayer = player;
    this.playerX = this.playerPositions[player];
    this.resetCameraToTurnView();
    this.syncBagsLeftState();

    if (this.state.bagsRemaining <= 0) {
      this.currentTurnBagReady = false;
      return;
    }

    this.throwStyle = this.playerThrowStyles[player];
    this.selectedBagSide = this.playerBagSides[player];
    this.applyThrowStyleBagPreference();
    this.state.selectedBagSide = this.selectedBagSide;
    this.state.bagPreviewSide = this.selectedBagSide;
    this.state.throwStyle = this.throwStyle;
    this.currentTurnBagReady = true;
    this.state.message = `${player === 1 ? 'Player 1' : 'Player 2'}'s turn. Pull back to set power / aim, release to throw.`;
  }

  applyThrowStyleBagPreference() {
    // Bag side preference is now independent of throw style — players can
    // choose any bag side with any throw style. This method is kept for
    // API compatibility but no longer forces a side change.
  }

  setCinematicCameraEnabled(enabled: boolean) {
    this.cinematicCameraEnabled = enabled;
  }

  setHoleColliderDebugVisible(visible: boolean) {
    if (this.holeColliderDebug) {
      this.holeColliderDebug.visible = visible;
    }
    this.physicsDebugVisible = visible;
    if (visible) {
      this.buildPhysicsDebugMeshes();
    }
    if (this.physicsDebugGroup) {
      this.physicsDebugGroup.visible = visible;
    }
  }

  // Build (or rebuild) wireframe meshes for every shape on every physics body
  // in the world. Bodies are lightweight enough to rebuild on toggle. Shape
  // transforms are synced each frame in `syncPhysicsDebugMeshes`.
  buildPhysicsDebugMeshes() {
    if (!this.physicsDebugGroup) {
      this.physicsDebugGroup = new THREE.Group();
      this.physicsDebugGroup.renderOrder = 999;
      this.scene.add(this.physicsDebugGroup);
    }
    // Clear previous meshes.
    for (const entry of this.physicsDebugMeshes) {
      this.physicsDebugGroup.remove(entry.mesh);
      const m = entry.mesh as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
    }
    this.physicsDebugMeshes = [];

    const bagBodySet = new Set(this.bagBodies);
    const colorFor = (body: CANNON.Body): number => {
      if (body === this.boardBody) return 0x33ccff;
      if (body === this.groundBody) return 0x66ff66;
      if (bagBodySet.has(body)) return 0xffaa33;
      return 0xff66cc;
    };

    for (const body of this.world.bodies) {
      for (let s = 0; s < body.shapes.length; s++) {
        const shape = body.shapes[s];
        const color = colorFor(body);
        const mat = new THREE.LineBasicMaterial({
          color,
          transparent: true,
          opacity: 0.85,
          depthTest: false,
        });
        let mesh: THREE.Object3D | null = null;
        if (shape instanceof CANNON.Box) {
          const he = shape.halfExtents;
          const geo = new THREE.BoxGeometry(he.x * 2, he.y * 2, he.z * 2);
          mesh = new THREE.LineSegments(new THREE.EdgesGeometry(geo), mat);
          geo.dispose();
        } else if (shape instanceof CANNON.Sphere) {
          const geo = new THREE.SphereGeometry(shape.radius, 12, 8);
          mesh = new THREE.LineSegments(new THREE.EdgesGeometry(geo), mat);
          geo.dispose();
        } else if (shape instanceof CANNON.Plane) {
          // Infinite plane — draw a large grid-like quad.
          const size = 50;
          const geo = new THREE.PlaneGeometry(size, size);
          mesh = new THREE.LineSegments(new THREE.EdgesGeometry(geo), mat);
          geo.dispose();
        } else if (shape instanceof CANNON.Cylinder) {
          const geo = new THREE.CylinderGeometry(
            shape.radiusTop,
            shape.radiusBottom,
            shape.height,
            16,
          );
          mesh = new THREE.LineSegments(new THREE.EdgesGeometry(geo), mat);
          geo.dispose();
        }
        if (!mesh) continue;
        (mesh as THREE.LineSegments).renderOrder = 999;
        this.physicsDebugGroup.add(mesh);
        this.physicsDebugMeshes.push({ body, shapeIndex: s, mesh });
      }
    }
  }

  // Sync each debug mesh's transform to its physics body's current shape
  // position/orientation (body transform composed with per-shape offset/quat).
  syncPhysicsDebugMeshes() {
    if (!this.physicsDebugVisible || !this.physicsDebugGroup) return;
    const bodyPos = new THREE.Vector3();
    const bodyQuat = new THREE.Quaternion();
    const shapeOffset = new THREE.Vector3();
    const shapeQuat = new THREE.Quaternion();
    for (const entry of this.physicsDebugMeshes) {
      const { body, shapeIndex, mesh } = entry;
      bodyPos.set(body.position.x, body.position.y, body.position.z);
      bodyQuat.set(body.quaternion.x, body.quaternion.y, body.quaternion.z, body.quaternion.w);
      const so = body.shapeOffsets[shapeIndex];
      const sq = body.shapeOrientations[shapeIndex];
      shapeOffset.set(so.x, so.y, so.z).applyQuaternion(bodyQuat);
      shapeQuat.set(sq.x, sq.y, sq.z, sq.w);
      mesh.position.copy(bodyPos).add(shapeOffset);
      mesh.quaternion.copy(bodyQuat).multiply(shapeQuat);
    }
  }

  throwBag() {
    if (this.state.isThrowing || this.state.isSettling || this.state.gameOver) return;
    if (!this.currentTurnBagReady) return;

    const throwingPlayer = this.state.currentPlayer;
    const idx = this.getBagIndexForCurrentPlayer();
    this.activeThrownBagIndex = idx;
    this.decrementBagsLeft(this.state.currentPlayer);
    this.currentTurnBagReady = false;

    this.state.isThrowing = true;
    this.state.throwingPlayer = throwingPlayer;
    this.state.isAiming = false;
    this.state.isDragging = false;
    this.state.message = '';
    this.state.lastResult = '';
    this.state.lastPoints = 0;
    // Immediately sync bags left so UI reflects the throw
    this.syncBagsLeftState();
    this.emitState();
    this.bagSides[idx] = this.selectedBagSide;
    this.bagThrowStyles[idx] = this.throwStyle;
    this.bagInHole[idx] = false;
    this.bagInHoleDetectedAt[idx] = 0;
    this.bagPendingHoleCleanup[idx] = false;
    this.bagHoleCleanupReadyAt[idx] = 0;
    this.cornholeSoundPlayed[idx] = false;
    this.pointSoundPlayed[idx] = false;
    this.impactSoundPlayed[idx] = false;
    this.bagPrevPositions[idx].set(0, 0, 0);

    const body = this.bagBodies[idx];
    const mesh = this.bags[idx];
    this.resetBagVisualState(idx);
    body.collisionResponse = true;

    // Ensure body is in the physics world (it may have been removed by hole cleanup)
    if (!this.world.bodies.includes(body)) {
      this.world.addBody(body);
    }

    const startX = this.playerX + this.aimX * 0.25;
    const startY = 1.5;
    const startZ = 12;
    const speedT = THREE.MathUtils.clamp((this.aimPower - 0.35) / 0.65, 0, 1);
    body.position.set(startX, startY, startZ);
    body.velocity.set(0, 0, 0);
    body.angularVelocity.set(0, 0, 0);
    const sideFlip = this.selectedBagSide === 'sticky' ? Math.PI : 0;
    const isRollThrow = this.throwStyle === 'roll';
    const releasePitch = isRollThrow
      ? THREE.MathUtils.lerp(0.48, 0.66, speedT)
      : THREE.MathUtils.lerp(0.32, 0.12, speedT);
    const releaseYaw = isRollThrow ? this.aimX * 0.015 : 0;
    const releaseRoll = isRollThrow ? -this.aimX * 0.015 : -this.aimX * 0.08;
    body.quaternion.setFromEuler(sideFlip + releasePitch, releaseYaw, releaseRoll);
    body.material = this.selectedBagSide === 'sticky' ? this.stickyBagMaterial : this.slickBagMaterial;
    body.linearDamping = 0.4;
    body.angularDamping = isRollThrow ? 0.82 : 0.6;

    mesh.visible = true;
    mesh.position.set(startX, startY, startZ);

    const boardPos = this.boardGroup.position;
    const targetZ = THREE.MathUtils.lerp(startZ - 4, boardPos.z - 1.2, this.pullDistance);
    const targetX = boardPos.x + this.playerX * 0.35 + this.aimX * THREE.MathUtils.lerp(1.1, 2.2, this.pullDistance);

    const dx = targetX - startX;
    const dz = targetZ - startZ;

    const baseFlightTime = isRollThrow
      ? THREE.MathUtils.lerp(0.62, 0.96, this.pullDistance)
      : THREE.MathUtils.lerp(0.58, 1.02, this.pullDistance);
    const flightTime = baseFlightTime * (isRollThrow
      ? THREE.MathUtils.lerp(1.02, 0.68, speedT)
      : THREE.MathUtils.lerp(1.06, 0.72, speedT));
    const arcVy = isRollThrow
      ? THREE.MathUtils.lerp(5.9, 9.1, this.pullDistance)
      : THREE.MathUtils.lerp(5.6, 9.4, this.pullDistance);
    const vy = isRollThrow
      ? THREE.MathUtils.lerp(arcVy * 0.9, arcVy * 0.42, speedT)
      : THREE.MathUtils.lerp(arcVy * 1.02, arcVy * 0.38, speedT);
    const vx = dx / flightTime + this.aimX * 0.35 + (Math.random() - 0.5) * 0.18;
    const vz = dz / flightTime;
    const windLaunchDrift = this.weatherEnabled ? this.windMph * 0.035 : 0;
    const launchSpeedScale = 1.1 * this.getTemperatureSpeedFactor() / this.getHumidityDragFactor();

    body.velocity.set(
      vx * launchSpeedScale + this.windVector.x * windLaunchDrift,
      vy * launchSpeedScale,
      vz * launchSpeedScale + this.windVector.z * windLaunchDrift * 0.45
    );

    if (isRollThrow) {
      const rollSpinAxis = body.quaternion.vmult(new CANNON.Vec3(0, 1, 0));
      const rollSpinSpeed = THREE.MathUtils.lerp(10, 15, speedT);
      body.angularVelocity.set(
        rollSpinAxis.x * rollSpinSpeed + THREE.MathUtils.lerp(-0.16, 0.16, Math.random()),
        rollSpinAxis.y * rollSpinSpeed + THREE.MathUtils.lerp(-0.1, 0.1, Math.random()),
        rollSpinAxis.z * rollSpinSpeed + THREE.MathUtils.lerp(-0.16, 0.16, Math.random())
      );
    } else {
      body.angularVelocity.set(
        THREE.MathUtils.lerp(-0.8, 0.8, Math.random()),
        THREE.MathUtils.lerp(14, 32, speedT),
        -this.aimX * 1.2 + THREE.MathUtils.lerp(-0.5, 0.5, Math.random())
      );
    }

    this.settlingTimer = 0;
    this.bagSettled = false;
    this.state.isSettling = true;
    this.emitState();
  }

  evaluateThrow(bagIndex: number, throwingPlayer: 1 | 2) {
    const body = this.bagBodies[bagIndex];

    // Get bag world position
    const bagPos = new THREE.Vector3(body.position.x, body.position.y, body.position.z);

    // Transform to board local space
    const boardWorldPos = new THREE.Vector3();
    this.boardGroup.getWorldPosition(boardWorldPos);

    // Simple: check distance from hole in world space
    const holeWorldPos = new THREE.Vector3(
      boardWorldPos.x,
      boardWorldPos.y + 0.1,
      boardWorldPos.z + HOLE_Z * Math.cos(this.boardGroup.rotation.x)
    );

    const holeDist = Math.sqrt(
      (bagPos.x - holeWorldPos.x) ** 2 +
      (bagPos.z - holeWorldPos.z) ** 2
    );

    // Check if bag is on board
    const boardHalfW = BOARD_W / 2 + 0.1;
    const boardHalfL = BOARD_L / 2 + 0.1;
    const onBoardX = Math.abs(bagPos.x - boardWorldPos.x) < boardHalfW;
    const onBoardZ = Math.abs(bagPos.z - boardWorldPos.z) < boardHalfL;
    const onBoardY = bagPos.y > boardWorldPos.y - 0.3 && bagPos.y < boardWorldPos.y + 1.0;

    let result = '';

    if (holeDist < HOLE_RADIUS - 0.05 && bagPos.y < boardWorldPos.y + 0.2) {
      result = '🎯 IN THE HOLE!';
    } else if (onBoardX && onBoardZ && onBoardY) {
      result = '✅ On the board!';
    } else {
      result = '❌ Miss!';
    }

    const previousThrowerRoundScore = throwingPlayer === 1
      ? this.state.player1RoundScore
      : this.state.player2RoundScore;
    this.recomputeScoresFromBoardState();
    const updatedThrowerRoundScore = throwingPlayer === 1
      ? this.state.player1RoundScore
      : this.state.player2RoundScore;
    const awardedPoints = Math.max(0, updatedThrowerRoundScore - previousThrowerRoundScore);
    this.state.lastPoints = awardedPoints;
    this.state.lastResult = result;
    // Use captured throwingPlayer — never stale
    this.state.bagsThisInning++;
    this.state.isThrowing = false;
    this.state.throwingPlayer = null;
    this.currentTurnBagReady = false;

    this.syncBagsLeftState();
    this.onScoreUpdate(awardedPoints, result, throwingPlayer, this.state.inning);

    // Determine next player: alternate from whoever just threw
    const nextPlayer: 1 | 2 = throwingPlayer === 1 ? 2 : 1;
    if (this.getBagsLeft(1) <= 0 && this.getBagsLeft(2) <= 0) {
      this.endInning();
    } else if (this.getBagsLeft(nextPlayer) > 0) {
      this.startTurn(nextPlayer);
      this.state.isAiming = true;
    } else if (this.getBagsLeft(throwingPlayer) > 0) {
      this.startTurn(throwingPlayer);
      this.state.isAiming = true;
    } else {
      this.endInning();
    }

    this.emitState();
  }

  endInning() {
    this.recomputeScoresFromBoardState();
    this.cumulativeRoundPoints[1] += this.state.player1RoundScore;
    this.cumulativeRoundPoints[2] += this.state.player2RoundScore;
    const canceledRoundScores = this.getCanceledRoundScores();
    this.state.player1Score = this.inningBaseScores[1] + canceledRoundScores.player1;
    this.state.player2Score = this.inningBaseScores[2] + canceledRoundScores.player2;
    this.inningBaseScores[1] = this.state.player1Score;
    this.inningBaseScores[2] = this.state.player2Score;

    const completedInning = this.state.inning;
    this.state.inning++;
    this.state.bagsThisInning = 0;
    this.currentTurnBagReady = false;

    // Notify UI of round results (post-cancellation points)
    if (this.onInningComplete) {
      this.onInningComplete(completedInning, canceledRoundScores.player1, canceledRoundScores.player2);
    }

    // "Honor" — in online play, whoever scored points this inning starts the next one.
    // Ties preserve the current starter. Keeps hot-seat play unchanged (starter stays P1).
    if (this.onlineHostMode || this.guestMode) {
      if (canceledRoundScores.player1 > canceledRoundScores.player2) {
        this.nextInningStarter = 1;
      } else if (canceledRoundScores.player2 > canceledRoundScores.player1) {
        this.nextInningStarter = 2;
      }
    } else {
      this.nextInningStarter = 1;
    }

    this.syncBagsLeftState();

    // Check game over
    if (this.state.player1Score >= 21 || this.state.player2Score >= 21) {
      this.state.gameOver = true;
      this.state.showResult = true;
      const winner = this.state.player1Score >= 21 ? 'Player 1' : 'Player 2';
      this.state.resultMessage = `🏆 ${winner} wins!`;
      this.state.message = 'Game Over!';
    } else {
      this.state.showResult = true;
      this.state.resultMessage = `Round ${this.state.inning - 1} complete!`;
      this.state.message = 'New round starting...';
    }

    this.emitState();

    const roundPointsAwarded = canceledRoundScores.player1 + canceledRoundScores.player2;
    const resetDelayMs = this.state.gameOver
      ? 2200
      : roundPointsAwarded > 0
        ? 1500
        : 550;

    setTimeout(() => {
      this.resetBags();
    }, resetDelayMs);
  }

  resetBags() {
    this.state.showResult = false;
    this.state.isAiming = true;
    this.state.isDragging = false;
    this.state.lastResult = '';
    this.state.lastPoints = 0;
    // Reset bags thrown counters — this is the ONLY place they reset (new round)
    this.playerBagsThrown[1] = 0;
    this.playerBagsThrown[2] = 0;
    this.state.player1RoundScore = 0;
    this.state.player2RoundScore = 0;
    this.inningBaseScores[1] = this.state.player1Score;
    this.inningBaseScores[2] = this.state.player2Score;
    this.currentTurnBagReady = false;
    this.aimX = 0;
    this.pullDistance = 0.3;
    this.aimPower = 0.65;

    for (let i = 0; i < 8; i++) {
      this.bags[i].visible = false;
      this.bagBodies[i].position.set(0, -20, 0);
      this.bagBodies[i].velocity.set(0, 0, 0);
      this.bagBodies[i].angularVelocity.set(0, 0, 0);
      this.bagBodies[i].collisionResponse = true;
      this.resetBagVisualState(i);
    }
    this.bagThrowStyles.fill('slide');
    this.bagInHole.fill(false);
    this.bagInHoleDetectedAt.fill(0);
    this.bagPendingHoleCleanup.fill(false);
    this.bagHoleCleanupReadyAt.fill(0);
    for (let i = 0; i < 8; i++) {
      this.bagPrevPositions[i].set(0, 0, 0);
    }
    this.startTurn(this.nextInningStarter);
    this.emitState();
  }

  getHoleWorldPosition() {
    const boardWorldPos = new THREE.Vector3();
    this.boardGroup.getWorldPosition(boardWorldPos);
    return new THREE.Vector3(
      boardWorldPos.x,
      boardWorldPos.y + 0.1,
      boardWorldPos.z + HOLE_Z * Math.cos(this.boardGroup.rotation.x)
    );
  }

  getBagScore(index: number) {
    const body = this.bagBodies[index];
    const bagPos = new THREE.Vector3(body.position.x, body.position.y, body.position.z);
    const boardWorldPos = new THREE.Vector3();
    this.boardGroup.getWorldPosition(boardWorldPos);
    const holeWorldPos = this.getHoleWorldPosition();
    const holeDist = Math.sqrt(
      (bagPos.x - holeWorldPos.x) ** 2 +
      (bagPos.z - holeWorldPos.z) ** 2
    );
    const boardHalfW = BOARD_W / 2 + 0.1;
    const boardHalfL = BOARD_L / 2 + 0.1;
    const onBoardX = Math.abs(bagPos.x - boardWorldPos.x) < boardHalfW;
    const onBoardZ = Math.abs(bagPos.z - boardWorldPos.z) < boardHalfL;
    const onBoardY = bagPos.y > boardWorldPos.y - 0.3 && bagPos.y < boardWorldPos.y + 1.0;

    if (this.bagInHole[index]) return 3;
    if (holeDist < HOLE_RADIUS - 0.05 && bagPos.y < boardWorldPos.y + 0.2) return 3;
    if (onBoardX && onBoardZ && onBoardY) return 1;
    return 0;
  }

  recomputeScoresFromBoardState() {
    let player1RoundScore = 0;
    let player2RoundScore = 0;

    for (let i = 0; i < this.bags.length; i++) {
      if (!this.bags[i].visible && !this.bagInHole[i]) continue;
      const points = this.getBagScore(i);
      if (i < 4) {
        player1RoundScore += points;
      } else {
        player2RoundScore += points;
      }
    }

    this.state.player1RoundScore = player1RoundScore;
    this.state.player2RoundScore = player2RoundScore;
  }

  getCanceledRoundScores() {
    const rawPlayer1 = this.state.player1RoundScore;
    const rawPlayer2 = this.state.player2RoundScore;

    if (rawPlayer1 === rawPlayer2) {
      return { player1: 0, player2: 0 };
    }

    if (rawPlayer1 > rawPlayer2) {
      return { player1: rawPlayer1 - rawPlayer2, player2: 0 };
    }

    return { player1: 0, player2: rawPlayer2 - rawPlayer1 };
  }

  getBagsLeft(player: 1 | 2) {
    return 4 - this.playerBagsThrown[player];
  }

  decrementBagsLeft(player: 1 | 2) {
    this.playerBagsThrown[player] = Math.min(4, this.playerBagsThrown[player] + 1);
  }

  getNextPlayer(): 1 | 2 {
    const otherPlayer = this.state.currentPlayer === 1 ? 2 : 1;
    if (this.getBagsLeft(otherPlayer) > 0) {
      return otherPlayer;
    }
    if (this.getBagsLeft(this.state.currentPlayer) > 0) {
      return this.state.currentPlayer;
    }
    return otherPlayer;
  }

  getBagIndexForCurrentPlayer() {
    if (this.state.currentPlayer === 1) {
      return this.playerBagsThrown[1];
    }
    return 4 + this.playerBagsThrown[2];
  }

  // ====== PARTICLES ======

  spawnParticles(position: THREE.Vector3, color: number, count: number) {
    const geo = new THREE.BufferGeometry();
    const positions = new Float32Array(count * 3);
    const velocities: THREE.Vector3[] = [];

    for (let i = 0; i < count; i++) {
      positions[i * 3] = position.x;
      positions[i * 3 + 1] = position.y;
      positions[i * 3 + 2] = position.z;
      velocities.push(new THREE.Vector3(
        (Math.random() - 0.5) * 4,
        Math.random() * 4 + 1,
        (Math.random() - 0.5) * 4
      ));
    }

    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const mat = new THREE.PointsMaterial({
      color,
      size: 0.12,
      transparent: true,
      opacity: 1,
      sizeAttenuation: true,
    });

    const points = new THREE.Points(geo, mat);
    this.scene.add(points);
    this.particleSystems.push({ points, velocities, life: 1.0 });
  }

  updateParticles(dt: number) {
    for (let i = this.particleSystems.length - 1; i >= 0; i--) {
      const ps = this.particleSystems[i];
      ps.life -= dt * 1.5;

      if (ps.life <= 0) {
        this.scene.remove(ps.points);
        ps.points.geometry.dispose();
        (ps.points.material as THREE.PointsMaterial).dispose();
        this.particleSystems.splice(i, 1);
        continue;
      }

      const pos = ps.points.geometry.attributes.position;
      for (let j = 0; j < ps.velocities.length; j++) {
        pos.setX(j, pos.getX(j) + ps.velocities[j].x * dt);
        pos.setY(j, pos.getY(j) + ps.velocities[j].y * dt);
        pos.setZ(j, pos.getZ(j) + ps.velocities[j].z * dt);
        ps.velocities[j].y -= 8 * dt;
      }
      pos.needsUpdate = true;
      (ps.points.material as THREE.PointsMaterial).opacity = ps.life;
    }
  }

  updateBagSurfacePhysics(body: CANNON.Body, bagIndex: number) {
    const boardTopY = this.boardGroup.position.y + 0.9;
    const isNearLanding = body.position.y < boardTopY && Math.abs(body.velocity.y) < 5;
    const horizontalSpeed = Math.hypot(body.velocity.x, body.velocity.z);
    const surfaceDampingMultiplier = this.getSurfaceDampingMultiplier();

    if (!isNearLanding) {
      body.material = this.slickBagMaterial;
      body.linearDamping = 0.4;
      body.angularDamping = 0.6;
      return;
    }

    if (this.state.isAiming && !this.state.isThrowing) {
      body.material = this.settledBagMaterial;
      body.linearDamping = THREE.MathUtils.lerp(0.015, 0.055, Math.min(1, horizontalSpeed / 6));
      body.linearDamping *= THREE.MathUtils.clamp(surfaceDampingMultiplier, 0.84, 1.02);
      body.angularDamping = 0.18;
      return;
    }

    // Lock material to the side that was thrown, regardless of current orientation.
    // This prevents a slick throw from being punished with sticky physics when it
    // tumbles on impact, and vice versa.
    const thrownSide = this.bagSides[bagIndex];
    const isSticky = thrownSide === 'sticky';

    body.material = isSticky ? this.stickyBagMaterial : this.slickBagMaterial;
    body.linearDamping = isSticky
      ? THREE.MathUtils.lerp(0.5, 0.68, Math.min(1, horizontalSpeed / 5))
      : THREE.MathUtils.lerp(0.08, 0.18, Math.min(1, horizontalSpeed / 6));
    body.linearDamping *= surfaceDampingMultiplier;
    body.angularDamping = isSticky ? 0.72 : 0.34;

    // Prevent bag from standing on its side. A real bean bag is a loose sack of
    // corn — its center of mass shifts the moment it tilts, so it physically cannot
    // balance on an edge. We model that by always applying a tipping torque
    // whenever the bag is off-flat, regardless of whether it's "settled" — a bag
    // leaning against another bag can jitter above any velocity threshold yet still
    // needs to fall over.
    const bagUp = new CANNON.Vec3(0, 1, 0);
    const worldUp = body.quaternion.vmult(bagUp);
    const upDotY = Math.abs(worldUp.y);
    // Engage whenever the bag is meaningfully off-flat (within ~25° of flat is fine).
    // tiltFactor goes 0→1 as |upDotY| drops from 0.9 (flat-ish) to 0 (on edge).
    const tiltFactor = THREE.MathUtils.clamp((0.9 - upDotY) / 0.9, 0, 1);
    if (tiltFactor > 0) {
      // Don't fight large existing spin, but don't require near-zero either — a
      // bag slowly toppling should keep getting a nudge.
      const angularSpeed = body.angularVelocity.length();
      const motionScale = THREE.MathUtils.clamp(1 - angularSpeed / 4.5, 0, 1);
      // Ramp strength with tilt² so nearly-flat bags get only a whisper but
      // near-vertical bags get a firm shove toward flat.
      const tipStrength = 0.55 * tiltFactor * tiltFactor * motionScale;
      const torqueAxis = new CANNON.Vec3(-worldUp.z, 0, worldUp.x);
      if (torqueAxis.length() > 0.01 && tipStrength > 0.001) {
        torqueAxis.normalize();
        body.applyTorque(torqueAxis.scale(tipStrength, torqueAxis));
      }
      // Heavy angular damping while tipping so we never build spin that overshoots flat.
      body.angularDamping = 0.92;
    }
  }

  playActiveBagOnBagImpactSound() {
    const activeIndex = this.activeThrownBagIndex;
    if (activeIndex === null) return;
    if (!this.state.isThrowing && !this.state.isSettling) return;
    if (this.impactSoundPlayed[activeIndex]) return;
    if (!this.bags[activeIndex]?.visible) return;

    const activeBody = this.bagBodies[activeIndex];
    if (!activeBody) return;

    for (const contact of this.world.contacts) {
      const otherBody = contact.bi === activeBody
        ? contact.bj
        : contact.bj === activeBody
          ? contact.bi
          : null;
      if (!otherBody) continue;

      const otherBagIndex = this.bagBodies.indexOf(otherBody);
      if (otherBagIndex < 0 || otherBagIndex === activeIndex) continue;
      if (!this.bags[otherBagIndex]?.visible && !this.bagInHole[otherBagIndex]) continue;

      this.playBagOnBagSound();
      this.impactSoundPlayed[activeIndex] = true;
      return;
    }
  }

  applyBagVisualSoftness(index: number, dt: number) {
    const body = this.bagBodies[index];
    const mesh = this.bags[index];
    const visual = this.bagVisualStates[index];
    const restPose = this.bagRestPosePositions[index];

    this.bagVisualWorldPos.set(body.position.x, body.position.y, body.position.z);
    this.bagVisualLocalPos.copy(this.bagVisualWorldPos);
    this.boardGroup.worldToLocal(this.bagVisualLocalPos);

    const horizontalSpeed = Math.hypot(body.velocity.x, body.velocity.z);
    const boardTopLocalY = BOARD_THICKNESS / 2;
    const overBoard = Math.abs(this.bagVisualLocalPos.x) < BOARD_W / 2 + BAG_SIZE * 0.55
      && Math.abs(this.bagVisualLocalPos.z) < BOARD_L / 2 + BAG_SIZE * 0.55;
    const onBoard = overBoard
      && this.bagVisualLocalPos.y < boardTopLocalY + BAG_SIZE * 0.6
      && this.bagVisualLocalPos.y > boardTopLocalY - BAG_SIZE * 1.15;
    const nearGround = body.position.y < BAG_SIZE * 0.7;
    const onGround = nearGround && !onBoard;
    const surfaceContact = onBoard || onGround || this.bagPendingHoleCleanup[index];

    // --- Impact detection (same logic as before) ---
    const impactReady = this.totalTime - visual.lastImpactAt > 0.14;
    const descendingFast = visual.lastVelocityY < -1.6;
    const impactLikely = surfaceContact && descendingFast && body.velocity.y > visual.lastVelocityY * 0.35 && impactReady;

    if (impactLikely) {
      const impactSpeed = Math.max(0, -visual.lastVelocityY) + horizontalSpeed * 0.16 + Math.abs(body.angularVelocity.y) * 0.04;
      const impactStrength = THREE.MathUtils.clamp((impactSpeed - 1.1) / 7, 0, 1);
      const wobbleSeedX = THREE.MathUtils.clamp(
        body.velocity.x * 0.28 + body.angularVelocity.z * 0.06 + (Math.random() - 0.5), -1, 1
      );
      const wobbleSeedZ = THREE.MathUtils.clamp(
        -body.velocity.z * 0.08 - body.angularVelocity.x * 0.08 + (Math.random() - 0.5), -1, 1
      );
      const wobbleLength = Math.hypot(wobbleSeedX, wobbleSeedZ) || 1;

      visual.impactSquash = Math.max(visual.impactSquash, THREE.MathUtils.lerp(0.1, 0.34, impactStrength));
      visual.wobbleAmplitude = Math.max(visual.wobbleAmplitude, THREE.MathUtils.lerp(0.045, 0.19, impactStrength));
      visual.wobbleTime = 0;
      visual.wobblePhase = Math.random() * Math.PI * 2;
      visual.wobbleAxisX = wobbleSeedX / wobbleLength;
      visual.wobbleAxisZ = wobbleSeedZ / wobbleLength;
      visual.lastImpactAt = this.totalTime;

      // Play impact sound when bag hits the board.
      // Only for the actively-thrown bag so settled bags from prior throws
      // don't trigger sounds during clearing/transitions.
      if (onBoard && !this.impactSoundPlayed[index] && this.activeThrownBagIndex === index) {
        this.playPointSound();
        this.impactSoundPlayed[index] = true;
      }

      // Per-vertex deformation: seed impact direction in bag-local space
      visual.deformAmount = Math.max(visual.deformAmount, THREE.MathUtils.lerp(0.3, 1.0, impactStrength));
      // Contact side: transform world down vector into bag-local space to find which face hit
      const bodyQuat = new THREE.Quaternion(body.quaternion.x, body.quaternion.y, body.quaternion.z, body.quaternion.w);
      const worldDown = new THREE.Vector3(0, -1, 0);
      const localDown = worldDown.applyQuaternion(bodyQuat.invert());
      visual.deformContactY = localDown.y > 0 ? -1 : 1; // -1 = bottom hit, +1 = top hit
      // Lateral impact direction in bag-local space (from velocity)
      const localVel = new THREE.Vector3(body.velocity.x, 0, body.velocity.z);
      localVel.applyQuaternion(bodyQuat); // bodyQuat is already inverted above
      const latLen = Math.hypot(localVel.x, localVel.z) || 1;
      visual.deformDirX = localVel.x / latLen;
      visual.deformDirZ = localVel.z / latLen;
    }

    // --- Squash / wobble state evolution ---
    const settleAmount = surfaceContact
      ? THREE.MathUtils.clamp(1 - Math.abs(body.velocity.y) / 1.6, 0, 1)
      : 0;
    const slideAmount = surfaceContact
      ? THREE.MathUtils.clamp(horizontalSpeed / 5, 0, 1)
      : 0;
    const holeDx = this.bagVisualLocalPos.x;
    const holeDz = this.bagVisualLocalPos.z - HOLE_Z;
    const holeDist = Math.hypot(holeDx, holeDz);
    const holeRingInfluence = onBoard
      ? THREE.MathUtils.clamp(1 - Math.abs(holeDist - HOLE_RADIUS * 0.92) / (BAG_SIZE * 0.9), 0, 1)
      : 0;
    const holeCenterInfluence = this.bagPendingHoleCleanup[index]
      ? 1
      : onBoard
        ? THREE.MathUtils.clamp(1 - holeDist / (HOLE_RADIUS + BAG_SIZE * 0.55), 0, 1)
        : 0;
    const holeInfluence = Math.max(holeRingInfluence * 1.15, holeCenterInfluence * 0.95);
    const restSquashTarget = surfaceContact
      ? THREE.MathUtils.lerp(0.02, 0.13, settleAmount) + slideAmount * 0.05 + holeInfluence * 0.1
      : 0;

    visual.impactSquash = THREE.MathUtils.damp(visual.impactSquash, 0, surfaceContact ? 7.4 : 4.4, dt);
    visual.squash = THREE.MathUtils.damp(visual.squash, Math.max(restSquashTarget, visual.impactSquash), surfaceContact ? 10.5 : 5.3, dt);
    visual.wobbleAmplitude = THREE.MathUtils.damp(visual.wobbleAmplitude, 0, surfaceContact ? 2.25 : 1.15, dt);
    visual.wobbleTime += dt * (5.8 + horizontalSpeed * 1.15 + holeInfluence * 3.3);
    visual.deformAmount = THREE.MathUtils.damp(visual.deformAmount, surfaceContact ? settleAmount * 0.25 : 0, surfaceContact ? 3.5 : 6.0, dt);

    // --- Fill shifting: corn settles toward gravity-relative low point (only when on surface) ---
    const sloshing = visual.impactSquash > 0.02;
    if (surfaceContact) {
      const bodyQuat2 = new THREE.Quaternion(body.quaternion.x, body.quaternion.y, body.quaternion.z, body.quaternion.w);
      const gravityLocal = new THREE.Vector3(0, -1, 0).applyQuaternion(bodyQuat2.clone().invert());
      const fillTargetX = gravityLocal.x * 0.35;
      const fillTargetY = gravityLocal.y * 0.15;
      const fillTargetZ = gravityLocal.z * 0.35;
      // On impact, slosh fill toward impact direction
      const sloshX = sloshing ? visual.deformDirX * visual.impactSquash * 0.4 : 0;
      const sloshZ = sloshing ? visual.deformDirZ * visual.impactSquash * 0.4 : 0;
      visual.fillOffsetX = THREE.MathUtils.damp(visual.fillOffsetX, fillTargetX + sloshX, 4.0, dt);
      visual.fillOffsetY = THREE.MathUtils.damp(visual.fillOffsetY, fillTargetY, 4.0, dt);
      visual.fillOffsetZ = THREE.MathUtils.damp(visual.fillOffsetZ, fillTargetZ + sloshZ, 4.0, dt);
    } else {
      // Return to neutral when in air
      visual.fillOffsetX = THREE.MathUtils.damp(visual.fillOffsetX, 0, 4.0, dt);
      visual.fillOffsetY = THREE.MathUtils.damp(visual.fillOffsetY, 0, 4.0, dt);
      visual.fillOffsetZ = THREE.MathUtils.damp(visual.fillOffsetZ, 0, 4.0, dt);
    }

    // --- Wobble / tilt for mesh transform ---
    const holeTiltX = holeInfluence * THREE.MathUtils.clamp(-holeDz / (HOLE_RADIUS + BAG_SIZE), -1, 1) * 0.19;
    const holeTiltZ = holeInfluence * THREE.MathUtils.clamp(holeDx / (HOLE_RADIUS + BAG_SIZE), -1, 1) * 0.19;
    const wobbleX = Math.sin(visual.wobbleTime * 0.86 + visual.wobblePhase) * visual.wobbleAmplitude * visual.wobbleAxisX;
    const wobbleZ = Math.cos(visual.wobbleTime * 0.98 + visual.wobblePhase * 0.7) * visual.wobbleAmplitude * visual.wobbleAxisZ;

    // --- Set mesh transform from physics body ---
    const holeSag = holeInfluence * BAG_SIZE * 0.1;
    mesh.position.set(
      body.position.x,
      body.position.y - visual.squash * BAG_SIZE * 0.22 - holeSag,
      body.position.z
    );
    mesh.quaternion.set(body.quaternion.x, body.quaternion.y, body.quaternion.z, body.quaternion.w);
    this.bagVisualEuler.set(wobbleX + holeTiltX, 0, wobbleZ + holeTiltZ);
    this.bagVisualQuat.setFromEuler(this.bagVisualEuler);
    mesh.quaternion.multiply(this.bagVisualQuat);
    mesh.scale.set(1, 1, 1); // Reset scale — deformation is now per-vertex

    // --- Determine if per-vertex update is needed ---
    const totalDeform = visual.deformAmount + visual.squash + holeInfluence
      + Math.abs(visual.fillOffsetX) + Math.abs(visual.fillOffsetZ);
    const isSettled = totalDeform < 0.005 && !sloshing && visual.wobbleAmplitude < 0.003;

    if (isSettled && visual.prevSettled) {
      // Skip vertex update when fully settled (perf optimization)
      visual.lastVelocityY = body.velocity.y;
      return;
    }
    visual.prevSettled = isSettled;
    visual.isDeforming = totalDeform > 0.005;

    // --- Per-vertex deformation ---
    const pos = (mesh.geometry as THREE.BufferGeometry).attributes.position as THREE.BufferAttribute;
    const arr = pos.array as Float32Array;
    const bagHeight = BAG_SIZE * 0.52;
    const bagHalfH = bagHeight * 0.5;

    // Precompute the inverse mesh quaternion so we can transform board-local coords into bag-local
    const meshQuatInv = mesh.quaternion.clone().invert();
    // Board edge positions in bag-local space (for drape)
    const boardWorldPos = new THREE.Vector3();
    this.boardGroup.getWorldPosition(boardWorldPos);
    const holeWorldPos = this.getHoleWorldPosition();

    // Conform pass context: when resting on a surface with low vertical speed,
    // flatten the bag's contact face against the real board/ground plane. This
    // is the single biggest visual cue that sells a bean bag as soft.
    const verticalSpeed = Math.abs(body.velocity.y);
    const conformWeight = surfaceContact
      ? THREE.MathUtils.clamp(1 - verticalSpeed / 2.2, 0, 1)
        * THREE.MathUtils.clamp(1 - horizontalSpeed / 4.5, 0, 1)
      : 0;
    const boardHalfW = BOARD_W / 2;
    const boardHalfL = BOARD_L / 2;

    for (let i = 0; i < restPose.length; i += 3) {
      let rx = restPose[i];
      let ry = restPose[i + 1];
      let rz = restPose[i + 2];

      // Normalized coordinates within the bag (-1 to 1)
      const xNorm = THREE.MathUtils.clamp(rx / BAG_SIZE, -1, 1);
      const yNorm = THREE.MathUtils.clamp(ry / bagHalfH, -1, 1);
      const zNorm = THREE.MathUtils.clamp(rz / BAG_SIZE, -1, 1);

      // === 1. Impact flattening ===
      if (visual.deformAmount > 0.001) {
        const contactSide = visual.deformContactY; // -1=bottom, +1=top
        // Signed position on contact axis: +1 = at contact face, -1 = opposite face.
        const contactAxis = -yNorm * contactSide;
        // Smooth falloff, strongly engaged only on the contact half.
        const t = THREE.MathUtils.clamp((contactAxis + 0.15) * 0.6, 0, 1);
        const contactProximity = t * t * (3 - 2 * t); // smoothstep
        // Flatten contact-side vertices toward a plane
        const flattenY = -contactSide * contactProximity * visual.deformAmount * bagHalfH * 0.32;
        // Bulge opposite side (volume conservation) with smoothstep falloff.
        const ot = THREE.MathUtils.clamp((-contactAxis + 0.15) * 0.6, 0, 1);
        const oppositeProximity = ot * ot * (3 - 2 * ot);
        const bulgeY = contactSide * oppositeProximity * visual.deformAmount * bagHalfH * 0.18;
        // Lateral spread on contact side (mushroom out at the contact)
        const spreadFactor = contactProximity * visual.deformAmount * 0.14;
        // Directional spread from impact velocity
        const dirSpread = contactProximity * visual.deformAmount * 0.05;

        ry += flattenY + bulgeY;
        rx += rx * spreadFactor + visual.deformDirX * dirSpread * (1 - Math.abs(xNorm) * 0.5);
        rz += rz * spreadFactor + visual.deformDirZ * dirSpread * (1 - Math.abs(zNorm) * 0.5);
      }

      // === 2. Squash (settle/rest deformation — enhanced from old scale-based) ===
      if (visual.squash > 0.001) {
        // Compress Y, expand XZ (like the old scale but per-vertex)
        const squashY = -ry * visual.squash * 0.7;
        const expandXZ = visual.squash * 0.35;
        ry += squashY;
        rx *= 1 + expandXZ * (1 - Math.abs(yNorm) * 0.3);
        rz *= 1 + expandXZ * (1 - Math.abs(yNorm) * 0.3);
      }

      // === 3. Fill shifting (corn moves inside bag) ===
      const fillMag = Math.abs(visual.fillOffsetX) + Math.abs(visual.fillOffsetY) + Math.abs(visual.fillOffsetZ);
      if (fillMag > 0.005) {
        // Vertices in the fill direction get pushed outward, opposite get pulled in
        const fillDot = xNorm * visual.fillOffsetX + yNorm * visual.fillOffsetY + zNorm * visual.fillOffsetZ;
        const fillInfluence = THREE.MathUtils.clamp(fillDot * 2, -1, 1);
        const centeredness = 1 - (Math.abs(xNorm) + Math.abs(zNorm)) * 0.35;
        const fillDisplace = fillInfluence * centeredness * 0.04;
        rx += visual.fillOffsetX * fillDisplace;
        ry += visual.fillOffsetY * fillDisplace * 0.5;
        rz += visual.fillOffsetZ * fillDisplace;
      }

      // === 4. Drape at board edges and hole rim, plus surface conform ===
      // Transform this vertex from bag-local to world space once; reuse for all world-space checks.
      const worldVert = new THREE.Vector3(rx, ry, rz);
      worldVert.applyQuaternion(mesh.quaternion);
      worldVert.add(mesh.position);

      let worldDx = 0;
      let worldDy = 0;
      let worldDz = 0;

      if (onBoard && (holeInfluence > 0.01 || overBoard)) {
        // Hole drape: pull vertices inside the hole radius downward with a smooth, sagging falloff.
        const vertHoleDx = worldVert.x - holeWorldPos.x;
        const vertHoleDz = worldVert.z - holeWorldPos.z;
        const vertHoleDist = Math.hypot(vertHoleDx, vertHoleDz);
        const holeInfluenceRadius = HOLE_RADIUS + BAG_SIZE * 0.2;
        if (vertHoleDist < holeInfluenceRadius) {
          const hd = THREE.MathUtils.clamp(1 - vertHoleDist / holeInfluenceRadius, 0, 1);
          // Smoothstep for a softer lip and a deeper center.
          const holeDepth = hd * hd * (3 - 2 * hd);
          worldDy -= holeDepth * BAG_SIZE * 0.55;
        }

        // Board edge drape: vertices past board boundaries droop with a smooth quadratic falloff.
        const boardLocalVert = worldVert.clone();
        this.boardGroup.worldToLocal(boardLocalVert);
        const overhangX = Math.max(0, Math.abs(boardLocalVert.x) - boardHalfW);
        const overhangZ = Math.max(
          0,
          boardLocalVert.z > boardHalfL ? boardLocalVert.z - boardHalfL
            : boardLocalVert.z < -boardHalfL ? -boardHalfL - boardLocalVert.z : 0
        );
        if (overhangX > 0 || overhangZ > 0) {
          // Diagonal overhangs shouldn't double up, so combine as the length.
          const overhang = Math.hypot(overhangX, overhangZ);
          // Quadratic ease-in, capped — creates a soft hanging curve rather than a sharp wedge.
          const t = Math.min(1, overhang / (BAG_SIZE * 0.65));
          const edgeDrape = t * t * BAG_SIZE * 0.38;
          worldDy -= edgeDrape;
        }
      }

      // === 5. Surface conform — press the contact face flat against the surface ===
      // When the bag is settled on a surface, any vertex that would sink below the
      // real board/ground plane gets lifted up to it. This produces the authentic
      // pancake-pressed-flat contact patch that a solid physics box can never show.
      if (conformWeight > 0.001) {
        const worldVy = worldVert.y + worldDy;

        // Inverse-transform (already displaced) vertex into board-local space to test footprint.
        const boardLocal = worldVert.clone();
        boardLocal.x += worldDx; boardLocal.y += worldDy; boardLocal.z += worldDz;
        this.boardGroup.worldToLocal(boardLocal);
        const inBoardFootprint =
          Math.abs(boardLocal.x) < boardHalfW &&
          Math.abs(boardLocal.z) < boardHalfL;
        const hx = boardLocal.x;
        const hz = boardLocal.z - HOLE_Z;
        const inHole = Math.hypot(hx, hz) < HOLE_RADIUS - 0.01;

        // Determine the surface Y under this vertex. Default to ground (y=0).
        let surfaceY = 0;
        if (inBoardFootprint && !inHole) {
          // Project onto the board's top plane (local y = BOARD_THICKNESS/2), then
          // transform back to world to get the true (tilted) surface Y beneath this vertex.
          const surfacePoint = new THREE.Vector3(boardLocal.x, BOARD_THICKNESS / 2, boardLocal.z);
          this.boardGroup.localToWorld(surfacePoint);
          surfaceY = surfacePoint.y;
        }

        // Only conform if the bag as a whole is actually near the surface (not in flight).
        if (body.position.y < surfaceY + BAG_SIZE * 0.9 && worldVy < surfaceY + BAG_SIZE * 0.02) {
          const penetration = surfaceY - worldVy;
          if (penetration > 0) {
            // Cap how far any single vertex can be lifted. A real bean bag can flatten
            // about a quarter of its thickness — anything beyond that would be a
            // stretch artefact (e.g. a vertex hanging off the board edge being yanked
            // up to meet the board top). Clamping keeps the mesh coherent.
            const maxLift = BAG_SIZE * 0.22;
            worldDy += Math.min(penetration, maxLift) * conformWeight;
          }
          // Keep a tiny sliver above the surface on near-plane vertices so the
          // contact face sits visibly on top instead of z-fighting.
          const clearance = 0.0012;
          const residual = (surfaceY + clearance) - (worldVy + worldDy);
          if (residual > 0 && residual < 0.01) worldDy += residual * conformWeight;
        }
      }

      // Apply any accumulated world-space displacement back in bag-local coords.
      if (worldDx !== 0 || worldDy !== 0 || worldDz !== 0) {
        const worldDelta = new THREE.Vector3(worldDx, worldDy, worldDz);
        worldDelta.applyQuaternion(meshQuatInv);
        rx += worldDelta.x;
        ry += worldDelta.y;
        rz += worldDelta.z;
      }

      arr[i] = rx;
      arr[i + 1] = ry;
      arr[i + 2] = rz;
    }

    pos.needsUpdate = true;
    mesh.geometry.computeVertexNormals();

    visual.lastVelocityY = body.velocity.y;
  }

  markBagInHole(index: number, boardWorldQuat?: THREE.Quaternion) {
    if (this.bagInHole[index]) return;

    this.bagInHole[index] = true;
    if (this.bagInHoleDetectedAt[index] === 0) {
      this.bagInHoleDetectedAt[index] = Math.max(this.totalTime, 0.001);
    }

    const body = this.bagBodies[index];
    body.collisionResponse = false;

    const quat = boardWorldQuat ?? (() => {
      const q = new THREE.Quaternion();
      this.boardGroup.getWorldQuaternion(q);
      return q;
    })();
    const downWorld = new THREE.Vector3(0, -1, 0).applyQuaternion(quat);
    const currentDownSpeed = body.velocity.x * downWorld.x
      + body.velocity.y * downWorld.y
      + body.velocity.z * downWorld.z;
    const targetDownSpeed = 1.8;
    if (currentDownSpeed < targetDownSpeed) {
      const boost = targetDownSpeed - currentDownSpeed;
      body.velocity.x += downWorld.x * boost;
      body.velocity.y += downWorld.y * boost;
      body.velocity.z += downWorld.z * boost;
    }

    // Play cornhole sound once when first detected. Only for the actively-thrown
    // bag so settled bags don't trigger sounds during clearing/transitions.
    if (!this.cornholeSoundPlayed[index] && this.activeThrownBagIndex === index) {
      this.playCornholeSound();
      this.cornholeSoundPlayed[index] = true;
    }
  }

  captureBagInHole(index: number) {
    if (this.bagInHole[index]) return;

    const body = this.bagBodies[index];
    const boardWorldPos = new THREE.Vector3();
    this.boardGroup.getWorldPosition(boardWorldPos);
    const boardWorldQuat = new THREE.Quaternion();
    this.boardGroup.getWorldQuaternion(boardWorldQuat);

    const currentPos = new THREE.Vector3(body.position.x, body.position.y, body.position.z);
    const prevPos = this.bagPrevPositions[index];

    // Track previous position for trajectory crossing detection
    this.bagPrevPositions[index].copy(currentPos);

    // If we don't have a valid previous position, skip this frame
    if (prevPos.length() === 0) return;

    // Transform positions to board-local space to account for tilt
    const currentLocal = currentPos.clone().sub(boardWorldPos).applyQuaternion(boardWorldQuat.clone().invert());
    const prevLocal = prevPos.clone().sub(boardWorldPos).applyQuaternion(boardWorldQuat.clone().invert());

    // In board-local space, the hole is at (0, 0, HOLE_Z) and the board surface is at y = BOARD_THICKNESS/2
    const holeLocalZ = HOLE_Z;
    const holeLocalDist = Math.hypot(currentLocal.x, currentLocal.z - holeLocalZ);
    const prevHoleLocalDist = Math.hypot(prevLocal.x, prevLocal.z - holeLocalZ);

    // Check if bag crossed the capture plane in local Y. This sits below the
    // board surface so the bag has to actually sink into the hole to count.
    const captureY = HOLE_CAPTURE_Y;
    const aboveBoard = currentLocal.y > captureY;
    const prevAboveBoard = prevLocal.y > captureY;

    // Detect crossing from above the board surface to below it while within hole radius
    const crossedBoardPlane = prevAboveBoard && !aboveBoard;
    const withinHoleRadius = holeLocalDist < HOLE_CAPTURE_RADIUS || prevHoleLocalDist < HOLE_CAPTURE_RADIUS;

    // Also detect bags that have already fallen below the board surface and are within radius
    const belowBoard = !aboveBoard && holeLocalDist < HOLE_CAPTURE_RADIUS;

    if ((crossedBoardPlane && withinHoleRadius) || belowBoard) {
      this.markBagInHole(index, boardWorldQuat);
    }
  }

  finalizeBagInHole(index: number) {
    // Clear bags from hole after they've been counted for 5 seconds to prevent clogging
    if (!this.bagInHole[index]) return;
    if (this.bagPendingHoleCleanup[index]) return;

    const timeSinceDetection = this.totalTime - this.bagInHoleDetectedAt[index];
    if (timeSinceDetection > 5.0) {
      // Mark for cleanup and remove from physics world
      this.bagPendingHoleCleanup[index] = true;
      this.bagHoleCleanupReadyAt[index] = this.totalTime;

      const body = this.bagBodies[index];
      const mesh = this.bags[index];

      // Remove from physics world
      if (body) {
        this.world.removeBody(body);
      }

      // Hide the mesh
      if (mesh) {
        mesh.visible = false;
      }
    }
  }

  // ====== INPUT ======

  getPointerNdc(event: MouseEvent) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    return new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1
    );
  }

  updateAimFromDrag() {
    const dragVector = new THREE.Vector2().subVectors(this.dragCurrent, this.dragStart);
    const launchVector = dragVector.clone().multiplyScalar(-1);
    const dragDistance = dragVector.length();
    const downwardPull = Math.max(0, dragVector.y);
    const normalizedPull = THREE.MathUtils.clamp(
      Math.max(downwardPull / 0.55, dragDistance / 0.85),
      0,
      1
    );
    const easedPull = 1 - (1 - normalizedPull) * (1 - normalizedPull);

    this.aimX = THREE.MathUtils.clamp(launchVector.x * 2.1, -1.5, 1.5);
    this.pullDistance = THREE.MathUtils.lerp(0.18, 1.0, easedPull);

    const rawPull = Math.max(downwardPull / 0.55, dragDistance / 0.85);
    const throwFeet = rawPull * 74.5;
    const throwPercentage = Math.min((throwFeet / 30) * 100, 500);
    this.state.message = `Throw power: ${throwPercentage.toFixed(0)}%`;
    this.state.throwDistanceFeet = throwFeet;
  }

  clearDragGuide() {
    this.dragCurrent.copy(this.dragStart);
    this.state.isDragging = false;
    this.state.throwDistanceFeet = 0;
    this.pullLine.visible = false;
  }

  resetCameraToTurnView() {
    const cameraX = this.playerX;
    this.cameraPosition.set(cameraX, 2.25, 12);
    this.cameraLookTarget.set(cameraX, 0.6, this.boardGroup.position.z + 1);
    this.syncFreeRoamAnglesFromLookTarget();
    this.turnStartCameraPosition.copy(this.cameraPosition);
    this.turnStartCameraLookTarget.copy(this.cameraLookTarget);
    this.camera.position.copy(this.cameraPosition);
    this.camera.lookAt(this.cameraLookTarget);
  }

  syncFreeRoamAnglesFromDirection(direction: THREE.Vector3) {
    const normalizedDirection = direction.clone().normalize();
    this.freeRoamYaw = Math.atan2(normalizedDirection.x, -normalizedDirection.z);
    this.freeRoamPitch = Math.asin(THREE.MathUtils.clamp(normalizedDirection.y, -0.98, 0.98));
  }

  syncFreeRoamAnglesFromLookTarget() {
    const lookDirection = new THREE.Vector3().subVectors(this.cameraLookTarget, this.cameraPosition).normalize();
    this.syncFreeRoamAnglesFromDirection(lookDirection);
  }

  updateFreeRoamLookTarget() {
    const cosPitch = Math.cos(this.freeRoamPitch);
    const direction = new THREE.Vector3(
      Math.sin(this.freeRoamYaw) * cosPitch,
      Math.sin(this.freeRoamPitch),
      -Math.cos(this.freeRoamYaw) * cosPitch
    );
    this.cameraLookTarget.copy(this.cameraPosition).add(direction.multiplyScalar(10));
  }

  getHoleInspectAnchor() {
    const inspectTarget = this.getHoleInspectTarget();
    const cosPitch = Math.cos(this.freeRoamPitch);
    const inspectDirection = new THREE.Vector3(
      Math.sin(this.freeRoamYaw) * cosPitch,
      Math.sin(this.freeRoamPitch),
      -Math.cos(this.freeRoamYaw) * cosPitch
    );
    return inspectTarget.clone().addScaledVector(inspectDirection, -this.inspectCameraDistance);
  }

  getHoleInspectTarget() {
    return this.boardGroup.localToWorld(new THREE.Vector3(0, BOARD_THICKNESS / 2 + 0.02, HOLE_Z));
  }

  beginHoleInspection() {
    const inspectAnchor = this.getHoleInspectAnchor();
    const inspectTarget = this.getHoleInspectTarget();
    const inspectDirection = inspectTarget.clone().sub(inspectAnchor);
    this.syncFreeRoamAnglesFromDirection(inspectDirection);
    this.cameraLookTarget.copy(inspectTarget);
    const canvas = this.renderer.domElement;
    if (document.pointerLockElement !== canvas) {
      canvas.requestPointerLock?.();
    }
  }

  updateCamera(dt: number) {
    if (this.inspectCameraHeld) {
      const inspectDirection = new THREE.Vector3().subVectors(this.cameraLookTarget, this.cameraPosition);
      if (inspectDirection.lengthSq() > 1e-6) {
        this.syncFreeRoamAnglesFromDirection(inspectDirection);
      }
      const inspectAnchor = this.getHoleInspectAnchor();
      this.cameraPosition.lerp(inspectAnchor, 1 - Math.exp(-dt * 18));
      this.updateFreeRoamLookTarget();
      this.camera.position.copy(this.cameraPosition);
      this.camera.lookAt(this.cameraLookTarget);
      return;
    }

    if (this.freeRoamCameraEnabled) {
      const horizontalInput = (this.moveRightPressed ? 1 : 0) - (this.moveLeftPressed ? 1 : 0);
      const depthInput = (this.moveDownPressed ? 1 : 0) - (this.moveUpPressed ? 1 : 0);

      if (horizontalInput !== 0 || depthInput !== 0) {
        const lookDirection = new THREE.Vector3().subVectors(this.cameraLookTarget, this.cameraPosition);
        lookDirection.y = 0;
        if (lookDirection.lengthSq() < 1e-6) {
          lookDirection.set(0, 0, -1);
        } else {
          lookDirection.normalize();
        }

        const rightDirection = new THREE.Vector3(-lookDirection.z, 0, lookDirection.x);
        const moveOffset = new THREE.Vector3()
          .addScaledVector(rightDirection, horizontalInput * FREE_ROAM_CAMERA_SPEED * dt)
          .addScaledVector(lookDirection, -depthInput * FREE_ROAM_CAMERA_SPEED * dt);
        this.cameraPosition.add(moveOffset);
        this.cameraLookTarget.add(moveOffset);
      }

      this.camera.position.copy(this.cameraPosition);
      this.camera.lookAt(this.cameraLookTarget);
      return;
    }

    if (this.cinematicCameraEnabled && this.activeThrownBagIndex !== null && !this.state.isAiming) {
      const body = this.bagBodies[this.activeThrownBagIndex];
      // Stop following once the bag passes the hole (overshoot). Keep the
      // camera holding its current pose so it doesn't swing wildly to chase
      // a missed bag hurtling into the distance.
      const holeWorldZ = this.boardGroup.position.z + HOLE_Z * Math.cos(BOARD_TILT);
      if (body.position.z < holeWorldZ) {
        this.camera.position.copy(this.cameraPosition);
        this.camera.lookAt(this.cameraLookTarget);
        return;
      }
      const followTarget = new THREE.Vector3(body.position.x, body.position.y + 0.05, body.position.z);
      const horizontalOffset = this.state.throwingPlayer === 1 ? -1.45 : 1.45;
      const desiredCameraPosition = new THREE.Vector3(
        followTarget.x + horizontalOffset * 1.15,
        followTarget.y + 0.7,
        followTarget.z + 1.65
      );
      const desiredLookTarget = followTarget.clone().add(new THREE.Vector3(0, -0.03, -1.4));
      this.cameraPosition.lerp(desiredCameraPosition, 1 - Math.exp(-dt * 11));
      this.cameraLookTarget.lerp(desiredLookTarget, 1 - Math.exp(-dt * 12));
      this.camera.position.copy(this.cameraPosition);
      this.camera.lookAt(this.cameraLookTarget);
      return;
    }

    const swayX = Math.sin(this.totalTime * 0.4) * 0.03;
    const swayY = Math.sin(this.totalTime * 0.6) * 0.015;
    this.cameraPosition.set(this.playerX + swayX + this.aimX * 0.08, 2.25 + swayY, 12);
    this.cameraLookTarget.set(this.playerX + this.aimX * 0.3, 0.6, this.boardGroup.position.z + 1);
    this.camera.position.copy(this.cameraPosition);
    this.camera.lookAt(this.cameraLookTarget);
  }

  getCurrentDragDistance() {
    return this.dragCurrent.distanceTo(this.dragStart);
  }

  handleMouseMove = (event: MouseEvent) => {
    if (this.inspectCameraHeld) {
      this.freeRoamYaw += event.movementX * 0.005;
      this.freeRoamPitch = THREE.MathUtils.clamp(this.freeRoamPitch - event.movementY * 0.004, -1.25, 0.95);
      this.updateFreeRoamLookTarget();
      return;
    }

    if (this.freeRoamCameraEnabled && this.freeRoamLookActive) {
      const deltaX = event.clientX - this.freeRoamLookLastPointer.x;
      const deltaY = event.clientY - this.freeRoamLookLastPointer.y;
      this.freeRoamLookLastPointer.set(event.clientX, event.clientY);
      this.freeRoamYaw += deltaX * 0.005;
      this.freeRoamPitch = THREE.MathUtils.clamp(this.freeRoamPitch - deltaY * 0.004, -1.35, 1.1);
      this.updateFreeRoamLookTarget();
      return;
    }

    if (this.guestMode) {
      if (!this.isDragging) return;
      const ndc = this.getPointerNdc(event);
      this.dragCurrent.copy(ndc);
      // Client-side prediction: update aim + UI locally so the guest's own
      // drag visuals (power bar, pull line) respond at 60fps without waiting
      // for the host→guest snapshot round-trip. The host will still receive
      // the intent and drive the authoritative throw on release.
      this.updateAimFromDrag();
      this.emitState();
      this.onLocalIntent?.({ type: 'dragMove', ndcX: ndc.x, ndcY: ndc.y });
      return;
    }

    if (!this.state.isAiming || !this.isDragging) return;
    this.dragCurrent.copy(this.getPointerNdc(event));
    this.updateAimFromDrag();
    this.emitState();
  };

  handleMouseDown = (event: MouseEvent) => {
    if (this.inspectCameraHeld) return;

    if (this.freeRoamCameraEnabled) {
      this.freeRoamLookActive = true;
      this.freeRoamLookLastPointer.set(event.clientX, event.clientY);
      return;
    }

    if (this.guestMode) {
      if (this.localPlayerSlot !== this.state.currentPlayer) return;
      if (!this.state.isAiming || this.state.isThrowing || this.state.gameOver) return;
      const ndc = this.getPointerNdc(event);
      this.isDragging = true;
      this.state.isDragging = true;
      this.dragStart.copy(ndc);
      this.dragCurrent.copy(ndc);
      this.aimX = 0;
      this.pullDistance = 0.18;
      this.emitState();
      this.onLocalIntent?.({ type: 'dragStart', ndcX: ndc.x, ndcY: ndc.y });
      return;
    }

    if (!this.state.isAiming || this.state.isThrowing || this.state.gameOver) return;
    if (!this.ownsCurrentTurn()) return;
    this.isDragging = true;
    this.state.isDragging = true;
    this.dragStart.copy(this.getPointerNdc(event));
    this.dragCurrent.copy(this.dragStart);
    this.aimX = 0;
    this.pullDistance = 0.18;
    this.state.lastResult = '';
    this.state.lastPoints = 0;
    this.state.message = 'Pull for distance, release to lock speed.';
    this.emitState();
  };

  handleMouseUp = (event: MouseEvent) => {
    if (this.inspectCameraHeld) return;

    if (this.freeRoamCameraEnabled) {
      this.freeRoamLookActive = false;
      return;
    }

    if (!this.isDragging) return;

    if (this.guestMode) {
      const ndc = this.getPointerNdc(event);
      this.dragCurrent.copy(ndc);
      this.updateAimFromDrag();
      const dragDistance = this.getCurrentDragDistance();
      const shouldThrow = dragDistance >= MIN_THROW_DRAG_DISTANCE && this.pullDistance > 0.2;
      this.isDragging = false;
      this.clearDragGuide();
      if (!shouldThrow) {
        this.state.message = 'Pull farther for more distance.';
      }
      this.suppressRemoteDragUntil = performance.now() + 1200;
      this.emitState();
      // Send the guest's locally-oscillated aimPower with the release so the
      // host throws with the same sin value the guest actually saw when
      // releasing — otherwise the host's own oscillator (a ~100ms-different
      // phase) would pick a different speedT and the throw strength wouldn't
      // match the trajectory meter the guest saw.
      this.onLocalIntent?.({ type: 'dragEnd', ndcX: ndc.x, ndcY: ndc.y, aimPower: this.aimPower });
      return;
    }

    this.dragCurrent.copy(this.getPointerNdc(event));
    this.updateAimFromDrag();
    const dragDistance = this.getCurrentDragDistance();
    this.isDragging = false;
    this.clearDragGuide();

    const shouldThrow = dragDistance >= MIN_THROW_DRAG_DISTANCE && this.pullDistance > 0.2;
    this.emitState();

    if (shouldThrow) {
      this.throwBag();
    } else {
      this.state.message = 'Pull farther for more distance.';
      this.emitState();
    }
  };

  handleMouseLeave = () => {
    if (this.inspectCameraHeld) return;

    if (this.freeRoamCameraEnabled) {
      this.freeRoamLookActive = false;
      return;
    }

    if (!this.isDragging) return;

    if (this.guestMode) {
      this.isDragging = false;
      this.clearDragGuide();
      this.state.message = 'Pull for distance, release to lock speed.';
      this.aimX = 0;
      this.pullDistance = 0.3;
      this.aimPower = 0.65;
      this.suppressRemoteDragUntil = performance.now() + 1200;
      this.emitState();
      this.onLocalIntent?.({ type: 'dragCancel' });
      return;
    }

    this.isDragging = false;
    this.clearDragGuide();
    this.state.message = 'Pull for distance, release to lock speed.';
    this.aimX = 0;
    this.pullDistance = 0.3;
    this.aimPower = 0.65;
    this.emitState();
  };

  handleWheel = (event: WheelEvent) => {
    if (!this.inspectCameraHeld) return;
    this.inspectCameraDistance = THREE.MathUtils.clamp(
      this.inspectCameraDistance + event.deltaY * 0.005,
      INSPECT_CAMERA_MIN_DISTANCE,
      INSPECT_CAMERA_MAX_DISTANCE
    );
    event.preventDefault();
  };

  handleKeyDown = (event: KeyboardEvent) => {
    if (this.guestMode) {
      if (event.code === 'ArrowLeft') {
        this.onLocalIntent?.({ type: 'moveStart', direction: 'left' });
        event.preventDefault();
        return;
      } else if (event.code === 'ArrowRight') {
        this.onLocalIntent?.({ type: 'moveStart', direction: 'right' });
        event.preventDefault();
        return;
      } else if (event.code === 'KeyF' && !event.repeat) {
        this.onLocalIntent?.({ type: 'flipBagSide' });
        event.preventDefault();
        return;
      } else if (event.code === 'KeyT' && !event.repeat) {
        this.onLocalIntent?.({ type: 'toggleThrowStyle' });
        event.preventDefault();
        return;
      } else if (event.code === 'KeyW' && !event.repeat) {
        this.onLocalIntent?.({ type: 'toggleWeather' });
        event.preventDefault();
        return;
      } else if (event.code === 'KeyB' && !event.repeat) {
        this.cycleBoardTexture();
        event.preventDefault();
        return;
      } else if (event.code === 'KeyC' && !event.repeat && !this.isDragging) {
        this.inspectCameraHeld = true;
        this.beginHoleInspection();
        event.preventDefault();
        return;
      }
      // Let other keys fall through for local camera controls.
    }
    const blockTurnInput = this.onlineHostMode && !this.ownsCurrentTurn();
    if (event.code === 'ArrowLeft') {
      if (blockTurnInput) { event.preventDefault(); return; }
      this.moveLeftPressed = true;
      event.preventDefault();
    } else if (event.code === 'ArrowRight') {
      if (blockTurnInput) { event.preventDefault(); return; }
      this.moveRightPressed = true;
      event.preventDefault();
    } else if (event.code === 'ArrowUp') {
      if (blockTurnInput) { event.preventDefault(); return; }
      this.moveUpPressed = true;
      event.preventDefault();
    } else if (event.code === 'ArrowDown') {
      if (blockTurnInput) { event.preventDefault(); return; }
      this.moveDownPressed = true;
      event.preventDefault();
    } else if (event.code === 'KeyC' && !event.repeat && !this.isDragging) {
      this.inspectCameraHeld = true;
      this.beginHoleInspection();
      this.state.message = 'Inspecting the hole. Move the mouse to look around.';
      this.emitState();
      event.preventDefault();
    } else if (event.code === 'KeyR') {
      this.freeRoamCameraEnabled = false;
      this.inspectCameraHeld = false;
      this.freeRoamLookActive = false;
      this.cameraPosition.copy(this.turnStartCameraPosition);
      this.cameraLookTarget.copy(this.turnStartCameraLookTarget);
      this.syncFreeRoamAnglesFromLookTarget();
      this.camera.position.copy(this.cameraPosition);
      this.camera.lookAt(this.cameraLookTarget);
      this.state.message = `${this.state.currentPlayer === 1 ? 'Player 1' : 'Player 2'} camera reset.`;
      this.emitState();
      event.preventDefault();
    } else if (event.code === 'KeyF' && this.state.isAiming && !this.state.isThrowing && !this.state.gameOver) {
      if (blockTurnInput) { event.preventDefault(); return; }
      this.selectedBagSide = this.selectedBagSide === 'sticky' ? 'slick' : 'sticky';
      this.playerBagSides[this.state.currentPlayer] = this.selectedBagSide;
      this.state.selectedBagSide = this.selectedBagSide;
      this.state.bagPreviewSide = this.selectedBagSide;
      this.emitState();
      event.preventDefault();
    } else if (event.code === 'KeyT' && this.state.isAiming && !this.state.isThrowing && !this.state.gameOver) {
      if (blockTurnInput) { event.preventDefault(); return; }
      this.throwStyle = this.throwStyle === 'slide' ? 'roll' : 'slide';
      this.playerThrowStyles[this.state.currentPlayer] = this.throwStyle;
      this.applyThrowStyleBagPreference();
      this.state.throwStyle = this.throwStyle;
      this.state.message = `Throw style: ${this.throwStyle === 'slide' ? 'Slide' : 'Roll'}`;
      this.emitState();
      event.preventDefault();
    } else if (event.code === 'KeyW' && !event.repeat) {
      this.weatherEnabled = !this.weatherEnabled;
      this.emitState();
      event.preventDefault();
    } else if (event.code === 'KeyB' && !event.repeat) {
      this.cycleBoardTexture();
      event.preventDefault();
    } else if (event.code === 'KeyS' && !event.repeat) {
      this.slowMotionEnabled = !this.slowMotionEnabled;
      this.state.message = this.slowMotionEnabled ? 'Slow motion ON' : 'Slow motion OFF';
      this.emitState();
      event.preventDefault();
    }
  };

  handleKeyUp = (event: KeyboardEvent) => {
    if (this.guestMode) {
      if (event.code === 'ArrowLeft') {
        this.onLocalIntent?.({ type: 'moveStop', direction: 'left' });
        event.preventDefault();
        return;
      } else if (event.code === 'ArrowRight') {
        this.onLocalIntent?.({ type: 'moveStop', direction: 'right' });
        event.preventDefault();
        return;
      } else if (event.code === 'KeyC') {
        this.inspectCameraHeld = false;
        event.preventDefault();
        return;
      }
    }
    if (event.code === 'ArrowLeft') {
      this.moveLeftPressed = false;
      event.preventDefault();
    } else if (event.code === 'ArrowRight') {
      this.moveRightPressed = false;
      event.preventDefault();
    } else if (event.code === 'ArrowUp') {
      this.moveUpPressed = false;
      event.preventDefault();
    } else if (event.code === 'ArrowDown') {
      this.moveDownPressed = false;
      event.preventDefault();
    } else if (event.code === 'KeyC') {
      this.inspectCameraHeld = false;
      if (document.pointerLockElement === this.renderer.domElement) {
        document.exitPointerLock?.();
      }
      if (this.state.isAiming && !this.state.isThrowing && !this.state.gameOver) {
        this.state.message = `${this.state.currentPlayer === 1 ? 'Player 1' : 'Player 2'}'s turn. Pull for distance, release to lock speed.`;
        this.emitState();
      }
      event.preventDefault();
    }
  };

  handleResize = () => {
    const canvas = this.renderer.domElement;
    this.camera.aspect = canvas.clientWidth / canvas.clientHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(canvas.clientWidth, canvas.clientHeight);
    this.updateBoardCameraFrustum();
  };

  syncBagsLeftState() {
    this.state.player1BagsLeft = 4 - this.playerBagsThrown[1];
    this.state.player2BagsLeft = 4 - this.playerBagsThrown[2];
    this.state.bagsRemaining = this.state.currentPlayer === 1
      ? this.state.player1BagsLeft
      : this.state.player2BagsLeft;
  }

  emitState() {
    if (this.isDisposed) return;
    // Do NOT overwrite player1BagsLeft / player2BagsLeft here —
    // they are managed explicitly by throwBag, startTurn, evaluateThrow, resetBags.
    this.state.aimPower = this.aimPower;
    const completedRounds = Math.max(0, this.state.inning - 1);
    this.state.player1Ppr = completedRounds > 0 ? Number((this.cumulativeRoundPoints[1] / completedRounds).toFixed(2)) : 0;
    this.state.player2Ppr = completedRounds > 0 ? Number((this.cumulativeRoundPoints[2] / completedRounds).toFixed(2)) : 0;
    this.state.selectedBagSide = this.selectedBagSide;
    this.state.throwStyle = this.throwStyle;
    this.state.timeOfDayLabel = this.formatTimeOfDayLabel();
    this.state.temperatureF = this.temperatureF;
    this.state.windMph = this.windMph;
    this.state.windDirection = this.windDirection;
    this.state.humidityPct = this.humidityPct;
    this.state.weatherEnabled = this.weatherEnabled;
    this.state.dragStartX = (this.dragStart.x + 1) * 0.5;
    this.state.dragStartY = (1 - this.dragStart.y) * 0.5;
    this.state.dragCurrentX = (this.dragCurrent.x + 1) * 0.5;
    this.state.dragCurrentY = (1 - this.dragCurrent.y) * 0.5;
    this.onStateChange({ ...this.state });
    if (!this.guestMode && this.onSnapshot) {
      // Skip broadcasting drag-in-progress state. The guest UI hides the
      // opponent's aim anyway, so every mousemove-driven emitState during a
      // pull-back would just fill the 20Hz broadcast budget with invisible
      // updates, starving real transitions. The throw release still flips
      // isThrowing and clears isDragging, which broadcasts normally.
      if (!this.state.isDragging) {
        this.requestBroadcast('full');
      }
    }
  }

  // Single choke point for every network send. Any code path that wants to
  // push state to the guest queues a request here; the queue runs at most
  // once per BROADCAST_INTERVAL (50ms = 20Hz). If multiple requests land in
  // the same window they collapse: a full-state request wins over a
  // flight-only request (we'd rather drop a smoothing sample than a real
  // transition like bag-settled / round-over).
  private requestBroadcast(kind: 'full' | 'flight') {
    if (!this.onSnapshot) return;
    if (!this.onlineHostMode) {
      // Hot-seat has no network peer, so cost is zero and we can send every
      // request directly. (In practice onSnapshot is null in hot-seat anyway.)
      this.onSnapshot(kind === 'flight' ? this.serializeFlightSnapshot() : this.serializeSnapshot());
      return;
    }
    // Promote flight→full if a full is already waiting.
    if (this.queuedBroadcast === 'full' || kind === 'full') this.queuedBroadcast = 'full';
    else this.queuedBroadcast = 'flight';

    const sinceLast = this.totalTime - this.lastBroadcastAt;

    if (sinceLast >= BROADCAST_INTERVAL && this.queuedBroadcastTimer === null) {
      // Leading edge: no recent send and nothing pending — fire now.
      this.flushQueuedBroadcast();
      return;
    }
    if (this.queuedBroadcastTimer !== null) return;
    const waitMs = Math.max(0, (BROADCAST_INTERVAL - sinceLast) * 1000);
    this.queuedBroadcastTimer = window.setTimeout(() => {
      this.queuedBroadcastTimer = null;
      this.flushQueuedBroadcast();
    }, waitMs);
  }

  private flushQueuedBroadcast() {
    if (this.isDisposed || !this.onSnapshot || this.queuedBroadcast === null) return;
    const kind = this.queuedBroadcast;
    this.queuedBroadcast = null;
    this.lastBroadcastAt = this.totalTime;
    this.onSnapshot(kind === 'flight' ? this.serializeFlightSnapshot() : this.serializeSnapshot());
  }

  renderGameToText = () => JSON.stringify({
    coordinateSystem: 'x increases right, y increases up, z decreases toward the board',
    inning: this.state.inning,
    currentPlayer: this.state.currentPlayer,
    scores: {
      player1: this.state.player1Score,
      player2: this.state.player2Score,
      player1Round: this.state.player1RoundScore,
      player2Round: this.state.player2RoundScore,
    },
    environment: {
      timeOfDay: this.formatTimeOfDayLabel(),
      temperatureF: this.temperatureF,
      windMph: this.windMph,
      windDirection: this.windDirection,
      humidityPct: this.humidityPct,
    },
    throwState: {
      isAiming: this.state.isAiming,
      isThrowing: this.state.isThrowing,
      isDragging: this.state.isDragging,
      aimX: Number(this.aimX.toFixed(2)),
      pullDistance: Number(this.pullDistance.toFixed(2)),
      aimPower: Number(this.aimPower.toFixed(2)),
      selectedBagSide: this.selectedBagSide,
      throwStyle: this.throwStyle,
    },
    visibleBags: this.bags
      .map((bag, index) => ({ bag, body: this.bagBodies[index], index }))
      .filter(({ bag }) => bag.visible)
      .map(({ body, index }) => ({
        index,
        x: Number(body.position.x.toFixed(2)),
        y: Number(body.position.y.toFixed(2)),
        z: Number(body.position.z.toFixed(2)),
      })),
  });

  installTestingHooks() {
    window.render_game_to_text = this.renderGameToText;
    window.advanceTime = (ms: number) => {
      const steps = Math.max(1, Math.round(ms / (1000 / 60)));
      for (let i = 0; i < steps; i++) {
        this.step(1 / 60);
      }
      this.render();
    };
  }

  // ====== ANIMATION LOOP ======

  animate = () => {
    if (this.isDisposed) return;
    this.animationFrameId = requestAnimationFrame(this.animate);
    const dt = Math.min(this.clock.getDelta(), 0.05);
    this.step(dt);
    this.render();
  };

  step(dt: number) {
    const timeScale = this.slowMotionEnabled ? 0.25 : 1.0;
    dt *= timeScale;
    this.totalTime += dt;

    // Move clouds and fade them near the wrap edges so the loop isn't visible.
    // Sun direction for projecting cloud shadows onto the ground.
    const dayProgress = THREE.MathUtils.clamp((this.timeOfDay - DAWN_TIME) / (DUSK_TIME - DAWN_TIME), 0, 1);
    const sunHeight = Math.sin(dayProgress * Math.PI);
    const sunX = THREE.MathUtils.lerp(-18, 18, dayProgress);
    const sunY = THREE.MathUtils.lerp(7, 28, sunHeight);
    const sunZ = THREE.MathUtils.lerp(18, 8, dayProgress);
    const invSunY = sunY > 0.5 ? 1 / sunY : 0;

    for (let i = 0; i < this.clouds.length; i++) {
      const cloud = this.clouds[i];
      const speed = cloud.userData.speed || 1;
      const wrapX: number = cloud.userData.wrapX ?? 80;
      const fadeMargin: number = cloud.userData.fadeMargin ?? 15;
      const baseOpacity: number = cloud.userData.baseOpacity ?? 0.95;

      cloud.position.x += speed * dt;
      if (cloud.position.x > wrapX) {
        cloud.position.x -= wrapX * 2;
      }

      const edgeDist = wrapX - Math.abs(cloud.position.x);
      const fade = THREE.MathUtils.clamp(edgeDist / fadeMargin, 0, 1);
      const mat = cloud.userData.material as THREE.MeshStandardMaterial | undefined;
      if (mat) mat.opacity = baseOpacity * fade;

      const shadow = this.cloudShadows[i];
      if (shadow) {
        // Project cloud onto ground along the sun direction:
        // ground_xz = cloud_xz - (cloud_y / sun_y) * sun_xz
        const t = cloud.position.y * invSunY;
        const sx = cloud.position.x - sunX * t;
        const sz = cloud.position.z - sunZ * t;
        shadow.position.x = sx;
        shadow.position.z = sz;

        // Hide the shadow when it falls outside the grass plane
        // (x in [-40, 40], z in [-40, 60]). Soft edge to avoid popping.
        const shadowRadius = shadow.scale.x * 0.5;
        const xOver = Math.max(0, Math.abs(sx) - 40 + shadowRadius);
        const zOver = Math.max(0, Math.max(sz - 60, -40 - sz) + shadowRadius);
        const landFade = THREE.MathUtils.clamp(1 - Math.max(xOver, zOver) / (shadowRadius * 2 + 4), 0, 1);

        const shadowMat = shadow.material as THREE.MeshBasicMaterial;
        const baseShadowOpacity: number = shadow.userData.baseOpacity ?? 0.25;
        // Shadows dim when the sun is low (soft contrast at dusk/dawn) and
        // disappear when the sun is below the horizon.
        shadowMat.opacity = baseShadowOpacity * fade * landFade * THREE.MathUtils.smoothstep(sunHeight, 0.05, 0.4);
        shadow.visible = shadowMat.opacity > 0.005;
      }
    }

    if (!this.guestMode) {
      const moveInput = (this.moveRightPressed ? 1 : 0) - (this.moveLeftPressed ? 1 : 0);
      if (!this.freeRoamCameraEnabled && moveInput !== 0) {
        const currentPlayer = this.state.currentPlayer;
        const minX = currentPlayer === 1 ? -PLAYER_OUTER_X : PLAYER_DEFAULT_X[2];
        const maxX = currentPlayer === 1 ? PLAYER_DEFAULT_X[1] : PLAYER_OUTER_X;
        this.playerX = THREE.MathUtils.clamp(this.playerX + moveInput * dt * 2.8, minX, maxX);
        this.playerPositions[this.state.currentPlayer] = this.playerX;
      }
    }
    // Aim-power oscillator is a deterministic sin(totalTime) — no authority
    // needed — so we run it on host always, and on the guest during their own
    // turn so their power bar animates at 60fps without relying on snapshots.
    const canRunAimCycle = !this.guestMode || this.localPlayerSlot === this.state.currentPlayer;
    if (canRunAimCycle && this.state.isAiming && !this.state.gameOver) {
      const cycle = (Math.sin(this.totalTime * 3.8) + 1) * 0.5;
      this.aimPower = cycle;
      this.emitState();
    }
    this.updatePreviewBagMaterials();

    if (!this.guestMode) {
      this.world.step(1 / 60, dt, 3);
      this.suppressFrontEdgeBounce();
      this.suppressBagHoleRimBounce();
      this.applyHoleCaptureAssist(dt);
      this.playActiveBagOnBagImpactSound();
      this.syncPhysicsDebugMeshes();

      // Handle settling timer (game-time based, respects slow motion)
      if (this.state.isSettling && this.activeThrownBagIndex !== null) {
        this.settlingTimer += dt;
        if (this.settlingTimer >= 3.5) {
          this.state.isSettling = false;
          this.evaluateThrow(this.activeThrownBagIndex, this.state.throwingPlayer!);
        }
      }

      // Broadcast snapshots during flight/settling so the guest can see the bag move.
      // emitState only fires on state transitions — physics updates bodies every frame
      // without touching state. requestBroadcast collapses with any concurrent
      // emitState calls, giving a single unified 20Hz send rate to the guest.
      if (this.onSnapshot && (this.state.isThrowing || this.state.isSettling)) {
        this.requestBroadcast('flight');
      }
    }

    // On the guest, blend bag meshes from the last snapshot toward the newest
    // before softness code reads them, so soft-body deformation tracks the
    // smoothed visual rather than jumping between 20Hz snapshot positions.
    if (this.guestMode) {
      this.stepGuestInterpolation(dt);
    }

    // Sync bag visuals
    for (let i = 0; i < this.bags.length; i++) {
      if (this.bags[i].visible) {
        if (!this.guestMode) {
          this.captureBagInHole(i);
          this.applyWeatherWindToBag(this.bagBodies[i], dt);
          this.updateBagSurfacePhysics(this.bagBodies[i], i);
          this.finalizeBagInHole(i);
        }
        this.applyBagVisualSoftness(i, dt);
      }
    }

    if (this.state.isAiming) {
      this.updatePullLine();
    } else {
      this.pullLine.visible = false;
    }

    this.updateCamera(dt);

    // Update particles
    this.updateParticles(dt);

    const previewPitchBase = this.throwStyle === 'roll' ? -0.34 : -0.48;
    const previewPitch = this.selectedBagSide === 'sticky' ? previewPitchBase : Math.PI + previewPitchBase;
    const previewYaw = this.throwStyle === 'roll' ? Math.sin(this.totalTime * 0.7) * 0.04 : this.totalTime * 0.7;
    const previewBank = this.throwStyle === 'roll' ? -0.05 : -0.02;
    const previewTumble = this.throwStyle === 'roll' ? Math.sin(this.totalTime * 2.4) * 0.32 : previewBank;
    this.previewBag.rotation.set(previewPitch, previewYaw, previewTumble);
    this.previewBag.position.y = -0.04 + Math.sin(this.totalTime * 1.2) * 0.015;
  }

  render() {
    this.updateBoardCameraFrustum();
    this.boardCamera.position.set(this.boardGroup.position.x, this.boardGroup.position.y + 7.5, this.boardGroup.position.z);
    this.boardCamera.lookAt(this.boardGroup.position.x, this.boardGroup.position.y, this.boardGroup.position.z);

    const canvas = this.renderer.domElement;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    const insetWidth = Math.round(Math.min(336, width * 0.312));
    const insetHeight = Math.round(Math.min(432, height * 0.432));
    const insetX = 24;
    const insetY = Math.max(24, Math.round(height * 0.28));
    this.renderer.setViewport(0, 0, width, height);
    this.renderer.setScissorTest(false);
    this.renderer.clear();
    this.renderer.render(this.scene, this.camera);

    this.renderer.clearDepth();
    this.renderer.setScissorTest(true);
    this.renderer.setScissor(insetX, height - insetY - insetHeight, insetWidth, insetHeight);
    this.renderer.setViewport(insetX, height - insetY - insetHeight, insetWidth, insetHeight);
    this.renderer.render(this.scene, this.boardCamera);

    const previewElement = document.getElementById('bag-preview-viewport');
    const canvasRect = canvas.getBoundingClientRect();
    const previewRect = previewElement?.getBoundingClientRect();
    if (previewRect) {
      const previewViewportX = Math.round(previewRect.left - canvasRect.left);
      const previewViewportY = Math.round(canvasRect.bottom - previewRect.bottom);
      const previewViewportWidth = Math.round(previewRect.width);
      const previewViewportHeight = Math.round(previewRect.height);
      const previewAspect = previewViewportWidth / previewViewportHeight;
      const previewVerticalSpan = 1.1;

      this.previewCamera.left = -previewVerticalSpan * previewAspect;
      this.previewCamera.right = previewVerticalSpan * previewAspect;
      this.previewCamera.top = previewVerticalSpan;
      this.previewCamera.bottom = -previewVerticalSpan;
      this.previewCamera.updateProjectionMatrix();

      this.renderer.clearDepth();
      this.renderer.setScissor(previewViewportX, previewViewportY, previewViewportWidth, previewViewportHeight);
      this.renderer.setViewport(previewViewportX, previewViewportY, previewViewportWidth, previewViewportHeight);
      this.renderer.render(this.previewScene, this.previewCamera);
    }
    this.renderer.setScissorTest(false);
  }

  updateBoardCameraFrustum() {
    const canvas = this.renderer.domElement;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    const insetWidth = Math.max(216, Math.min(336, width * 0.312));
    const insetHeight = Math.max(264, Math.min(432, height * 0.432));
    const aspect = insetWidth / insetHeight;
    const verticalSpan = 3.4;

    this.boardCamera.left = -verticalSpan * aspect;
    this.boardCamera.right = verticalSpan * aspect;
    this.boardCamera.top = verticalSpan;
    this.boardCamera.bottom = -verticalSpan;
    this.boardCamera.updateProjectionMatrix();
  }

  updatePullLine() {
    const startX = this.aimX * 0.8;
    const startY = 1.5;
    const startZ = 12;
    const pullPositions = this.pullLine.geometry.attributes.position;
    if (this.state.isDragging) {
      const pullX = startX - (this.dragCurrent.x - this.dragStart.x) * 1.3;
      const pullY = startY - (this.dragCurrent.y - this.dragStart.y) * 0.9;
      pullPositions.setXYZ(0, startX, startY, startZ);
      pullPositions.setXYZ(1, pullX, pullY, startZ + 0.1);
      pullPositions.needsUpdate = true;
      this.pullLine.visible = true;
    } else {
      this.pullLine.visible = false;
    }
  }

  dispose() {
    this.isDisposed = true;
    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
    if (this.queuedBroadcastTimer !== null) {
      window.clearTimeout(this.queuedBroadcastTimer);
      this.queuedBroadcastTimer = null;
    }
    window.removeEventListener('resize', this.handleResize);
    window.removeEventListener('keydown', this.handleKeyDown);
    window.removeEventListener('keyup', this.handleKeyUp);
    const canvas = this.renderer.domElement;
    if (document.pointerLockElement === canvas) {
      document.exitPointerLock?.();
    }
    canvas.removeEventListener('mousemove', this.handleMouseMove);
    canvas.removeEventListener('mousedown', this.handleMouseDown);
    canvas.removeEventListener('mouseup', this.handleMouseUp);
    canvas.removeEventListener('mouseleave', this.handleMouseLeave);
    canvas.removeEventListener('wheel', this.handleWheel);
    delete window.render_game_to_text;
    delete window.advanceTime;
    if (this.previewBag) {
      this.previewBag.geometry.dispose();
      this.disposeBagMaterials(this.previewBag.material as THREE.Material | THREE.Material[]);
    }
    for (const texture of this.boardTopTextures) {
      texture?.dispose();
    }
    this.renderer.dispose();
  }

  setupControls(canvas: HTMLCanvasElement) {
    window.addEventListener('keydown', this.handleKeyDown);
    window.addEventListener('keyup', this.handleKeyUp);
    canvas.addEventListener('mousemove', this.handleMouseMove);
    canvas.addEventListener('mousedown', this.handleMouseDown);
    canvas.addEventListener('mouseup', this.handleMouseUp);
    canvas.addEventListener('mouseleave', this.handleMouseLeave);
    canvas.addEventListener('wheel', this.handleWheel, { passive: false });
  }

  // ====== MULTIPLAYER ======

  setGuestMode(enabled: boolean, localPlayerSlot: 1 | 2) {
    this.guestMode = enabled;
    this.onlineHostMode = false;
    this.localPlayerSlot = localPlayerSlot;
  }

  // Fully reset the match in place without disposing the game instance. Used
  // for the online rematch flow where disposing would drop the transport
  // subscription and force the guest to reconnect.
  restartMatch() {
    this.state.player1Score = 0;
    this.state.player2Score = 0;
    this.state.player1RoundScore = 0;
    this.state.player2RoundScore = 0;
    this.state.player1Ppr = 0;
    this.state.player2Ppr = 0;
    this.state.inning = 1;
    this.state.bagsThisInning = 0;
    this.state.gameOver = false;
    this.state.showResult = false;
    this.state.resultMessage = '';
    this.state.lastPoints = 0;
    this.state.lastResult = '';
    this.state.throwingPlayer = null;
    this.state.isThrowing = false;
    this.state.isSettling = false;
    this.inningBaseScores[1] = 0;
    this.inningBaseScores[2] = 0;
    this.cumulativeRoundPoints[1] = 0;
    this.cumulativeRoundPoints[2] = 0;
    this.playerBagsThrown[1] = 0;
    this.playerBagsThrown[2] = 0;
    this.nextInningStarter = 1;
    this.activeThrownBagIndex = null;
    this.settlingTimer = 0;
    this.bagSettled = false;
    this.aimX = 0;
    this.pullDistance = 0.3;
    this.aimPower = 0.65;
    for (let i = 0; i < 8; i++) {
      if (this.bags[i]) this.bags[i].visible = false;
      if (this.bagBodies[i]) {
        this.bagBodies[i].position.set(0, -20, 0);
        this.bagBodies[i].velocity.set(0, 0, 0);
        this.bagBodies[i].angularVelocity.set(0, 0, 0);
        this.bagBodies[i].collisionResponse = true;
      }
      this.resetBagVisualState(i);
    }
    this.bagThrowStyles.fill('slide');
    this.bagInHole.fill(false);
    this.bagInHoleDetectedAt.fill(0);
    this.bagPendingHoleCleanup.fill(false);
    this.bagHoleCleanupReadyAt.fill(0);
    for (let i = 0; i < 8; i++) {
      this.bagPrevPositions[i].set(0, 0, 0);
    }
    this.startTurn(1);
    this.emitState();
  }

  setHostMode(localPlayerSlot: 1 | 2, online = false) {
    this.guestMode = false;
    this.onlineHostMode = online;
    this.localPlayerSlot = localPlayerSlot;
  }

  // True when this client has any kind of multiplayer role and should refuse
  // inputs for a player slot it doesn't own.
  private isOnline(): boolean {
    return this.guestMode || this.onlineHostMode;
  }

  private ownsCurrentTurn(): boolean {
    if (!this.isOnline()) return true;
    return this.localPlayerSlot === this.state.currentPlayer;
  }

  canLocalPlayerAct(): boolean {
    if (this.guestMode) return false;
    if (this.localPlayerSlot === this.state.currentPlayer) return true;
    return false;
  }

  applyIntent(intent: import('./net/types').Intent, fromSlot: 1 | 2) {
    if (this.guestMode) return;
    if (fromSlot !== this.state.currentPlayer && intent.type !== 'toggleWeather' && intent.type !== 'resetCamera') {
      return;
    }
    switch (intent.type) {
      case 'moveStart':
        if (intent.direction === 'left') this.moveLeftPressed = true;
        else if (intent.direction === 'right') this.moveRightPressed = true;
        else if (intent.direction === 'up') this.moveUpPressed = true;
        else this.moveDownPressed = true;
        break;
      case 'moveStop':
        if (intent.direction === 'left') this.moveLeftPressed = false;
        else if (intent.direction === 'right') this.moveRightPressed = false;
        else if (intent.direction === 'up') this.moveUpPressed = false;
        else this.moveDownPressed = false;
        break;
      case 'dragStart':
        if (!this.state.isAiming || this.state.isThrowing || this.state.gameOver) break;
        this.isDragging = true;
        this.state.isDragging = true;
        this.dragStart.set(intent.ndcX, intent.ndcY);
        this.dragCurrent.copy(this.dragStart);
        this.aimX = 0;
        this.pullDistance = 0.18;
        this.state.lastResult = '';
        this.state.lastPoints = 0;
        this.state.message = 'Pull for distance, release to lock speed.';
        this.emitState();
        break;
      case 'dragMove':
        if (!this.state.isAiming || !this.isDragging) break;
        this.dragCurrent.set(intent.ndcX, intent.ndcY);
        this.updateAimFromDrag();
        this.emitState();
        break;
      case 'dragEnd': {
        if (!this.isDragging) break;
        this.dragCurrent.set(intent.ndcX, intent.ndcY);
        this.updateAimFromDrag();
        // Pin aimPower to the value the guest actually saw at release. Host's
        // own oscillator runs on a different clock and would give throwBag a
        // different speedT, making the thrown bag's speed disagree with the
        // trajectory meter the guest was looking at when they let go.
        this.aimPower = intent.aimPower;
        const dragDistance = this.getCurrentDragDistance();
        this.isDragging = false;
        this.state.isDragging = false;
        this.clearDragGuide();
        const shouldThrow = dragDistance >= 0.08 && this.pullDistance > 0.2;
        this.emitState();
        if (shouldThrow) {
          this.throwBag();
        } else {
          this.state.message = 'Pull farther for more distance.';
          this.emitState();
        }
        break;
      }
      case 'dragCancel':
        if (!this.isDragging) break;
        this.isDragging = false;
        this.state.isDragging = false;
        this.clearDragGuide();
        this.state.message = 'Pull for distance, release to lock speed.';
        this.aimX = 0;
        this.pullDistance = 0.3;
        this.aimPower = 0.65;
        this.emitState();
        break;
      case 'flipBagSide':
        if (!this.state.isAiming || this.state.isThrowing || this.state.gameOver) break;
        this.selectedBagSide = this.selectedBagSide === 'sticky' ? 'slick' : 'sticky';
        this.playerBagSides[this.state.currentPlayer] = this.selectedBagSide;
        this.state.selectedBagSide = this.selectedBagSide;
        this.state.bagPreviewSide = this.selectedBagSide;
        this.emitState();
        break;
      case 'toggleThrowStyle':
        if (!this.state.isAiming || this.state.isThrowing || this.state.gameOver) break;
        this.throwStyle = this.throwStyle === 'slide' ? 'roll' : 'slide';
        this.playerThrowStyles[this.state.currentPlayer] = this.throwStyle;
        this.applyThrowStyleBagPreference();
        this.state.throwStyle = this.throwStyle;
        this.state.message = `Throw style: ${this.throwStyle === 'slide' ? 'Slide' : 'Roll'}`;
        this.emitState();
        break;
      case 'toggleWeather':
        this.weatherEnabled = !this.weatherEnabled;
        this.emitState();
        break;
      case 'resetCamera':
        this.cameraPosition.copy(this.turnStartCameraPosition);
        this.cameraLookTarget.copy(this.turnStartCameraLookTarget);
        this.camera.position.copy(this.cameraPosition);
        this.camera.lookAt(this.cameraLookTarget);
        this.emitState();
        break;
      case 'setInspect':
        this.inspectCameraHeld = intent.held;
        if (intent.held) this.beginHoleInspection();
        break;
      case 'startGame':
        break;
    }
  }

  // Full snapshot — used on state transitions (throw start, evaluate, inning end).
  // Includes every visible bag so the guest can resync fully.
  serializeSnapshot(): import('./net/types').Snapshot {
    return this.serializeSnapshotInternal(false);
  }

  // Flight-only snapshot — includes only the in-flight bag. Settled bags haven't
  // moved so re-sending them every 50ms wastes bandwidth.
  serializeFlightSnapshot(): import('./net/types').Snapshot {
    return this.serializeSnapshotInternal(true);
  }

  private serializeSnapshotInternal(flightOnly: boolean): import('./net/types').Snapshot {
    this.snapshotSeq++;
    const bags: import('./net/types').BagSnapshot[] = [];
    for (let i = 0; i < this.bags.length; i++) {
      const mesh = this.bags[i];
      const body = this.bagBodies[i];
      if (!mesh || !body) continue;
      if (!mesh.visible) continue;
      if (flightOnly && i !== this.activeThrownBagIndex) continue;
      bags.push({
        index: i,
        visible: true,
        inHole: this.bagInHole[i],
        side: this.bagSides[i],
        throwStyle: this.bagThrowStyles[i],
        x: body.position.x, y: body.position.y, z: body.position.z,
        qx: body.quaternion.x, qy: body.quaternion.y,
        qz: body.quaternion.z, qw: body.quaternion.w,
      });
    }
    return {
      state: { ...this.state },
      bags,
      playerX: this.playerX,
      aimX: this.aimX,
      pullDistance: this.pullDistance,
      cameraPos: [this.cameraPosition.x, this.cameraPosition.y, this.cameraPosition.z],
      cameraLook: [this.cameraLookTarget.x, this.cameraLookTarget.y, this.cameraLookTarget.z],
      timeOfDay: this.timeOfDay,
      seq: this.snapshotSeq,
      flightOnly,
    };
  }

  applySnapshot(snapshot: import('./net/types').Snapshot) {
    if (!this.guestMode) return;
    if (snapshot.seq <= this.snapshotSeq) return;
    this.snapshotSeq = snapshot.seq;

    // Client-prediction preservation: if the guest is mid-drag on their own
    // turn, DON'T let an incoming snapshot stomp the locally-predicted drag
    // fields. Without this, any host broadcast that lands during the ~100ms
    // intent-travel window overwrites dragStart / dragCurrent / aimX /
    // pullDistance / isDragging back to host's stale values, producing visible
    // jumps in the pull-back UI. The host becomes authoritative again the
    // instant the guest releases (dragEnd intent flips isDragging false,
    // throw-start snapshot arrives with real values and we accept it).
    // While on their own turn the guest's local aim oscillator is the source
    // of truth for aimPower; snapshots from the host carry a stale sin wave
    // from a *different* totalTime clock, which causes visible jerks in the
    // power bar if we let them overwrite.
    const guestOwnsAim = !this.guestMode || this.localPlayerSlot === this.state.currentPlayer;
    const guestIsPredicting = this.isDragging && this.localPlayerSlot === this.state.currentPlayer;
    const preservedAimPower = this.aimPower;
    const preservedAimX = this.aimX;
    const preservedPullDistance = this.pullDistance;
    const preservedDragStart = this.dragStart.clone();
    const preservedDragCurrent = this.dragCurrent.clone();
    const preservedThrowDistanceFeet = this.state.throwDistanceFeet;
    const preservedMessage = this.state.message;
    const suppressStaleRemoteDrag =
      this.localPlayerSlot === this.state.currentPlayer &&
      !this.isDragging &&
      performance.now() < this.suppressRemoteDragUntil &&
      snapshot.state.isAiming &&
      !snapshot.state.isThrowing &&
      snapshot.state.isDragging;

    this.state = { ...snapshot.state };
    this.playerX = snapshot.playerX;
    this.aimX = snapshot.aimX;
    this.pullDistance = snapshot.pullDistance;
    this.aimPower = snapshot.state.aimPower;
    this.selectedBagSide = snapshot.state.selectedBagSide;
    this.throwStyle = snapshot.state.throwStyle;
    this.weatherEnabled = snapshot.state.weatherEnabled;
    const timeOfDayChanged = this.timeOfDay !== snapshot.timeOfDay;
    this.timeOfDay = snapshot.timeOfDay;
    this.temperatureF = snapshot.state.temperatureF;
    this.windMph = snapshot.state.windMph;
    this.windDirection = snapshot.state.windDirection;
    this.humidityPct = snapshot.state.humidityPct;
    if (timeOfDayChanged) {
      this.applyTimeOfDayLighting();
    }
    this.dragStart.set(snapshot.state.dragStartX * 2 - 1, 1 - snapshot.state.dragStartY * 2);
    this.dragCurrent.set(snapshot.state.dragCurrentX * 2 - 1, 1 - snapshot.state.dragCurrentY * 2);
    this.isDragging = snapshot.state.isDragging;

    if (suppressStaleRemoteDrag) {
      this.isDragging = false;
      this.clearDragGuide();
    }

    if (guestOwnsAim) {
      // Guest's local aim oscillator is authoritative for the power bar when
      // it's their turn — host snapshots carry a stale sin value from a
      // different clock and would cause visible jerks if we overwrote.
      this.aimPower = preservedAimPower;
      this.state.aimPower = preservedAimPower;
    }

    if (guestIsPredicting) {
      // Restore locally-predicted drag state — our mousemove-driven values are
      // fresher than whatever stale frame the host just sent us.
      this.aimX = preservedAimX;
      this.pullDistance = preservedPullDistance;
      this.dragStart.copy(preservedDragStart);
      this.dragCurrent.copy(preservedDragCurrent);
      this.isDragging = true;
      this.state.isDragging = true;
      this.state.throwDistanceFeet = preservedThrowDistanceFeet;
      this.state.message = preservedMessage;
      this.state.dragStartX = (preservedDragStart.x + 1) * 0.5;
      this.state.dragStartY = (1 - preservedDragStart.y) * 0.5;
      this.state.dragCurrentX = (preservedDragCurrent.x + 1) * 0.5;
      this.state.dragCurrentY = (1 - preservedDragCurrent.y) * 0.5;
    }

    // Full snapshots replace the whole bag set (hide all, re-apply what's in
    // the snapshot). Flight snapshots only update the one bag in motion, so
    // settled bags stay where the last full snapshot placed them.
    if (!snapshot.flightOnly) {
      for (let i = 0; i < this.bags.length; i++) {
        if (this.bags[i]) this.bags[i].visible = false;
        this.bagInHole[i] = false;
      }
    }

    // Keep activeThrownBagIndex in sync so guest-side features that follow the
    // in-flight bag (e.g. cinematic camera) work. Flight-only snapshots only
    // carry the moving bag so it's always bags[0]; full snapshots while a
    // throw is in progress also include it, so pick the same bag out.
    if (snapshot.state.isThrowing || snapshot.state.isSettling) {
      if (snapshot.flightOnly && snapshot.bags.length > 0) {
        this.activeThrownBagIndex = snapshot.bags[0].index;
      } else if (!snapshot.flightOnly && snapshot.bags.length > 0) {
        // The most recently thrown bag is the highest-index bag for the
        // throwing player's range (0–3 for P1, 4–7 for P2).
        const throwing = snapshot.state.throwingPlayer;
        const range = throwing === 1 ? [0, 3] : throwing === 2 ? [4, 7] : null;
        if (range) {
          let latest = -1;
          for (const bag of snapshot.bags) {
            if (bag.index >= range[0] && bag.index <= range[1] && bag.index > latest) {
              latest = bag.index;
            }
          }
          if (latest >= 0) this.activeThrownBagIndex = latest;
        }
      }
    } else {
      this.activeThrownBagIndex = null;
    }

    this.ensureGuestBagSamples();

    const now = performance.now() / 1000;
    if (this.guestFirstSnapshotAt === 0) this.guestFirstSnapshotAt = now;

    // A bag index is "new" (just thrown, or just re-appeared after a reset)
    // when its sample buffer is empty. The full-snapshot branch above hides
    // every bag each frame, but we don't want that to force a sample reset —
    // only an actual "never seen before / freshly thrown" transition should.
    // So we detect freshness from an empty buffer instead of mesh.visible.
    for (const bag of snapshot.bags) {
      const mesh = this.bags[bag.index];
      const body = this.bagBodies[bag.index];
      if (!mesh || !body) continue;

      const samples = this.guestBagSamples[bag.index];
      // A genuinely new bag is one whose last sample was long enough ago that
      // we can treat it as a fresh throw (or one with no samples at all).
      // During an active throw, snapshots arrive every ~50–100ms, so any gap
      // >500ms means this bag was off-screen and is now reappearing.
      const lastSampleAge = samples.length > 0 ? now - samples[samples.length - 1].t : Infinity;
      const isFreshThrow = samples.length === 0 || lastSampleAge > 0.5;

      mesh.visible = bag.visible;
      this.bagInHole[bag.index] = bag.inHole;
      this.bagSides[bag.index] = bag.side;
      this.bagThrowStyles[bag.index] = bag.throwStyle;

      if (isFreshThrow) {
        // Brand new throw — plant mesh at launch position, clear any stale samples.
        samples.length = 0;
        mesh.position.set(bag.x, bag.y, bag.z);
        mesh.quaternion.set(bag.qx, bag.qy, bag.qz, bag.qw);
      }
      samples.push({
        t: now,
        pos: new THREE.Vector3(bag.x, bag.y, bag.z),
        quat: new THREE.Quaternion(bag.qx, bag.qy, bag.qz, bag.qw),
      });
      // Drop samples older than the render delay + a margin so we always keep
      // at least the two bracketing samples.
      const keepAfter = now - GUEST_RENDER_DELAY - 0.25;
      while (samples.length > 2 && samples[0].t < keepAfter) samples.shift();

      // Keep the body on the *newest* target so non-positional code (e.g.
      // capturing settled state for future snapshots) has a sane reference.
      body.position.set(bag.x, bag.y, bag.z);
      body.quaternion.set(bag.qx, bag.qy, bag.qz, bag.qw);
      body.velocity.setZero();
      body.angularVelocity.setZero();
      body.sleep();
    }
    this.emitState();
  }

  private ensureGuestBagSamples() {
    if (this.guestBagSamples.length === this.bags.length) return;
    this.guestBagSamples = this.bags.map(() => []);
  }

  // Called each render frame on the guest. For each visible bag, picks the
  // two samples that bracket renderTime = now - GUEST_RENDER_DELAY and
  // interpolates between them. Because we render "in the past" by a fixed
  // amount, there's almost always a future sample to head toward — so the
  // bag never arrives-and-waits the way straight-to-latest lerping does.
  private stepGuestInterpolation(_dt: number) {
    if (!this.guestMode || this.guestBagSamples.length === 0) return;
    const now = performance.now() / 1000;
    // Ramp up render delay gradually on the first snapshot so we don't
    // visually freeze for 80ms waiting for the buffer to fill.
    const sinceFirst = now - this.guestFirstSnapshotAt;
    const delay = Math.min(GUEST_RENDER_DELAY, sinceFirst);
    const renderT = now - delay;
    for (let i = 0; i < this.bags.length; i++) {
      const mesh = this.bags[i];
      const body = this.bagBodies[i];
      const samples = this.guestBagSamples[i];
      if (!mesh || !body || !mesh.visible || !samples || samples.length === 0) continue;

      // Find the two samples that bracket renderT. If renderT is before all
      // samples, clamp to the oldest; if after all, extrapolate slightly from
      // the last two so motion continues instead of freezing.
      let a = samples[0];
      let b = samples[0];
      let bracketed = false;
      for (let j = 0; j < samples.length - 1; j++) {
        if (samples[j].t <= renderT && samples[j + 1].t >= renderT) {
          a = samples[j];
          b = samples[j + 1];
          bracketed = true;
          break;
        }
      }
      if (!bracketed) {
        if (renderT < samples[0].t) {
          // Haven't reached oldest sample yet — just hold at it.
          a = samples[0];
          b = samples[0];
        } else {
          // renderT is ahead of newest — extrapolate from last two so the bag
          // doesn't freeze if the next snapshot is a little late.
          a = samples.length >= 2 ? samples[samples.length - 2] : samples[samples.length - 1];
          b = samples[samples.length - 1];
        }
      }

      let progress: number;
      if (b.t === a.t) {
        progress = 0;
      } else {
        progress = (renderT - a.t) / (b.t - a.t);
        // Cap extrapolation so a long gap doesn't send the bag flying past.
        progress = Math.max(0, Math.min(1.25, progress));
      }

      mesh.position.lerpVectors(a.pos, b.pos, progress);
      mesh.quaternion.copy(a.quat).slerp(b.quat, Math.min(1, progress));
      body.position.set(mesh.position.x, mesh.position.y, mesh.position.z);
      body.quaternion.set(mesh.quaternion.x, mesh.quaternion.y, mesh.quaternion.z, mesh.quaternion.w);
    }
  }
}
