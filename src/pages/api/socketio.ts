
import type { Server as HTTPServer } from 'http';
import type { Socket as NetSocket } from 'net';
import type { NextApiRequest, NextApiResponse } from 'next';
import { Server as SocketIOServer, Socket } from 'socket.io';
import type { GameRoom, PlayerData, Guess, MultiplayerGameStatus } from '@/types/game';
import { CODE_LENGTH, calculateFeedback, checkWin } from '@/lib/gameLogic';
import { MongoClient, Db as MongoDb, UpdateResult, FindOneAndUpdateOptions } from 'mongodb';

interface NextApiResponseWithSocket extends NextApiResponse {
  socket: NetSocket & {
    server: HTTPServer & {
      io?: SocketIOServer;
    };
  };
}

// Extend Socket type to store custom properties
interface CustomSocket extends Socket {
  gameId?: string;
  playerId?: string;
}

const MONGODB_URI = process.env.MONGODB_URI;
let db: MongoDb | null = null;

// Initialize MongoDB connection
(async () => {
  if (!MONGODB_URI) {
    console.warn('MONGODB_URI not found in environment variables. Database operations will not be available.');
    return;
  }
  try {
    const client = new MongoClient(MONGODB_URI);
    await client.connect();
    const dbNameFromUri = new URL(MONGODB_URI).pathname.substring(1);
    const databaseName = dbNameFromUri || "4sureDB"; 
    
    db = client.db(databaseName);
    console.log(`Successfully connected to MongoDB. Database: ${databaseName}`);
    // Optional: Create an index on gameId if it doesn't exist for better performance
    // await db.collection<GameRoom>('gameRooms').createIndex({ gameId: 1 }, { unique: true });
  } catch (error) {
    console.error("Error connecting to MongoDB:", error);
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
        // console.log(`MongoDB: Fetched game room ${gameId}`);
        const { _id, ...data } = roomDocument as any; // Remove _id if it causes issues with GameRoom type
        return data as GameRoom;
    }
    // console.log(`MongoDB: Game room ${gameId} not found.`);
    return null;
  } catch (error) {
    console.error(`MongoDB: Error fetching game room ${gameId}:`, error);
    return null;
  }
}

async function updateGameRoom(gameId: string, roomData: Partial<GameRoom>, options?: FindOneAndUpdateOptions): Promise<GameRoom | null> {
  if (!db) {
    console.warn(`MongoDB: db instance not available. Cannot updateGameRoom for ${gameId}.`);
    return null;
  }
  try {
    const filter = { gameId: gameId };
    
    const updateDocument: any = {};
    if (Object.keys(roomData).some(key => key.startsWith('$'))) { // If roomData contains MongoDB operators
      Object.assign(updateDocument, roomData);
    } else {
      updateDocument.$set = roomData;
    }

    if (!updateDocument.$setOnInsert && (!options || !options.upsert)) {
       updateDocument.$setOnInsert = { 
        gameId: gameId, 
        playerCount: roomData.playerCount || 0,
        players: roomData.players || {},
        status: roomData.status || 'WAITING_FOR_PLAYERS',
        secretsSetCount: roomData.secretsSetCount || 0,
        targetMap: roomData.targetMap || {},
      };
    }
    
    const defaultOptions: FindOneAndUpdateOptions = { upsert: true, returnDocument: 'after' };
    const finalOptions = { ...defaultOptions, ...options };

    const result = await db.collection<GameRoom>('gameRooms').findOneAndUpdate(
      filter,
      updateDocument,
      finalOptions
    );
    
    // console.log(`MongoDB: Update/Upsert operation for game room ${gameId}.`);
    if (result) {
      const { _id, ...data } = result as any;
      return data as GameRoom;
    }
    return null; // Should not happen with upsert:true and returnDocument:'after' if operation succeeds
  } catch (error) {
    console.error(`MongoDB: Error updating/upserting game room ${gameId}:`, error);
    return null;
  }
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

      io.on('connection', (socket: CustomSocket) => {
        console.log('Socket connected:', socket.id);

        socket.on('disconnect', async () => {
          console.log(`Socket disconnected: ${socket.id}`);
          const gameId = socket.gameId;
          const playerId = socket.playerId;

          if (gameId && playerId) {
            console.log(`Player ${playerId} from game ${gameId} disconnected.`);
            try {
              let room = await getGameRoom(gameId);
              if (room && room.players[playerId]) {
                // Basic: Notify others the player disconnected
                // More advanced: Remove player, check if game can continue, update status, etc.
                // For now, just remove the player from the room object for notification purposes
                // but a full DB update might be more complex (e.g. if they were the current turn)
                // delete room.players[playerId]; // This is a local modification for broadcast
                
                // A more robust approach would be to update the player's status in DB
                // e.g., room.players[playerId].isActive = false;
                // await updateGameRoom(gameId, { players: room.players });

                // Let other players know
                io.to(gameId).emit('player-disconnected', { gameId, playerId,
                  message: `${playerId} has disconnected.` 
                });
                
                // If it's a duo game and one player disconnects, the other might win by default or game ends
                if (room.playerCount === 2 && room.status === 'IN_PROGRESS') {
                    const remainingPlayerId = Object.keys(room.players).find(pId => pId !== playerId);
                    if (remainingPlayerId) {
                        const gameOverUpdate = await updateGameRoom(gameId, { status: 'GAME_OVER', winner: remainingPlayerId });
                        if (gameOverUpdate) {
                            io.to(gameId).emit('game-over', { gameId, winner: remainingPlayerId });
                            io.to(gameId).emit('game-state-update', gameOverUpdate);
                        }
                    }
                } else {
                    // For larger games, you might just update the player list or check if minimum players are still there.
                    // For now, just re-fetch and emit the potentially unchanged (or slightly changed if we did mark inactive) game state.
                    const updatedRoom = await getGameRoom(gameId); // re-fetch after potential modifications
                    if (updatedRoom) io.to(gameId).emit('game-state-update', updatedRoom);
                }


              }
            } catch (error) {
                console.error(`Error handling disconnect for player ${playerId} in game ${gameId}:`, error);
            }
          }
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
          
          const playerObjectBase = { socketId: socket.id, guessesMade: [], guessesAgainst: [] };

          if (!room) { 
            console.log(`Game room ${gameId} not found in DB. Creating for ${numPlayerCount} players.`);
            assignedPlayerId = rejoiningPlayerId || `player1`;
            const initialPlayers: { [playerId: string]: PlayerData } = {};
            initialPlayers[assignedPlayerId] = playerObjectBase;

            room = {
              gameId,
              playerCount: numPlayerCount,
              players: initialPlayers,
              status: 'WAITING_FOR_PLAYERS',
              secretsSetCount: 0,
              targetMap: {},
            };
            const createdRoom = await updateGameRoom(gameId, room, { upsert: true }); // Ensure it's an upsert
            if (!createdRoom) {
                socket.emit('error-event', { message: 'Failed to create game room data.' });
                return;
            }
            room = createdRoom;
          } else { 
            console.log(`Game room ${gameId} found. Status: ${room.status}`);
            if (room.status === 'GAME_OVER') {
                 socket.emit('error-event', { message: 'This game has already ended.' });
                 socket.leave(gameId);
                 return;
            }
            // Check if full and not rejoining
            if (Object.keys(room.players).length >= room.playerCount && (!assignedPlayerId || !room.players[assignedPlayerId])) {
                socket.emit('error-event', { message: 'Game room is full.' });
                socket.leave(gameId);
                return;
            }
            // Assign new player ID if not rejoining
            if (!assignedPlayerId) {
              for (let i = 1; i <= room.playerCount; i++) {
                  const potentialPlayerId = `player${i}`;
                  if (!room.players[potentialPlayerId]) {
                      assignedPlayerId = potentialPlayerId;
                      break;
                  }
              }
            }
             if (!assignedPlayerId) { // Should not happen if room is not full
                socket.emit('error-event', { message: 'Could not assign player ID. No available slot.' });
                socket.leave(gameId);
                return;
            }

            // Update or add player
            const playerUpdate: Partial<GameRoom> = {
                [`players.${assignedPlayerId}`]: room.players[assignedPlayerId] 
                                                ? { ...room.players[assignedPlayerId], socketId: socket.id } 
                                                : playerObjectBase
            };
            const updatedRoomAfterPlayerJoin = await updateGameRoom(gameId, playerUpdate);
            if (!updatedRoomAfterPlayerJoin) {
                socket.emit('error-event', { message: 'Failed to update game room with new/rejoining player.' });
                return;
            }
            room = updatedRoomAfterPlayerJoin;
          }
          
          // Store context on socket
          socket.gameId = gameId;
          socket.playerId = assignedPlayerId;
          
          console.log(`Socket ${socket.id} assigned/confirmed as ${assignedPlayerId} in game ${gameId}. Players: ${Object.keys(room.players).length}/${room.playerCount}`);
          socket.emit('player-assigned', { playerId: assignedPlayerId, gameId });
          
          io.to(gameId).emit('game-state-update', room); 

          if (room.status === 'WAITING_FOR_PLAYERS' && Object.keys(room.players).length === room.playerCount) {
            const newStatusUpdate: Partial<GameRoom> = { status: 'ALL_PLAYERS_JOINED' };
            console.log(`All ${room.playerCount} players joined game ${gameId}. Status changing to ALL_PLAYERS_JOINED.`);
            const statusUpdatedRoom = await updateGameRoom(gameId, newStatusUpdate);
            if (statusUpdatedRoom) {
                room = statusUpdatedRoom; 
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
          if (room.players[playerId].secret) {
             console.log(`Player ${playerId} trying to set secret again for ${gameId}. Already set.`);
             // Just re-emit current state including their set secret confirmation.
             io.to(gameId).emit('secret-update', { playerId, secretSet: true, secretsCurrentlySet: room.secretsSetCount, totalPlayers: room.playerCount });
             io.to(gameId).emit('game-state-update', room);
             return;
          }
          
          // Atomically set secret and increment count if secret not already set for this player
          const updatePayload = {
            $set: { [`players.${playerId}.secret`]: secret },
            $inc: { secretsSetCount: 1 }
          };
          const filter = { gameId, [`players.${playerId}.secret`]: { $exists: false } }; // Only if secret isn't set
          
          const updatedRoom = await updateGameRoom(gameId, updatePayload, { filterOverride: filter, upsert: false });


          if (!updatedRoom) {
             console.warn(`Failed to set secret for ${playerId} in ${gameId} (maybe already set or player/game changed). Re-fetching.`);
             room = await getGameRoom(gameId); // Get current state
             if(room) io.to(gameId).emit('game-state-update', room);
             return;
          }
          room = updatedRoom;

          console.log(`Secret from ${playerId} for ${gameId}. Total set: ${room.secretsSetCount}/${room.playerCount}`);
          
          io.to(gameId).emit('secret-update', { playerId, secretSet: true, secretsCurrentlySet: room.secretsSetCount, totalPlayers: room.playerCount });
          io.to(gameId).emit('game-state-update', room);


          if (room.secretsSetCount === room.playerCount && (room.status === 'ALL_PLAYERS_JOINED' || room.status === 'SETTING_SECRETS')) {
            console.log(`All secrets set for game ${gameId}. Starting game.`);
            
            const playerIds = Object.keys(room.players).sort(); 
            let targetMap: { [playerId: string]: string } = {};
            if (room.playerCount === 2) { 
               targetMap = { [playerIds[0]]: playerIds[1], [playerIds[1]]: playerIds[0] };
            } // TODO: Implement targetMap for Trio/Quads

            const startingTurn = playerIds[Math.floor(Math.random() * playerIds.length)]; // Random starting player
            
            const gameStartUpdatePayload: Partial<GameRoom> = { status: 'IN_PROGRESS', targetMap, turn: startingTurn };
            const gameStartedRoom = await updateGameRoom(gameId, gameStartUpdatePayload);
            if (!gameStartedRoom) { 
                socket.emit('error-event', { message: 'Failed to start game after secrets.'}); 
                return; 
            }
            room = gameStartedRoom;

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
          
          console.log(`${playerId} guessed ${guessArray.join('')} vs ${targetPlayerId} in ${gameId}. Feedback: ${feedback.join(',')}`);
          
          const updateFields: any = {
            $push: {
              [`players.${playerId}.guessesMade`]: guessObject,
              [`players.${targetPlayerId}.guessesAgainst`]: guessObject,
            }
          };
          
          if (checkWin(feedback)) {
            updateFields.$set = { status: 'GAME_OVER', winner: playerId, turn: undefined }; // Clear turn on game over
            console.log(`Game ${gameId} over. Winner: ${playerId}`);
          } else {
            const playerIds = Object.keys(room.players).sort();
            const currentPlayerIndex = playerIds.indexOf(playerId);
            const nextPlayerId = playerIds[(currentPlayerIndex + 1) % playerIds.length];
            updateFields.$set = { turn: nextPlayerId };
          }
          
          const updatedRoomAfterGuess = await updateGameRoom(gameId, updateFields, {upsert: false}); // Don't upsert on guess

          if (!updatedRoomAfterGuess) { 
              socket.emit('error-event', { message: 'Failed to update game after guess.'}); 
              const currentRoomState = await getGameRoom(gameId); // Resync client
              if (currentRoomState) io.to(gameId).emit('game-state-update', currentRoomState);
              return; 
          }
          room = updatedRoomAfterGuess;
          
          io.to(gameId).emit('guess-feedback', { gameId, guessingPlayerId: playerId, targetPlayerId, guess: guessObject });
          if (room.status === 'GAME_OVER') {
            io.to(gameId).emit('game-over', { gameId, winner: room.winner! });
          } else {
            io.to(gameId).emit('turn-update', { gameId, nextPlayerId: room.turn! });
          }
          io.to(gameId).emit('game-state-update', room);
        });
      });
    }
    res.status(200).json({ message: 'Socket.IO server initialized or already running.' });
  } else {
    res.setHeader('Allow', ['POST']);
    res.status(405).end(`Method ${req.method} Not Allowed`);
  }
}
    
