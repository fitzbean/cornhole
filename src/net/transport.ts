import { BroadcastTransport } from './broadcastTransport';
import { getSupabaseClient, SupabaseTransport } from './supabaseTransport';
import type { Role, Transport } from './types';

export function createTransport(roomId: string, role: Role): Transport {
  const supabase = getSupabaseClient();
  if (supabase) return new SupabaseTransport(supabase, roomId);
  return new BroadcastTransport(roomId, role);
}

export function transportMode(): 'supabase' | 'broadcast' {
  return getSupabaseClient() ? 'supabase' : 'broadcast';
}
