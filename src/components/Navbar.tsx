import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { Activity, ChevronDown, Edit3, FolderClock, MessageSquare, Save, ShieldCheck, X } from 'lucide-react';
import { ViewMode, UserSession } from '../types';

interface NavbarProps {
  currentView: ViewMode;
  setView: (view: ViewMode) => void;
  session: UserSession;
  onUpdateNickname: (newName: string) => void;
  latencyMs: number;
}

const NAV_ITEMS: Array<{ view: ViewMode; label: string; icon: typeof MessageSquare }> = [
  { view: 'DASHBOARD', label: 'Rooms', icon: MessageSquare },
  { view: 'ROOM', label: 'Active room', icon: Activity },
  { view: 'HISTORY', label: 'Memory', icon: FolderClock },
];

export function Navbar({ currentView, setView, session, onUpdateNickname, latencyMs }: NavbarProps) {
  const [isEditingName, setIsEditingName] = useState(false);
  const [nameInput, setNameInput] = useState(session.identifier);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, []);

  useEffect(() => {
    document.body.style.overflow = menuOpen ? 'hidden' : '';
    return () => { document.body.style.overflow = ''; };
  }, [menuOpen]);

  const handleSaveName = (event: FormEvent) => {
    event.preventDefault();
    const cleanName = nameInput.trim().replace(/[^a-zA-Z0-9 _-]/g, '').slice(0, 18);
    if (cleanName) onUpdateNickname(cleanName);
    setIsEditingName(false);
  };

  const navigate = (view: ViewMode) => {
    setView(view);
    setMenuOpen(false);
  };

  return (
    <>
      <header className="sticky top-0 z-50 border-b border-white/10 bg-[#050505]/80 backdrop-blur-2xl">
        <div className="mx-auto flex min-h-[68px] sm:min-h-[76px] w-full max-w-[1440px] items-center justify-between gap-2 sm:gap-4 px-3 sm:px-8 lg:px-12">
          <button onClick={() => navigate('DASHBOARD')} className="group flex items-center gap-3 text-left" aria-label="Go to UltronChat rooms">
            <span className="grid h-10 w-10 place-items-center rounded-xl border border-white/15 bg-white/[.08] shadow-[0_0_24px_rgba(214,255,98,.08)] transition-transform duration-200 group-hover:scale-105">
              <span className="h-3 w-3 rotate-45 rounded-[3px] bg-[#d6ff62] shadow-[0_0_18px_rgba(214,255,98,.8)]" />
            </span>
            <span className="hidden sm:block">
              <span className="block font-semibold tracking-[-.04em] text-white">Ultron<span className="text-[#d6ff62]">Chat</span></span>
              <span className="block font-mono text-[9px] uppercase tracking-[.22em] text-white/40">Private by design</span>
            </span>
          </button>

          <nav className="hidden items-center gap-1 rounded-full border border-white/10 bg-white/[.04] p-1 lg:flex" aria-label="Primary navigation">
            {NAV_ITEMS.map(({ view, label, icon: Icon }) => {
              const active = currentView === view;
              return (
                <button key={view} onClick={() => navigate(view)} className={`relative inline-flex items-center gap-2 rounded-full px-4 py-2 text-xs font-medium transition-all duration-200 ${active ? 'bg-white text-[#111]' : 'text-white/55 hover:bg-white/[.08] hover:text-white'}`} aria-current={active ? 'page' : undefined}>
                  <Icon size={14} strokeWidth={1.8} />
                  {label}
                </button>
              );
            })}
          </nav>

          <div className="flex items-center gap-2 sm:gap-3">
            <div className="hidden items-center gap-2 rounded-full border border-[#d6ff62]/20 bg-[#d6ff62]/[.06] px-3 py-2 xl:flex" title="Local session status">
              <span className="h-1.5 w-1.5 rounded-full bg-[#d6ff62] shadow-[0_0_10px_#d6ff62]" />
              <span className="font-mono text-[10px] uppercase tracking-[.16em] text-[#d6ff62]">{latencyMs}ms secure link</span>
            </div>

            <div className="relative">
              {isEditingName ? (
                <form onSubmit={handleSaveName} className="flex items-center gap-1 rounded-full border border-white/20 bg-white/[.08] p-1">
                  <label htmlFor="nickname" className="sr-only">Guest nickname</label>
                  <input id="nickname" autoFocus value={nameInput} onChange={(event) => setNameInput(event.target.value)} maxLength={18} className="w-20 sm:w-28 bg-transparent px-2 text-xs text-white outline-none" />
                  <button type="submit" className="grid h-7 w-7 place-items-center rounded-full bg-[#d6ff62] text-[#111]" aria-label="Save nickname"><Save size={13} /></button>
                  <button type="button" onClick={() => setIsEditingName(false)} className="grid h-7 w-7 place-items-center rounded-full text-white/50 hover:bg-white/10 hover:text-white" aria-label="Cancel nickname edit"><X size={13} /></button>
                </form>
              ) : (
                <button onClick={() => { setNameInput(session.identifier); setIsEditingName(true); }} className="group flex items-center gap-2 rounded-full border border-white/15 bg-white/[.06] px-3 py-2 transition-colors hover:border-white/30 hover:bg-white/[.1]" aria-label={`Edit nickname ${session.identifier}`}>
                  <span className="grid h-6 w-6 place-items-center rounded-full bg-white text-[10px] font-bold text-[#111]">{session.identifier.slice(0, 1).toUpperCase()}</span>
                  <span className="hidden max-w-24 truncate text-xs font-medium text-white/85 sm:block">{session.identifier}</span>
                  <Edit3 size={13} className="text-white/35 transition-colors group-hover:text-[#d6ff62]" />
                </button>
              )}
            </div>

            <button onClick={() => setMenuOpen((open) => !open)} className="grid h-10 w-10 place-items-center rounded-full border border-white/15 bg-white/[.06] text-white lg:hidden" aria-expanded={menuOpen} aria-controls="mobile-nav" aria-label={menuOpen ? 'Close navigation menu' : 'Open navigation menu'}>
              {menuOpen ? <X size={18} /> : <ChevronDown size={18} />}
            </button>
          </div>
        </div>

        <div id="mobile-nav" className={`border-t border-white/10 bg-[#080808] px-5 py-4 lg:hidden ${menuOpen ? 'block' : 'hidden'}`}>
          <nav className="grid gap-2" aria-label="Mobile navigation">
            {NAV_ITEMS.map(({ view, label, icon: Icon }) => (
              <button key={view} onClick={() => navigate(view)} className={`flex items-center gap-3 rounded-xl px-4 py-3 text-left text-sm ${currentView === view ? 'bg-white text-[#111]' : 'text-white/65 hover:bg-white/[.08] hover:text-white'}`}>
                <Icon size={16} />{label}
              </button>
            ))}
          </nav>
          <div className="mt-4 flex items-center gap-2 border-t border-white/10 pt-4 font-mono text-[10px] uppercase tracking-[.18em] text-white/45"><ShieldCheck size={14} className="text-[#d6ff62]" /> Session data stays in this tab</div>
        </div>
      </header>
    </>
  );
}
