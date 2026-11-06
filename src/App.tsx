import { useEffect, useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { ViewMode, UserSession, RoomState, BundleItem } from './types';
import { Navbar } from './components/Navbar';
import { DashboardScreen } from './components/DashboardScreen';
import { RoomView } from './components/RoomView';
import { FilePreviewModal } from './components/FilePreviewModal';
import { HistoryScreen } from './components/HistoryScreen';
import { generateRoomOTP, normalizeRoomId } from './lib/p2pEngine';
import { getOrCreateGuestSession, updateGuestNickname } from './lib/session';
import { callRoomRegistry } from './lib/roomRegistry';

const createInitialRoom = (session: UserSession, roomId = 'X-R92-K', hostId = session.id): RoomState => ({
  id: roomId,
  createdAt: Date.now(),
  hostId,
  activePeers: [{ id: session.id, name: session.identifier, isYou: true, status: 'ONLINE', latencyMs: 0, ip: 'P2P_DIRECT' }],
  bundleItems: [],
  messages: [],
  selectedTargetPeerId: 'ALL_BUNDLE',
});

async function findActiveRoom(roomId: string) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const response = await fetch(`/api/signal/rooms/${encodeURIComponent(roomId)}`);
    if (response.ok) return response.json();
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('Room not found or expired.');
}

function clearRoomQuery() {
  const url = new URL(window.location.href);
  url.searchParams.delete('room');
  window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
}

export default function App() {
  const [session, setSession] = useState<UserSession>(() => getOrCreateGuestSession());
  const [currentView, setCurrentView] = useState<ViewMode>('DASHBOARD');
  const [latencyMs] = useState(12);
  const [room, setRoom] = useState<RoomState>(() => createInitialRoom(session));
  const [previewFile, setPreviewFile] = useState<BundleItem | null>(null);
  const [joinError, setJoinError] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const roomParam = params.get('room');
    const cleanRoom = roomParam ? normalizeRoomId(roomParam) : '';
    if (cleanRoom.length !== 6) return;

    let cancelled = false;
    findActiveRoom(cleanRoom)
      .then(async (activeRoom) => {
        if (cancelled) return;
        const registry = await callRoomRegistry('join', { roomCode: cleanRoom, peerId: session.id, peerName: session.identifier });
        setRoom(createInitialRoom(session, cleanRoom, registry.host_peer_id || activeRoom.hostPeerId || 'HOST_NODE'));
        clearRoomQuery();
        setCurrentView('ROOM');
      })
      .catch(() => {
        if (!cancelled) setJoinError('This room is no longer active. Ask the host for a fresh code.');
      });

    return () => { cancelled = true; };
  }, [session]);

  const handleUpdateNickname = (newName: string) => {
    const updated = updateGuestNickname(newName);
    setSession(updated);
    setRoom((prev) => ({ ...prev, activePeers: prev.activePeers.map((peer) => peer.isYou ? { ...peer, name: updated.identifier } : peer) }));
  };

  const handleCreateRoom = async () => {
    const newOtp = normalizeRoomId(generateRoomOTP());
    setJoinError(null);
    try {
      const registry = await callRoomRegistry('create', { roomCode: newOtp, peerId: session.id, peerName: session.identifier });
      if (!registry.active || registry.room_code !== newOtp) throw new Error('The shared room registry did not confirm room creation.');
      setRoom({ ...createInitialRoom(session, newOtp, registry.host_peer_id || session.id), messages: [{ id: `sys-${Date.now()}`, senderId: 'SYSTEM', senderName: 'ULTRONCHAT SYSTEM', text: `Private room ${newOtp} created. This room is now shared across active instances.`, timestamp: Date.now(), type: 'system' }] });
      setCurrentView('ROOM');
    } catch {
      setJoinError('Could not create a shared room right now. Please try again.');
    }
  };

  const handleJoinRoom = async (otpCode: string) => {
    const cleanOtp = normalizeRoomId(otpCode);
    if (cleanOtp.length !== 6) return;
    setJoinError(null);

    try {
      const activeRoom = await findActiveRoom(cleanOtp);
      const registry = await callRoomRegistry('join', { roomCode: cleanOtp, peerId: session.id, peerName: session.identifier });
      setRoom({ ...createInitialRoom(session, cleanOtp, registry.host_peer_id || activeRoom.hostPeerId || 'HOST_NODE'), messages: [{ id: `sys-${Date.now()}`, senderId: 'SYSTEM', senderName: 'ULTRONCHAT SYSTEM', text: `Joined room ${cleanOtp}. This instance is mapped to the shared active room.`, timestamp: Date.now(), type: 'system' }] });
      clearRoomQuery();
      setCurrentView('ROOM');
    } catch {
      setJoinError('No active room matches that code. Check the code or ask the host to reopen the room.');
    }
  };

  const handleLeaveRoom = () => {
    void callRoomRegistry('leave', { roomCode: room.id, peerId: session.id }).catch(() => {});
    setPreviewFile(null);
    setRoom(createInitialRoom(session));
    setCurrentView('DASHBOARD');
  };

  const handleAddBundleItem = (item: BundleItem) => setRoom((prev) => ({ ...prev, bundleItems: [item, ...prev.bundleItems] }));

  const handleDownloadFile = (file: BundleItem) => {
    if (!file.blobUrl) return;
    const anchor = document.createElement('a');
    anchor.href = file.blobUrl;
    anchor.download = file.name;
    anchor.rel = 'noreferrer';
    anchor.click();
  };

  const handleWipeSession = () => {
    if (!window.confirm('Wipe this tab’s in-memory files and messages? This cannot be undone.')) return;
    setRoom((prev) => ({ ...prev, bundleItems: [], messages: [{ id: `sys-${Date.now()}`, senderId: 'SYSTEM', senderName: 'ULTRONCHAT SYSTEM', text: 'Local session memory wiped.', timestamp: Date.now(), type: 'system' }] }));
  };

  return (
    <div className="app-shell">
      <div className="noise-overlay" aria-hidden="true" />
      <Navbar currentView={currentView} setView={setCurrentView} session={session} onUpdateNickname={handleUpdateNickname} latencyMs={latencyMs} />
      <main className="relative z-10 min-h-[calc(100vh-76px)] min-h-[calc(100dvh-76px)]">
        {currentView === 'DASHBOARD' || currentView === 'AUTH' ? <DashboardScreen session={session} onCreateRoom={handleCreateRoom} onJoinRoom={handleJoinRoom} joinError={joinError} setView={setCurrentView} onUpdateNickname={handleUpdateNickname} /> : null}
        {currentView === 'ROOM' && <RoomView room={room} session={session} onLeaveRoom={handleLeaveRoom} onPreviewFile={setPreviewFile} onAddBundleItem={handleAddBundleItem} />}
        {currentView === 'HISTORY' && <HistoryScreen bundleItems={room.bundleItems} onWipeSession={handleWipeSession} />}
      </main>
      {previewFile && <FilePreviewModal file={previewFile} onClose={() => setPreviewFile(null)} onDownload={handleDownloadFile} />}
      <footer className="relative z-10 mx-auto flex w-full max-w-[1440px] flex-col sm:flex-row sm:items-center justify-between gap-4 border-t border-white/10 px-4 py-5 font-mono text-[10px] uppercase tracking-[.16em] text-white/35 sm:px-8 lg:px-12">
        <span>UltronChat / ephemeral collaboration</span>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 sm:justify-end">
          <span className="inline-flex items-center gap-2"><ShieldCheck size={13} className="text-[#d6ff62]" /> Built by Ayush Bhattacharya</span>
          <a href="https://github.com/itsjustayush" target="_blank" rel="noreferrer" className="text-white/45 transition-colors hover:text-[#d6ff62]">GitHub</a>
          <a href="https://github.com/itsjustayush/UltronChat" target="_blank" rel="noreferrer" className="text-white/45 transition-colors hover:text-[#d6ff62]">Repo</a>
          <a href="https://itsjustayush.vercel.app/" target="_blank" rel="noreferrer" className="text-white/45 transition-colors hover:text-[#d6ff62]">Portfolio</a>
          <a href="mailto:info.cometlabs@gmail.com" className="text-white/45 transition-colors hover:text-[#d6ff62]">Email</a>
        </div>
      </footer>
    </div>
  );
}
