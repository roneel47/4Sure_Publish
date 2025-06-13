
import type { Server as HTTPServer } from 'http';
import type { Socket as NetSocket } from 'net';
import type { NextApiRequest, NextApiResponse } from 'next';
import { Server as SocketIOServer, Socket } from 'socket.io';
import type { GameRoom, PlayerData, Guess, MultiplayerGameStatus } from '@/types/game';
import { calculateFeedback, checkWin } from '@/lib/gameLogic';
import { MongoClient, Db as MongoDb } from 'mongodb';

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
const DATABASE_NAME = "4SureDB"; // Corrected to match the existing DB case
const COLLECTION_NAME = "gameRooms";
let db: MongoDb | null = null;

// Promise to ensure DB connection is ready before operations
let resolveDbConnection: (value: MongoDb | PromiseLike<MongoDb>) => void;
let rejectDbConnection: (reason?: any) => void;
const dbConnectionPromise = new Promise<MongoDb>((resolve, reject) => {
  resolveDbConnection = resolve;
  rejectDbConnection = reject;
});

(async () => {
  if (!MONGODB_URI) {
    console.warn('MONGODB_URI not found in environment variables. Database operations will not be available.');
    rejectDbConnection(new Error('MONGODB_URI not found'));
    return;
  }
  try {
    console.log("Attempting to connect to MongoDB...");
    const client = new MongoClient(MONGODB_URI);
    await client.connect();
    console.log("Successfully connected to MongoDB.");
    
    db = client.db(DATABASE_NAME);
    console.log(`MongoDB: Targeting database: '${DATABASE_NAME}'.`);
    console.log(`MongoDB: Targeting collection: '${COLLECTION_NAME}' in database '${DATABASE_NAME}'. DB setup complete.`);
    // Manual creation of the unique index on gameId in MongoDB Atlas is recommended.
    // db.collection(COLLECTION_NAME).createIndex({ gameId: 1 }, { unique: true })
    //  .then(() => console.log(`MongoDB: Ensured unique index on 'gameId' in '${COLLECTION_NAME}'.`))
    //  .catch(err => console.warn(`MongoDB: Error ensuring unique index on 'gameId':`, err.message));

    resolveDbConnection(db);
  } catch (error) {
    console.error("Error connecting to MongoDB:", error);
    db = null;
    rejectDbConnection(error);
  }
})();


const getPlayerCountNumber = (playerCountString: string): number => {
  if (playerCountString === 'duo') return 2;
  if (playerCountString === 'trio') return 3;
  if (playerCountString === 'quads') return 4;
  return 0; 
};

async function getGameRoom(gameId: string): Promise<GameRoom | null> {
  try {
    await dbConnectionPromise; 
  } catch (connectionError) {
    console.error(`MongoDB connection error (getGameRoom for ${gameId}):`, connectionError);
    return null;
  }
  if (!db) {
    console.warn(`MongoDB: db instance is null (getGameRoom for ${gameId}) even after promise. Critical connection issue.`);
    return null;
  }
  try {
    const roomDocument = await db.collection<GameRoom>(COLLECTION_NAME).findOne({ gameId: gameId });
    if (roomDocument) {
        const { _id, ...data } = roomDocument as any; 
        return data as GameRoom;
    }
    console.log(`MongoDB: Game room ${gameId} not found in DB (getGameRoom).`);
    return null;
  } catch (error) {
    console.error(`MongoDB: Error fetching game room ${gameId} (getGameRoom):`, error);
    return null;
  }
}

async function updateGameRoom(gameId: string, operationData: Partial<GameRoom> | any, isCreatingNew: boolean = false): Promise<GameRoom | null> {
  try {
      await dbConnectionPromise;
  } catch (connectionError) {
      console.error(`MongoDB connection error (updateGameRoom for ${gameId}):`, connectionError);
      return null;
  }
  if (!db) {
      console.warn(`MongoDB: db instance is null (updateGameRoom for ${gameId}) after promise. Critical connection issue.`);
      return null;
  }

  if (isCreatingNew) {
      // Create new room
      const newRoomDocument: GameRoom = {
          gameId: gameId, // Ensure gameId from parameter is used
          playerCount: operationData.playerCount || 0,
          players: operationData.players || {},
          status: operationData.status || 'WAITING_FOR_PLAYERS',
          secretsSetCount: operationData.secretsSetCount || 0,
          targetMap: operationData.targetMap || {},
          turn: operationData.turn, // Can be undefined
          winner: operationData.winner, // Can be undefined
          // Spread other fields from operationData, gameId will be overwritten by the explicit one above
          ...operationData 
      };
      // Crucially ensure the gameId is the one passed to the function, not one potentially in operationData
      newRoomDocument.gameId = gameId; 

      try {
          console.log(`MongoDB: Attempting to insert new game room ${gameId} with data:`, JSON.stringify(newRoomDocument));
          const insertResult = await db.collection<GameRoom>(COLLECTION_NAME).insertOne(newRoomDocument as any);
          if (insertResult.acknowledged && insertResult.insertedId) {
              console.log(`MongoDB: Successfully inserted new game room ${gameId}.`);
              // Fetch the newly inserted document to ensure consistency and include _id (though we strip it)
              return await getGameRoom(gameId); 
          }
          console.error(`MongoDB: Insert new game room ${gameId} not acknowledged or missing insertedId.`);
          return null;
      } catch (insertError: any) {
          console.error(`MongoDB: Error inserting new game room ${gameId}:`, insertError);
          // If it's a duplicate key error (E11000), it means it somehow already exists.
          if (insertError.code === 11000) {
              console.warn(`MongoDB: Insert failed for ${gameId} due to duplicate key. Attempting to fetch existing.`);
              return await getGameRoom(gameId); // Try to fetch it, maybe a race condition created it.
          }
          return null;
      }
  } else {
      // Update existing room
      // operationData should be MongoDB update operators like {$set: ..., $inc: ...}
      let updateOps: any = {};
      if (Object.keys(operationData).length === 0) {
          console.warn(`MongoDB: updateGameRoom called for ${gameId} with empty operationData. No update performed.`);
          return await getGameRoom(gameId); // Return current state if no ops
      }

      if (Object.keys(operationData).some(key => key.startsWith('$'))) {
          updateOps = { ...operationData };
      } else {
          // If it's a plain object, assume $set, but EXCLUDE gameId
          const { gameId: opGameId, ...fieldsToSet } = operationData;
          if (Object.keys(fieldsToSet).length > 0) {
            updateOps.$set = fieldsToSet;
          }
      }

      // Ensure gameId is never in any $set operation
      if (updateOps.$set && updateOps.$set.gameId) {
          delete updateOps.$set.gameId;
      }
      if (updateOps.$set && Object.keys(updateOps.$set).length === 0) { // Avoid empty $set
          delete updateOps.$set;
      }
      if (Object.keys(updateOps).length === 0) {
        console.warn(`MongoDB: No valid update operations for ${gameId} after processing operationData. Returning current state.`);
        return await getGameRoom(gameId);
      }


      try {
          console.log(`MongoDB: Attempting to update existing game room ${gameId} with ops:`, JSON.stringify(updateOps));
          const updateResult = await db.collection<GameRoom>(COLLECTION_NAME).updateOne({ gameId }, updateOps);
          if (updateResult.acknowledged) {
              console.log(`MongoDB: Update for game room ${gameId} acknowledged. Matched: ${updateResult.matchedCount}, Modified: ${updateResult.modifiedCount}.`);
              return await getGameRoom(gameId); // Fetch updated document
          }
          console.error(`MongoDB: Update existing game room ${gameId} not acknowledged.`);
          return null;
      } catch (updateError) {
          console.error(`MongoDB: Error updating existing game room ${gameId} with ops ${JSON.stringify(updateOps)}:`, updateError);
          return null;
      }
  }
}


export default function handler(
  req: NextApiRequest,
  res: NextApiResponseWithSocket
) {
  if (req.method === 'POST') {
    if (res.socket.server.io) {
      // console.log('Socket.IO server already running.');
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
              await dbConnectionPromise; 
              if (!db) {
                  console.warn(`DB not available during disconnect for player ${playerId} in game ${gameId}`);
                  return;
              }
              let room = await getGameRoom(gameId);
              if (room && room.players[playerId]) {
                io.to(gameId).emit('player-disconnected', { 
                  gameId, 
                  playerId,
                  message: `${playerId} has disconnected.` 
                });
                
                if (room.playerCount === 2 && room.status === 'IN_PROGRESS') {
                    const remainingPlayerIds = Object.keys(room.players).filter(pId => pId !== playerId); 
                    if (remainingPlayerIds.length === 1) {
                        const winnerId = remainingPlayerIds[0];
                        if (room.players[winnerId]) { 
                             const gameOverUpdate = { status: 'GAME_OVER' as MultiplayerGameStatus, winner: winnerId, turn: undefined };
                             const updatedRoom = await updateGameRoom(gameId, { $set: gameOverUpdate });
                             if (updatedRoom) {
                                 io.to(gameId).emit('game-over', { gameId, winner: winnerId });
                                 io.to(gameId).emit('game-state-update', updatedRoom);
                             }
                        }
                    }
                } else if (room.status !== 'GAME_OVER') { 
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
          
          try {
            await dbConnectionPromise;
          } catch (dbError) {
            socket.emit('error-event', { message: 'Database connection error. Please try again later.' });
            return;
          }
          if (!db) { 
            socket.emit('error-event', { message: 'Database not connected (post-promise). Please try again later.' });
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
          
          const playerObjectBase: PlayerData = { socketId: socket.id, guessesMade: [], guessesAgainst: [], secret: [] };

          if (!room) { 
            console.log(`Game room ${gameId} not found in DB. Attempting to create for ${numPlayerCount} players.`);
            assignedPlayerId = rejoiningPlayerId || `player1`; 
            const initialPlayers: { [playerId: string]: PlayerData } = {};
            initialPlayers[assignedPlayerId] = playerObjectBase;

            const newRoomData: Partial<GameRoom> = {
              playerCount: numPlayerCount,
              players: initialPlayers,
              status: 'WAITING_FOR_PLAYERS',
              secretsSetCount: 0,
              targetMap: {},
            };
            // Pass gameId explicitly for creation context, newRoomData contains the rest
            room = await updateGameRoom(gameId, newRoomData, true); 
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
            
            const existingPlayerData = room.players[assignedPlayerId] || {};
            const playerUpdatePayload = {
              $set: {
                [`players.${assignedPlayerId}`]: {
                  ...playerObjectBase, 
                  ...existingPlayerData, 
                  socketId: socket.id 
                }
              }
            };
            
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
          try {
            await dbConnectionPromise;
          } catch (dbError) {
            socket.emit('error-event', { message: 'Database connection error (send-secret).' });
            return;
          }
          if (!db) { socket.emit('error-event', { message: 'Database not connected (send-secret).' }); return; }
          
          let room = await getGameRoom(gameId);

          if (!room || !room.players[playerId] || (room.status !== 'ALL_PLAYERS_JOINED' && room.status !== 'SETTING_SECRETS')) {
            socket.emit('error-event', { message: `Cannot set secret. Game Status: ${room?.status}, Player: ${playerId}` });
            return;
          }
          
          if (room.players[playerId].secret && room.players[playerId].secret!.length > 0) {
             console.log(`Player ${playerId} trying to set secret again for ${gameId}. Already set.`);
             io.to(gameId).emit('game-state-update', room); 
             return;
          }
          
          const setSecretUpdate: any = {
                $set: {
                    [`players.${playerId}.secret`]: secret,
                },
                $inc: { secretsSetCount: 1 } 
            };
            
            if (room.status === 'ALL_PLAYERS_JOINED') {
                if(!setSecretUpdate.$set) setSecretUpdate.$set = {};
                setSecretUpdate.$set.status = 'SETTING_SECRETS';
            }
            
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

          if (room.secretsSetCount === room.playerCount && (room.status === 'SETTING_SECRETS')) {
            console.log(`All secrets set for game ${gameId}. Starting game.`);
            
            const playerIds = Object.keys(room.players).sort(); 
            let targetMap: { [playerId: string]: string } = {};
            if (room.playerCount === 2) { 
               targetMap = { [playerIds[0]]: playerIds[1], [playerIds[1]]: playerIds[0] };
            } 
            
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
          try {
            await dbConnectionPromise;
          } catch (dbError) {
            socket.emit('error-event', { message: 'Database connection error (make-guess).' });
            return;
          }
          if (!db) { socket.emit('error-event', { message: 'Database not connected (make-guess).' }); return; }
          
          let room = await getGameRoom(gameId);

          if (!room || room.status !== 'IN_PROGRESS') {
            socket.emit('error-event', { message: 'Game not in progress.' }); return;
          }
          if (room.turn !== playerId) {
            socket.emit('error-event', { message: 'Not your turn.' }); return;
          }
          
          const targetPlayerId = room.targetMap?.[playerId];
          if (!targetPlayerId || !room.players[targetPlayerId]?.secret || room.players[targetPlayerId].secret?.length === 0) {
            socket.emit('error-event', { message: 'Target player or their secret not found or not set.' }); return;
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
          
          const updatedRoomAfterGuess = await updateGameRoom(gameId, updateFields);

          if (!updatedRoomAfterGuess) { 
              socket.emit('error-event', { message: 'Failed to update game after guess.'}); 
              const currentRoomStateOnError = await getGameRoom(gameId); 
              if (currentRoomStateOnError) io.to(gameId).emit('game-state-update', currentRoomStateOnError);
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
    
