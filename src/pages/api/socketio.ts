
import type { Server as HTTPServer } from 'http';
import type { Socket as NetSocket } from 'net';
import type { NextApiRequest, NextApiResponse } from 'next';
import { Server as SocketIOServer, Socket } from 'socket.io';
import type { GameRoom, PlayerData, Guess, MultiplayerGameStatus } from '@/types/game';
import { CODE_LENGTH, calculateFeedback, checkWin } from '@/lib/gameLogic';
import { MongoClient } from 'mongodb';
import type { Db } from 'mongodb';

interface NextApiResponseWithSocket extends NextApiResponse {
  socket: NetSocket & {
    server: HTTPServer & {
      io?: SocketIOServer;
    };
  };
}

const MONGODB_URI = process.env.MONGODB_URI;
let db: Db | null = null;

(async () => {
  if (!MONGODB_URI) {
    console.warn('MONGODB_URI not found in environment variables. Database operations will not be available.');
    return;
  }
  try {
    const client = new MongoClient(MONGODB_URI);
    await client.connect();
    // Attempt to derive DB name from URI or use a default. Adjust 'yourDefaultDbName' as needed.
    const dbNameFromUri = new URL(MONGODB_URI).pathname.substring(1);
    const databaseName = dbNameFromUri || "4sureDB"; // Default DB name if not in URI path
    
    db = client.db(databaseName);
    console.log(`Successfully connected to MongoDB. Database: ${databaseName}`);
  } catch (error) {
    console.error("Error connecting to MongoDB:", error);
    // In a Next.js API route context, process.exit() is not appropriate.
    // The server will continue running, but 'db' will remain null.
  }
})();


const getPlayerCountNumber = (playerCountString: string): number => {
  if (playerCountString === 'duo') return 2;
  if (playerCountString === 'trio') return 3;
  if (playerCountString === 'quads') return 4;
  return 0; // Should ideally not happen with UI constraints
};

async function getGameRoom(gameId: string): Promise<GameRoom | null> {
  if (!db) {
    console.warn(`MongoDB: db instance not available. Cannot getGameRoom for ${gameId}.`);
    return null;
  }
  try {
    // TODO: Implement MongoDB findOne query. Collection name e.g., 'gameRooms'.
    // Ensure the gameId field is indexed in your MongoDB collection for performance.
    const roomDocument = await db.collection<GameRoom>('gameRooms').findOne({ gameId: gameId });
    if (roomDocument) {
        console.log(`MongoDB: Fetched game room ${gameId}`);
        // MongoDB's _id is not part of GameRoom, so we can directly return, or omit _id if needed.
        // const { _id, ...roomData } = roomDocument; return roomData;
        return roomDocument;
    }
    console.log(`MongoDB: Game room ${gameId} not found.`);
    return null;
  } catch (error) {
    console.error(`MongoDB: Error fetching game room ${gameId}:`, error);
    return null;
  }
}

async function updateGameRoom(gameId: string, roomData: Partial<GameRoom>): Promise<GameRoom | null> {
  if (!db) {
    console.warn(`MongoDB: db instance not available. Cannot updateGameRoom for ${gameId}.`);
    // To allow some local testing if DB is down, you might return a merged object:
    // return { gameId, playerCount: 0, players: {}, status: 'WAITING_FOR_PLAYERS', secretsSetCount: 0, ...roomData } as GameRoom;
    return null;
  }
  try {
    // TODO: Implement MongoDB updateOne query with upsert.
    // This example assumes roomData contains all necessary fields for an insert if the room is new.
    // For a new room, ensure roomData includes initial structure like playerCount, players: {}, status, etc.
    const filter = { gameId: gameId };
    
    // For an upsert, if the document is inserted, $set will apply.
    // You might want to use $setOnInsert for fields that should only be set on creation.
    const updateDocument = {
      $set: roomData,
      $setOnInsert: { gameId: gameId } // Basic $setOnInsert
    };
    
    const result = await db.collection<GameRoom>('gameRooms').updateOne(filter, updateDocument, { upsert: true });
    
    console.log(`MongoDB: Update operation for game room ${gameId}. Matched: ${result.matchedCount}, Modified: ${result.modifiedCount}, UpsertedId: ${result.upsertedId}`);
    
    return await getGameRoom(gameId); // Fetch and return the potentially modified/created room.
  } catch (error) {
    console.error(`MongoDB: Error updating game room ${gameId}:`, error);
    return null;
  }
}

async function initializePlayerInRoom(room: GameRoom, playerId: string, socketId: string): Promise<GameRoom> {
  // This function modifies the room object in memory; it doesn't directly save to DB.
  // The caller (e.g., in 'join-game') is responsible for calling updateGameRoom.
  if (!room.players[playerId]) {
    room.players[playerId] = { socketId, guessesMade: [], guessesAgainst: [] };
  } else {
    // Player is rejoining, update their socketId
    room.players[playerId].socketId = socketId;
  }
  return room; // Return the modified room object
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
          // TODO: Robust disconnect handling (e.g., find game, update player status, notify others)
          // This would involve querying the database for rooms containing this socket.id
        });

        socket.on('join-game', async (data: { gameId: string; playerCount: string; rejoiningPlayerId?: string }) => {
          const { gameId, playerCount: playerCountString, rejoiningPlayerId } = data;
          const numPlayerCount = getPlayerCountNumber(playerCountString);

          if (!numPlayerCount) {
            socket.emit('error-event', { message: 'Invalid player count specified.' });
            return;
          }

          socket.join(gameId);
          console.log(`Socket ${socket.id} attempting to join game: ${gameId} (${playerCountString})`);

          let room = await getGameRoom(gameId);
          let assignedPlayerId: string | undefined = rejoiningPlayerId;

          if (!room) { // Room doesn't exist, try to create it
            if (Object.keys(global.PLAYER_ID_SOCKET_MAP?.[gameId] || {}).length >= numPlayerCount && !rejoiningPlayerId) {
                 socket.emit('error-event', { message: 'Game room is full (new room scenario).' });
                 socket.leave(gameId);
                 return;
            }
            console.log(`Game room ${gameId} not found in DB. Attempting to create for ${numPlayerCount} players.`);
            room = {
              gameId,
              playerCount: numPlayerCount,
              players: {},
              status: 'WAITING_FOR_PLAYERS',
              secretsSetCount: 0,
              targetMap: {},
              turn: undefined,
              winner: undefined,
            };
            // Player ID assignment for a new room
            if (!assignedPlayerId) {
                assignedPlayerId = `player${Object.keys(room.players).length + 1}`;
            }
          } else { // Room exists
            console.log(`Game room ${gameId} found. Status: ${room.status}`);
            if (assignedPlayerId && room.players[assignedPlayerId]) {
              // Player is rejoining, socket ID will be updated by initializePlayerInRoom
              console.log(`Player ${assignedPlayerId} rejoining game ${gameId}.`);
            } else {
              // New player joining an existing room
              if (Object.keys(room.players).length >= room.playerCount) {
                socket.emit('error-event', { message: 'Game room is full.' });
                socket.leave(gameId);
                return;
              }
              // Assign next available player ID slot
              for (let i = 1; i <= room.playerCount; i++) {
                  const potentialPlayerId = `player${i}`;
                  if (!room.players[potentialPlayerId]) {
                      assignedPlayerId = potentialPlayerId;
                      break;
                  }
              }
            }
          }
          
          if (!assignedPlayerId) {
             socket.emit('error-event', { message: 'Could not assign player ID.' });
             return;
          }

          room = await initializePlayerInRoom(room, assignedPlayerId, socket.id);
          const updatedRoom = await updateGameRoom(gameId, room);

          if (!updatedRoom) {
            socket.emit('error-event', { message: 'Failed to update/create game room data.' });
            return;
          }
          room = updatedRoom;

          console.log(`Socket ${socket.id} assigned/confirmed as ${assignedPlayerId} in game ${gameId}.`);
          socket.emit('player-assigned', { playerId: assignedPlayerId, gameId });
          
          // Emit full current game state to all players, especially for joining/rejoining.
          io.to(gameId).emit('game-state-update', room);

          if (room.status === 'WAITING_FOR_PLAYERS' && Object.keys(room.players).length === room.playerCount) {
            room.status = 'ALL_PLAYERS_JOINED'; // Transition state before emitting
            io.to(gameId).emit('all-players-joined', { gameId }); // Inform clients all players are in
            console.log(`All ${room.playerCount} players joined game ${gameId}. Status changing to SETTING_SECRETS.`);
            room.status = 'SETTING_SECRETS'; // Now officially ready for secrets
            await updateGameRoom(gameId, { status: room.status }); // Save this new status
            io.to(gameId).emit('game-state-update', room); // Send updated state with new status
          }
        });

        socket.on('send-secret', async (data: { gameId: string; playerId: string; secret: string[] }) => {
          const { gameId, playerId, secret } = data;
          let room = await getGameRoom(gameId);

          if (!room || !room.players[playerId] || (room.status !== 'SETTING_SECRETS' && room.status !== 'ALL_PLAYERS_JOINED')) {
            socket.emit('error-event', { message: 'Cannot set secret at this time or invalid player/game.' });
            return;
          }

          room.players[playerId].secret = secret;
          room.secretsSetCount = Object.values(room.players).filter(p => !!p.secret).length;
          
          console.log(`Secret received from ${playerId} for game ${gameId}. Total secrets set: ${room.secretsSetCount}/${room.playerCount}`);
          
          let updatedRoom = await updateGameRoom(gameId, { 
              players: room.players, 
              secretsSetCount: room.secretsSetCount 
          });
          if (!updatedRoom) { socket.emit('error-event', { message: 'Failed to save secret.'}); return; }
          room = updatedRoom;

          io.to(gameId).emit('secret-update', { playerId, secretSet: true, secretsCurrentlySet: room.secretsSetCount, totalPlayers: room.playerCount });
          io.to(gameId).emit('game-state-update', room);


          if (room.secretsSetCount === room.playerCount && room.status === 'SETTING_SECRETS') {
            console.log(`All secrets set for game ${gameId}. Starting game.`);
            room.status = 'IN_PROGRESS';
            
            const playerIds = Object.keys(room.players).sort(); // Consistent ordering
            if (room.playerCount === 2) { // Duo mode target assignment
               room.targetMap = { [playerIds[0]]: playerIds[1], [playerIds[1]]: playerIds[0] };
            } else { /* TODO: Implement targetMap for Trio/Quads if expanding */ }
            
            room.turn = playerIds[0]; // First player in sorted list starts
            
            updatedRoom = await updateGameRoom(gameId, { status: room.status, targetMap: room.targetMap, turn: room.turn });
            if (!updatedRoom) { socket.emit('error-event', { message: 'Failed to start game after secrets.'}); return; }
            room = updatedRoom;

            io.to(gameId).emit('game-start', { gameId, startingPlayer: room.turn!, targetMap: room.targetMap! });
            io.to(gameId).emit('game-state-update', room);
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

          // Ensure arrays exist before pushing
          if (!room.players[playerId].guessesMade) room.players[playerId].guessesMade = [];
          room.players[playerId].guessesMade!.push(guessObject);

          if (!room.players[targetPlayerId].guessesAgainst) room.players[targetPlayerId].guessesAgainst = [];
          room.players[targetPlayerId].guessesAgainst!.push(guessObject);
          
          console.log(`Player ${playerId} guessed ${guessArray.join('')} against ${targetPlayerId} in game ${gameId}. Feedback: ${feedback.join(',')}`);
          
          let roomUpdates: Partial<GameRoom> = { players: room.players }; // Only update players initially

          if (checkWin(feedback)) {
            roomUpdates.status = 'GAME_OVER';
            roomUpdates.winner = playerId;
            console.log(`Game ${gameId} over. Winner: ${playerId}`);
          } else {
            const playerIds = Object.keys(room.players).sort();
            const currentPlayerIndex = playerIds.indexOf(playerId);
            roomUpdates.turn = playerIds[(currentPlayerIndex + 1) % playerIds.length];
            console.log(`Game ${gameId} turn switched to ${roomUpdates.turn}`);
          }

          const finalUpdatedRoom = await updateGameRoom(gameId, roomUpdates);
          if (!finalUpdatedRoom) { socket.emit('error-event', { message: 'Failed to update game after guess.'}); return; }
          
          // Emit specific events first
          io.to(gameId).emit('guess-feedback', { gameId, guessingPlayerId: playerId, targetPlayerId, guess: guessObject });
          if (finalUpdatedRoom.status === 'GAME_OVER') {
            io.to(gameId).emit('game-over', { gameId, winner: finalUpdatedRoom.winner! });
          } else {
            io.to(gameId).emit('turn-update', { gameId, nextPlayerId: finalUpdatedRoom.turn! });
          }
          // Then emit the full state for consistency
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
// Helper for disconnects, (not currently used but for future reference)
// This would need a global or shared map to track socket IDs to player/game IDs
// if not directly storing socketId in player objects in DB and querying.
const global = globalThis as any; // For type safety with global
if (!global.PLAYER_ID_SOCKET_MAP) {
    global.PLAYER_ID_SOCKET_MAP = {}; // gameId -> { playerId -> socketId }
}
if (!global.SOCKET_ID_GAME_MAP) {
    global.SOCKET_ID_GAME_MAP = {}; // socketId -> gameId
}

