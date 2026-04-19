import type { ConnectionStatus, Envelope, Role, Transport } from './types';

// Same-origin transport used for local testing (two tabs on one machine).
// Messages are echoed back to every subscriber *except* the sender, matching
// the semantics of a real relay.
export class BroadcastTransport implements Transport {
  status: ConnectionStatus = 'connecting';
  private channel: BroadcastChannel;
  private messageHandlers = new Set<(e: Envelope) => void>();
  private statusHandlers = new Set<(s: ConnectionStatus) => void>();
  private senderId = Math.random().toString(36).slice(2);
  private unloadHandler: (() => void) | null = null;

  constructor(roomId: string, _role: Role) {
    this.channel = new BroadcastChannel(`cornhole:${roomId}`);
    this.channel.onmessage = (event) => {
      const { senderId, envelope } = event.data as { senderId: string; envelope: Envelope };
      if (senderId === this.senderId) return;
      this.messageHandlers.forEach((h) => h(envelope));
    };
    queueMicrotask(() => this.setStatus('connected'));
  }

  registerUnloadBye(onUnload: () => Envelope) {
    this.unloadHandler = () => {
      try { this.send(onUnload()); } catch { /* ignore */ }
    };
    window.addEventListener('beforeunload', this.unloadHandler);
    window.addEventListener('pagehide', this.unloadHandler);
  }

  private setStatus(status: ConnectionStatus) {
    this.status = status;
    this.statusHandlers.forEach((h) => h(status));
  }

  send(envelope: Envelope) {
    this.channel.postMessage({ senderId: this.senderId, envelope });
  }

  onMessage(handler: (envelope: Envelope) => void) {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  onStatusChange(handler: (status: ConnectionStatus) => void) {
    this.statusHandlers.add(handler);
    handler(this.status);
    return () => this.statusHandlers.delete(handler);
  }

  close() {
    if (this.unloadHandler) {
      window.removeEventListener('beforeunload', this.unloadHandler);
      window.removeEventListener('pagehide', this.unloadHandler);
      this.unloadHandler = null;
    }
    this.channel.close();
    this.setStatus('disconnected');
  }
}
