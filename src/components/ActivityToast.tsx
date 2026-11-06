import React from 'react';

export interface ActivityToastData {
  id: string;
  type: 'join' | 'leave' | 'info';
  peerName: string;
  peerId?: string;
  message: string;
  timestamp: number;
}

interface ActivityToastProps {
  toasts: ActivityToastData[];
  onDismiss: (id: string) => void;
}

export const ActivityToastContainer: React.FC<ActivityToastProps> = ({ toasts, onDismiss }) => {
  if (toasts.length === 0) return null;

  return (
    <div className="fixed top-20 right-3 left-3 sm:left-auto sm:right-6 z-50 flex flex-col gap-2.5 max-w-sm w-auto sm:w-full pointer-events-none transition-all duration-300">
      {toasts.map((toast) => {
        const isJoin = toast.type === 'join';
        const isLeave = toast.type === 'leave';

        return (
          <div
            key={toast.id}
            className={`pointer-events-auto flex items-center justify-between gap-3 p-3.5 rounded-2xl border shadow-xl backdrop-blur-md transition-all duration-300 transform translate-y-0 animate-slide-in-right ${
              isJoin
                ? 'bg-[#0D1520]/95 border-emerald-500/40 text-emerald-100 shadow-emerald-950/30'
                : isLeave
                ? 'bg-[#0D1520]/95 border-rose-500/40 text-rose-100 shadow-rose-950/30'
                : 'bg-[#0D1520]/95 border-[#d6ff62]/40 text-[#efffbf] shadow-[#d6ff62]/10'
            }`}
          >
            <div className="flex items-center gap-3 overflow-hidden">
              <div
                className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 font-bold ${
                  isJoin
                    ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                    : isLeave
                    ? 'bg-rose-500/20 text-rose-400 border border-rose-500/30'
                    : 'bg-[#d6ff62]/10 text-[#d6ff62] border border-[#d6ff62]/30'
                }`}
              >
                <span className="material-symbols-outlined text-lg">
                  {isJoin ? 'person_add' : isLeave ? 'person_remove' : 'info'}
                </span>
              </div>

              <div className="flex flex-col min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-xs font-bold truncate text-white">
                    {toast.peerName}
                  </span>
                  <span
                    className={`font-mono text-[9px] px-1.5 py-0.2 rounded-full uppercase tracking-wider font-bold ${
                      isJoin
                        ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                        : isLeave
                        ? 'bg-rose-500/20 text-rose-300 border border-rose-500/30'
                        : 'bg-[#d6ff62]/10 text-[#d6ff62] border border-[#d6ff62]/30'
                    }`}
                  >
                    {isJoin ? 'JOINED' : isLeave ? 'LEFT' : 'INFO'}
                  </span>
                </div>
                <p className="text-xs text-white/80 font-sans truncate mt-0.5">
                  {toast.message}
                </p>
              </div>
            </div>

            <button
              onClick={() => onDismiss(toast.id)}
              className="text-white/50 hover:text-white transition-colors p-1 rounded-lg hover:bg-white/10 shrink-0 cursor-pointer"
              title="Dismiss notification"
            >
              <span className="material-symbols-outlined text-sm">close</span>
            </button>
          </div>
        );
      })}
    </div>
  );
};
