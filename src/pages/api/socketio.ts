
import type { Server as HTTPServer } from 'http';
import type { Socket as NetSocket } from 'net';
import type { NextApiRequest, NextApiResponse } from 'next';
import { Server as SocketIOServer, Socket } from 'socket.io';
import type { GameRoom, PlayerData, Guess, MultiplayerGameStatus } from '@/types/game';
import { calculateFeedback, checkWin } from '@/lib/gameLogic';
import { MongoClient, Db as MongoDb, FindOneAndUpdateOptions } from 'mongodb';

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
    
    const databaseName = "4sureDB"; 
    db = client.db(databaseName);
    console.log(`Successfully connected to MongoDB. Database: ${databaseName}`);

    const gameRoomsCollection = db.collection<GameRoom>('gameRooms');
    await gameRoomsCollection.createIndex({ gameId: 1 }, { unique: true });
    console.log(`Ensured unique index on 'gameId' in 'gameRooms' collection in '${databaseName}'.`);

  } catch (error) {
    console.error("Error connecting to MongoDB or ensuring index:", error);
    db = null; // Ensure db is null if connection fails
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
    console.log(`MongoDB: Game room ${gameId} not found.`);
    return null;
  } catch (error) {
    console.error(`MongoDB: Error fetching game room ${gameId}:`, error);
    return null;
  }
}

async function updateGameRoom(gameId: string, operationData: Partial<GameRoom> | any): Promise<GameRoom | null> {
  if (!db) {
    console.warn(`MongoDB: db instance not available. Cannot updateGameRoom for ${gameId}.`);
    return null;
  }
  
  const filter = { gameId: gameId };
  let mongoUpdateOps: any = {};

  try {
    // Default fields for $setOnInsert when a new document is created
    // These are applied only if an insert happens.
    const defaultsOnInsert: Partial<GameRoom> = {
      gameId: gameId, // gameId is the primary identifier, set on insert
      playerCount: (operationData as GameRoom).playerCount !== undefined ? (operationData as GameRoom).playerCount : 0,
      players: (operationData as GameRoom).players || {},
      status: (operationData as GameRoom).status || 'WAITING_FOR_PLAYERS',
      secretsSetCount: (operationData as GameRoom).secretsSetCount || 0,
      targetMap: (operationData as GameRoom).targetMap || {},
    };
    
    mongoUpdateOps.$setOnInsert = defaultsOnInsert;

    if (Object.keys(operationData).some(key => key.startsWith('$'))) {
      // operationData contains MongoDB operators like $set, $inc, $push
      // Merge these operators, ensuring gameId is NOT part of any $set.
      for (const opKey in operationData) {
        if (opKey === '$setOnInsert') {
          mongoUpdateOps.$setOnInsert = { ...mongoUpdateOps.$setOnInsert, ...operationData.$setOnInsert };
        } else if (opKey === '$set') {
          const { gameId: _, ...setFieldsFromOp } = operationData.$set; // Explicitly remove gameId
          if (Object.keys(setFieldsFromOp).length > 0) {
            mongoUpdateOps.$set = { ...(mongoUpdateOps.$set || {}), ...setFieldsFromOp };
          }
        } else {
          mongoUpdateOps[opKey] = { ...(mongoUpdateOps[opKey] || {}), ...operationData[opKey] };
        }
      }
    } else {
      // operationData is a plain object of fields to set (e.g., when creating a new room with full data)
      const { gameId: _gameId, ...fieldsToSet } = operationData; // Exclude gameId from direct $set
      if (Object.keys(fieldsToSet).length > 0) {
        mongoUpdateOps.$set = { ...(mongoUpdateOps.$set || {}), ...fieldsToSet };
      }
      // For upsert where new document is created, $setOnInsert should reflect all initial fields from operationData
      mongoUpdateOps.$setOnInsert = { ...mongoUpdateOps.$setOnInsert, ...operationData };
      // Ensure gameId in $setOnInsert is strictly the one from the filter
      mongoUpdateOps.$setOnInsert.gameId = gameId; 
    }

    // Clean up $set if it's empty
    if (mongoUpdateOps.$set && Object.keys(mongoUpdateOps.$set).length === 0) {
      delete mongoUpdateOps.$set;
    }
    // If after all operations, mongoUpdateOps is effectively empty (only $setOnInsert with just gameId, or nothing else)
    // This can be valid if the intent is just to ensure the document exists via upsert.
    // findOneAndUpdate will handle this: if no update ops besides $setOnInsert, it only acts on insert.

    const options: FindOneAndUpdateOptions = { upsert: true, returnDocument: 'after' };
    
    const result = await db.collection<GameRoom>('gameRooms').findOneAndUpdate(
      filter,
      mongoUpdateOps,
      options
    );
    
    if (result) {
      const { _id, ...data } = result as any;
      return data as GameRoom;
    }
    
    // If findOneAndUpdate returns null on an upsert, it's unusual.
    // It might happen if the document was deleted by another process between the find and modify phases,
    // or if there's a very specific condition not met for the upsert.
    console.warn(`MongoDB: findOneAndUpdate for game ${gameId} returned null. Filter: ${JSON.stringify(filter)}, Operation: ${JSON.stringify(mongoUpdateOps)}. Attempting direct find.`);
    const existingRoom = await db.collection<GameRoom>('gameRooms').findOne(filter);
    if (existingRoom) {
        console.log(`MongoDB: Room ${gameId} found after null from findOneAndUpdate. Returning found room.`);
        const { _id, ...data } = existingRoom as any;
        return data as GameRoom;
    }
    console.warn(`MongoDB: Room ${gameId} still not found after null from findOneAndUpdate (means upsert likely failed without error, or document was immediately deleted).`);
    return null;

  } catch (error: any) {
    console.error(`MongoDB: Error updating/upserting game room ${gameId}:`, error);
    // Log the specific update document that caused a conflict
    if (error.code === 40 || error.message?.includes("conflict at 'gameId'")) {
        console.error("Filter that might have caused conflict:", JSON.stringify(filter, null, 2));
        console.error("Update document that might have caused conflict:", JSON.stringify(mongoUpdateOps, null, 2));
    }
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

          if (gameId && playerId && db) { // Ensure db is available
            try {
              let room = await getGameRoom(gameId);
              if (room && room.players[playerId]) {
                // Example: Mark player as inactive or handle game state
                // For simplicity, just log and notify.
                // A more complex app might delete the player or award win to opponent.
                
                io.to(gameId).emit('player-disconnected', { 
                  gameId, 
                  playerId,
                  message: `${playerId} has disconnected.` 
                });
                
                // If it's a duo game and one player disconnects, the other might win
                if (room.playerCount === 2 && room.status === 'IN_PROGRESS') {
                    const remainingPlayerIds = Object.keys(room.players).filter(pId => pId !== playerId);
                    if (remainingPlayerIds.length === 1) {
                        const winnerId = remainingPlayerIds[0];
                        // Check if winnerId is still a valid player in the room (e.g. not also disconnected)
                        if (room.players[winnerId]) {
                             const gameOverUpdate = { status: 'GAME_OVER' as MultiplayerGameStatus, winner: winnerId, turn: undefined };
                             const updatedRoom = await updateGameRoom(gameId, { $set: gameOverUpdate });
                             if (updatedRoom) {
                                 io.to(gameId).emit('game-over', { gameId, winner: winnerId });
                                 io.to(gameId).emit('game-state-update', updatedRoom);
                             }
                        }
                    }
                } else if (room.status !== 'GAME_OVER') { // For other cases, just send state update
                    // Potentially remove player from room or mark inactive
                    // const updateOps = { $unset: { [`players.${playerId}`]: "" } }; // Example to remove player
                    // const updatedRoom = await updateGameRoom(gameId, updateOps);
                    // if (updatedRoom) io.to(gameId).emit('game-state-update', updatedRoom);
                    // For now, just re-fetch and send
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
          if (!db) {
            socket.emit('error-event', { message: 'Database not connected. Please try again later.' });
            return;
          }
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
            console.log(`Game room ${gameId} not found in DB. Creating for ${numPlayerCount} players.`);
            assignedPlayerId = rejoiningPlayerId || `player1`; 
            const initialPlayers: { [playerId: string]: PlayerData } = {};
            initialPlayers[assignedPlayerId] = playerObjectBase;

            const newRoomData: GameRoom = {
              gameId, // Will be set by $setOnInsert.gameId
              playerCount: numPlayerCount,
              players: initialPlayers,
              status: 'WAITING_FOR_PLAYERS',
              secretsSetCount: 0,
              targetMap: {},
            };
            room = await updateGameRoom(gameId, newRoomData); // This call will use $setOnInsert for all fields
            if (!room) {
                socket.emit('error-event', { message: 'Failed to create game room data.' });
                console.error(`Failed to create game room ${gameId} with newRoomData: ${JSON.stringify(newRoomData)}`);
                return;
            }
          } else { 
            console.log(`Game room ${gameId} found. Status: ${room.status}, Players: ${Object.keys(room.players).length}/${room.playerCount}`);
            if (room.status === 'GAME_OVER') {
                 socket.emit('error-event', { message: 'This game has already ended.' });
                 socket.leave(gameId);
                 return;
            }
            
            const isPlayerAlreadyInRoom = assignedPlayerId && room.players[assignedPlayerId];

            if (Object.keys(room.players).length >= room.playerCount && !isPlayerAlreadyInRoom) {
                socket.emit('error-event', { message: 'Game room is full.' });
                socket.leave(gameId);
                return;
            }
            
            if (!assignedPlayerId) { 
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
            
            const playerUpdatePayload: any = {
                $set: {
                    [`players.${assignedPlayerId}.socketId`]: socket.id
                }
            };
            if (!room.players[assignedPlayerId]) { 
                playerUpdatePayload.$set[`players.${assignedPlayerId}`] = playerObjectBase;
            }

            const updatedRoomAfterPlayerJoin = await updateGameRoom(gameId, playerUpdatePayload);
            if (!updatedRoomAfterPlayerJoin) {
                socket.emit('error-event', { message: 'Failed to update game room with new/rejoining player.' });
                const currentRoomStateOnError = await getGameRoom(gameId); 
                if(currentRoomStateOnError) io.to(gameId).emit('game-state-update', currentRoomStateOnError);
                return;
            }
            room = updatedRoomAfterPlayerJoin;
          }
          
          socket.gameId = gameId;
          socket.playerId = assignedPlayerId;
          
          console.log(`Socket ${socket.id} assigned/confirmed as ${assignedPlayerId} in game ${gameId}. Players in room: ${Object.keys(room.players).length}/${room.playerCount}`);
          socket.emit('player-assigned', { playerId: assignedPlayerId!, gameId });
          
          io.to(gameId).emit('game-state-update', room); 

          if (room.status === 'WAITING_FOR_PLAYERS' && Object.keys(room.players).length === room.playerCount) {
            const newStatusUpdate = { status: 'ALL_PLAYERS_JOINED' as MultiplayerGameStatus };
            console.log(`All ${room.playerCount} players joined game ${gameId}. Status changing to ALL_PLAYERS_JOINED.`);
            const statusUpdatedRoom = await updateGameRoom(gameId, { $set: newStatusUpdate });
            if (statusUpdatedRoom) {
                room = statusUpdatedRoom; 
                io.to(gameId).emit('all-players-joined', { gameId }); 
                io.to(gameId).emit('game-state-update', room);
            } else {
                 socket.emit('error-event', { message: 'Failed to update game status to ALL_PLAYERS_JOINED.' });
                 const currentRoomStateOnError = await getGameRoom(gameId);
                 if(currentRoomStateOnError) io.to(gameId).emit('game-state-update', currentRoomStateOnError);
            }
          } else if ((room.status === 'ALL_PLAYERS_JOINED' || room.status === 'SETTING_SECRETS' || room.status === 'IN_PROGRESS') && rejoiningPlayerId ) { 
            console.log(`Player ${rejoiningPlayerId} rejoining game ${gameId} which is in status ${room.status}. Sending full state.`);
            io.to(gameId).emit('game-state-update', room);
          }
        });

        socket.on('send-secret', async (data: { gameId: string; playerId: string; secret: string[] }) => {
          const { gameId, playerId, secret } = data;
          if (!db) {
            socket.emit('error-event', { message: 'Database not connected.' });
            return;
          }
          let room = await getGameRoom(gameId);

          if (!room || !room.players[playerId] || (room.status !== 'ALL_PLAYERS_JOINED' && room.status !== 'SETTING_SECRETS')) {
            socket.emit('error-event', { message: `Cannot set secret. Game Status: ${room?.status}, Player: ${playerId}` });
            return;
          }
          
          if (room.players[playerId].secret && room.players[playerId].secret!.length > 0) {
             console.log(`Player ${playerId} trying to set secret again for ${gameId}. Already set.`);
             // Send current state as confirmation that secret is indeed set server-side
             io.to(gameId).emit('game-state-update', room); 
             return;
          }
          
          // Use a conditional update to only set the secret and increment if it's not already set.
          // This helps prevent race conditions if client sends multiple times.
          const filterForSecretSet = { 
            gameId, 
            [`players.${playerId}.secret`]: { $exists: false } 
          };
          const updatePayloadIfSecretNotSet: any = {
            $set: { 
                [`players.${playerId}.secret`]: secret,
                status: 'SETTING_SECRETS' as MultiplayerGameStatus 
            },
            $inc: { secretsSetCount: 1 }
          };
          
          const updatedRoom = await updateGameRoom(gameId, updatePayloadIfSecretNotSet); // findOneAndUpdate with filterOverride is not what we want here.
                                                                                              // updateGameRoom's internal filter is {gameId: gameId}.
                                                                                              // We need a way to pass the conditional player secret check.
                                                                                              // For now, let's simplify and rely on the initial check.

          // Re-fetch room to get the absolute current state after attempting update
          // This handles the case where another process might have updated it or the conditional update failed.
          // Simpler approach for now:
           const setSecretUpdate: any = {
                $set: {
                    [`players.${playerId}.secret`]: secret,
                    status: 'SETTING_SECRETS' // Ensure status is updated
                },
                $inc: { secretsSetCount: 1 }
            };
            // This will increment secretsSetCount even if secret was already there due to a race.
            // The client-side check (room.players[playerId].secret) is crucial.
            // A more robust solution involves specific query for conditional update.
            const roomAfterSecretAttempt = await updateGameRoom(gameId, setSecretUpdate);


          if (!roomAfterSecretAttempt) {
             console.warn(`Failed to set secret for ${playerId} in ${gameId}. Re-fetching current state.`);
             room = await getGameRoom(gameId); 
             if (room) { 
                io.to(gameId).emit('secret-update', { 
                    playerId, 
                    secretSet: !!(room.players[playerId]?.secret && room.players[playerId].secret!.length > 0),
                    secretsCurrentlySet: room.secretsSetCount, 
                    totalPlayers: room.playerCount 
                });
                io.to(gameId).emit('game-state-update', room);
             }
             return;
          }
          room = roomAfterSecretAttempt;

          console.log(`Secret from ${playerId} for ${gameId}. Total set: ${room.secretsSetCount}/${room.playerCount}`);
          
          io.to(gameId).emit('secret-update', { playerId, secretSet: true, secretsCurrentlySet: room.secretsSetCount, totalPlayers: room.playerCount });
          io.to(gameId).emit('game-state-update', room);

          if (room.secretsSetCount === room.playerCount && (room.status === 'ALL_PLAYERS_JOINED' || room.status === 'SETTING_SECRETS')) {
            console.log(`All secrets set for game ${gameId}. Starting game.`);
            
            const playerIds = Object.keys(room.players).sort(); 
            let targetMap: { [playerId: string]: string } = {};
            if (room.playerCount === 2) { 
               targetMap = { [playerIds[0]]: playerIds[1], [playerIds[1]]: playerIds[0] };
            } 
            // TODO: Implement targetMap for Trio/Quads for future

            const startingTurn = playerIds[Math.floor(Math.random() * playerIds.length)];
            
            const gameStartUpdatePayload = { 
                $set: {
                    status: 'IN_PROGRESS' as MultiplayerGameStatus, 
                    targetMap, 
                    turn: startingTurn 
                }
            };
            const gameStartedRoom = await updateGameRoom(gameId, gameStartUpdatePayload);
            if (!gameStartedRoom) { 
                socket.emit('error-event', { message: 'Failed to start game after secrets.'}); 
                const currentRoomStateOnError = await getGameRoom(gameId);
                if(currentRoomStateOnError) io.to(gameId).emit('game-state-update', currentRoomStateOnError);
                return; 
            }
            room = gameStartedRoom;

            io.to(gameId).emit('game-start', { gameId, startingPlayer: room.turn!, targetMap: room.targetMap! });
            io.to(gameId).emit('game-state-update', room);
          }
        });
        
        socket.on('make-guess', async (data: { gameId: string; playerId: string; guess: string[] }) => {
          const { gameId, playerId, guess: guessArray } = data;
          if (!db) {
            socket.emit('error-event', { message: 'Database not connected.' });
            return;
          }
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
              // [`players.${targetPlayerId}.guessesAgainst`]: guessObject, // Store on target as well if needed
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
          
          const updatedRoomAfterGuess = await updateGameRoom(gameId, updateFields);

          if (!updatedRoomAfterGuess) { 
              socket.emit('error-event', { message: 'Failed to update game after guess.'}); 
              const currentRoomStateOnError = await getGameRoom(gameId); 
              if (currentRoomStateOnError) io.to(gameId).emit('game-state-update', currentRoomStateOnError);
              return; 
          }
          room = updatedRoomAfterGuess;
          
          // When sending guess feedback, it's often useful for all players to see who guessed what against whom.
          // The current PlayerPanel on client might only show guessesMade by that player.
          // For simplicity, we send full updated room state.
          // io.to(gameId).emit('guess-feedback', { gameId, guessingPlayerId: playerId, targetPlayerId, guess: guessObject });
          
          if (room.status === 'GAME_OVER') {
            io.to(gameId).emit('game-over', { gameId, winner: room.winner! });
          } else {
            io.to(gameId).emit('turn-update', { gameId, nextPlayerId: room.turn! });
          }
          io.to(gameId).emit('game-state-update', room); // This provides the most comprehensive update
        });
      });
    }
    res.status(200).json({ message: 'Socket.IO server initialized or already running.' });
  } else {
    res.setHeader('Allow', ['POST']);
    res.status(405).end(`Method ${req.method} Not Allowed`);
  }
}
    

    