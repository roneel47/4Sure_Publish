
import type { Server as HTTPServer } from 'http';
import type { Socket as NetSocket } from 'net';
import type { NextApiRequest, NextApiResponse } from 'next';
import { Server as SocketIOServer, Socket } from 'socket.io';
import type { GameRoom, PlayerData, Guess, MultiplayerGameStatus } from '@/types/game'; // GameRoom will represent the structure in DB
import { CODE_LENGTH, calculateFeedback, checkWin } from '@/lib/gameLogic';
// import { MongoClient } from 'mongodb'; // You'll need to import MongoClient

interface NextApiResponseWithSocket extends NextApiResponse {
  socket: NetSocket & {
    server: HTTPServer & {
      io?: SocketIOServer;
    };
  };
}

// TODO: Initialize MongoDB Client and connect to your database
// const MONGODB_URI = process.env.MONGODB_URI; // Make sure MONGODB_URI is in .env.local
// if (!MONGODB_URI) {
//   throw new Error('Please define the MONGODB_URI environment variable inside .env.local');
// }
// let db; // MongoClient instance's db connection
// (async () => {
//   try {
//     const client = await MongoClient.connect(MONGODB_URI);
//     db = client.db(); // Or client.db("yourDbName") if not in URI
//     console.log("Successfully connected to MongoDB.");
//   } catch (error) {
//     console.error("Error connecting to MongoDB:", error);
//     process.exit(1); // Exit if DB connection fails
//   }
// })();

const getPlayerCountNumber = (playerCountString: string): number => {
  if (playerCountString === 'duo') return 2;
  if (playerCountString === 'trio') return 3;
  if (playerCountString === 'quads') return 4;
  return 0;
};

// Helper function to fetch a game room from DB (example)
async function getGameRoom(gameId: string): Promise<GameRoom | null> {
  // TODO: Implement MongoDB findOne query
  // e.g., return await db.collection('gameRooms').findOne({ gameId });
  console.warn(`MongoDB: getGameRoom for ${gameId} not implemented. Returning null.`);
  return null;
}

// Helper function to create/update a game room in DB (example)
async function updateGameRoom(gameId: string, roomData: Partial<GameRoom>): Promise<GameRoom | null> {
  // TODO: Implement MongoDB updateOne query with upsert
  // e.g., const result = await db.collection('gameRooms').updateOne({ gameId }, { $set: roomData }, { upsert: true });
  // return await getGameRoom(gameId); // return the updated room
  console.warn(`MongoDB: updateGameRoom for ${gameId} not implemented. Data:`, roomData);
  return roomData as GameRoom; // Placeholder
}


async function initializePlayerInRoom(room: GameRoom, playerId: string, socketId: string): Promise<GameRoom> {
  if (!room.players[playerId]) {
    room.players[playerId] = { socketId, guessesMade: [], guessesAgainst: [] };
  } else {
    room.players[playerId].socketId = socketId; // Update socket ID on reconnect
  }
  // No direct DB update here, assumed to be part of a larger updateGameRoom call
  return room;
}


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

        socket.on('disconnect', async () => {
          console.log('Socket disconnected:', socket.id);
          // TODO: Handle player disconnection more robustly
          // This might involve finding which game room the socket was in,
          // marking the player as inactive, or notifying other players.
          // For example:
          // const gameId = findGameIdForSocket(socket.id); // You'd need a way to track this
          // if (gameId) {
          //   const room = await getGameRoom(gameId);
          //   if (room) {
          //      const disconnectedPlayerId = Object.keys(room.players).find(pid => room.players[pid].socketId === socket.id);
          //      // ... update room status, notify others ...
          //      // await updateGameRoom(gameId, room);
          //   }
          // }
        });

        socket.on('join-game', async (data: { gameId: string; playerCount: string; rejoiningPlayerId?: string }) => {
          const { gameId, playerCount: playerCountString, rejoiningPlayerId } = data;
          const numPlayerCount = getPlayerCountNumber(playerCountString);

          if (!numPlayerCount) {
            socket.emit('error-event', { message: 'Invalid player count specified.' });
            return;
          }

          socket.join(gameId);
          console.log(`Socket ${socket.id} attempting to join game room: ${gameId} as ${playerCountString} (${numPlayerCount} players)`);
          
          let room = await getGameRoom(gameId);

          if (!room) {
            room = {
              gameId,
              playerCount: numPlayerCount,
              players: {},
              status: 'WAITING_FOR_PLAYERS',
              secretsSetCount: 0,
              targetMap: {}, // Will be set when game starts
              turn: undefined,
              winner: undefined,
            };
            console.log(`New game room ${gameId} to be created for ${numPlayerCount} players.`);
            // The room will be formally created/updated in DB after player assignment
          } else {
             console.log(`Game room ${gameId} found. Status: ${room.status}`);
          }

          let assignedPlayerId: string | undefined = rejoiningPlayerId; // Try rejoining ID first
          
          if (assignedPlayerId && room.players[assignedPlayerId]) {
             room.players[assignedPlayerId].socketId = socket.id; // Update socket ID for rejoining player
          } else { // New player or rejoiningPlayerId not found/valid
            assignedPlayerId = undefined; // Reset if rejoiningPlayerId was not valid
            if (Object.keys(room.players).length >= room.playerCount && !Object.values(room.players).some(p => p.socketId === socket.id)) {
              socket.emit('error-event', { message: 'Game room is full.' });
              socket.leave(gameId);
              return;
            }
            // Assign a new player ID if not already assigned
            for (let i = 1; i <= room.playerCount; i++) {
              const potentialPlayerId = `player${i}`;
              if (!room.players[potentialPlayerId]) {
                assignedPlayerId = potentialPlayerId;
                break;
              }
            }
          }
          
          if (assignedPlayerId) {
            room = await initializePlayerInRoom(room, assignedPlayerId, socket.id);
            const updatedRoom = await updateGameRoom(gameId, room); // Persist the new/updated player
            
            if (!updatedRoom) {
                socket.emit('error-event', { message: 'Failed to update game room data.' });
                return;
            }
            room = updatedRoom; // Use the returned (potentially merged) room data

            console.log(`Socket ${socket.id} assigned/confirmed as ${assignedPlayerId} in game ${gameId}`);
            socket.emit('player-assigned', { playerId: assignedPlayerId, gameId });
            io.to(gameId).emit('player-joined', { playerId: assignedPlayerId, playerCount: Object.keys(room.players).length, totalPlayerCount: room.playerCount });

            // Emit current full game state to all players in the room, especially for new/rejoining ones
            io.to(gameId).emit('game-state-update', room);
            
            if (Object.keys(room.players).length === room.playerCount && room.status === 'WAITING_FOR_PLAYERS') {
              room.status = 'ALL_PLAYERS_JOINED';
              io.to(gameId).emit('all-players-joined', { gameId });
              console.log(`All ${room.playerCount} players joined game ${gameId}. Moving to secret setting.`);
              room.status = 'SETTING_SECRETS';
              await updateGameRoom(gameId, { status: room.status });
            }
          } else {
             console.log(`Could not assign player ID to socket ${socket.id} in game ${gameId}.`);
             socket.emit('error-event', { message: 'Could not join game. No available player slot.' });
          }
        });

        socket.on('send-secret', async (data: { gameId: string; playerId: string; secret: string[] }) => {
          const { gameId, playerId, secret } = data;
          let room = await getGameRoom(gameId);

          if (room && room.players[playerId] && (room.status === 'SETTING_SECRETS' || room.status === 'ALL_PLAYERS_JOINED')) {
            room.players[playerId].secret = secret;
            room.secretsSetCount = Object.values(room.players).filter(p => !!p.secret).length;

            console.log(`Secret received from ${playerId} for game ${gameId}. Total secrets set: ${room.secretsSetCount}/${room.playerCount}`);
            
            // Persist changes
            const updatedRoom = await updateGameRoom(gameId, { 
                players: room.players, 
                secretsSetCount: room.secretsSetCount 
            });
            if (!updatedRoom) { socket.emit('error-event', { message: 'Failed to save secret.'}); return; }
            room = updatedRoom;

            io.to(gameId).emit('secret-update', { playerId, secretSet: true, secretsCurrentlySet: room.secretsSetCount, totalPlayers: room.playerCount });
            // Also emit full state update as secretsSetCount changed
            io.to(gameId).emit('game-state-update', room);


            if (room.secretsSetCount === room.playerCount) {
              console.log(`All secrets set for game ${gameId}. Starting game.`);
              room.status = 'IN_PROGRESS';
              
              const playerIds = Object.keys(room.players).sort();
              if (room.playerCount === 2) {
                 room.targetMap = { [playerIds[0]]: playerIds[1], [playerIds[1]]: playerIds[0] };
                 room.turn = playerIds[0]; 
              } else { /* TODO: Implement targetMap for Trio/Quads */ }
              
              await updateGameRoom(gameId, { status: room.status, targetMap: room.targetMap, turn: room.turn });
              io.to(gameId).emit('game-start', { gameId, startingPlayer: room.turn!, targetMap: room.targetMap! });
              // Emit game-state-update again as status, turn, targetMap changed
              io.to(gameId).emit('game-state-update', room);
            }
          } else {
            console.log(`Invalid send-secret: game ${gameId}, player ${playerId}, room status ${room?.status}`);
            socket.emit('error-event', { message: 'Cannot set secret at this time or invalid player/game.' });
          }
        });
        
        socket.on('make-guess', async (data: { gameId: string; playerId: string; guess: string[] }) => {
          const { gameId, playerId, guess: guessArray } = data;
          let room = await getGameRoom(gameId);

          if (!room || room.status !== 'IN_PROGRESS') {
            socket.emit('error-event', { message: 'Game not in progress.' }); return;
          }
          if (room.turn !== playerId) {
            socket.emit('error-event', { message: 'Not your turn.' }); return;
          }
          
          const targetPlayerId = room.targetMap?.[playerId];
          if (!targetPlayerId || !room.players[targetPlayerId]?.secret) {
            socket.emit('error-event', { message: 'Target player or their secret not found.' }); return;
          }

          const targetSecret = room.players[targetPlayerId]!.secret!;
          const feedback = calculateFeedback(guessArray, targetSecret);
          const guessObject: Guess = { value: guessArray.join(''), feedback };

          if (!room.players[playerId].guessesMade) room.players[playerId].guessesMade = [];
          room.players[playerId].guessesMade!.push(guessObject);

          if (!room.players[targetPlayerId].guessesAgainst) room.players[targetPlayerId].guessesAgainst = [];
          room.players[targetPlayerId].guessesAgainst!.push(guessObject);
          
          console.log(`Player ${playerId} guessed ${guessArray.join('')} against ${targetPlayerId} in game ${gameId}. Feedback: ${feedback.join(',')}`);
          
          let updatedRoomData: Partial<GameRoom> = { players: room.players };

          if (checkWin(feedback)) {
            room.status = 'GAME_OVER';
            room.winner = playerId;
            updatedRoomData = { ...updatedRoomData, status: room.status, winner: room.winner };
            console.log(`Game ${gameId} over. Winner: ${playerId}`);
          } else {
            const playerIds = Object.keys(room.players).sort();
            const currentPlayerIndex = playerIds.indexOf(playerId);
            room.turn = playerIds[(currentPlayerIndex + 1) % playerIds.length];
            updatedRoomData = { ...updatedRoomData, turn: room.turn };
            console.log(`Game ${gameId} turn switched to ${room.turn}`);
          }

          const finalUpdatedRoom = await updateGameRoom(gameId, updatedRoomData);
          if (!finalUpdatedRoom) { socket.emit('error-event', { message: 'Failed to update game after guess.'}); return; }
          
          // Emit specific events first for immediate UI reaction
          io.to(gameId).emit('guess-feedback', { gameId, guessingPlayerId: playerId, targetPlayerId, guess: guessObject });
          if (finalUpdatedRoom.status === 'GAME_OVER') {
            io.to(gameId).emit('game-over', { gameId, winner: finalUpdatedRoom.winner! });
          } else {
            io.to(gameId).emit('turn-update', { gameId, nextPlayerId: finalUpdatedRoom.turn! });
          }
          // Then emit the full state for consistency / catch-up
          io.to(gameId).emit('game-state-update', finalUpdatedRoom);

        });

      });
    }
    res.status(200).json({ message: 'Socket.IO server initialized or already running.' });
  } else {
    res.setHeader('Allow', ['POST']);
    res.status(405).end(`Method ${req.method} Not Allowed`);
  }
}

