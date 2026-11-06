import { useRef, useState } from 'react';
import type { ChangeEvent, CSSProperties, FormEvent, KeyboardEvent } from 'react';
import { ArrowRight, Check, ClipboardPaste, KeyRound, LockKeyhole, Plus, Radio, Scan, ShieldCheck, Sparkles, Users } from 'lucide-react';
import { ViewMode, UserSession } from '../types';
import { QRScannerModal } from './QRScannerModal';

interface DashboardScreenProps {
  session: UserSession;
  onCreateRoom: () => void;
  onJoinRoom: (otpCode: string) => Promise<void>;
  joinError?: string | null;
  setView: (view: ViewMode) => void;
  onUpdateNickname?: (newName: string) => void;
}

const guarantees = [
  'No account or contact list required',
  'Room expires when the last peer leaves',
  'Files remain in local memory until wiped',
];

export function DashboardScreen({ session, onCreateRoom, onJoinRoom, joinError, onUpdateNickname }: DashboardScreenProps) {
  const [otpValues, setOtpValues] = useState<string[]>(['', '', '', '', '', '']);
  const [editingNick, setEditingNick] = useState(false);
  const [nickVal, setNickVal] = useState(session.identifier);
  const [isJoining, setIsJoining] = useState(false);
  const [showScanner, setShowScanner] = useState(false);
  const inputRefs = useRef<Array<HTMLInputElement | null>>([]);

  const handleOtpChange = (index: number, event: ChangeEvent<HTMLInputElement>) => {
    const incoming = event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    const next = [...otpValues];
    if (incoming.length > 1) {
      incoming.slice(0, 6).split('').forEach((char, offset) => { next[offset] = char; });
      setOtpValues(next);
      inputRefs.current[Math.min(incoming.length, 5)]?.focus();
      return;
    }
    next[index] = incoming;
    setOtpValues(next);
    if (incoming && index < 5) inputRefs.current[index + 1]?.focus();
  };

  const handleOtpKeyDown = (index: number, event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Backspace' && !otpValues[index] && index > 0) inputRefs.current[index - 1]?.focus();
    if (event.key === 'ArrowLeft' && index > 0) inputRefs.current[index - 1]?.focus();
    if (event.key === 'ArrowRight' && index < 5) inputRefs.current[index + 1]?.focus();
  };

  const handleJoin = async () => {
    const code = otpValues.join('');
    if (code.length < 4 || isJoining) return;
    setIsJoining(true);
    try {
      await onJoinRoom(code);
    } finally {
      setIsJoining(false);
    }
  };

  const handleScannedRoom = async (code: string) => {
    setShowScanner(false);
    const clean = code.replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 16);
    if (clean.length >= 4) {
      setOtpValues(clean.split(''));
      setIsJoining(true);
      try {
        await onJoinRoom(clean);
      } finally {
        setIsJoining(false);
      }
    }
  };

  const handleSaveNick = (event: FormEvent) => {
    event.preventDefault();
    const cleanName = nickVal.trim().replace(/[^a-zA-Z0-9 _-]/g, '').slice(0, 18);
    if (cleanName && onUpdateNickname) onUpdateNickname(cleanName);
    setEditingNick(false);
  };

  return (
    <div className="page-reveal mx-auto w-full max-w-[1440px] px-3.5 pb-12 pt-6 sm:px-8 sm:pb-16 sm:pt-10 lg:px-12 lg:pt-16">
      <section className="grid gap-10 lg:grid-cols-[1.15fr_.85fr] lg:items-end lg:gap-16">
        <div className="max-w-3xl">
          <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-[#d6ff62]/20 bg-[#d6ff62]/[.08] px-3 py-2 font-mono text-[10px] uppercase tracking-[.2em] text-[#d6ff62]">
            <Sparkles size={13} /> Private realtime rooms
          </div>
          <h1 className="text-[clamp(2.35rem,7.5vw,7.8rem)] font-semibold leading-[.92] sm:leading-[.88] tracking-[-.075em] text-white break-words">Move work<br /><em className="font-display font-normal not-italic text-white/45">without a trace.</em></h1>
          <p className="mt-7 max-w-xl text-base leading-7 text-white/55 sm:text-lg">UltronChat gives teams a temporary place to talk and move files together. No profile graph, no archive, no friction between a room and the people in it.</p>
          <div className="mt-8 flex flex-wrap items-center gap-4 font-mono text-[10px] uppercase tracking-[.16em] text-white/45">
            <span className="inline-flex items-center gap-2"><Radio size={14} className="text-[#d6ff62]" /> Live transport</span>
            <span className="inline-flex items-center gap-2"><LockKeyhole size={14} className="text-[#d6ff62]" /> Memory-first</span>
            <span className="inline-flex items-center gap-2"><Users size={14} className="text-[#d6ff62]" /> Guest access</span>
          </div>
        </div>

        <div className="glass-panel relative overflow-hidden rounded-[2rem] p-5 sm:p-7">
          <div className="absolute -right-20 -top-20 h-40 w-40 rounded-full bg-[#d6ff62]/10 blur-3xl" />
          <div className="relative flex items-center justify-between border-b border-white/10 pb-5">
            <div><p className="font-mono text-[10px] uppercase tracking-[.18em] text-white/40">Your session identity</p><p className="mt-2 text-xl font-medium tracking-[-.04em] text-white">{session.identifier}</p></div>
            <button onClick={() => { setNickVal(session.identifier); setEditingNick((editing) => !editing); }} className="rounded-full border border-white/15 px-3 py-2 text-xs text-white/60 hover:border-white/35 hover:text-white">{editingNick ? 'Close' : 'Edit'}</button>
          </div>
          {editingNick && (
            <form onSubmit={handleSaveNick} className="relative mt-4 flex gap-2">
              <label htmlFor="dashboard-nickname" className="sr-only">Guest nickname</label>
              <input id="dashboard-nickname" value={nickVal} onChange={(event) => setNickVal(event.target.value)} maxLength={18} className="min-w-0 flex-1 rounded-xl border border-white/15 bg-black/30 px-3 py-3 text-sm text-white outline-none focus:border-[#d6ff62]" />
              <button type="submit" className="grid h-11 w-11 place-items-center rounded-xl bg-[#d6ff62] text-[#111]" aria-label="Save nickname"><Check size={17} /></button>
            </form>
          )}
          <div className="relative mt-5 grid grid-cols-3 gap-2 text-center font-mono text-[9px] uppercase tracking-[.12em] text-white/40"><div className="rounded-xl bg-white/[.04] px-2 py-3"><span className="block text-white">RAM</span>storage</div><div className="rounded-xl bg-white/[.04] px-2 py-3"><span className="block text-white">P2P</span>preferred</div><div className="rounded-xl bg-white/[.04] px-2 py-3"><span className="block text-white">0</span>accounts</div></div>
        </div>
      </section>

      <section className="mt-14 grid gap-4 lg:grid-cols-2 lg:gap-5">
        <article className="stagger-reveal group relative flex min-h-[360px] flex-col justify-between overflow-hidden rounded-[2rem] border border-[#d6ff62]/35 bg-[#d6ff62] p-6 text-[#111] shadow-[0_0_50px_rgba(214,255,98,.08)] sm:p-8" style={{ '--delay': '120ms' } as CSSProperties}>
          <div className="absolute -bottom-24 -right-16 h-64 w-64 rounded-full border-[32px] border-black/[.06] transition-transform duration-500 group-hover:scale-110" />
          <div className="relative"><div className="flex items-center justify-between font-mono text-[10px] uppercase tracking-[.18em] opacity-55"><span>01 / Create</span><Plus size={18} /></div><h2 className="mt-12 max-w-sm text-4xl font-semibold leading-[.92] tracking-[-.07em] sm:text-5xl">Start a room<br /><em className="font-display font-normal not-italic">in seconds.</em></h2><p className="mt-5 max-w-sm text-sm leading-6 text-black/65">Generate a short-lived room and bring people in with a code or link. The host controls the room’s first connection.</p></div>
          <button onClick={onCreateRoom} className="relative mt-8 inline-flex w-full items-center justify-between rounded-full bg-[#111] px-5 py-4 text-sm font-medium text-white transition-transform duration-200 hover:scale-[1.015] active:scale-[.98]">Create private room <ArrowRight size={18} /></button>
        </article>

        <article className="stagger-reveal glass-panel group flex min-h-[360px] flex-col justify-between rounded-[2rem] p-6 sm:p-8" style={{ '--delay': '200ms' } as CSSProperties}>
          <div><div className="flex items-center justify-between font-mono text-[10px] uppercase tracking-[.18em] text-white/40"><span>02 / Join</span><KeyRound size={18} className="text-[#d6ff62]" /></div><h2 className="mt-12 max-w-sm text-4xl font-semibold leading-[.92] tracking-[-.07em] text-white sm:text-5xl">Enter the<br /><em className="font-display font-normal not-italic text-white/45">room code.</em></h2><p className="mt-5 max-w-sm text-sm leading-6 text-white/50">Use the six-character code from your host, or scan the host's QR code on mobile.</p></div>
          <div className="mt-8">
            <div className="flex gap-1.5 sm:gap-3" role="group" aria-label="Six-character room code">
              {otpValues.map((value, index) => <input key={index} ref={(element) => { inputRefs.current[index] = element; }} value={value} onChange={(event) => handleOtpChange(index, event)} onKeyDown={(event) => handleOtpKeyDown(index, event)} aria-label={`Room code character ${index + 1}`} inputMode="text" autoComplete="one-time-code" maxLength={1} className="h-11 sm:h-14 min-w-0 flex-1 rounded-xl border border-white/15 bg-black/25 text-center font-mono text-base sm:text-xl text-white outline-none transition-all focus:border-[#d6ff62] focus:bg-[#d6ff62]/10" />)}
            </div>
            <div className="mt-4 flex gap-2">
              <button onClick={handleJoin} disabled={otpValues.join('').length < 4 || isJoining} className="liquid-button liquid-button--solid flex-1 disabled:cursor-not-allowed disabled:opacity-35"><ClipboardPaste size={16} /> {isJoining ? 'Checking active room…' : 'Enter room'} {!isJoining && <ArrowRight size={16} />}</button>
              <button type="button" onClick={() => setShowScanner(true)} className="liquid-button px-4 font-mono text-xs text-white/90 hover:text-white" title="Scan QR Code with Camera"><Scan size={16} className="text-[#d6ff62]" /> <span className="hidden sm:inline">Scan QR</span></button>
            </div>
            {joinError && <p role="alert" className="mt-3 rounded-xl border border-[#ff8e8e]/30 bg-[#ff8e8e]/[.08] px-3 py-2.5 font-mono text-[10px] uppercase tracking-[.08em] text-[#ffb2b2]">{joinError}</p>}
          </div>
        </article>
      </section>

      <section className="mt-8 grid gap-3 border-t border-white/10 pt-7 sm:grid-cols-3">
        {guarantees.map((guarantee, index) => <div key={guarantee} className="stagger-reveal flex items-start gap-3 text-sm text-white/50" style={{ '--delay': `${280 + index * 70}ms` } as CSSProperties}><span className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full border border-[#d6ff62]/35 text-[#d6ff62]"><Check size={11} /></span>{guarantee}</div>)}
      </section>

      <div className="mt-8 flex items-center gap-2 font-mono text-[10px] uppercase tracking-[.18em] text-white/30"><ShieldCheck size={14} className="text-[#d6ff62]" /> We do not retain room content. Signaling remains transient while peers are online.</div>

      {showScanner && (
        <QRScannerModal
          onScan={handleScannedRoom}
          onClose={() => setShowScanner(false)}
        />
      )}
    </div>
  );
}
