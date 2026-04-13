'use client';

import { useRef, useState, useCallback, useEffect } from 'react';

const CANVAS_W = 1152;
const CANVAS_H = 630;

const ASCII_RAMP = " `.-':_,^=;><+!rc*/z?sLTv)J7(|Fi{C}fI31tlu[neoZ5Yxjya]2ESwqkP6h9d4VpOGbUAKXHm8RD#$Bg0MNWQ%&@";

const WS_URL = process.env.NEXT_PUBLIC_WS_URL ?? null;

type StatusKind = 'idle' | 'busy' | 'ok' | 'error';
type ColorMode  = 'default' | 'gray' | 'red' | 'green' | 'blue' | 'amber' | 'custom';

const COLOR_MODES: { mode: ColorMode; label: string; swatch: string }[] = [
  { mode: 'default', label: 'Default', swatch: 'transparent' },
  { mode: 'gray',    label: 'B&W',     swatch: '#888'         },
  { mode: 'red',     label: 'Red',     swatch: '#f44'         },
  { mode: 'green',   label: 'Green',   swatch: '#4d4'         },
  { mode: 'blue',    label: 'Blue',    swatch: '#55f'         },
  { mode: 'amber',   label: 'Amber',   swatch: '#fa0'         },
];

export default function AsciiPlayer() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const audioRef  = useRef<HTMLAudioElement>(null);
  const wsRef     = useRef<WebSocket | null>(null);
  const rafRef    = useRef<number>(0);

  const frameStoreRef  = useRef<Map<number, Uint8Array>>(new Map());
  const allFramesRef   = useRef<Uint8Array[]>([]);
  const nextIdxRef     = useRef(0);
  const lastDrawnRef   = useRef(-1);
  const playStartRef   = useRef(0);
  const totalFramesRef = useRef(-1);
  const fpsRef         = useRef(24);
  const playingRef     = useRef(false);
  const pausedRef      = useRef(false);
  const frameNumRef    = useRef(0);

  const granularityRef = useRef(80);
  const colorModeRef   = useRef<ColorMode>('default');
  const customColorRef = useRef<{ r: number; g: number; b: number }>({ r: 255, g: 255, b: 255 });

  const audioCtxRef    = useRef<AudioContext | null>(null);
  const audioDestRef   = useRef<MediaStreamAudioDestinationNode | null>(null);
  const recorderRef    = useRef<MediaRecorder | null>(null);
  const recordChunks   = useRef<Blob[]>([]);

  const [status, setStatus]           = useState<{ text: string; kind: StatusKind }>({ text: '', kind: 'idle' });
  const [showReplay, setShowReplay]   = useState(false);
  const [recording, setRecording]     = useState(false);
  const [paused, setPaused]           = useState(false);
  const [dragging, setDragging]       = useState(false);
  const [fileName, setFileName]       = useState('');
  const [frameInfo, setFrameInfo]     = useState('');
  const [volume, setVolume]           = useState(1);
  const [granularity, setGranularity] = useState(80);
  const [colorMode, setColorMode]     = useState<ColorMode>('default');
  const [customColor, setCustomColor] = useState('#ffffff');

  function drawFrame(data: Uint8Array) {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const srcCols = (data[0] << 8) | data[1];
    const srcRows = (data[2] << 8) | data[3];

    if (canvas.width !== CANVAS_W || canvas.height !== CANVAS_H) {
      canvas.width  = CANVAS_W;
      canvas.height = CANVAS_H;
    }

    const gran    = granularityRef.current;
    const tgtCols = gran;
    const tgtRows = Math.max(1, Math.round(gran * srcRows / srcCols));
    const charW   = CANVAS_W / tgtCols;
    const charH   = CANVAS_H / tgtRows;
    const fontSize = Math.max(1, Math.floor(charH * 6 / 7));

    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
    ctx.font = `${fontSize}px "Courier New", monospace`;
    ctx.textBaseline = 'top';

    for (let tr = 0; tr < tgtRows; tr++) {
      for (let tc = 0; tc < tgtCols; tc++) {
        const sc  = Math.min(srcCols - 1, Math.floor(tc * srcCols / tgtCols));
        const sr  = Math.min(srcRows - 1, Math.floor(tr * srcRows / tgtRows));
        const off = 4 + (sr * srcCols + sc) * 3;
        const r = data[off], g = data[off + 1], b = data[off + 2];

        const lum     = 0.299 * r + 0.587 * g + 0.114 * b;
        const charIdx = Math.round((lum / 255) * (ASCII_RAMP.length - 1));
        const L = lum | 0;
        switch (colorModeRef.current) {
          case 'gray':   ctx.fillStyle = `rgb(${L},${L},${L})`; break;
          case 'red':    ctx.fillStyle = `rgb(${L},0,0)`; break;
          case 'green':  ctx.fillStyle = `rgb(0,${L},0)`; break;
          case 'blue':   ctx.fillStyle = `rgb(0,0,${L})`; break;
          case 'amber':  ctx.fillStyle = `rgb(${L},${(lum * 0.6) | 0},0)`; break;
          case 'custom': {
            const { r: cr, g: cg, b: cb } = customColorRef.current;
            ctx.fillStyle = `rgb(${(cr * lum / 255) | 0},${(cg * lum / 255) | 0},${(cb * lum / 255) | 0})`;
            break;
          }
          default: ctx.fillStyle = `rgb(${r},${g},${b})`; break;
        }
        ctx.fillText(ASCII_RAMP[charIdx], tc * charW, tr * charH);
      }
    }
  }

  const renderLoop = useCallback((ts: number) => {
    if (!playingRef.current) return;

    if (!pausedRef.current) {
      const audio = audioRef.current;
      const store = frameStoreRef.current;
      const fps   = fpsRef.current;

      let targetIdx: number;
      if (audio && audio.currentTime > 0) {
        targetIdx = Math.floor(audio.currentTime * fps);
      } else {
        if (playStartRef.current === 0) playStartRef.current = ts;
        targetIdx = Math.floor(((ts - playStartRef.current) / 1000) * fps);
      }

      const frame = store.get(targetIdx) ?? store.get(lastDrawnRef.current + 1);
      const idx   = store.get(targetIdx) ? targetIdx : lastDrawnRef.current + 1;

      if (frame && idx > lastDrawnRef.current) {
        drawFrame(frame);
        lastDrawnRef.current = idx;
        frameNumRef.current  = idx + 1;
        setFrameInfo(`frame ${idx + 1}  ·  buffered ${store.size}`);

        for (let i = idx - 20; i >= 0; i--) {
          if (!store.has(i)) break;
          store.delete(i);
        }
      }

      const total = totalFramesRef.current;
      if (total !== -1 && lastDrawnRef.current >= total - 1) {
        playingRef.current = false;
        audioRef.current?.pause();
        if (recorderRef.current && recorderRef.current.state !== 'inactive') {
          recorderRef.current.stop();
        }
        setStatus({ text: 'Done', kind: 'ok' });
        setShowReplay(true);
        return;
      }
    }

    rafRef.current = requestAnimationFrame(renderLoop);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function resetSession() {
    playingRef.current = false;
    cancelAnimationFrame(rafRef.current);
    frameStoreRef.current.clear();
    allFramesRef.current   = [];
    nextIdxRef.current     = 0;
    lastDrawnRef.current   = -1;
    playStartRef.current   = 0;
    totalFramesRef.current = -1;
    frameNumRef.current    = 0;
    setPaused(false);
    pausedRef.current = false;
    setShowReplay(false);
    setFrameInfo('');
    if (recorderRef.current && recorderRef.current.state !== 'inactive') {
      recorderRef.current.onstop = null;
      recorderRef.current.stop();
    }
    recorderRef.current = null;
    recordChunks.current = [];
    setRecording(false);
    if (audioRef.current) { audioRef.current.pause(); audioRef.current.src = ''; }
  }

  const captureThumbnail = useCallback((file: File) => {
    const objUrl = URL.createObjectURL(file);
    const vid    = document.createElement('video');
    vid.muted    = true;
    vid.preload  = 'metadata';
    vid.src      = objUrl;

    const draw = () => {
      const canvas = canvasRef.current;
      if (!canvas) { URL.revokeObjectURL(objUrl); return; }
      canvas.width  = CANVAS_W;
      canvas.height = CANVAS_H;
      const ctx = canvas.getContext('2d');
      if (!ctx) { URL.revokeObjectURL(objUrl); return; }

      ctx.drawImage(vid, 0, 0, CANVAS_W, CANVAS_H);

      ctx.font = '12px "Courier New", monospace';
      ctx.textBaseline = 'middle';
      ctx.textAlign    = 'left';
      const maxChars = 55;
      const label    = file.name.length > maxChars ? file.name.slice(0, maxChars - 1) + '…' : file.name;
      const tw = ctx.measureText(label).width;
      const ph = 24, px = 16, py = CANVAS_H - 40;
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.beginPath();
      (ctx as CanvasRenderingContext2D & { roundRect(...a: unknown[]): void })
        .roundRect(px, py, tw + 20, ph, 12);
      ctx.fill();
      ctx.fillStyle = '#a1a1aa';
      ctx.fillText(label, px + 10, py + ph / 2);

      URL.revokeObjectURL(objUrl);
    };

    vid.addEventListener('loadedmetadata', () => {
      vid.currentTime = Math.min(0.5, vid.duration * 0.05);
    }, { once: true });
    vid.addEventListener('seeked', draw, { once: true });
    vid.addEventListener('error',  () => URL.revokeObjectURL(objUrl), { once: true });
    vid.load();
  }, []);

  const playFile = useCallback((file: File) => {
    resetSession();
    setFileName(file.name);
    captureThumbnail(file);
    setStatus({ text: 'Connecting…', kind: 'busy' });

    if (!audioCtxRef.current) {
      audioCtxRef.current = new AudioContext();
    } else {
      audioCtxRef.current.resume();
    }

    const wsUrl = WS_URL ?? `ws://${window.location.hostname}:3001`;
    const ws = new WebSocket(wsUrl);
    ws.binaryType = 'arraybuffer';
    wsRef.current = ws;

    ws.onopen = () => {
      setStatus({ text: `Uploading ${file.name}…`, kind: 'busy' });
      ws.send(JSON.stringify({ type: 'upload', filename: file.name }));
      file.arrayBuffer().then((buf) => ws.send(buf));
    };

    ws.onmessage = (ev) => {
      if (ev.data instanceof ArrayBuffer) {
        const frame = new Uint8Array(ev.data);
        frameStoreRef.current.set(nextIdxRef.current++, frame);
        allFramesRef.current.push(frame);
        return;
      }
      const msg = JSON.parse(ev.data as string);
      switch (msg.type) {
        case 'status': setStatus({ text: msg.message, kind: 'busy' }); break;

        case 'audio': {
          const blob = new Blob(
            [Uint8Array.from(atob(msg.data), (c) => c.charCodeAt(0))],
            { type: msg.mimeType }
          );
          if (audioRef.current) {
            audioRef.current.src = URL.createObjectURL(blob);
            audioRef.current.load();
            const ctx = audioCtxRef.current;
            if (ctx && !audioRef.current.dataset.connected) {
              const src       = ctx.createMediaElementSource(audioRef.current);
              const audioDest = ctx.createMediaStreamDestination();
              src.connect(ctx.destination);
              src.connect(audioDest);
              audioDestRef.current = audioDest;
              audioRef.current.dataset.connected = '1';
            }
          }
          break;
        }

        case 'meta': {
          fpsRef.current     = msg.fps;
          playingRef.current = true;
          pausedRef.current  = true;
          setPaused(true);
          rafRef.current = requestAnimationFrame(renderLoop);
          setStatus({ text: `Ready  ·  ${(msg.fps as number).toFixed(2)} fps`, kind: 'ok' });
          break;
        }

        case 'done':
          totalFramesRef.current = nextIdxRef.current;
          setStatus({ text: `Playing  ·  ${fpsRef.current.toFixed(2)} fps`, kind: 'ok' });
          break;

        case 'error':
          playingRef.current = false;
          setStatus({ text: msg.message, kind: 'error' });
          break;
      }
    };

    ws.onerror = () => setStatus({ text: 'Connection error', kind: 'error' });
    ws.onclose = () => { if (playingRef.current) setStatus({ text: 'Connection lost', kind: 'error' }); };
  }, [renderLoop, captureThumbnail]); // eslint-disable-line react-hooks/exhaustive-deps

  const replay = useCallback(() => {
    const frames = allFramesRef.current;
    if (frames.length === 0) return;
    cancelAnimationFrame(rafRef.current);
    frameStoreRef.current.clear();
    frames.forEach((f, i) => frameStoreRef.current.set(i, f));
    lastDrawnRef.current   = -1;
    playStartRef.current   = 0;
    frameNumRef.current    = 0;
    pausedRef.current      = false;
    setPaused(false);
    setShowReplay(false);
    setStatus({ text: `Playing  ·  ${fpsRef.current.toFixed(2)} fps`, kind: 'ok' });
    if (audioRef.current) {
      audioRef.current.currentTime = 0;
      audioRef.current.play().catch(() => {});
    }
    playingRef.current = true;
    rafRef.current = requestAnimationFrame(renderLoop);
  }, [renderLoop]);

  const toggleRecord = useCallback(() => {
    if (recorderRef.current && recorderRef.current.state !== 'inactive') {
      recorderRef.current.stop();
      return;
    }

    const canvas = canvasRef.current;
    if (!canvas) return;

    const fps         = fpsRef.current;
    const videoStream = (canvas as HTMLCanvasElement & { captureStream(fps?: number): MediaStream }).captureStream(fps);
    const audioTracks = audioDestRef.current?.stream.getAudioTracks() ?? [];
    const combined    = new MediaStream([...videoStream.getVideoTracks(), ...audioTracks]);
    const mimeType    = MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus') ? 'video/webm;codecs=vp9,opus' : 'video/webm';
    const recorder    = new MediaRecorder(combined, { mimeType });

    recordChunks.current = [];
    recorder.ondataavailable = (e) => { if (e.data.size > 0) recordChunks.current.push(e.data); };
    recorder.onstop = () => {
      const blob = new Blob(recordChunks.current, { type: 'video/webm' });
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href     = url;
      a.download = `${fileName.replace(/\.[^.]+$/, '') || 'ascii-video'}-clip.webm`;
      a.click();
      URL.revokeObjectURL(url);
      recorderRef.current = null;
      setRecording(false);
    };

    audioCtxRef.current?.resume().then(() => {
      recorder.start();
    }).catch(() => {
      recorder.start();
    });
    recorderRef.current = recorder;
    setRecording(true);

    if (pausedRef.current) {
      pausedRef.current = false;
      setPaused(false);
      playStartRef.current = 0;
      audioRef.current?.play().catch(() => {});
    }
  }, [fileName]); // eslint-disable-line react-hooks/exhaustive-deps

  const togglePause = useCallback(() => {
    if (!playingRef.current) return;
    const next = !pausedRef.current;
    pausedRef.current = next;
    setPaused(next);
    if (audioRef.current) next ? audioRef.current.pause() : audioRef.current.play().catch(() => {});
    if (!next) playStartRef.current = 0;
  }, []);

  const onVolumeChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const v = parseFloat(e.target.value);
    setVolume(v);
    if (audioRef.current) audioRef.current.volume = v;
  }, []);

  const onGranularityChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const v = parseInt(e.target.value, 10);
    granularityRef.current = v;
    setGranularity(v);
  }, []);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) playFile(file);
  }, [playFile]);

  useEffect(() => () => { cancelAnimationFrame(rafRef.current); wsRef.current?.close(); }, []);

  const statusColor = { idle: 'text-zinc-600', busy: 'text-amber-400', ok: 'text-green-400', error: 'text-red-400' }[status.kind];
  const hasFile = !!fileName;

  return (
    <div className="flex flex-col items-center gap-4 w-full" style={{ maxWidth: 960 }}>

      {!hasFile && (
        <div
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          onClick={() => document.getElementById('file-input')?.click()}
          className={`w-full rounded-2xl border border-dashed py-20 flex flex-col items-center gap-5
            cursor-pointer select-none transition-all duration-200
            ${dragging
              ? 'border-green-500/60 bg-green-950/10'
              : 'border-zinc-800 hover:border-zinc-600 hover:bg-zinc-900/20'}`}
        >
          <div className={`w-14 h-14 rounded-2xl flex items-center justify-center transition-colors
            ${dragging ? 'bg-green-950/40' : 'bg-zinc-900'}`}>
            <svg className={`w-6 h-6 transition-colors ${dragging ? 'text-green-400' : 'text-zinc-500'}`}
              fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round"
                d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 7.5m0 0L7.5 12M12 7.5V19.5" />
            </svg>
          </div>
          <div className="text-center">
            <p className={`text-sm font-medium transition-colors ${dragging ? 'text-green-400' : 'text-zinc-400'}`}>
              {dragging ? 'Release to play' : 'Drop a video file here'}
            </p>
            <p className="text-zinc-700 text-xs mt-1.5">or click to browse · MP4 · MKV · MOV · WebM · AVI</p>
          </div>
          {status.text && <p className={`text-xs ${statusColor}`}>{status.text}</p>}
        </div>
      )}

      <input
        id="file-input"
        type="file"
        accept="video/*"
        className="hidden"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) playFile(f); e.target.value = ''; }}
      />

      <canvas
        ref={canvasRef}
        className="w-full rounded-xl bg-black"
        style={{ height: 'auto', display: hasFile ? 'block' : 'none' }}
      />

      {hasFile && (
        <div className="w-full rounded-xl bg-zinc-900/80 border border-zinc-800 px-5 py-4 flex flex-col gap-4 backdrop-blur">

          <div className="flex items-center gap-5">
            <button
              onClick={togglePause}
              title={paused ? 'Resume' : 'Pause'}
              className="w-8 h-8 shrink-0 flex items-center justify-center rounded-lg bg-zinc-800
                hover:bg-zinc-700 text-white text-sm transition-colors"
            >
              {paused ? '▶' : '⏸'}
            </button>

            {showReplay && (
              <button
                onClick={replay}
                title="Replay"
                className="w-8 h-8 shrink-0 flex items-center justify-center rounded-lg
                  bg-green-950/60 hover:bg-green-900/60 text-green-400 text-sm transition-colors
                  border border-green-900/60"
              >
                ↺
              </button>
            )}

            <button
              onClick={toggleRecord}
              title={recording ? 'Stop recording' : 'Record clip'}
              className={`w-8 h-8 shrink-0 flex items-center justify-center rounded-lg text-sm transition-colors
                ${recording
                  ? 'bg-red-600 hover:bg-red-500 text-white'
                  : 'bg-zinc-800 hover:bg-zinc-700 text-red-400'}`}
            >
              {recording ? '⏹' : '⏺'}
            </button>

            <div className="flex-1 flex flex-col gap-1.5">
              <div className="flex justify-between">
                <span className="text-zinc-600 text-xs">Abstract</span>
                <span className="text-zinc-600 text-xs">Detail</span>
              </div>
              <input
                type="range" min={4} max={160} step={4}
                value={granularity} onChange={onGranularityChange}
                className="w-full accent-green-400 cursor-pointer"
                style={{ height: 2 }}
              />
            </div>

            <div className="flex items-center gap-2 shrink-0">
              <svg className="w-3.5 h-3.5 text-zinc-500 shrink-0" fill="currentColor" viewBox="0 0 20 20">
                {volume === 0 ? (
                  <path d="M9.383 3.076A1 1 0 0110 4v12a1 1 0 01-1.617.784L4.5 13H2a1 1 0 01-1-1V8a1 1 0 011-1h2.5l3.883-3.784a1 1 0 011 .076zM14.293 7.293a1 1 0 011.414 0L17 8.586l1.293-1.293a1 1 0 011.414 1.414L18.414 10l1.293 1.293a1 1 0 01-1.414 1.414L17 11.414l-1.293 1.293a1 1 0 01-1.414-1.414L15.586 10l-1.293-1.293a1 1 0 010-1.414z" />
                ) : (
                  <path d="M9.383 3.076A1 1 0 0110 4v12a1 1 0 01-1.617.784L4.5 13H2a1 1 0 01-1-1V8a1 1 0 011-1h2.5l3.883-3.784a1 1 0 011 .076zM12.293 7.293a1 1 0 011.414 0A4 4 0 0115 10a4 4 0 01-1.293 2.707 1 1 0 01-1.414-1.414A2 2 0 0013 10a2 2 0 00-.707-1.293 1 1 0 010-1.414z" />
                )}
              </svg>
              <input
                type="range" min={0} max={1} step={0.01}
                value={volume} onChange={onVolumeChange}
                className="w-20 accent-green-400 cursor-pointer"
                style={{ height: 2 }}
              />
            </div>
          </div>

          <div className="h-px bg-zinc-800" />

          <div className="flex items-center gap-4">
            <span className="text-zinc-600 text-xs shrink-0">Color</span>

            <div className="flex items-center gap-2 flex-1">
              {COLOR_MODES.map(({ mode, label, swatch }) => (
                <button
                  key={mode}
                  onClick={() => { colorModeRef.current = mode; setColorMode(mode); }}
                  title={label}
                  className={`w-4 h-4 rounded-full shrink-0 transition-all duration-150
                    ${colorMode === mode
                      ? 'ring-2 ring-white/60 ring-offset-2 ring-offset-zinc-900 scale-110'
                      : 'opacity-50 hover:opacity-100 hover:scale-110'}`}
                  style={{ background: swatch === 'transparent'
                    ? 'conic-gradient(red,yellow,lime,cyan,blue,magenta,red)'
                    : swatch }}
                />
              ))}

              <label
                title="Pick a custom colour"
                className={`relative flex items-center gap-1.5 px-2.5 h-5 rounded-full cursor-pointer
                  border transition-all duration-150 shrink-0
                  ${colorMode === 'custom'
                    ? 'border-white/50 opacity-100'
                    : 'border-zinc-600 opacity-60 hover:opacity-100'}`}
                style={{ background: colorMode === 'custom' ? customColor + '28' : 'transparent' }}
              >
                <span className="w-2 h-2 rounded-full shrink-0 border border-white/25" style={{ background: customColor }} />
                <svg className="w-2.5 h-2.5 text-zinc-400 shrink-0" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L6.832 19.82a4.5 4.5 0 01-1.897 1.13l-2.685.8.8-2.685a4.5 4.5 0 011.13-1.897L16.863 4.487z" />
                </svg>
                <span className="text-zinc-400 text-[10px] leading-none select-none">Custom</span>
                <input
                  type="color"
                  value={customColor}
                  onChange={(e) => {
                    const hex = e.target.value;
                    setCustomColor(hex);
                    customColorRef.current = {
                      r: parseInt(hex.slice(1, 3), 16),
                      g: parseInt(hex.slice(3, 5), 16),
                      b: parseInt(hex.slice(5, 7), 16),
                    };
                    colorModeRef.current = 'custom';
                    setColorMode('custom');
                  }}
                  className="absolute inset-0 opacity-0 w-full h-full cursor-pointer"
                />
              </label>
            </div>

            {status.text && <span className={`text-xs shrink-0 ${statusColor}`}>{status.text}</span>}

            <div className="flex items-center gap-3 shrink-0">
              <span className="text-zinc-700 text-xs truncate max-w-[140px]">{fileName}</span>
              <button
                onClick={() => document.getElementById('file-input')?.click()}
                className="text-xs text-zinc-500 hover:text-zinc-200 transition-colors"
              >
                Open new ↑
              </button>
            </div>
          </div>

        </div>
      )}

      <audio ref={audioRef} className="hidden" />
    </div>
  );
}
