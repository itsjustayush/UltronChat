/**
 * Room Registry Client for UltronChat backed by Neon Serverless PostgreSQL
 * Exact clone replica replacing external Supabase Edge Functions with native Neon queries.
 */

import { executeNeonRoomAction } from './neonRoomRegistry';

export interface RegistryPeer {
  peer_id: string;
  peer_name: string;
  is_host: boolean;
  joined_at: string;
  last_seen_at: string;
  expires_at: string;
}

export interface RegistryRoom {
  active: boolean;
  room_code?: string;
  host_peer_id?: string;
  created_at?: string;
  last_seen_at?: string;
  expires_at?: string;
  peers?: RegistryPeer[];
  messages?: any[];
  error?: string;
  code?: string;
  [key: string]: unknown;
}

const MAX_REGISTRY_BYTES = 64 * 1024;

export async function roomRegistry(
  action: string,
  payload: Record<string, unknown>
): Promise<RegistryRoom & { messages?: unknown[] }> {
  const body = JSON.stringify({ action, ...payload });
  if (body.length > MAX_REGISTRY_BYTES) {
    const error = new Error('Room registry payload is too large') as Error & {
      status?: number;
    };
    error.status = 413;
    throw error;
  }

  try {
    const result = await executeNeonRoomAction(action, payload);
    return result as RegistryRoom & { messages?: unknown[] };
  } catch (err: any) {
    const error = new Error(
      typeof err?.message === 'string'
        ? err.message
        : 'Room registry request failed'
    ) as Error & { status?: number; code?: string };
    error.status = err?.status || 500;
    error.code = err?.code;
    throw error;
  }
}
