import { UserSession } from '../types';

const GUEST_SESSION_KEY = 'ultron_chat_guest_session_v1';

/**
 * Retrieves or creates a temporary session-based Guest identity.
 * Uses sessionStorage so each tab/device gets a unique guest identity that vanishes when the tab closes.
 */
export function getOrCreateGuestSession(): UserSession {
  if (typeof window === 'undefined') {
    return {
      id: 'guest_node_0',
      email: 'guest@ultron.chat',
      identifier: 'Guest-0000',
      authenticated: false,
      nodeType: 'EPH_NODE_0.5.0',
      encryptionAlgorithm: 'WEBRTC-DTLS-1.3',
    };
  }

  const stored = sessionStorage.getItem(GUEST_SESSION_KEY);
  if (stored) {
    try {
      const parsed = JSON.parse(stored);
      if (parsed && parsed.id && parsed.identifier) {
        return parsed;
      }
    } catch {
      // invalid stored session, recreate
    }
  }

  const uuid =
    typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID()
      : `guest_${Math.random().toString(36).substring(2, 11)}`;

  const randomCode = Math.floor(1000 + Math.random() * 9000);
  const nickname = `Guest-${randomCode}`;

  const session: UserSession = {
    id: uuid,
    email: `${nickname.toLowerCase()}@ultron.chat`,
    identifier: nickname,
    authenticated: false,
    nodeType: 'EPH_NODE_0.5.0',
    encryptionAlgorithm: 'WEBRTC-DTLS-1.3',
  };

  sessionStorage.setItem(GUEST_SESSION_KEY, JSON.stringify(session));
  return session;
}

/**
 * Updates the guest display nickname in sessionStorage.
 */
export function updateGuestNickname(newNickname: string): UserSession {
  const current = getOrCreateGuestSession();
  const cleanName = newNickname.trim() || current.identifier;
  const updated: UserSession = {
    ...current,
    identifier: cleanName,
    email: `${cleanName.toLowerCase().replace(/\s+/g, '_')}@ultron.chat`,
  };
  if (typeof window !== 'undefined') {
    sessionStorage.setItem(GUEST_SESSION_KEY, JSON.stringify(updated));
  }
  return updated;
}
