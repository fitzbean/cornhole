import { useEffect, useRef, useState } from 'react';
import { createTransport } from './transport';
import type { ConnectionStatus, Envelope, PlayerSlot, Role, Snapshot, Transport } from './types';
import type { CornholeGame } from '../CornholeGame';
import type { Intent } from './types';

export interface RoomOptions {
  roomId: string;
  role: Role;
  localPlayerSlot: PlayerSlot;
  game: CornholeGame | null;
}

export interface RoomHandle {
  status: ConnectionStatus;
  peerConnected: boolean;
  rejected: boolean;
}

const HEARTBEAT_INTERVAL_MS = 1000;
const PEER_TIMEOUT_MS = 3500;

function newClientId(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export function useRoom({ roomId, role, localPlayerSlot, game }: RoomOptions): RoomHandle {
  const [status, setStatus] = useState<ConnectionStatus>('connecting');
  const [peerConnected, setPeerConnected] = useState(false);
  const [rejected, setRejected] = useState(false);
  const transportRef = useRef<Transport | null>(null);

  useEffect(() => {
    if (!game) return;

    const transport = createTransport(roomId, role);
    transportRef.current = transport;
    const clientId = newClientId();
    // Host tracks which guest clientId currently owns the opponent slot so we
    // can reject a third browser that tries to join the same room.
    let acceptedPeerClientId: string | null = null;

    if (role === 'host') {
      game.setHostMode(localPlayerSlot, true);
      game.onSnapshot = (snapshot: Snapshot) => {
        transport.send({ kind: 'snapshot', from: 'host', snapshot, clientId });
      };
      game.onLocalIntent = null;
    } else {
      game.setGuestMode(true, localPlayerSlot);
      game.onSnapshot = null;
      game.onLocalIntent = (intent: Intent) => {
        transport.send({ kind: 'intent', from: 'guest', intent, ts: Date.now(), clientId });
      };
    }

    transport.registerUnloadBye(() => ({ kind: 'bye', from: role, clientId }));

    let lastPeerMessageAt = 0;
    let peerAliveChecker: number | null = null;

    const markPeerAlive = () => {
      lastPeerMessageAt = Date.now();
      setPeerConnected(true);
    };

    const unsubMessage = transport.onMessage((envelope: Envelope) => {
      if (envelope.kind === 'roomFull') {
        if (role === 'guest' && envelope.toClientId === clientId) {
          setRejected(true);
          setPeerConnected(false);
        }
        return;
      }

      if (envelope.kind === 'hello') {
        if (role === 'host') {
          // Allow the first guest in, or let the same guest rejoin after refresh.
          // If a *different* guest is already active (recent heartbeat), refuse.
          const peerStillAlive =
            acceptedPeerClientId !== null &&
            acceptedPeerClientId !== envelope.clientId &&
            lastPeerMessageAt !== 0 &&
            Date.now() - lastPeerMessageAt < PEER_TIMEOUT_MS;
          if (peerStillAlive) {
            transport.send({ kind: 'roomFull', from: 'host', toClientId: envelope.clientId });
            return;
          }
          acceptedPeerClientId = envelope.clientId;
          markPeerAlive();
          transport.send({ kind: 'hello', from: role, playerSlot: localPlayerSlot, roomId, clientId });
          const snapshot = game.serializeSnapshot();
          transport.send({ kind: 'snapshot', from: 'host', snapshot, clientId });
          return;
        }

        // role === 'guest'
        markPeerAlive();
        transport.send({ kind: 'hello', from: role, playerSlot: localPlayerSlot, roomId, clientId });
        // A host rejoining spawns a fresh CornholeGame whose snapshotSeq starts at 0.
        // Reset our counter so we accept the next snapshot instead of rejecting it.
        game.snapshotSeq = 0;
        return;
      }

      // For host, only trust messages from the accepted peer. A late-joiner
      // whose hello was refused could otherwise still spam intents.
      if (role === 'host' && 'clientId' in envelope && envelope.clientId !== acceptedPeerClientId) {
        return;
      }

      markPeerAlive();

      if (envelope.kind === 'intent' && role === 'host') {
        const senderSlot: PlayerSlot = localPlayerSlot === 1 ? 2 : 1;
        game.applyIntent(envelope.intent, senderSlot);
      } else if (envelope.kind === 'snapshot' && role === 'guest') {
        game.applySnapshot(envelope.snapshot);
      } else if (envelope.kind === 'bye') {
        setPeerConnected(false);
        lastPeerMessageAt = 0;
        if (role === 'host') acceptedPeerClientId = null;
      }
      // heartbeat envelopes just update lastPeerMessageAt via markPeerAlive.
    });

    const unsubStatus = transport.onStatusChange((s) => {
      setStatus(s);
      if (s === 'connected') {
        transport.send({ kind: 'hello', from: role, playerSlot: localPlayerSlot, roomId, clientId });
      } else {
        setPeerConnected(false);
      }
    });

    const heartbeatTimer = window.setInterval(() => {
      transport.send({ kind: 'heartbeat', from: role, ts: Date.now(), clientId });
    }, HEARTBEAT_INTERVAL_MS);

    peerAliveChecker = window.setInterval(() => {
      if (lastPeerMessageAt === 0) return;
      if (Date.now() - lastPeerMessageAt > PEER_TIMEOUT_MS) {
        setPeerConnected(false);
        lastPeerMessageAt = 0;
        if (role === 'host') acceptedPeerClientId = null;
      }
    }, 1000);

    return () => {
      try {
        transport.send({ kind: 'bye', from: role, clientId });
      } catch {
        /* ignore */
      }
      window.clearInterval(heartbeatTimer);
      if (peerAliveChecker !== null) window.clearInterval(peerAliveChecker);
      unsubMessage();
      unsubStatus();
      transport.close();
      transportRef.current = null;
      if (game) {
        game.onSnapshot = null;
        game.onLocalIntent = null;
        game.setHostMode(1);
      }
    };
  }, [roomId, role, localPlayerSlot, game]);

  return { status, peerConnected, rejected };
}
