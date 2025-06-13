
import type { Server as HTTPServer } from 'http';
import type { Socket as NetSocket } from 'net';
import type { NextApiRequest, NextApiResponse } from 'next';
import { Server as SocketIOServer, Socket } from 'socket.io';
import type { GameRoom, PlayerData, Guess, MultiplayerGameStatus } from '@/types/game';
import { calculateFeedback, checkWin } from '@/lib/gameLogic';
import { MongoClient, Db as MongoDb, UpdateOptions } from 'mongodb';

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
    // Note: Manual creation of the unique index on gameId in MongoDB Atlas is recommended.
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
    console.log(`MongoDB: Game room ${gameId} not found.`);
    return null;
  } catch (error) {
    console.error(`MongoDB: Error fetching game room ${gameId}:`, error);
    return null;
  }
}

async function updateGameRoom(gameId: string, operationData: Partial<GameRoom> | any): Promise<GameRoom | null> {
  try {
    await dbConnectionPromise;
  } catch (connectionError) {
    console.error(`MongoDB connection error (updateGameRoom for ${gameId}):`, connectionError);
    return null;
  }
  if (!db) {
    console.warn(`MongoDB: db instance is null (updateGameRoom for ${gameId}) even after promise. Critical connection issue.`);
    return null;
  }
  
  const filter = { gameId: gameId };

  // Default fields for a new room if an upsert results in an insert
  const defaultsOnInsert: Partial<GameRoom> = {
    playerCount: (operationData as GameRoom).playerCount !== undefined ? (operationData as GameRoom).playerCount : 0,
    players: {},
    status: 'WAITING_FOR_PLAYERS',
    secretsSetCount: 0,
    targetMap: {},
    turn: undefined,
    winner: undefined,
  };

  let updateDocument: any = {};
  
  // Separate operationData from gameId for $set operations
  const { gameId: opGameIdToRemove, ...fieldsToSetOrMerge } = operationData;

  if (Object.keys(fieldsToSetOrMerge).some(key => key.startsWith('$'))) {
    // If operationData already contains MongoDB operators (e.g., $set, $inc)
    updateDocument = { ...fieldsToSetOrMerge };
    if (updateDocument.$set && updateDocument.$set.gameId) {
      delete updateDocument.$set.gameId; // Ensure gameId is not in $set
    }
  } else {
    // If operationData is a plain object of fields to set
    updateDocument.$set = { ...fieldsToSetOrMerge };
  }
  
  // Always define $setOnInsert for the upsert operation
  // It includes the gameId from the filter, defaults, and merges operationData (excluding its gameId)
  updateDocument.$setOnInsert = {
    gameId: gameId, // Set gameId from the filter for new documents
    ...defaultsOnInsert,
    ...fieldsToSetOrMerge, // Merge other fields from operationData for new docs
  };
   // Clean up $setOnInsert if operationData had its own gameId, filter's gameId takes precedence
  if (updateDocument.$setOnInsert.gameId && updateDocument.$setOnInsert.gameId !== gameId) {
    // This case should ideally not happen if opGameIdToRemove was effective, but defensive
    delete updateDocument.$setOnInsert.gameId; 
    updateDocument.$setOnInsert.gameId = gameId;
  }


  // Remove empty $set to avoid issues
  if (updateDocument.$set && Object.keys(updateDocument.$set).length === 0) {
    delete updateDocument.$set;
  }
  // If only $setOnInsert is needed (e.g. initial creation with no $set ops)
  if (!updateDocument.$set && !Object.keys(fieldsToSetOrMerge).some(key => key.startsWith('$'))) {
      // No $set fields and no other operators, ensure $setOnInsert is the primary operation for creation.
  }


  try {
    const options: UpdateOptions = { upsert: true };
    
    const result = await db.collection<GameRoom>(COLLECTION_NAME).updateOne(
      filter,
      updateDocument,
      options
    );
    
    // console.log(`MongoDB: Update operation for game room ${gameId}. Matched: ${result.matchedCount}, Modified: ${result.modifiedCount}, UpsertedId: ${result.upsertedId}`);

    if (result.acknowledged) {
      return await getGameRoom(gameId); 
    }
    
    console.warn(`MongoDB: updateOne for game ${gameId} was not acknowledged or failed. Result:`, result);
    return null;

  } catch (error: any) {
    console.error(`MongoDB: Error updating game room ${gameId}. Filter: ${JSON.stringify(filter)}, UpdateDoc: ${JSON.stringify(updateDocument)}`, error);
    if (error.code === 40) { 
        console.error("Detailed conflict info (code 40): Filter:", JSON.stringify(filter), "Operation:", JSON.stringify(updateDocument));
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
      // console.log('Socket.IO server already running.');
    } else {
      console.log('Initializing Socket.IO server...');
      const io = new SocketIOServer(res.socket.server, {
        path: '/api/socketio_c', 
        addTrailingSlash: false, // Client should match this
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
                // Basic notification, can be expanded
                io.to(gameId).emit('player-disconnected', { 
                  gameId, 
                  playerId,
                  message: `${playerId} has disconnected.` 
                });
                
                // Example: Auto-end game if only 2 players and one disconnects
                if (room.playerCount === 2 && room.status === 'IN_PROGRESS') {
                    const remainingPlayerIds = Object.keys(room.players).filter(pId => pId !== playerId && room!.players[pId].socketId !== socket.id); // Check socketId too if players can rejoin
                    if (remainingPlayerIds.length === 1) {
                        const winnerId = remainingPlayerIds[0];
                        if (room.players[winnerId]) { // Ensure remaining player still exists
                             const gameOverUpdate = { status: 'GAME_OVER' as MultiplayerGameStatus, winner: winnerId, turn: undefined };
                             const updatedRoom = await updateGameRoom(gameId, { $set: gameOverUpdate });
                             if (updatedRoom) {
                                 io.to(gameId).emit('game-over', { gameId, winner: winnerId });
                                 io.to(gameId).emit('game-state-update', updatedRoom);
                             }
                        }
                    }
                } else if (room.status !== 'GAME_OVER') { 
                    // For other cases, just send a state update
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
            console.log(`Game room ${gameId} not found in DB. Creating for ${numPlayerCount} players.`);
            assignedPlayerId = rejoiningPlayerId || `player1`; 
            const initialPlayers: { [playerId: string]: PlayerData } = {};
            initialPlayers[assignedPlayerId] = playerObjectBase;

            const newRoomData: Partial<GameRoom> = {
              // gameId is implicitly handled by the filter in updateGameRoom's upsert
              playerCount: numPlayerCount,
              players: initialPlayers,
              status: 'WAITING_FOR_PLAYERS',
              secretsSetCount: 0,
              targetMap: {},
            };
            room = await updateGameRoom(gameId, newRoomData); 
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
            
            // Prepare player update ensuring socketId is current, other data preserved or initialized
            const existingPlayerData = room.players[assignedPlayerId] || {};
            const playerUpdatePayload: any = {
              $set: {
                [`players.${assignedPlayerId}`]: {
                  ...playerObjectBase, // Base structure (empty arrays for guesses, secret)
                  ...existingPlayerData, // Overlay existing data
                  socketId: socket.id // Always update socketId
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
            // Re-send full state, client should handle merging or replacing
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
          
          // Check if secret already set to prevent re-incrementing secretsSetCount
          if (room.players[playerId].secret && room.players[playerId].secret!.length > 0) {
             console.log(`Player ${playerId} trying to set secret again for ${gameId}. Already set.`);
             // Send current state back, or a specific "already set" event
             io.to(gameId).emit('game-state-update', room); 
             return;
          }
          
          // Only increment secretsSetCount if this is a new secret being set
          const setSecretUpdate: any = {
                $set: {
                    [`players.${playerId}.secret`]: secret,
                },
                $inc: { secretsSetCount: 1 } // This will be applied once
            };
            
            // If this is the first secret being set, transition status
            if (room.status === 'ALL_PLAYERS_JOINED') {
                setSecretUpdate.$set.status = 'SETTING_SECRETS';
            }
            
          const roomAfterSecretAttempt = await updateGameRoom(gameId, setSecretUpdate);

          if (!roomAfterSecretAttempt) {
             console.warn(`Failed to set secret for ${playerId} in ${gameId}. Re-fetching current state.`);
             room = await getGameRoom(gameId); // Get latest state
             if (room) { 
                // Emit based on actual DB state
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
            if (room.playerCount === 2) { // For now, only Duo logic for targetMap
               targetMap = { [playerIds[0]]: playerIds[1], [playerIds[1]]: playerIds[0] };
            } 
            // TODO: Add targetMap logic for Trio/Quads if/when implemented
            
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
    
