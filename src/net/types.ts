import type { BagSide, ThrowStyle } from '../CornholeGame';

export type PlayerSlot = 1 | 2;
export type Role = 'host' | 'guest';

export type Intent =
  | { type: 'startGame' }
  | { type: 'moveStart'; direction: 'left' | 'right' | 'up' | 'down' }
  | { type: 'moveStop'; direction: 'left' | 'right' | 'up' | 'down' }
  | { type: 'dragStart'; ndcX: number; ndcY: number }
  | { type: 'dragMove'; ndcX: number; ndcY: number }
  | { type: 'dragEnd'; ndcX: number; ndcY: number }
  | { type: 'dragCancel' }
  | { type: 'flipBagSide' }
  | { type: 'toggleThrowStyle' }
  | { type: 'toggleWeather' }
  | { type: 'resetCamera' }
  | { type: 'setInspect'; held: boolean };

export interface BagSnapshot {
  index: number;
  visible: boolean;
  inHole: boolean;
  side: BagSide;
  throwStyle: ThrowStyle;
  x: number; y: number; z: number;
  qx: number; qy: number; qz: number; qw: number;
}

export interface Snapshot {
  state: import('../CornholeGame').GameState;
  bags: BagSnapshot[];
  playerX: number;
  aimX: number;
  pullDistance: number;
  cameraPos: [number, number, number];
  cameraLook: [number, number, number];
  timeOfDay: number;
  seq: number;
}

export type Envelope =
  | { kind: 'hello'; from: Role; playerSlot: PlayerSlot; roomId: string; clientId: string }
  | { kind: 'heartbeat'; from: Role; ts: number; clientId: string }
  | { kind: 'intent'; from: Role; intent: Intent; ts: number; clientId: string }
  | { kind: 'snapshot'; from: 'host'; snapshot: Snapshot; clientId: string }
  | { kind: 'bye'; from: Role; clientId: string }
  | { kind: 'roomFull'; from: 'host'; toClientId: string };

export interface Transport {
  send(envelope: Envelope): void;
  onMessage(handler: (envelope: Envelope) => void): () => void;
  onStatusChange(handler: (status: ConnectionStatus) => void): () => void;
  registerUnloadBye(onUnload: () => Envelope): void;
  close(): void;
  status: ConnectionStatus;
}

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'error';
