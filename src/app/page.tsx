import AsciiPlayer from '@/components/AsciiPlayer';

export default function Home() {
  return (
    <main className="flex min-h-screen flex-col items-center px-4 py-10 gap-6">

      <div className="flex flex-col items-center gap-3">
        <div className="flex items-center gap-1.5">
          {['V', 'S', 'C', 'I', 'I'].map((ch, i) => (
            <div
              key={i}
              className="w-10 h-12 flex items-center justify-center
                border border-green-900/60 bg-green-950/20 rounded-sm
                text-green-400 font-mono text-2xl font-bold select-none"
              style={{ textShadow: '0 0 12px rgba(74,222,128,0.7)' }}
            >
              {ch}
            </div>
          ))}
        </div>
        <p className="text-zinc-600 text-xs tracking-widest uppercase">ASCII video player</p>
      </div>

      <AsciiPlayer />
    </main>
  );
}
