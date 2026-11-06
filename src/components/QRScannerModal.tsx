import React, { useEffect, useRef, useState } from 'react';
import { Camera, X, AlertCircle, Scan } from 'lucide-react';

interface QRScannerModalProps {
  onScan: (scannedCode: string) => void;
  onClose: () => void;
}

export function QRScannerModal({ onScan, onClose }: QRScannerModalProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [hasCamera, setHasCamera] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [manualCode, setManualCode] = useState<string>('');

  useEffect(() => {
    let active = true;
    let detector: any = null;
    let animFrame: number;

    async function initCamera() {
      try {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
          setHasCamera(false);
          setError('Camera API not supported on this browser.');
          return;
        }

        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: false,
        });

        if (!active) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }

        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
        }

        // Check for native BarcodeDetector API
        if ('BarcodeDetector' in window) {
          try {
            // @ts-ignore
            detector = new window.BarcodeDetector({ formats: ['qr_code'] });
          } catch {
            detector = null;
          }
        }

        const scanFrame = async () => {
          if (!active) return;
          if (videoRef.current && videoRef.current.readyState === videoRef.current.HAVE_ENOUGH_DATA && detector) {
            try {
              const barcodes = await detector.detect(videoRef.current);
              if (barcodes.length > 0) {
                const rawValue = barcodes[0].rawValue;
                handleCodeExtracted(rawValue);
                return;
              }
            } catch {}
          }
          animFrame = requestAnimationFrame(scanFrame);
        };

        if (detector) {
          animFrame = requestAnimationFrame(scanFrame);
        }
      } catch (err: any) {
        if (!active) return;
        setHasCamera(false);
        setError(err.name === 'NotAllowedError' ? 'Camera permission was denied. Please allow camera access in browser settings.' : 'Could not access device camera.');
      }
    }

    initCamera();

    return () => {
      active = false;
      if (animFrame) cancelAnimationFrame(animFrame);
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
      }
    };
  }, []);

  const handleCodeExtracted = (rawValue: string) => {
    try {
      // If it's a full URL e.g. https://.../?room=XR92KB
      const url = new URL(rawValue);
      const roomParam = url.searchParams.get('room');
      if (roomParam) {
        onScan(roomParam);
        return;
      }
    } catch {}

    // Or if it's the raw OTP code directly
    const clean = rawValue.replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 6);
    if (clean.length === 6) {
      onScan(clean);
    } else {
      setError(`Detected "${rawValue}", but expected a 6-character room OTP code.`);
    }
  };

  const handleManualSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (manualCode.trim()) {
      handleCodeExtracted(manualCode.trim());
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 p-4 backdrop-blur-md">
      <div className="relative w-full max-w-md overflow-hidden rounded-3xl border border-white/10 bg-[#0d0d0d] p-6 shadow-2xl">
        <div className="flex items-center justify-between pb-4 border-b border-white/10">
          <div className="flex items-center gap-2.5">
            <Scan className="h-5 w-5 text-[#d6ff62]" />
            <h3 className="font-mono text-sm uppercase tracking-wider text-white">Scan Room QR Code</h3>
          </div>
          <button
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-full bg-white/5 text-white/60 transition hover:bg-white/10 hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="relative mt-4 aspect-square w-full overflow-hidden rounded-2xl bg-black border border-white/10 flex items-center justify-center">
          {hasCamera ? (
            <>
              <video
                ref={videoRef}
                playsInline
                muted
                className="h-full w-full object-cover"
              />
              {/* Scan target viewfinder */}
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                <div className="relative h-48 w-48 rounded-2xl border-2 border-[#d6ff62]/80 shadow-[0_0_30px_rgba(214,255,98,0.2)]">
                  <div className="absolute -top-1 -left-1 h-4 w-4 border-t-2 border-l-2 border-[#d6ff62]" />
                  <div className="absolute -top-1 -right-1 h-4 w-4 border-t-2 border-r-2 border-[#d6ff62]" />
                  <div className="absolute -bottom-1 -left-1 h-4 w-4 border-b-2 border-l-2 border-[#d6ff62]" />
                  <div className="absolute -bottom-1 -right-1 h-4 w-4 border-b-2 border-r-2 border-[#d6ff62]" />
                </div>
              </div>
            </>
          ) : (
            <div className="flex flex-col items-center justify-center gap-3 p-6 text-center text-white/60">
              <Camera className="h-10 w-10 text-white/30" />
              <p className="text-xs">{error || 'Camera preview unavailable'}</p>
            </div>
          )}
        </div>

        {error && hasCamera && (
          <div className="mt-3 flex items-center gap-2 rounded-xl bg-amber-500/10 p-3 text-xs text-amber-300 border border-amber-500/20">
            <AlertCircle className="h-4 w-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <form onSubmit={handleManualSubmit} className="mt-4 flex gap-2">
          <input
            type="text"
            value={manualCode}
            onChange={(e) => setManualCode(e.target.value)}
            placeholder="Or enter 6-digit code or URL"
            className="flex-1 rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 font-mono text-xs text-white placeholder:text-white/30 focus:border-[#d6ff62] focus:outline-none"
          />
          <button
            type="submit"
            className="rounded-xl bg-[#d6ff62] px-4 py-2.5 font-mono text-xs font-semibold text-black transition hover:bg-[#edffb0]"
          >
            Pair
          </button>
        </form>
      </div>
    </div>
  );
}

