import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'net';
import type { IncomingMessage } from 'http';
import { pipelineFromBuffer } from './pipeline';

export function attachWebSocketServer(server: Server) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 500 * 1024 * 1024 });

  server.on('upgrade', (req: IncomingMessage, socket, head) => {
    if (req.url === '/ws') {
      wss.handleUpgrade(req, socket as never, head, (ws) => wss.emit('connection', ws, req));
    }
  });

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

  console.log('  WebSocket server  →  /ws');
}
