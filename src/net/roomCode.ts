const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function generateRoomCode(length = 6): string {
  let code = '';
  for (let i = 0; i < length; i++) {
    code += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  }
  return code;
}

export function getRoomFromUrl(): string | null {
  if (typeof window === 'undefined') return null;
  const params = new URLSearchParams(window.location.search);
  const raw = params.get('room');
  if (!raw) return null;
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8) || null;
}

export function buildRoomUrl(code: string): string {
  const url = new URL(window.location.href);
  url.searchParams.set('room', code);
  return url.toString();
}

export function clearRoomFromUrl() {
  const url = new URL(window.location.href);
  url.searchParams.delete('room');
  window.history.replaceState({}, '', url.toString());
}

// Persist which role this browser tab claimed for a given room, so a reload
// doesn't accidentally turn the host into a second guest.
const ROLE_STORAGE_PREFIX = 'cornhole.role.';

export function rememberRoleForRoom(roomId: string, role: 'host' | 'guest') {
  try {
    sessionStorage.setItem(ROLE_STORAGE_PREFIX + roomId, role);
  } catch {
    /* storage blocked */
  }
}

export function getStoredRoleForRoom(roomId: string): 'host' | 'guest' | null {
  try {
    const raw = sessionStorage.getItem(ROLE_STORAGE_PREFIX + roomId);
    return raw === 'host' || raw === 'guest' ? raw : null;
  } catch {
    return null;
  }
}

export function clearStoredRoleForRoom(roomId: string) {
  try {
    sessionStorage.removeItem(ROLE_STORAGE_PREFIX + roomId);
  } catch {
    /* ignore */
  }
}
