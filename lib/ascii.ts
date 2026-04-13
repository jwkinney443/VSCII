/**
 * Wrap a raw RGB24 buffer in a minimal frame message.
 * Format: [cols_hi, cols_lo, rows_hi, rows_lo,  r, g, b,  r, g, b, …]
 *
 * The ASCII character mapping now happens client-side so the granularity
 * slider can change density in real time without touching the pipeline.
 */
export function rgbToFrameMsg(raw: Buffer, cols: number, rows: number): Buffer {
  const out = Buffer.allocUnsafe(4 + raw.length);
  out.writeUInt16BE(cols, 0);
  out.writeUInt16BE(rows, 2);
  raw.copy(out, 4);
  return out;
}
