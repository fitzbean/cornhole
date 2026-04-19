import type { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js';
import { createClient } from '@supabase/supabase-js';
import type { ConnectionStatus, Envelope, Transport } from './types';

let cachedClient: SupabaseClient | null = null;

export function getSupabaseClient(): SupabaseClient | null {
  if (cachedClient) return cachedClient;
  const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
  const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
  if (!url || !key) return null;
  cachedClient = createClient(url, key, {
    realtime: { params: { eventsPerSecond: 30 } },
  });
  return cachedClient;
}

export class SupabaseTransport implements Transport {
  status: ConnectionStatus = 'connecting';
  private channel: RealtimeChannel;
  private messageHandlers = new Set<(e: Envelope) => void>();
  private statusHandlers = new Set<(s: ConnectionStatus) => void>();
  private unloadHandler: (() => void) | null = null;

  constructor(client: SupabaseClient, roomId: string) {
    this.channel = client.channel(`cornhole:${roomId}`, {
      config: { broadcast: { self: false, ack: false } },
    });

    this.channel.on('broadcast', { event: 'msg' }, ({ payload }) => {
      this.messageHandlers.forEach((h) => h(payload as Envelope));
    });

    this.channel.subscribe((status) => {
      if (status === 'SUBSCRIBED') this.setStatus('connected');
      else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') this.setStatus('error');
      else if (status === 'CLOSED') this.setStatus('disconnected');
    });
  }

  private setStatus(status: ConnectionStatus) {
    this.status = status;
    this.statusHandlers.forEach((h) => h(status));
  }

  send(envelope: Envelope) {
    this.channel.send({ type: 'broadcast', event: 'msg', payload: envelope });
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

  registerUnloadBye(onUnload: () => Envelope) {
    this.unloadHandler = () => {
      try { this.send(onUnload()); } catch { /* ignore */ }
    };
    window.addEventListener('beforeunload', this.unloadHandler);
    window.addEventListener('pagehide', this.unloadHandler);
  }

  close() {
    if (this.unloadHandler) {
      window.removeEventListener('beforeunload', this.unloadHandler);
      window.removeEventListener('pagehide', this.unloadHandler);
      this.unloadHandler = null;
    }
    this.channel.unsubscribe();
    this.setStatus('disconnected');
  }
}
