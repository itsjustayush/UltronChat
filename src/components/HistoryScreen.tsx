import { Download, FileArchive, Github, HardDrive, Leaf, LockKeyhole, Mail, ShieldCheck, Trash2, UserRound } from 'lucide-react';
import { BundleItem } from '../types';
import { formatBytes } from '../lib/crypto';

interface HistoryScreenProps {
  bundleItems: BundleItem[];
  onWipeSession: () => void;
}

const makerLinks = [
  { label: 'GitHub profile', href: 'https://github.com/itsjustayush', icon: Github },
  { label: 'UltronChat repository', href: 'https://github.com/itsjustayush/UltronChat', icon: FileArchive },
  { label: 'Portfolio', href: 'https://itsjustayush.vercel.app/', icon: UserRound },
  { label: 'Email Ayush', href: 'mailto:info.cometlabs@gmail.com', icon: Mail },
];

export function HistoryScreen({ bundleItems, onWipeSession }: HistoryScreenProps) {
  const totalBytes = bundleItems.reduce((acc, curr) => acc + curr.size, 0);
  const totalCarbonGrams = bundleItems.reduce((acc, curr) => acc + curr.carbonFootprintGrams, 0);
  const savedCloudCarbonGrams = parseFloat((totalBytes / (1024 * 1024) * 0.055).toFixed(2));

  const downloadFile = (item: BundleItem) => {
    if (!item.blobUrl) return;
    const anchor = document.createElement('a');
    anchor.href = item.blobUrl;
    anchor.download = item.name;
    anchor.rel = 'noreferrer';
    anchor.click();
  };

  return (
    <div className="history-shell page-reveal mx-auto min-h-screen min-h-[100dvh] w-full max-w-[1440px] px-3.5 pb-16 pt-6 sm:px-8 sm:pb-20 sm:pt-10 lg:px-12 lg:pt-16">
      <header className="flex flex-col justify-between gap-8 border-b border-white/10 pb-8 md:flex-row md:items-end">
        <div className="max-w-2xl">
          <div className="mb-5 inline-flex items-center gap-2 rounded-full border border-[#d6ff62]/20 bg-[#d6ff62]/[.08] px-3 py-2 font-mono text-[10px] uppercase tracking-[.2em] text-[#d6ff62]"><HardDrive size={13} /> Memory / current tab</div>
          <h1 className="text-[clamp(2.35rem,7vw,6.5rem)] font-semibold leading-[.92] sm:leading-[.88] tracking-[-.075em] text-white break-words">Session<br /><em className="font-display font-normal not-italic text-white/45">memory.</em></h1>
          <p className="mt-6 max-w-xl text-base leading-7 text-white/50">A local view of files received or shared in this tab. This is not a cloud archive; wiping the session removes the in-memory registry and its downloadable blobs.</p>
        </div>
        <button onClick={onWipeSession} className="liquid-button self-stretch sm:self-start md:self-end border-[#ff8e8e]/40 bg-[#ff8e8e]/[.08] text-[#ffb2b2] hover:border-[#ff8e8e]/75 hover:bg-[#ff8e8e]/[.14]"><Trash2 size={16} /> Wipe session memory</button>
      </header>

      <section className="mt-8 grid gap-4 sm:grid-cols-3">
        <div className="glass-panel rounded-[1.5rem] p-5"><div className="flex items-center justify-between text-white/45"><span className="font-mono text-[10px] uppercase tracking-[.16em]">Assets held</span><FileArchive size={16} /></div><div className="mt-5 text-3xl font-semibold tracking-[-.06em] text-white">{bundleItems.length}<span className="ml-2 text-base font-normal text-white/40">files</span></div></div>
        <div className="glass-panel rounded-[1.5rem] p-5"><div className="flex items-center justify-between text-white/45"><span className="font-mono text-[10px] uppercase tracking-[.16em]">Memory used</span><HardDrive size={16} /></div><div className="mt-5 text-3xl font-semibold tracking-[-.06em] text-[#d6ff62]">{formatBytes(totalBytes)}</div></div>
        <div className="glass-panel rounded-[1.5rem] p-5"><div className="flex items-center justify-between text-white/45"><span className="font-mono text-[10px] uppercase tracking-[.16em]">Estimated savings</span><Leaf size={16} className="text-[#d6ff62]" /></div><div className="mt-5 text-3xl font-semibold tracking-[-.06em] text-white">{savedCloudCarbonGrams}<span className="ml-2 text-base font-normal text-white/40">g CO₂e</span></div><div className="mt-2 font-mono text-[10px] text-white/35">{totalCarbonGrams.toFixed(2)} g used by direct transfer</div></div>
      </section>

      <section className="glass-panel mt-5 overflow-hidden rounded-[1.75rem]">
        <div className="flex flex-col justify-between gap-3 border-b border-white/10 bg-white/[.03] p-5 sm:flex-row sm:items-center sm:px-6"><div><h2 className="text-base font-medium tracking-[-.03em] text-white">Local transfer registry</h2><p className="mt-1 font-mono text-[10px] uppercase tracking-[.16em] text-white/35">Non-persistent / RAM only</p></div><div className="inline-flex items-center gap-2 font-mono text-[10px] uppercase tracking-[.15em] text-[#d6ff62]"><ShieldCheck size={14} /> No room archive</div></div>
        {bundleItems.length === 0 ? (
          <div className="flex min-h-64 flex-col items-center justify-center px-6 py-16 text-center"><span className="grid h-14 w-14 place-items-center rounded-2xl border border-white/10 bg-white/[.04] text-[#d6ff62]"><HardDrive size={22} /></span><h3 className="mt-5 text-lg font-medium text-white">Nothing held in memory yet.</h3><p className="mt-2 max-w-sm text-sm leading-6 text-white/45">Files shared or received in an active room will appear here until you leave the room or wipe this tab.</p></div>
        ) : (
          <div className="overflow-x-auto"><table className="w-full min-w-[760px] text-left"><thead className="border-b border-white/10 bg-white/[.02] font-mono text-[10px] uppercase tracking-[.14em] text-white/35"><tr><th className="p-4 font-normal sm:p-5">File</th><th className="p-4 font-normal sm:p-5">File ID</th><th className="p-4 font-normal sm:p-5">Size</th><th className="p-4 font-normal sm:p-5">Transport</th><th className="p-4 font-normal sm:p-5">Carbon</th><th className="p-4 font-normal sm:p-5">Action</th></tr></thead><tbody className="divide-y divide-white/10 text-sm text-white/75">{bundleItems.map((item) => <tr key={item.id} className="transition-colors hover:bg-white/[.035]"><td className="max-w-[240px] p-4 sm:p-5"><div className="flex items-center gap-3"><span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl border border-white/10 bg-white/[.04] text-[#d6ff62]"><FileArchive size={15} /></span><div className="min-w-0"><div className="truncate font-medium text-white">{item.name}</div><div className="mt-1 font-mono text-[10px] uppercase tracking-[.12em] text-white/35">{item.fileTypeLabel}</div></div></div></td><td className="p-4 font-mono text-xs text-[#d6ff62] sm:p-5">{item.fileId}</td><td className="p-4 font-mono text-xs text-white/60 sm:p-5">{formatBytes(item.size)}</td><td className="p-4 sm:p-5"><span className="inline-flex items-center gap-1.5 rounded-full border border-[#d6ff62]/20 bg-[#d6ff62]/[.06] px-2.5 py-1 font-mono text-[10px] text-[#d6ff62]"><LockKeyhole size={11} /> WebRTC</span></td><td className="p-4 font-mono text-xs text-white/60 sm:p-5">{item.carbonFootprintGrams}g</td><td className="p-4 sm:p-5"><button disabled={!item.blobUrl} onClick={() => downloadFile(item)} className="inline-flex items-center gap-2 rounded-full border border-white/15 px-3 py-2 font-mono text-[10px] uppercase tracking-[.12em] text-white/70 transition-colors hover:border-[#d6ff62]/50 hover:text-[#d6ff62] disabled:cursor-not-allowed disabled:opacity-30"><Download size={13} /> Download</button></td></tr>)}</tbody></table></div>
        )}
      </section>

      <section className="mt-5 grid gap-5 lg:grid-cols-[1.1fr_.9fr]">
        <div className="glass-panel rounded-[1.75rem] p-6 sm:p-8"><div className="mb-7 flex items-center gap-3"><span className="grid h-10 w-10 place-items-center rounded-xl bg-[#d6ff62] text-[#111]"><UserRound size={18} /></span><div><p className="font-mono text-[10px] uppercase tracking-[.18em] text-white/35">Maker / builder</p><h2 className="mt-1 text-2xl font-semibold tracking-[-.05em] text-white">Ayush Bhattacharya</h2></div></div><p className="max-w-lg text-sm leading-6 text-white/50">UltronChat is an ephemeral collaboration experience designed around direct transport, local memory, and a calmer workflow.</p><a href="mailto:info.cometlabs@gmail.com" className="mt-6 inline-flex items-center gap-2 text-sm text-[#d6ff62] hover:underline"><Mail size={15} /> info.cometlabs@gmail.com</a></div>
        <div className="glass-panel rounded-[1.75rem] p-6 sm:p-8"><p className="font-mono text-[10px] uppercase tracking-[.18em] text-white/35">Find the maker</p><div className="mt-5 grid gap-2">{makerLinks.map(({ label, href, icon: Icon }) => <a key={href} href={href} target={href.startsWith('http') ? '_blank' : undefined} rel={href.startsWith('http') ? 'noreferrer' : undefined} className="flex items-center justify-between rounded-xl border border-white/10 bg-white/[.03] px-4 py-3 text-sm text-white/70 transition-colors hover:border-[#d6ff62]/35 hover:bg-[#d6ff62]/[.06] hover:text-white"><span className="flex items-center gap-3"><Icon size={16} className="text-[#d6ff62]" />{label}</span><span className="font-mono text-[10px] text-white/30">OPEN</span></a>)}</div></div>
      </section>
    </div>
  );
}
