import { useEffect, useRef, useState } from 'react';
import { createTransport } from './transport';
import type { ChatMessage, ConnectionStatus, Envelope, PlayerSlot, Role, Snapshot, Transport } from './types';
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
  messagesSent: number;
  messagesReceived: number;
  messages: ChatMessage[];
  sendChat(text: string): void;
}

const HEARTBEAT_INTERVAL_MS = 10000;
const PEER_TIMEOUT_MS = 30000;

function newClientId(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export function useRoom({ roomId, role, localPlayerSlot, game }: RoomOptions): RoomHandle {
  const [status, setStatus] = useState<ConnectionStatus>('connecting');
  const [peerConnected, setPeerConnected] = useState(false);
  const [rejected, setRejected] = useState(false);
  const [messagesSent, setMessagesSent] = useState(0);
  const [messagesReceived, setMessagesReceived] = useState(0);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const transportRef = useRef<Transport | null>(null);
  const clientIdRef = useRef<string>(newClientId());

  useEffect(() => {
    setMessages([]);
    setRejected(false);
    setPeerConnected(false);
    setMessagesSent(0);
    setMessagesReceived(0);
  }, [roomId, role, game]);

  useEffect(() => {
    if (!game) return;

    const transport = createTransport(roomId, role);
    transportRef.current = transport;
    const clientId = newClientId();
    clientIdRef.current = clientId;
    // Host tracks which guest clientId currently owns the opponent slot so we
    // can reject a third browser that tries to join the same room.
    let acceptedPeerClientId: string | null = null;

    if (role === 'host') {
      game.setHostMode(localPlayerSlot, true);
      game.onSnapshot = (snapshot: Snapshot) => {
        send({ kind: 'snapshot', from: 'host', snapshot, clientId });
      };
      game.onLocalIntent = null;
    } else {
      game.setGuestMode(true, localPlayerSlot);
      game.onSnapshot = null;
      game.onLocalIntent = (intent: Intent) => {
        send({ kind: 'intent', from: 'guest', intent, ts: Date.now(), clientId });
      };
    }

    transport.registerUnloadBye(() => ({ kind: 'bye', from: role, clientId }));

    let lastPeerMessageAt = 0;
    let peerAliveChecker: number | null = null;

    const send = (envelope: Envelope) => {
      transport.send(envelope);
      setMessagesSent((count) => count + 1);
    };

    const markPeerAlive = () => {
      lastPeerMessageAt = Date.now();
      setPeerConnected(true);
    };

    const unsubMessage = transport.onMessage((envelope: Envelope) => {
      setMessagesReceived((count) => count + 1);
      if (envelope.kind === 'roomFull') {
        if (role === 'guest' && envelope.toClientId === clientId) {
          setRejected(true);
          setPeerConnected(false);
        }
        return;
      }

      if (envelope.kind === 'hello') {
        if (role === 'host') {
          acceptedPeerClientId = envelope.clientId;
          markPeerAlive();
          send({ kind: 'hello', from: role, playerSlot: localPlayerSlot, roomId, clientId });
          const snapshot = game.serializeSnapshot();
          send({ kind: 'snapshot', from: 'host', snapshot, clientId });
          return;
        }

        // role === 'guest'
        markPeerAlive();
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
      } else if (envelope.kind === 'chat') {
        setMessages((prev) => [...prev, envelope.message].slice(-80));
      } else if (envelope.kind === 'bye') {
        setPeerConnected(false);
        lastPeerMessageAt = 0;
        if (role === 'host') acceptedPeerClientId = null;
      }
      // heartbeat envelopes just update lastPeerMessageAt via markPeerAlive.
    });

    const unsubStatus = transport.onStatusChange((s) => {
      setStatus(s);
      if (s === 'connected' && role === 'guest') {
        send({ kind: 'hello', from: role, playerSlot: localPlayerSlot, roomId, clientId });
      } else {
        setPeerConnected(false);
      }
    });

    const heartbeatTimer = window.setInterval(() => {
      send({ kind: 'heartbeat', from: role, ts: Date.now(), clientId });
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

  const sendChat = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || !transportRef.current) return;
    const message: ChatMessage = {
      id: `${clientIdRef.current}:${Date.now()}:${Math.random().toString(36).slice(2)}`,
      from: role,
      playerSlot: localPlayerSlot,
      text: trimmed.slice(0, 180),
      ts: Date.now(),
    };
    setMessages((prev) => [...prev, message].slice(-80));
    transportRef.current.send({ kind: 'chat', from: role, message, clientId: clientIdRef.current });
    setMessagesSent((count) => count + 1);
  };

  return { status, peerConnected, rejected, messagesSent, messagesReceived, messages, sendChat };
}
