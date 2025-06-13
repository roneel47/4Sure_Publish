
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
    
    // Explicitly use "4sureDB" as per user's setup
    const databaseName = "4sureDB"; 
    db = client.db(databaseName);
    console.log(`Successfully connected to MongoDB. Database: ${databaseName}`);

    // Ensure 'gameRooms' collection and index on gameId
    const gameRoomsCollection = db.collection<GameRoom>('gameRooms');
    await gameRoomsCollection.createIndex({ gameId: 1 }, { unique: true });
    console.log(`Ensured unique index on 'gameId' in 'gameRooms' collection in '${databaseName}'.`);

  } catch (error) {
    console.error("Error connecting to MongoDB or ensuring index:", error);
    // If connection/index creation fails, db might remain null, and subsequent operations will show warnings.
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
        const { _id, ...data } = roomDocument as any; 
        return data as GameRoom;
    }
    return null;
  } catch (error) {
    console.error(`MongoDB: Error fetching game room ${gameId}:`, error);
    return null;
  }
}

async function updateGameRoom(gameId: string, roomData: Partial<GameRoom> | any, options?: FindOneAndUpdateOptions): Promise<GameRoom | null> {
  if (!db) {
    console.warn(`MongoDB: db instance not available. Cannot updateGameRoom for ${gameId}.`);
    return null;
  }
  try {
    const filter = options?.filterOverride || { gameId: gameId };
    
    let updateDocument: any = {};
    if (Object.keys(roomData).some(key => key.startsWith('$'))) {
      updateDocument = roomData; // roomData already contains operators like $set, $inc
    } else {
      updateDocument.$set = roomData; // roomData is a direct replacement or new fields
    }
    
    const defaultMongoOptions: FindOneAndUpdateOptions = { upsert: true, returnDocument: 'after' };
    const finalMongoOptions = { ...defaultMongoOptions, ...options };

    if ((finalMongoOptions as any).filterOverride) {
      delete (finalMongoOptions as any).filterOverride;
    }

    const result = await db.collection<GameRoom>('gameRooms').findOneAndUpdate(
      filter,
      updateDocument,
      finalMongoOptions
    );
    
    if (result) {
      const { _id, ...data } = result as any;
      return data as GameRoom;
    }
    console.warn(`MongoDB: findOneAndUpdate for game ${gameId} returned null/undefined. Filter: ${JSON.stringify(filter)}, Update: ${JSON.stringify(updateDocument)} Options: ${JSON.stringify(finalMongoOptions)}`);
    return null;
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
          const gameId = socket.gameId;
          const playerId = socket.playerId;
          console.log(`Socket disconnected: ${socket.id}, Player: ${playerId}, Game: ${gameId}`);

          if (gameId && playerId) {
            try {
              let room = await getGameRoom(gameId);
              if (room && room.players[playerId]) {
                // Mark player as inactive or remove, depending on game rules
                // For simplicity, we'll just notify. A real app might change game state.
                // delete room.players[playerId]; // Example: if removing player
                // const updatedRoom = await updateGameRoom(gameId, { players: room.players });
                
                io.to(gameId).emit('player-disconnected', { 
                  gameId, 
                  playerId,
                  message: `${playerId} has disconnected.` 
                });
                
                // Example: If it's a duo game and one player disconnects, the other might win
                if (room.playerCount === 2 && room.status === 'IN_PROGRESS') {
                    const remainingPlayerId = Object.keys(room.players).find(pId => pId !== playerId);
                    if (remainingPlayerId && room.players[remainingPlayerId]) { // Check if remaining player still in room
                        const gameOverUpdate = await updateGameRoom(gameId, { status: 'GAME_OVER', winner: remainingPlayerId, turn: undefined });
                        if (gameOverUpdate) {
                            io.to(gameId).emit('game-over', { gameId, winner: remainingPlayerId });
                            io.to(gameId).emit('game-state-update', gameOverUpdate);
                        }
                    }
                } else if (room.status !== 'GAME_OVER') { // For other cases, just send state update
                    const currentRoomState = await getGameRoom(gameId);
                    if (currentRoomState) io.to(gameId).emit('game-state-update', currentRoomState);
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
          
          const playerObjectBase: PlayerData = { socketId: socket.id, guessesMade: [], guessesAgainst: [] };

          if (!room) { 
            console.log(`Game room ${gameId} not found. Creating for ${numPlayerCount} players.`);
            assignedPlayerId = rejoiningPlayerId || `player1`; // First player is player1
            const initialPlayers: { [playerId: string]: PlayerData } = {};
            initialPlayers[assignedPlayerId] = playerObjectBase;

            const newRoomData: GameRoom = {
              gameId,
              playerCount: numPlayerCount,
              players: initialPlayers,
              status: 'WAITING_FOR_PLAYERS',
              secretsSetCount: 0,
              targetMap: {},
            };
            const createdRoom = await updateGameRoom(gameId, newRoomData, { upsert: true });
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
            
            const isPlayerInRoom = assignedPlayerId && room.players[assignedPlayerId];

            if (Object.keys(room.players).length >= room.playerCount && !isPlayerInRoom) {
                socket.emit('error-event', { message: 'Game room is full.' });
                socket.leave(gameId);
                return;
            }
            
            if (!assignedPlayerId) { // If not rejoining, find next available player ID
              for (let i = 1; i <= room.playerCount; i++) {
                  const potentialPlayerId = `player${i}`;
                  if (!room.players[potentialPlayerId]) {
                      assignedPlayerId = potentialPlayerId;
                      break;
                  }
              }
            }
             if (!assignedPlayerId) { 
                socket.emit('error-event', { message: 'Could not assign player ID. No available slot.' });
                socket.leave(gameId);
                return;
            }

            // Update player's socketId if they are rejoining or add them if new
            const playerUpdatePayload: any = {
                $set: {
                    [`players.${assignedPlayerId}.socketId`]: socket.id
                }
            };
            if (!room.players[assignedPlayerId]) { // If player is completely new to this room
                playerUpdatePayload.$set[`players.${assignedPlayerId}`] = playerObjectBase;
            }


            const updatedRoomAfterPlayerJoin = await updateGameRoom(gameId, playerUpdatePayload, { upsert: Object.keys(room.players).length === 0 }); // Upsert if room was empty
            if (!updatedRoomAfterPlayerJoin) {
                socket.emit('error-event', { message: 'Failed to update game room with new/rejoining player.' });
                const currentRoomState = await getGameRoom(gameId); // Resync client
                if(currentRoomState) io.to(gameId).emit('game-state-update', currentRoomState);
                return;
            }
            room = updatedRoomAfterPlayerJoin;
          }
          
          socket.gameId = gameId;
          socket.playerId = assignedPlayerId;
          
          console.log(`Socket ${socket.id} assigned/confirmed as ${assignedPlayerId} in game ${gameId}. Players: ${Object.keys(room.players).length}/${room.playerCount}`);
          socket.emit('player-assigned', { playerId: assignedPlayerId!, gameId });
          
          io.to(gameId).emit('game-state-update', room); 

          if (room.status === 'WAITING_FOR_PLAYERS' && Object.keys(room.players).length === room.playerCount) {
            const newStatusUpdate = { status: 'ALL_PLAYERS_JOINED' as MultiplayerGameStatus };
            console.log(`All ${room.playerCount} players joined game ${gameId}. Status changing to ALL_PLAYERS_JOINED.`);
            const statusUpdatedRoom = await updateGameRoom(gameId, { $set: newStatusUpdate }, {upsert: false});
            if (statusUpdatedRoom) {
                room = statusUpdatedRoom; 
                io.to(gameId).emit('all-players-joined', { gameId }); 
                io.to(gameId).emit('game-state-update', room);
            } else {
                 socket.emit('error-event', { message: 'Failed to update game status to ALL_PLAYERS_JOINED.' });
                 const currentRoomState = await getGameRoom(gameId);
                 if(currentRoomState) io.to(gameId).emit('game-state-update', currentRoomState);
            }
          } else if (room.status !== 'WAITING_FOR_PLAYERS' && room.status !== 'GAME_OVER' ) { // If game was already beyond waiting (e.g. player reconnected)
            // Send the current full state to everyone, especially the rejoining player.
            io.to(gameId).emit('game-state-update', room);
          }
        });

        socket.on('send-secret', async (data: { gameId: string; playerId: string; secret: string[] }) => {
          const { gameId, playerId, secret } = data;
          let room = await getGameRoom(gameId);

          if (!room || !room.players[playerId] || (room.status !== 'ALL_PLAYERS_JOINED' && room.status !== 'SETTING_SECRETS')) {
            socket.emit('error-event', { message: `Cannot set secret. Game Status: ${room?.status}, Player: ${playerId}` });
            return;
          }
          
          // Check if secret already set by this player to prevent double increment of secretsSetCount
          if (room.players[playerId].secret && room.players[playerId].secret!.length > 0) {
             console.log(`Player ${playerId} trying to set secret again for ${gameId}. Already set.`);
             io.to(gameId).emit('secret-update', { playerId, secretSet: true, secretsCurrentlySet: room.secretsSetCount, totalPlayers: room.playerCount });
             io.to(gameId).emit('game-state-update', room); // Send current state which includes their already set secret
             return;
          }
          
          const updatePayload: any = {
            $set: { 
                [`players.${playerId}.secret`]: secret,
                status: 'SETTING_SECRETS' as MultiplayerGameStatus // Explicitly set status if not already
            },
            $inc: { secretsSetCount: 1 }
          };
          // Only apply update if secret is not already set.
          // This filter is on the document level for atomicity.
          const filterForSecretSet = { gameId, [`players.${playerId}.secret`]: { $exists: false } };
          
          const updatedRoom = await updateGameRoom(gameId, updatePayload, { filterOverride: filterForSecretSet, upsert: false });

          if (!updatedRoom) {
             console.warn(`Failed to set secret for ${playerId} in ${gameId} (maybe already set or race condition). Re-fetching current state.`);
             room = await getGameRoom(gameId); // Get potentially updated state by another process or due to filter
             if (room) { // If room still exists
                io.to(gameId).emit('secret-update', { 
                    playerId, 
                    secretSet: !!(room.players[playerId]?.secret && room.players[playerId].secret!.length > 0), // Check again
                    secretsCurrentlySet: room.secretsSetCount, 
                    totalPlayers: room.playerCount 
                });
                io.to(gameId).emit('game-state-update', room);
             }
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
            } // TODO: Implement targetMap for Trio/Quads for future

            const startingTurn = playerIds[Math.floor(Math.random() * playerIds.length)];
            
            const gameStartUpdatePayload = { 
                $set: {
                    status: 'IN_PROGRESS' as MultiplayerGameStatus, 
                    targetMap, 
                    turn: startingTurn 
                }
            };
            const gameStartedRoom = await updateGameRoom(gameId, gameStartUpdatePayload, {upsert: false});
            if (!gameStartedRoom) { 
                socket.emit('error-event', { message: 'Failed to start game after secrets.'}); 
                const currentRoomState = await getGameRoom(gameId);
                if(currentRoomState) io.to(gameId).emit('game-state-update', currentRoomState);
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
            updateFields.$set = { status: 'GAME_OVER' as MultiplayerGameStatus, winner: playerId, turn: undefined };
            console.log(`Game ${gameId} over. Winner: ${playerId}`);
          } else {
            const playerIds = Object.keys(room.players).sort();
            const currentPlayerIndex = playerIds.indexOf(playerId);
            const nextPlayerId = playerIds[(currentPlayerIndex + 1) % playerIds.length];
            updateFields.$set = { turn: nextPlayerId };
          }
          
          const updatedRoomAfterGuess = await updateGameRoom(gameId, updateFields, {upsert: false});

          if (!updatedRoomAfterGuess) { 
              socket.emit('error-event', { message: 'Failed to update game after guess.'}); 
              const currentRoomState = await getGameRoom(gameId); 
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
    
