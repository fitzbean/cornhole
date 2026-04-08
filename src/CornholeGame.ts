import * as THREE from 'three';
import * as CANNON from 'cannon-es';

// ====== CONSTANTS ======
const BOARD_W = 2.0;
const BOARD_L = 4.0;
const BOARD_THICKNESS = 0.12;
const HOLE_RADIUS = 0.3;
const HOLE_Z = -1.2; // hole position along board (local Z)
const LEG_HEIGHT = 1.0;
const SIDE_H = 0.18;
const SIDE_T = 0.08;
const BAG_SIZE = 0.168;
const BAG_MASS = 0.45;
const PITCH_LENGTH = 27; // feet in real game, we use scaled units
const GRAVITY = -9.81;

export type BagSide = 'sticky' | 'slick';

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
  selectedBagSide: BagSide;
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
  stickyBagMaterial!: CANNON.Material;
  slickBagMaterial!: CANNON.Material;

  // Game objects
  boardGroup!: THREE.Group;
  boardBody!: CANNON.Body;
  groundBody!: CANNON.Body;
  bags: THREE.Mesh[] = [];
  bagBodies: CANNON.Body[] = [];
  bagSides: BagSide[] = Array(8).fill('sticky');
  bagInHole: boolean[] = Array(8).fill(false);
  pullLine!: THREE.Line;
  trailPoints: THREE.Vector3[] = [];
  trailLine!: THREE.Line;

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
  };

  // Aiming
  aimX = 0;
  aimPower = 0.65;
  pullDistance = 0.3;
  playerX = 0;
  moveLeftPressed = false;
  moveRightPressed = false;
  selectedBagSide: BagSide = 'sticky';
  playerBagSides: Record<1 | 2, BagSide> = { 1: 'sticky', 2: 'sticky' };
  playerBagsThrown: Record<1 | 2, number> = { 1: 0, 2: 0 };
  currentTurnBagReady = false;
  dragStart = new THREE.Vector2();
  dragCurrent = new THREE.Vector2();
  isDragging = false;
  totalTime = 0;

  // Callbacks
  onStateChange: (state: GameState) => void;
  onScoreUpdate: (points: number, result: string) => void;

  // Particles
  particleSystems: { points: THREE.Points; velocities: THREE.Vector3[]; life: number }[] = [];
  stickyFaceNormal = new CANNON.Vec3(0, 1, 0);

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
    onScoreUpdate: (points: number, result: string) => void
  ) {
    this.onStateChange = onStateChange;
    this.onScoreUpdate = onScoreUpdate;

    // Three.js
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x6BA3D6);
    this.scene.fog = new THREE.FogExp2(0x6BA3D6, 0.008);

    this.camera = new THREE.PerspectiveCamera(55, canvas.clientWidth / canvas.clientHeight, 0.1, 200);
    this.camera.position.set(0, 1.65, 12);
    this.camera.lookAt(0, 0.8, -8);

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

    this.world.addContactMaterial(new CANNON.ContactMaterial(this.stickyBagMaterial, groundMat, {
      friction: 1.25,
      restitution: 0.005,
    }));
    this.world.addContactMaterial(new CANNON.ContactMaterial(this.stickyBagMaterial, boardMat, {
      friction: 1.1,
      restitution: 0.008,
    }));
    this.world.addContactMaterial(new CANNON.ContactMaterial(this.slickBagMaterial, groundMat, {
      friction: 0.08,
      restitution: 0.004,
    }));
    this.world.addContactMaterial(new CANNON.ContactMaterial(this.slickBagMaterial, boardMat, {
      friction: 0.03,
      restitution: 0.006,
    }));
    this.world.addContactMaterial(new CANNON.ContactMaterial(this.stickyBagMaterial, this.stickyBagMaterial, {
      friction: 0.8,
      restitution: 0.01,
    }));
    this.world.addContactMaterial(new CANNON.ContactMaterial(this.slickBagMaterial, this.slickBagMaterial, {
      friction: 0.45,
      restitution: 0.012,
    }));
    this.world.addContactMaterial(new CANNON.ContactMaterial(this.stickyBagMaterial, this.slickBagMaterial, {
      friction: 0.58,
      restitution: 0.01,
    }));

    this.createLights();
    this.createGround(groundMat);
    this.createBoard(boardMat);
    this.createBags(this.stickyBagMaterial);
    this.createEnvironment();
    this.createPullLine();
    this.createBagPreview();
    this.startTurn(1);

    window.addEventListener('resize', this.handleResize);
    this.installTestingHooks();

    this.animate();
  }

  // ====== SCENE CREATION ======

  createLights() {
    const ambient = new THREE.AmbientLight(0x405070, 0.6);
    this.scene.add(ambient);

    const hemi = new THREE.HemisphereLight(0x87CEEB, 0x3a6b2a, 0.7);
    this.scene.add(hemi);

    const sun = new THREE.DirectionalLight(0xFFE8C0, 1.8);
    sun.position.set(8, 25, 12);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 80;
    sun.shadow.camera.left = -15;
    sun.shadow.camera.right = 15;
    sun.shadow.camera.top = 15;
    sun.shadow.camera.bottom = -15;
    sun.shadow.bias = -0.0005;
    sun.shadow.normalBias = 0.02;
    this.scene.add(sun);

    const fill = new THREE.DirectionalLight(0xC0D8FF, 0.3);
    fill.position.set(-8, 10, -5);
    this.scene.add(fill);
  }

  createGround(material: CANNON.Material) {
    // Grass
    const grassGeo = new THREE.PlaneGeometry(80, 100);
    const grassTex = this.createGrassTexture();
    const grassMat = new THREE.MeshStandardMaterial({
      map: grassTex,
      roughness: 0.95,
      metalness: 0.0,
    });
    const grass = new THREE.Mesh(grassGeo, grassMat);
    grass.rotation.x = -Math.PI / 2;
    grass.position.set(0, 0, 10);
    grass.receiveShadow = true;
    this.scene.add(grass);

    // Pitch (dirt path)
    const pitchGeo = new THREE.PlaneGeometry(5, PITCH_LENGTH + 5);
    const pitchTex = this.createDirtTexture();
    const pitchMat = new THREE.MeshStandardMaterial({
      map: pitchTex,
      roughness: 1.0,
      metalness: 0.0,
    });
    const pitch = new THREE.Mesh(pitchGeo, pitchMat);
    pitch.rotation.x = -Math.PI / 2;
    pitch.position.set(0, 0.003, 2);
    pitch.receiveShadow = true;
    this.scene.add(pitch);

    // Foul line
    const lineGeo = new THREE.PlaneGeometry(0.08, PITCH_LENGTH);
    const lineMat = new THREE.MeshBasicMaterial({ color: 0xFFFFFF, transparent: true, opacity: 0.4 });
    const line = new THREE.Mesh(lineGeo, lineMat);
    line.rotation.x = -Math.PI / 2;
    line.position.set(0, 0.006, 2);
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
    const boardVisMat = new THREE.MeshStandardMaterial({
      map: woodTex,
      roughness: 0.65,
      metalness: 0.05,
    });

    // Main board surface
    const boardGeo = new THREE.BoxGeometry(BOARD_W, BOARD_THICKNESS, BOARD_L);
    const boardMesh = new THREE.Mesh(boardGeo, boardVisMat);
    boardMesh.castShadow = true;
    boardMesh.receiveShadow = true;
    this.boardGroup.add(boardMesh);

    // Side rails
    const railMat = new THREE.MeshStandardMaterial({ color: 0x6B3A1F, roughness: 0.8 });

    // Left rail
    const leftRail = new THREE.Mesh(
      new THREE.BoxGeometry(SIDE_T, SIDE_H, BOARD_L),
      railMat
    );
    leftRail.position.set(-BOARD_W / 2 - SIDE_T / 2, SIDE_H / 2 - BOARD_THICKNESS / 2, 0);
    leftRail.castShadow = true;
    this.boardGroup.add(leftRail);

    // Right rail
    const rightRail = leftRail.clone();
    rightRail.position.x = BOARD_W / 2 + SIDE_T / 2;
    this.boardGroup.add(rightRail);

    // Back rail (far end)
    const backRail = new THREE.Mesh(
      new THREE.BoxGeometry(BOARD_W + SIDE_T * 2, SIDE_H, SIDE_T),
      railMat
    );
    backRail.position.set(0, SIDE_H / 2 - BOARD_THICKNESS / 2, -BOARD_L / 2 - SIDE_T / 2);
    backRail.castShadow = true;
    this.boardGroup.add(backRail);

    // Front rail (near player)
    const frontRail = backRail.clone();
    frontRail.position.z = BOARD_L / 2 + SIDE_T / 2;
    this.boardGroup.add(frontRail);

    // Hole (dark circle)
    const holeGeo = new THREE.CircleGeometry(HOLE_RADIUS, 32);
    const holeMat = new THREE.MeshStandardMaterial({ color: 0x0A0A0A, roughness: 0.95 });
    const hole = new THREE.Mesh(holeGeo, holeMat);
    hole.rotation.x = -Math.PI / 2;
    hole.position.set(0, BOARD_THICKNESS / 2 + 0.002, HOLE_Z);
    this.boardGroup.add(hole);

    // Hole rim ring
    const rimGeo = new THREE.RingGeometry(HOLE_RADIUS - 0.015, HOLE_RADIUS + 0.015, 32);
    const rimMat = new THREE.MeshStandardMaterial({ color: 0x888888, roughness: 0.4, metalness: 0.3 });
    const rim = new THREE.Mesh(rimGeo, rimMat);
    rim.rotation.x = -Math.PI / 2;
    rim.position.set(0, BOARD_THICKNESS / 2 + 0.003, HOLE_Z);
    this.boardGroup.add(rim);

    // Legs
    const legGeo = new THREE.CylinderGeometry(0.04, 0.04, LEG_HEIGHT, 8);
    const legMat = new THREE.MeshStandardMaterial({ color: 0x555555, roughness: 0.5, metalness: 0.4 });

    const legPositions = [
      [-BOARD_W / 2 + 0.2, 0, BOARD_L / 2 - 0.2],
      [BOARD_W / 2 - 0.2, 0, BOARD_L / 2 - 0.2],
      [-BOARD_W / 2 + 0.2, 0, -BOARD_L / 2 + 0.2],
      [BOARD_W / 2 - 0.2, 0, -BOARD_L / 2 + 0.2],
    ];

    for (const lp of legPositions) {
      const leg = new THREE.Mesh(legGeo, legMat);
      leg.position.set(lp[0], -LEG_HEIGHT / 2 - BOARD_THICKNESS / 2, lp[2]);
      leg.castShadow = true;
      this.boardGroup.add(leg);
    }

    // Position board at far end, tilted
    this.boardGroup.position.set(0, BOARD_THICKNESS / 2 + LEG_HEIGHT * 0.35, -10);
    this.boardGroup.rotation.x = 0.18; // ~10 degree tilt
    this.scene.add(this.boardGroup);

    // Physics body
    this.boardBody = new CANNON.Body({ mass: 0, material });

    // Main surface
    this.boardBody.addShape(
      new CANNON.Box(new CANNON.Vec3(BOARD_W / 2, BOARD_THICKNESS / 2, BOARD_L / 2))
    );

    // Rails
    const railShape = new CANNON.Box(new CANNON.Vec3(SIDE_T / 2, SIDE_H / 2, BOARD_L / 2));
    this.boardBody.addShape(railShape, new CANNON.Vec3(-BOARD_W / 2 - SIDE_T / 2, SIDE_H / 2 - BOARD_THICKNESS / 2, 0));
    this.boardBody.addShape(railShape, new CANNON.Vec3(BOARD_W / 2 + SIDE_T / 2, SIDE_H / 2 - BOARD_THICKNESS / 2, 0));

    const backShape = new CANNON.Box(new CANNON.Vec3((BOARD_W + SIDE_T * 2) / 2, SIDE_H / 2, SIDE_T / 2));
    this.boardBody.addShape(backShape, new CANNON.Vec3(0, SIDE_H / 2 - BOARD_THICKNESS / 2, -BOARD_L / 2 - SIDE_T / 2));
    this.boardBody.addShape(backShape, new CANNON.Vec3(0, SIDE_H / 2 - BOARD_THICKNESS / 2, BOARD_L / 2 + SIDE_T / 2));

    const bp = this.boardGroup.position;
    this.boardBody.position.set(bp.x, bp.y, bp.z);
    this.boardBody.quaternion.setFromEuler(this.boardGroup.rotation.x, 0, 0);
    this.world.addBody(this.boardBody);
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
      this.scene.add(mesh);
      this.bags.push(mesh);

      // Physics
      const body = new CANNON.Body({
        mass: BAG_MASS,
        material,
        shape: new CANNON.Box(new CANNON.Vec3(BAG_SIZE, BAG_SIZE * 0.35, BAG_SIZE)),
        linearDamping: 0.4,
        angularDamping: 0.6,
      });
      body.position.set(0, -20, 0);
      this.world.addBody(body);
      this.bagBodies.push(body);
    }
  }

  createBagMeshMaterials(teamColor: number): THREE.MeshStandardMaterial[] {
    const edgeTex = this.createFabricTexture(teamColor);
    const stickyTex = this.createBagFaceTexture(
      this.shadeColor(teamColor, 0.18),
      this.tintColor(teamColor, 0.35),
      false
    );
    const slickTex = this.createBagFaceTexture(0x24455b, 0x79a8c7, true);

    return [
      new THREE.MeshStandardMaterial({ map: edgeTex, roughness: 0.88, metalness: 0.0 }),
      new THREE.MeshStandardMaterial({ map: edgeTex, roughness: 0.88, metalness: 0.0 }),
      new THREE.MeshStandardMaterial({ map: stickyTex, roughness: 0.96, metalness: 0.0 }),
      new THREE.MeshStandardMaterial({ map: slickTex, roughness: 0.22, metalness: 0.16 }),
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
    const geo = new THREE.BoxGeometry(BAG_SIZE * 2, BAG_SIZE * 0.7, BAG_SIZE * 2, 6, 3, 6);
    const pos = geo.attributes.position;

    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const y = pos.getY(i);
      const z = pos.getZ(i);
      const dist = Math.sqrt(x * x + z * z);
      const maxDist = BAG_SIZE * 1.6;
      // Bulge in middle, flatten at edges
      const bulge = Math.max(0, 1 - (dist / maxDist) * (dist / maxDist)) * 0.06;
      pos.setY(i, y + bulge * (y > 0 ? 1 : -0.3));
      // Slight rounding at corners
      const cornerFactor = Math.min(1, Math.abs(x) / (BAG_SIZE * 1.5)) * Math.min(1, Math.abs(z) / (BAG_SIZE * 1.5));
      pos.setY(i, pos.getY(i) - cornerFactor * 0.03);
    }

    geo.computeVertexNormals();
    return geo;
  }

  createEnvironment() {
    // Sky dome
    const skyGeo = new THREE.SphereGeometry(90, 32, 16);
    const skyCanvas = document.createElement('canvas');
    skyCanvas.width = 512;
    skyCanvas.height = 512;
    const skyCtx = skyCanvas.getContext('2d')!;
    const grad = skyCtx.createLinearGradient(0, 0, 0, 512);
    grad.addColorStop(0, '#1a5faa');
    grad.addColorStop(0.3, '#4a9ae0');
    grad.addColorStop(0.6, '#87CEEB');
    grad.addColorStop(1, '#c8e6f5');
    skyCtx.fillStyle = grad;
    skyCtx.fillRect(0, 0, 512, 512);
    const skyTex = new THREE.CanvasTexture(skyCanvas);
    skyTex.wrapS = skyTex.wrapT = THREE.RepeatWrapping;
    const skyMat = new THREE.MeshBasicMaterial({ map: skyTex, side: THREE.BackSide });
    this.scene.add(new THREE.Mesh(skyGeo, skyMat));

    // Clouds
    for (let i = 0; i < 8; i++) {
      const cloud = this.createCloud();
      cloud.position.set(
        (Math.random() - 0.5) * 60,
        20 + Math.random() * 15,
        -30 + Math.random() * 40
      );
      cloud.scale.setScalar(0.5 + Math.random() * 1.5);
      this.scene.add(cloud);
    }

    // Trees
    const treePositions = [
      [-12, 0, -18], [14, 0, -22], [-18, 0, -8], [16, 0, -12],
      [-10, 0, -28], [20, 0, -26], [-22, 0, -18], [24, 0, -20],
      [-8, 0, -35], [12, 0, -32],
    ];
    for (const tp of treePositions) {
      const tree = this.createTree();
      tree.position.set(tp[0], tp[1], tp[2]);
      this.scene.add(tree);
    }

    // Fence
    this.createFence();
  }

  createCloud(): THREE.Group {
    const group = new THREE.Group();
    const cloudMat = new THREE.MeshStandardMaterial({
      color: 0xFFFFFF,
      roughness: 1,
      transparent: true,
      opacity: 0.8,
    });
    const puffGeo = new THREE.SphereGeometry(1, 8, 6);
    for (let i = 0; i < 5; i++) {
      const puff = new THREE.Mesh(puffGeo, cloudMat);
      puff.position.set(i * 1.2 - 2.4, Math.random() * 0.5, Math.random() * 0.8);
      puff.scale.set(0.8 + Math.random() * 0.5, 0.5 + Math.random() * 0.3, 0.6 + Math.random() * 0.4);
      group.add(puff);
    }
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
    ctx.fillStyle = '#5a8a4a';
    ctx.fillRect(0, 0, 256, 256);
    for (let i = 0; i < 5000; i++) {
      const x = Math.random() * 256;
      const y = Math.random() * 256;
      const s = Math.random() * 20 - 10;
      ctx.fillStyle = `rgb(${90 + s},${138 + s},${74 + s})`;
      ctx.fillRect(x, y, 2, 2);
    }
    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(2, 12);
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
    this.syncBagsLeftState();

    if (this.state.bagsRemaining <= 0) {
      this.currentTurnBagReady = false;
      return;
    }

    this.selectedBagSide = this.playerBagSides[player];
    this.state.selectedBagSide = this.selectedBagSide;
    this.currentTurnBagReady = true;
    this.state.message = `${player === 1 ? 'Player 1' : 'Player 2'}'s turn. Pull for distance, release to lock speed.`;
  }

  throwBag() {
    if (this.state.isThrowing || this.state.isSettling || this.state.gameOver) return;
    if (!this.currentTurnBagReady) return;

    const throwingPlayer = this.state.currentPlayer;
    const idx = this.getBagIndexForCurrentPlayer();
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

    const body = this.bagBodies[idx];
    const mesh = this.bags[idx];

    const startX = this.playerX + this.aimX * 0.25;
    const startY = 1.5;
    const startZ = 12;
    const speedT = THREE.MathUtils.clamp((this.aimPower - 0.35) / 0.65, 0, 1);
    body.position.set(startX, startY, startZ);
    body.velocity.set(0, 0, 0);
    body.angularVelocity.set(0, 0, 0);
    const sideFlip = this.selectedBagSide === 'sticky' ? Math.PI : 0;
    const releasePitch = THREE.MathUtils.lerp(0.32, 0.12, speedT);
    const releaseRoll = -this.aimX * 0.08;
    body.quaternion.setFromEuler(sideFlip + releasePitch, 0, releaseRoll);
    body.material = this.selectedBagSide === 'sticky' ? this.stickyBagMaterial : this.slickBagMaterial;
    body.linearDamping = 0.4;
    body.angularDamping = 0.6;

    mesh.visible = true;
    mesh.position.set(startX, startY, startZ);

    const boardPos = this.boardGroup.position;
    const targetZ = THREE.MathUtils.lerp(startZ - 4, boardPos.z - 1.2, this.pullDistance);
    const targetX = boardPos.x + this.playerX * 0.35 + this.aimX * THREE.MathUtils.lerp(1.1, 2.2, this.pullDistance);

    const dx = targetX - startX;
    const dz = targetZ - startZ;

    const baseFlightTime = THREE.MathUtils.lerp(0.58, 1.02, this.pullDistance);
    const flightTime = baseFlightTime * THREE.MathUtils.lerp(1.06, 0.72, speedT);
    const arcVy = THREE.MathUtils.lerp(5.6, 9.4, this.pullDistance);
    const vy = THREE.MathUtils.lerp(arcVy * 1.02, arcVy * 0.38, speedT);
    const vx = dx / flightTime + this.aimX * 0.35 + (Math.random() - 0.5) * 0.18;
    const vz = dz / flightTime;

    body.velocity.set(vx, vy, vz);
    body.angularVelocity.set(
      THREE.MathUtils.lerp(-0.8, 0.8, Math.random()),
      THREE.MathUtils.lerp(14, 32, speedT),
      -this.aimX * 1.2 + THREE.MathUtils.lerp(-0.5, 0.5, Math.random())
    );

    this.settlingTimer = 0;
    this.bagSettled = false;

    setTimeout(() => this.evaluateThrow(idx, throwingPlayer), 3500);
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

    let points = 0;
    let result = '';

    if (holeDist < HOLE_RADIUS - 0.05 && bagPos.y < boardWorldPos.y + 0.2) {
      points = 3;
      result = '🎯 IN THE HOLE!';
      this.spawnParticles(holeWorldPos, 0xFFD700, 40);
    } else if (onBoardX && onBoardZ && onBoardY) {
      points = 1;
      result = '✅ On the board!';
      this.spawnParticles(bagPos, 0x44FF44, 20);
    } else {
      result = '❌ Miss!';
      this.spawnParticles(bagPos, 0xFF4444, 10);
    }

    this.state.lastPoints = points;
    this.state.lastResult = result;
    // Use captured throwingPlayer — never stale
    this.addScore(throwingPlayer, points);
    this.state.bagsThisInning++;
    this.state.isThrowing = false;
    this.state.throwingPlayer = null;
    this.currentTurnBagReady = false;

    this.syncBagsLeftState();
    this.onScoreUpdate(points, result);

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
    // Calculate inning scores
    // For simplicity, we track total scores directly
    // In real cornhole, cancellation scoring is used

    this.state.inning++;
    this.state.bagsThisInning = 0;
    this.currentTurnBagReady = false;

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
      this.state.resultMessage = `Inning ${this.state.inning - 1} complete!`;
      this.state.message = 'New inning starting...';
    }

    this.emitState();

    setTimeout(() => {
      this.resetBags();
    }, 3000);
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
    this.currentTurnBagReady = false;
    this.aimX = 0;
    this.pullDistance = 0.3;
    this.aimPower = 0.65;

    for (let i = 0; i < 8; i++) {
      this.bags[i].visible = false;
      this.bagBodies[i].position.set(0, -20, 0);
      this.bagBodies[i].velocity.set(0, 0, 0);
      this.bagBodies[i].angularVelocity.set(0, 0, 0);
    }
    this.bagInHole.fill(false);
    this.startTurn(1);
    this.emitState();
  }

  addScore(player: 1 | 2, points: number) {
    if (player === 1) {
      this.state.player1Score += points;
      this.state.player1RoundScore += points;
    } else {
      this.state.player2Score += points;
      this.state.player2RoundScore += points;
    }
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

  updateBagSurfacePhysics(body: CANNON.Body) {
    const boardTopY = this.boardGroup.position.y + 0.9;
    const isNearLanding = body.position.y < boardTopY && Math.abs(body.velocity.y) < 5;

    if (!isNearLanding) {
      body.material = this.slickBagMaterial;
      body.linearDamping = 0.4;
      body.angularDamping = 0.6;
      return;
    }

    const stickyWorldNormal = body.quaternion.vmult(this.stickyFaceNormal);
    const stickyFaceDown = stickyWorldNormal.y < 0;

    body.material = stickyFaceDown ? this.stickyBagMaterial : this.slickBagMaterial;
    body.linearDamping = stickyFaceDown ? 0.82 : 0.03;
    body.angularDamping = stickyFaceDown ? 0.88 : 0.08;
  }

  captureBagInHole(index: number) {
    if (this.bagInHole[index]) return;

    const body = this.bagBodies[index];
    const boardWorldPos = new THREE.Vector3();
    this.boardGroup.getWorldPosition(boardWorldPos);
    const holeWorldPos = new THREE.Vector3(
      boardWorldPos.x,
      boardWorldPos.y + 0.08,
      boardWorldPos.z + HOLE_Z * Math.cos(this.boardGroup.rotation.x)
    );

    const holeDist = Math.hypot(body.position.x - holeWorldPos.x, body.position.z - holeWorldPos.z);
    const nearBoardTop = body.position.y < boardWorldPos.y + 0.55;
    const movingSlowEnough = Math.abs(body.velocity.y) < 3.5;

    if (!nearBoardTop || !movingSlowEnough || holeDist > HOLE_RADIUS * 0.78) return;

    this.bagInHole[index] = true;
    body.position.set(holeWorldPos.x, boardWorldPos.y - 0.55, holeWorldPos.z);
    body.velocity.set(0, -0.5, 0);
    body.angularVelocity.set(0, 0, 0);
    body.linearDamping = 0.95;
    body.angularDamping = 0.95;
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
  }

  handleMouseMove = (event: MouseEvent) => {
    if (!this.state.isAiming || !this.isDragging) return;
    this.dragCurrent.copy(this.getPointerNdc(event));
    this.updateAimFromDrag();
    this.emitState();
  };

  handleMouseDown = (event: MouseEvent) => {
    if (!this.state.isAiming || this.state.isThrowing || this.state.gameOver) return;
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
    if (!this.isDragging) return;
    this.dragCurrent.copy(this.getPointerNdc(event));
    this.updateAimFromDrag();
    this.isDragging = false;
    this.state.isDragging = false;
    this.dragStart.copy(this.dragCurrent);

    const shouldThrow = this.pullDistance > 0.2;
    this.emitState();

    if (shouldThrow) {
      this.throwBag();
    } else {
      this.state.message = 'Pull farther for more distance.';
      this.emitState();
    }
  };

  handleMouseLeave = () => {
    if (!this.isDragging) return;
    this.isDragging = false;
    this.state.isDragging = false;
    this.dragCurrent.copy(this.dragStart);
    this.state.message = 'Pull for distance, release to lock speed.';
    this.aimX = 0;
    this.pullDistance = 0.3;
    this.aimPower = 0.65;
    this.emitState();
  };

  handleKeyDown = (event: KeyboardEvent) => {
    if (event.code === 'ArrowLeft') {
      this.moveLeftPressed = true;
      event.preventDefault();
    } else if (event.code === 'ArrowRight') {
      this.moveRightPressed = true;
      event.preventDefault();
    } else if (event.code === 'KeyF' && this.state.isAiming && !this.state.isThrowing && !this.state.gameOver) {
      this.selectedBagSide = this.selectedBagSide === 'sticky' ? 'slick' : 'sticky';
      this.playerBagSides[this.state.currentPlayer] = this.selectedBagSide;
      this.state.selectedBagSide = this.selectedBagSide;
      this.emitState();
      event.preventDefault();
    }
  };

  handleKeyUp = (event: KeyboardEvent) => {
    if (event.code === 'ArrowLeft') {
      this.moveLeftPressed = false;
      event.preventDefault();
    } else if (event.code === 'ArrowRight') {
      this.moveRightPressed = false;
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
    // Do NOT overwrite player1BagsLeft / player2BagsLeft here —
    // they are managed explicitly by throwBag, startTurn, evaluateThrow, resetBags.
    this.state.aimPower = this.aimPower;
    this.state.selectedBagSide = this.selectedBagSide;
    this.state.dragStartX = (this.dragStart.x + 1) * 0.5;
    this.state.dragStartY = (1 - this.dragStart.y) * 0.5;
    this.state.dragCurrentX = (this.dragCurrent.x + 1) * 0.5;
    this.state.dragCurrentY = (1 - this.dragCurrent.y) * 0.5;
    this.onStateChange({ ...this.state });
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
    throwState: {
      isAiming: this.state.isAiming,
      isThrowing: this.state.isThrowing,
      isDragging: this.state.isDragging,
      aimX: Number(this.aimX.toFixed(2)),
      pullDistance: Number(this.pullDistance.toFixed(2)),
      aimPower: Number(this.aimPower.toFixed(2)),
      selectedBagSide: this.selectedBagSide,
      bagsRemaining: this.state.bagsRemaining,
      player1BagsLeft: this.state.player1BagsLeft,
      player2BagsLeft: this.state.player2BagsLeft,
      message: this.state.message,
      playerX: Number(this.playerX.toFixed(2)),
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
    requestAnimationFrame(this.animate);
    const dt = Math.min(this.clock.getDelta(), 0.05);
    this.step(dt);
    this.render();
  };

  step(dt: number) {
    this.totalTime += dt;
    const moveInput = (this.moveRightPressed ? 1 : 0) - (this.moveLeftPressed ? 1 : 0);
    if (moveInput !== 0) {
      this.playerX = THREE.MathUtils.clamp(this.playerX + moveInput * dt * 2.8, -2.4, 2.4);
    }
    if (this.state.isAiming && !this.state.gameOver) {
      const cycle = (Math.sin(this.totalTime * 3.8) + 1) * 0.5;
      this.aimPower = cycle;
      this.emitState();
    }
    this.updatePreviewBagMaterials();
    this.world.step(1 / 60, dt, 3);

    // Sync bag visuals
    for (let i = 0; i < this.bags.length; i++) {
      if (this.bags[i].visible) {
        this.captureBagInHole(i);
        this.updateBagSurfacePhysics(this.bagBodies[i]);
        this.bags[i].position.copy(this.bagBodies[i].position as any);
        this.bags[i].quaternion.copy(this.bagBodies[i].quaternion as any);
      }
    }

    if (this.state.isAiming) {
      this.updatePullLine();
    } else {
      this.pullLine.visible = false;
    }

    // Camera - subtle sway for realism
    const swayX = Math.sin(this.totalTime * 0.4) * 0.03;
    const swayY = Math.sin(this.totalTime * 0.6) * 0.015;
    this.camera.position.x = this.playerX + swayX + this.aimX * 0.08;
    this.camera.position.y = 1.65 + swayY;

    const lookTarget = new THREE.Vector3(
      this.playerX + this.aimX * 0.3,
      0.6,
      this.boardGroup.position.z + 1
    );
    this.camera.lookAt(lookTarget);

    // Update particles
    this.updateParticles(dt);

    const previewPitch = this.selectedBagSide === 'sticky' ? -0.48 : Math.PI - 0.48;
    this.previewBag.rotation.set(previewPitch, this.totalTime * 0.7, -0.02);
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
    window.removeEventListener('resize', this.handleResize);
    window.removeEventListener('keydown', this.handleKeyDown);
    window.removeEventListener('keyup', this.handleKeyUp);
    const canvas = this.renderer.domElement;
    canvas.removeEventListener('mousemove', this.handleMouseMove);
    canvas.removeEventListener('mousedown', this.handleMouseDown);
    canvas.removeEventListener('mouseup', this.handleMouseUp);
    canvas.removeEventListener('mouseleave', this.handleMouseLeave);
    delete window.render_game_to_text;
    delete window.advanceTime;
    if (this.previewBag) {
      this.previewBag.geometry.dispose();
      this.disposeBagMaterials(this.previewBag.material as THREE.Material | THREE.Material[]);
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
  }
}
