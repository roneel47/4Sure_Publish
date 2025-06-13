
import type { Server as HTTPServer } from 'http';
import type { Socket as NetSocket } from 'net';
import type { NextApiRequest, NextApiResponse } from 'next';
import { Server as SocketIOServer, Socket } from 'socket.io';
import type { GameRoom, GameRoomsStore, PlayerData } from '@/types/game';
import { CODE_LENGTH, calculateFeedback, checkWin } from '@/lib/gameLogic';

interface NextApiResponseWithSocket extends NextApiResponse {
  socket: NetSocket & {
    server: HTTPServer & {
      io?: SocketIOServer;
    };
  };
}

const gameRooms: GameRoomsStore = {};

const getPlayerCountNumber = (playerCountString: string): number => {
  if (playerCountString === 'duo') return 2;
  if (playerCountString === 'trio') return 3;
  if (playerCountString === 'quads') return 4;
  return 0;
};

export default function handler(
  req: NextApiRequest,
  res: NextApiResponseWithSocket
) {
  if (req.method === 'POST') {
    if (res.socket.server.io) {
      console.log('Socket.IO server already running.');
    } else {
      console.log('Initializing Socket.IO server...');
      const io = new SocketIOServer(res.socket.server, {
        path: '/api/socketio_c',
        addTrailingSlash: false,
      });
      res.socket.server.io = io;

      io.on('connection', (socket: Socket) => {
        console.log('Socket connected:', socket.id);

        socket.on('disconnect', () => {
          console.log('Socket disconnected:', socket.id);
          // Handle player disconnection from rooms if necessary
          // For simplicity, not fully implemented here
          for (const gameId in gameRooms) {
            const room = gameRooms[gameId];
            Object.keys(room.players).forEach(playerId => {
              if (room.players[playerId].socketId === socket.id) {
                console.log(`Player ${playerId} (${socket.id}) disconnected from game ${gameId}`);
                // Potentially remove player or mark as disconnected, notify others
                // delete room.players[playerId]; // Simplistic removal
                // io.to(gameId).emit('player-disconnected', playerId);
              }
            });
          }
        });

        socket.on('join-game', (data: { gameId: string; playerCount: string /* "duo", "trio", etc. */ }) => {
          const { gameId, playerCount: playerCountString } = data;
          const numPlayerCount = getPlayerCountNumber(playerCountString);

          if (!numPlayerCount) {
            socket.emit('error-event', { message: 'Invalid player count specified.' });
            return;
          }

          socket.join(gameId);
          console.log(`Socket ${socket.id} attempting to join game room: ${gameId} as ${playerCountString} (${numPlayerCount} players)`);

          if (!gameRooms[gameId]) {
            gameRooms[gameId] = {
              gameId,
              playerCount: numPlayerCount,
              players: {},
              status: 'WAITING_FOR_PLAYERS',
              secretsSetCount: 0,
            };
            console.log(`New game room ${gameId} created for ${numPlayerCount} players.`);
          }

          const room = gameRooms[gameId];

          if (Object.keys(room.players).length >= room.playerCount && !Object.values(room.players).find(p=>p.socketId === socket.id)) {
            socket.emit('error-event', { message: 'Game room is full.' });
            socket.leave(gameId); // Make sure they leave if they can't join
            return;
          }
          
          // Assign player ID if not already assigned to this socket
          let assignedPlayerId: string | undefined = Object.keys(room.players).find(pid => room.players[pid].socketId === socket.id);

          if (!assignedPlayerId) {
            for (let i = 1; i <= room.playerCount; i++) {
              const potentialPlayerId = `player${i}`;
              if (!room.players[potentialPlayerId]) {
                assignedPlayerId = potentialPlayerId;
                room.players[assignedPlayerId] = { socketId: socket.id, guessesMade: [], guessesAgainst: [] };
                break;
              }
            }
          }


          if (assignedPlayerId) {
            console.log(`Socket ${socket.id} assigned as ${assignedPlayerId} in game ${gameId}`);
            socket.emit('player-assigned', { playerId: assignedPlayerId, gameId });
            io.to(gameId).emit('player-joined', { playerId: assignedPlayerId, playerCount: Object.keys(room.players).length, totalPlayerCount: room.playerCount });


            if (Object.keys(room.players).length === room.playerCount && room.status === 'WAITING_FOR_PLAYERS') {
              room.status = 'ALL_PLAYERS_JOINED'; // Or directly to SETTING_SECRETS
              io.to(gameId).emit('all-players-joined', { gameId });
              console.log(`All ${room.playerCount} players joined game ${gameId}. Moving to secret setting.`);
              room.status = 'SETTING_SECRETS';
            }
          } else {
             console.log(`Could not assign player ID to socket ${socket.id} in game ${gameId}. Room might be full or error in logic.`);
             socket.emit('error-event', { message: 'Could not join game. Room might be full or an error occurred.' });
          }
        });

        socket.on('send-secret', (data: { gameId: string; playerId: string; secret: string[] }) => {
          const { gameId, playerId, secret } = data;
          const room = gameRooms[gameId];

          if (room && room.players[playerId] && room.status === 'SETTING_SECRETS') {
            if (room.players[playerId].secret) {
                console.log(`Player ${playerId} in game ${gameId} tried to set secret again.`);
                socket.emit('error-event', { message: 'You have already set your secret.' });
                return;
            }
            room.players[playerId].secret = secret;
            room.secretsSetCount = (room.secretsSetCount || 0) + 1;
            console.log(`Secret received from ${playerId} for game ${gameId}. Total secrets set: ${room.secretsSetCount}/${room.playerCount}`);
            
            // Notify others that this player has set their secret (but not the secret itself)
            io.to(gameId).emit('secret-update', { playerId, secretSet: true, secretsCurrentlySet: room.secretsSetCount, totalPlayers: room.playerCount });

            if (room.secretsSetCount === room.playerCount) {
              console.log(`All secrets set for game ${gameId}. Starting game.`);
              room.status = 'IN_PROGRESS';
              // For Duo mode: player1 targets player2, player2 targets player1
              if (room.playerCount === 2) {
                 room.targetMap = { player1: 'player2', player2: 'player1' };
                 room.turn = 'player1'; // Player 1 starts
              } else {
                // TODO: Implement target logic for Trio/Quads
              }
              io.to(gameId).emit('game-start', { gameId, startingPlayer: room.turn, targetMap: room.targetMap });
            }
          } else {
            console.log(`Invalid send-secret: game ${gameId}, player ${playerId}, room status ${room?.status}`);
            socket.emit('error-event', { message: 'Cannot set secret at this time or invalid player/game.' });
          }
        });
        
        socket.on('make-guess', (data: { gameId: string; playerId: string; guess: string[] }) => {
          const { gameId, playerId, guess } = data;
          const room = gameRooms[gameId];

          if (!room || room.status !== 'IN_PROGRESS' || room.turn !== playerId) {
            socket.emit('error-event', { message: 'Not your turn or game not in progress.' });
            return;
          }
          
          const targetPlayerId = room.targetMap?.[playerId];
          if (!targetPlayerId || !room.players[targetPlayerId]?.secret) {
            socket.emit('error-event', { message: 'Target player or secret not found.' });
            return;
          }

          const targetSecret = room.players[targetPlayerId]!.secret!;
          const feedback = calculateFeedback(guess, targetSecret);
          const guessObject: Guess = { value: guess.join(''), feedback };

          // Store guess for the guessing player
          if (!room.players[playerId].guessesMade) room.players[playerId].guessesMade = [];
          room.players[playerId].guessesMade!.push(guessObject);

          // Store guess for the target player (as guess against them)
          if (!room.players[targetPlayerId].guessesAgainst) room.players[targetPlayerId].guessesAgainst = [];
          room.players[targetPlayerId].guessesAgainst!.push(guessObject);


          console.log(`Player ${playerId} guessed ${guess.join('')} against ${targetPlayerId} in game ${gameId}. Feedback: ${feedback}`);
          io.to(gameId).emit('guess-feedback', {
            gameId,
            guessingPlayerId: playerId,
            targetPlayerId: targetPlayerId,
            guess: guessObject,
          });

          if (checkWin(feedback)) {
            room.status = 'GAME_OVER';
            room.winner = playerId;
            io.to(gameId).emit('game-over', { gameId, winner: playerId });
            console.log(`Game ${gameId} over. Winner: ${playerId}`);
          } else {
            // Switch turn
            const playerIds = Object.keys(room.players).sort(); // e.g. ["player1", "player2"]
            const currentPlayerIndex = playerIds.indexOf(playerId);
            room.turn = playerIds[(currentPlayerIndex + 1) % playerIds.length];
            io.to(gameId).emit('turn-update', { gameId, nextPlayerId: room.turn });
            console.log(`Game ${gameId} turn switched to ${room.turn}`);
          }
        });

      });
    }
    res.status(200).json({ message: 'Socket.IO server initialized or already running.' });
  } else {
    res.setHeader('Allow', ['POST']);
    res.status(405).end(`Method ${req.method} Not Allowed`);
  }
}
