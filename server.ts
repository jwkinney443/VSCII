import { createServer } from 'http';
import next from 'next';
import { attachWebSocketServer } from './lib/ws-server';

const dev  = process.env.NODE_ENV !== 'production';
const port = parseInt(process.env.PORT ?? '3000', 10);

const app    = next({ dev });
const handle = app.getRequestHandler();

app.prepare().then(() => {
  const server = createServer((req, res) => handle(req, res));
  attachWebSocketServer(server);
  server.listen(port, () => console.log(`> Ready on http://localhost:${port}`));
});
