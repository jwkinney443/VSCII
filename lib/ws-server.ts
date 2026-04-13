import { WebSocketServer, WebSocket } from 'ws';
import { pipelineFromBuffer } from './pipeline';

const port = parseInt(process.env.WS_PORT ?? '3001', 10);

const wss = new WebSocketServer({ port, maxPayload: 500 * 1024 * 1024 }); // 500 MB

wss.on('connection', (ws: WebSocket) => {
  let pendingFilename: string | null = null;

  ws.on('message', async (data, isBinary) => {
    try {
      if (isBinary) {
        const filename  = pendingFilename ?? 'upload.mp4';
        pendingFilename = null;
        await pipelineFromBuffer(ws, data as Buffer, filename);
        return;
      }

      const msg = JSON.parse((data as Buffer).toString()) as { type: string; filename?: string };
      if (msg.type === 'upload' && msg.filename) pendingFilename = msg.filename;
    } catch (err) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'error', message: String(err) }));
      }
    }
  });
});

wss.on('listening', () => console.log(`  WebSocket server  →  ws://localhost:${port}`));
