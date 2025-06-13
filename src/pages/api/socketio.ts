
import type { Server as HTTPServer } from 'http';
import type { Socket as NetSocket } from 'net';
import type { NextApiRequest, NextApiResponse } from 'next';
import { Server as SocketIOServer, Socket } from 'socket.io';

// Extend NextApiResponse to include the socket server
interface NextApiResponseWithSocket extends NextApiResponse {
  socket: NetSocket & {
    server: HTTPServer & {
      io?: SocketIOServer;
    };
  };
}

// This is a common pattern to attach Socket.IO to the Next.js dev server.
// For production, a custom server (server.js) or a dedicated WebSocket service is often preferred.
export default function handler(
  req: NextApiRequest,
  res: NextApiResponseWithSocket
) {
  if (req.method === 'POST') { // We'll use POST from client to ensure initialization
    if (res.socket.server.io) {
      console.log('Socket.IO server already running.');
    } else {
      console.log('Initializing Socket.IO server...');
      const io = new SocketIOServer(res.socket.server, {
        path: '/api/socketio_c', // Custom path for socket.io
        addTrailingSlash: false,
      });
      res.socket.server.io = io;

      io.on('connection', (socket: Socket) => {
        console.log('Socket connected:', socket.id);

        socket.on('disconnect', () => {
          console.log('Socket disconnected:', socket.id);
        });

        socket.on('join-game', (gameId: string) => {
          socket.join(gameId);
          console.log(`Socket ${socket.id} joined game room: ${gameId}`);
          // Acknowledge joining the room back to the client
          socket.emit('joined-room', gameId);
        });

        // Handle receiving a secret from a player
        socket.on('send-secret', (data: { gameId: string; playerId: string; secret: string[] }) => {
          console.log(`Secret received on server from ${data.playerId} for game ${data.gameId}:`, data.secret);
          // For now, we're not storing it persistently on the server in this step.
          // We just broadcast that this player has set their secret.
          // In a real app, you'd store this (e.g., in-memory store per room, or DB).
          io.to(data.gameId).emit('secret-update', { playerId: data.playerId, secretSet: true });
          // Potentially, add logic here to check if all players in data.gameId have submitted secrets
          // and then emit an 'all-secrets-ready' or 'start-game' event.
        });

        // Placeholder for future events like 'make-guess', etc.
      });
    }
    res.status(200).json({ message: 'Socket.IO server initialized or already running.' });
  } else {
    res.setHeader('Allow', ['POST']);
    res.status(405).end(`Method ${req.method} Not Allowed`);
  }
}

// It's important to export a config object for this API route
// if you want to disable the default body parser, which can interfere with Socket.IO.
// However, for just initialization via POST, default body parser is fine.
// export const config = {
//   api: {
//     bodyParser: false,
//   },
// };

