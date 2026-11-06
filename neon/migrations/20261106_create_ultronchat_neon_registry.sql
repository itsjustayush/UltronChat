-- UltronChat Neon Serverless PostgreSQL Schema
-- Replaces Supabase room registry tables and edge function state

CREATE TABLE IF NOT EXISTS public.ultronchat_rooms (
  room_code text PRIMARY KEY,
  host_peer_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  last_seen_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  expires_at timestamptz NOT NULL DEFAULT (timezone('utc', now()) + interval '90 seconds'),
  CONSTRAINT ultronchat_rooms_code_format CHECK (room_code ~ '^[A-Z0-9]{6}$'),
  CONSTRAINT ultronchat_rooms_host_format CHECK (char_length(host_peer_id) BETWEEN 3 AND 80)
);

CREATE TABLE IF NOT EXISTS public.ultronchat_room_peers (
  room_code text NOT NULL REFERENCES public.ultronchat_rooms(room_code) ON DELETE CASCADE,
  peer_id text NOT NULL,
  peer_name text NOT NULL DEFAULT 'Guest',
  is_host boolean NOT NULL DEFAULT false,
  joined_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  last_seen_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  expires_at timestamptz NOT NULL DEFAULT (timezone('utc', now()) + interval '90 seconds'),
  PRIMARY KEY (room_code, peer_id),
  CONSTRAINT ultronchat_peers_id_format CHECK (char_length(peer_id) BETWEEN 3 AND 80),
  CONSTRAINT ultronchat_peers_name_length CHECK (char_length(peer_name) BETWEEN 1 AND 64)
);

CREATE TABLE IF NOT EXISTS public.ultronchat_room_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  room_code text NOT NULL REFERENCES public.ultronchat_rooms(room_code) ON DELETE CASCADE,
  target_peer_id text NOT NULL,
  sender_peer_id text NOT NULL,
  message_type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  expires_at timestamptz NOT NULL DEFAULT (timezone('utc', now()) + interval '30 seconds'),
  CONSTRAINT ultronchat_events_target_format CHECK (char_length(target_peer_id) BETWEEN 3 AND 80),
  CONSTRAINT ultronchat_events_sender_format CHECK (char_length(sender_peer_id) BETWEEN 3 AND 80),
  CONSTRAINT ultronchat_events_type_length CHECK (char_length(message_type) BETWEEN 1 AND 32)
);

-- Performance Indexes optimized for Neon
CREATE INDEX IF NOT EXISTS ultronchat_rooms_expires_at_idx ON public.ultronchat_rooms (expires_at);
CREATE INDEX IF NOT EXISTS ultronchat_room_peers_composite_idx ON public.ultronchat_room_peers (room_code, expires_at, joined_at);
CREATE INDEX IF NOT EXISTS ultronchat_room_peers_expires_at_idx ON public.ultronchat_room_peers (expires_at);
CREATE INDEX IF NOT EXISTS ultronchat_room_events_poll_idx ON public.ultronchat_room_events (room_code, target_peer_id, id);
CREATE INDEX IF NOT EXISTS ultronchat_room_events_expires_idx ON public.ultronchat_room_events (expires_at);
