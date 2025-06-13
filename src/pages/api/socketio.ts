
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

// Initialize MongoDB connection
(async () => {
  if (!MONGODB_URI) {
    console.warn('MONGODB_URI not found in environment variables. Database operations will not be available.');
    return;
  }
  try {
    const client = new MongoClient(MONGODB_URI);
    await client.connect();
    // Attempt to derive DB name from URI or use a default.
    const dbNameFromUri = new URL(MONGODB_URI).pathname.substring(1);
    const databaseName = dbNameFromUri || "4sureDB"; 
    
    db = client.db(databaseName);
    console.log(`Successfully connected to MongoDB. Database: ${databaseName}`);
    // Optional: Create an index on gameId if it doesn't exist for better performance
    // await db.collection<GameRoom>('gameRooms').createIndex({ gameId: 1 }, { unique: true });
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
  return 0; 
};

async function getGameRoom(gameId: string): Promise<GameRoom | null> {
  if (!db) {
    console.warn(`MongoDB: db instance not available. Cannot getGameRoom for ${gameId}.`);
    return null;
  }
  try {
    const roomDocument = await db.collection<GameRoom>('gameRooms').findOne({ gameId: gameId });
    if (roomDocument) {
        console.log(`MongoDB: Fetched game room ${gameId}`);
        // MongoDB's _id is not part of GameRoom, so we might need to omit it if strict type matching is an issue
        // For now, assuming GameRoom type can handle or ignore _id.
        // If GameRoom has _id: any, then it's fine. Otherwise, might need: const { _id, ...data } = roomDocument; return data;
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
    return null;
  }
  try {
    const filter = { gameId: gameId };
    // For an upsert, if the document is inserted, $set will apply.
    // For fields that should only be set on creation, use $setOnInsert.
    // Here, roomData could contain complex nested objects (like players).
    // $set will overwrite the entire field if it's a top-level field in roomData.
    // If you need to update nested fields (e.g., players.player1.socketId), you'd use dot notation in $set.
    // Example: { $set: { "players.player1.socketId": "newSocketId", status: "newStatus" } }
    // For simplicity now, we assume roomData contains the fields to be fully set/replaced.
    const updateDocument = {
      $set: roomData,
      // Example $setOnInsert if creating a new room, ensure basic structure
      $setOnInsert: { 
        gameId: gameId, 
        playerCount: roomData.playerCount || 0, // Ensure these are set if it's an insert
        players: roomData.players || {},
        status: roomData.status || 'WAITING_FOR_PLAYERS',
        secretsSetCount: roomData.secretsSetCount || 0,
        targetMap: roomData.targetMap || {},
        turn: roomData.turn,
        winner: roomData.winner,
      } 
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
          let isNewRoom = false;

          if (!room) { 
            isNewRoom = true;
            console.log(`Game room ${gameId} not found in DB. Creating for ${numPlayerCount} players.`);
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
            if (!assignedPlayerId) { // Assign first player ID if new room and no rejoining ID
                assignedPlayerId = `player1`;
            }
          } else { // Room exists
            console.log(`Game room ${gameId} found. Status: ${room.status}`);
            if (room.status === 'GAME_OVER') {
                 socket.emit('error-event', { message: 'This game has already ended.' });
                 socket.leave(gameId);
                 return;
            }
            if (Object.keys(room.players).length >= room.playerCount && !room.players[assignedPlayerId || '']) {
                socket.emit('error-event', { message: 'Game room is full.' });
                socket.leave(gameId);
                return;
            }
            if (!assignedPlayerId) { // New player joining an existing room, find next slot
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
             socket.emit('error-event', { message: 'Could not assign player ID. Room might be full or ID mismatch.' });
             socket.leave(gameId);
             return;
          }
          
          room = await initializePlayerInRoom(room, assignedPlayerId, socket.id);
          // Critical: When updating, ensure players object is part of the update.
          // If it's a new room, all fields are set by $setOnInsert in updateGameRoom or passed in roomData.
          // If existing, specific fields like 'players' need to be in roomData passed to updateGameRoom.
          const roomUpdatePayload: Partial<GameRoom> = isNewRoom ? room : { players: room.players };
          // Also update current status if it's new
          if (isNewRoom) roomUpdatePayload.status = room.status;


          const updatedRoom = await updateGameRoom(gameId, roomUpdatePayload);

          if (!updatedRoom) {
            socket.emit('error-event', { message: 'Failed to update/create game room data.' });
            return;
          }
          room = updatedRoom; // Use the fresh state from DB

          console.log(`Socket ${socket.id} assigned/confirmed as ${assignedPlayerId} in game ${gameId}. Current players: ${Object.keys(room.players).length}/${room.playerCount}`);
          socket.emit('player-assigned', { playerId: assignedPlayerId, gameId });
          
          io.to(gameId).emit('game-state-update', room); // Emit full current game state

          if (room.status === 'WAITING_FOR_PLAYERS' && Object.keys(room.players).length === room.playerCount) {
            const newStatus: MultiplayerGameStatus = 'ALL_PLAYERS_JOINED';
            console.log(`All ${room.playerCount} players joined game ${gameId}. Status changing to ${newStatus}.`);
            const statusUpdateResult = await updateGameRoom(gameId, { status: newStatus });
            if (statusUpdateResult) {
                room = statusUpdateResult; // update local room with new status
                io.to(gameId).emit('all-players-joined', { gameId }); 
                io.to(gameId).emit('game-state-update', room);
            } else {
                 socket.emit('error-event', { message: 'Failed to update game status to ALL_PLAYERS_JOINED.' });
            }
          }
        });

        socket.on('send-secret', async (data: { gameId: string; playerId: string; secret: string[] }) => {
          const { gameId, playerId, secret } = data;
          let room = await getGameRoom(gameId);

          if (!room || !room.players[playerId] || (room.status !== 'ALL_PLAYERS_JOINED' && room.status !== 'SETTING_SECRETS')) {
            socket.emit('error-event', { message: `Cannot set secret. Game Status: ${room?.status}, Player: ${playerId}` });
            return;
          }
           if (room.players[playerId].secret) { // Player trying to set secret again
               console.log(`Player ${playerId} attempting to set secret again for game ${gameId}. Current secret exists.`);
               // Optionally re-confirm to client that their secret is already set, or allow change if game rules permit
               io.to(gameId).emit('secret-update', { playerId, secretSet: true, secretsCurrentlySet: room.secretsSetCount, totalPlayers: room.playerCount });
               io.to(gameId).emit('game-state-update', room); // Send current state which includes their existing secret
               return;
           }


          // Update specific player's secret and increment secretsSetCount
          const playerSecretUpdate = { [`players.${playerId}.secret`]: secret };
          // Use $inc to increment secretsSetCount atomically
          const updateResult = await db!.collection<GameRoom>('gameRooms').findOneAndUpdate(
            { gameId, [`players.${playerId}.secret`]: { $exists: false } }, // Condition: only update if secret not already set
            { 
              $set: playerSecretUpdate,
              $inc: { secretsSetCount: 1 }
            },
            { returnDocument: 'after' } // Return the updated document
          );

          if (!updateResult) { // Could mean secret already set or gameId/playerId mismatch
             console.warn(`Failed to set secret for ${playerId} in ${gameId} (maybe already set or player not found for update condition).`);
             room = await getGameRoom(gameId); // Get current state to send back
             if (room) io.to(gameId).emit('game-state-update', room); // Send potentially unchanged state
             return;
          }
          room = updateResult as GameRoom; // Cast because we expect the document back

          console.log(`Secret received from ${playerId} for game ${gameId}. Total secrets set: ${room.secretsSetCount}/${room.playerCount}`);
          
          io.to(gameId).emit('secret-update', { playerId, secretSet: true, secretsCurrentlySet: room.secretsSetCount, totalPlayers: room.playerCount });
          io.to(gameId).emit('game-state-update', room);


          if (room.secretsSetCount === room.playerCount && (room.status === 'ALL_PLAYERS_JOINED' || room.status === 'SETTING_SECRETS')) {
            console.log(`All secrets set for game ${gameId}. Starting game.`);
            const newStatus: MultiplayerGameStatus = 'IN_PROGRESS';
            
            const playerIds = Object.keys(room.players).sort(); 
            let targetMap: { [playerId: string]: string } = {};
            if (room.playerCount === 2) { 
               targetMap = { [playerIds[0]]: playerIds[1], [playerIds[1]]: playerIds[0] };
            } else { /* TODO: Implement targetMap for Trio/Quads */ }
            
            const startingTurn = playerIds[0];
            
            const gameStartUpdate = await updateGameRoom(gameId, { status: newStatus, targetMap: targetMap, turn: startingTurn });
            if (!gameStartUpdate) { 
                socket.emit('error-event', { message: 'Failed to start game after secrets.'}); 
                return; 
            }
            room = gameStartUpdate;

            io.to(gameId).emit('game-start', { gameId, startingPlayer: room.turn!, targetMap: room.targetMap! });
            io.to(gameId).emit('game-state-update', room); // Send final state before play starts
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

          // Prepare updates for MongoDB. Use dot notation for specific array appends.
          const updatePayload: any = {
            $push: {
              [`players.${playerId}.guessesMade`]: guessObject,
              [`players.${targetPlayerId}.guessesAgainst`]: guessObject,
            }
          };
          
          console.log(`Player ${playerId} guessed ${guessArray.join('')} against ${targetPlayerId} in game ${gameId}. Feedback: ${feedback.join(',')}`);
          
          if (checkWin(feedback)) {
            updatePayload.$set = { status: 'GAME_OVER', winner: playerId };
            console.log(`Game ${gameId} over. Winner: ${playerId}`);
          } else {
            const playerIds = Object.keys(room.players).sort();
            const currentPlayerIndex = playerIds.indexOf(playerId);
            const nextPlayerId = playerIds[(currentPlayerIndex + 1) % playerIds.length];
            updatePayload.$set = { turn: nextPlayerId };
            console.log(`Game ${gameId} turn switched to ${nextPlayerId}`);
          }
          
          // Atomically update the room with guess and turn/status change
           const updatedRoomResult = await db!.collection<GameRoom>('gameRooms').findOneAndUpdate(
            { gameId: gameId, status: 'IN_PROGRESS', turn: playerId }, // Ensure still correct turn and game state
            updatePayload,
            { returnDocument: 'after' }
          );

          if (!updatedRoomResult) { 
              socket.emit('error-event', { message: 'Failed to update game after guess. State mismatch or error.'}); 
              // Fetch current state to resync client if needed
              const currentRoomState = await getGameRoom(gameId);
              if (currentRoomState) io.to(gameId).emit('game-state-update', currentRoomState);
              return; 
          }
          const finalUpdatedRoom = updatedRoomResult as GameRoom;
          
          io.to(gameId).emit('guess-feedback', { gameId, guessingPlayerId: playerId, targetPlayerId, guess: guessObject });
          if (finalUpdatedRoom.status === 'GAME_OVER') {
            io.to(gameId).emit('game-over', { gameId, winner: finalUpdatedRoom.winner! });
          } else {
            io.to(gameId).emit('turn-update', { gameId, nextPlayerId: finalUpdatedRoom.turn! });
          }
          io.to(gameId).emit('game-state-update', finalUpdatedRoom); // Send full state for consistency
        });
      });
    }
    res.status(200).json({ message: 'Socket.IO server initialized or already running.' });
  } else {
    res.setHeader('Allow', ['POST']);
    res.status(405).end(`Method ${req.method} Not Allowed`);
  }
}

// Helper for disconnects or global maps (not currently used extensively but for reference)
const global = globalThis as any; 
if (!global.PLAYER_ID_SOCKET_MAP) {
    global.PLAYER_ID_SOCKET_MAP = {}; 
}
if (!global.SOCKET_ID_GAME_MAP) {
    global.SOCKET_ID_GAME_MAP = {};
}
    