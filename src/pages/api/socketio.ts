
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
const DATABASE_NAME = "4SureDB"; 
const COLLECTION_NAME = "gameRooms";

let db: MongoDb | null = null;
let resolveDbConnection: (value: MongoDb | PromiseLike<MongoDb>) => void;
let rejectDbConnection: (reason?: any) => void;

const dbConnectionPromise = new Promise<MongoDb>((resolve, reject) => {
  resolveDbConnection = resolve;
  rejectDbConnection = reject;
});

(async () => {
  if (!MONGODB_URI) {
    console.warn('MONGODB_URI not found. Database operations will be unavailable.');
    rejectDbConnection(new Error('MONGODB_URI not found'));
    return;
  }
  try {
    console.log("Attempting to connect to MongoDB...");
    const client = new MongoClient(MONGODB_URI);
    await client.connect();
    db = client.db(DATABASE_NAME);
    console.log(`Successfully connected to MongoDB. Database: ${DATABASE_NAME}`);
    // It's good practice to ensure a unique index on gameId. 
    // Create this manually in Atlas or via shell: db.gameRooms.createIndex( { "gameId": 1 }, { unique: true } )
    // console.log(`MongoDB: Targeting collection: '${COLLECTION_NAME}' in database '${DATABASE_NAME}'.`);
    // await db.collection(COLLECTION_NAME).createIndex({ gameId: 1 }, { unique: true });
    // console.log(`MongoDB: Ensured unique index on 'gameId' in '${COLLECTION_NAME}'. DB setup complete.`);
    resolveDbConnection(db);
  } catch (error) {
    console.error("Error connecting to MongoDB or setting up:", error);
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

async function updateGameRoom(gameId: string, operationData: Partial<GameRoom> | any): Promise<GameRoom | null> {
  try {
    await dbConnectionPromise;
  } catch (connectionError) {
    console.error(`MongoDB connection error during updateGameRoom for ${gameId}:`, connectionError);
    return null;
  }
  if (!db) {
    console.warn(`MongoDB: db instance is null (updateGameRoom for ${gameId}) after promise. Critical connection issue.`);
    return null;
  }

  const filter = { gameId: gameId };
  let updateDocument: any = {};

  // If operationData contains MongoDB operators (like $set, $inc), use them directly.
  // Otherwise, assume it's an object of fields to set.
  if (Object.keys(operationData).some(key => key.startsWith('$'))) {
    updateDocument = { ...operationData };
  } else {
    // It's a direct set of fields, ensure gameId is not part of it.
    const { gameId: opGameId, ...fieldsToSet } = operationData;
    if (Object.keys(fieldsToSet).length > 0) {
      updateDocument.$set = fieldsToSet;
    }
  }
  
  // Define what to insert if the document doesn't exist (upsert)
  // This should be the full initial structure of a new room
  const defaultNewRoomStructure: GameRoom = {
    gameId: gameId, // gameId from filter is authoritative for new doc
    playerCount: operationData.playerCount || 0, // Comes from operationData if creating
    players: operationData.players || {},       // Comes from operationData if creating
    status: operationData.status || 'WAITING_FOR_PLAYERS', // Comes from operationData if creating
    secretsSetCount: 0,
    targetMap: {},
    turn: undefined,
    winner: undefined,
  };

  // For $setOnInsert, merge defaults with any specific fields passed for creation in operationData
  // Ensure gameId from filter is the one used on insert.
  const { gameId: opGameIdForInsert, ...setOnInsertFields } = operationData;
  updateDocument.$setOnInsert = { ...defaultNewRoomStructure, ...setOnInsertFields, gameId: gameId };

  // Remove gameId from $set if it somehow slipped in, as it's immutable
  if (updateDocument.$set && updateDocument.$set.hasOwnProperty('gameId')) {
    delete updateDocument.$set.gameId;
  }
  if (updateDocument.$set && Object.keys(updateDocument.$set).length === 0) {
    delete updateDocument.$set; // Avoid empty $set
  }

  if (Object.keys(updateDocument).length === 0) {
    console.warn(`MongoDB: No valid update operations for ${gameId}. Returning current state.`);
    return getGameRoom(gameId);
  }

  const options: FindOneAndUpdateOptions = {
    upsert: true,
    returnDocument: 'after' // Return the modified document
  };

  try {
    console.log(`MongoDB: Attempting findOneAndUpdate for game room ${gameId} with filter: ${JSON.stringify(filter)}, update: ${JSON.stringify(updateDocument)}`);
    const result = await db.collection<GameRoom>(COLLECTION_NAME).findOneAndUpdate(filter, updateDocument, options);
    
    if (result && result.value) {
      console.log(`MongoDB: findOneAndUpdate successful for ${gameId}.`);
      const { _id, ...roomData } = result.value as any;
      return roomData as GameRoom;
    } else {
      console.error(`MongoDB: findOneAndUpdate for ${gameId} did not return a document. This can happen if upsert failed or filter didn't match after an attempt.`);
      // It's possible the document was created but not returned, try fetching it directly.
      return getGameRoom(gameId);
    }
  } catch (error: any) {
    console.error(`MongoDB: Error during findOneAndUpdate for ${gameId} with filter ${JSON.stringify(filter)} and update ${JSON.stringify(updateDocument)}:`, error);
    if (error.code === 40) { // Specific conflict error
        console.error("Detailed Error 40: Attempted to update 'gameId' or conflicting unique index issue. Filter:", filter, "Update:", updateDocument);
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
        addTrailingSlash: false, 
      });
      res.socket.server.io = io;

      io.on('connection', async (socket: CustomSocket) => { // Made handler async
        try {
          await dbConnectionPromise; // Ensure DB is connected before setting up listeners or processing events
          console.log('MongoDB connection confirmed for new socket connection:', socket.id);
        } catch (dbError) {
          console.error(`Socket ${socket.id} failed to connect due to DB init error:`, dbError);
          socket.emit('error-event', { message: 'Server database initialization error. Please try again later.' });
          socket.disconnect(true);
          return;
        }

        console.log('Socket connected:', socket.id);

        socket.on('disconnect', async () => {
          const gameId = socket.gameId;
          const playerId = socket.playerId;
          console.log(`Socket disconnected: ${socket.id}, Player: ${playerId}, Game: ${gameId}`);

          if (gameId && playerId) { 
            try {
              // await dbConnectionPromise; // Already awaited at connection start
              if (!db) {
                  console.warn(`DB not available during disconnect for player ${playerId} in game ${gameId}`);
                  return;
              }
              let room = await getGameRoom(gameId);
              if (room && room.players[playerId]) {
                // Optionally, update player's socketId to indicate disconnection or remove player
                // For simplicity, we'll just notify and handle game over for 2-player games.
                io.to(gameId).emit('player-disconnected', { 
                  gameId, 
                  playerId,
                  message: `${playerId} has disconnected.` 
                });
                
                if (room.playerCount === 2 && room.status === 'IN_PROGRESS') {
                    const remainingPlayerIds = Object.keys(room.players).filter(pId => pId !== playerId && room!.players[pId].socketId !== socket.id);
                    if (remainingPlayerIds.length === 1) {
                        const winnerId = remainingPlayerIds[0];
                        if (room.players[winnerId]) { 
                             const gameOverUpdate = { $set: { status: 'GAME_OVER' as MultiplayerGameStatus, winner: winnerId, turn: undefined }};
                             const updatedRoom = await updateGameRoom(gameId, gameOverUpdate);
                             if (updatedRoom) {
                                 io.to(gameId).emit('game-over', { gameId, winner: winnerId });
                                 io.to(gameId).emit('game-state-update', updatedRoom);
                             }
                        }
                    }
                } else if (room.status !== 'GAME_OVER') { 
                    // Potentially remove player or mark as disconnected for larger games
                    // For now, just send updated state
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
          // await dbConnectionPromise; // Ensured at main connection handler
          if (!db) { 
            socket.emit('error-event', { message: 'Database not connected (join-game). Please try again later.' });
            return;
          }

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
          
          const playerObjectBase: PlayerData = { socketId: socket.id, guessesMade: [], guessesAgainst: [], secret: [] };

          if (!room) { 
            console.log(`Game room ${gameId} not found in DB. Attempting to create for ${numPlayerCount} players.`);
            assignedPlayerId = rejoiningPlayerId || `player1`; 
            const initialPlayers: { [playerId: string]: PlayerData } = {};
            initialPlayers[assignedPlayerId] = playerObjectBase;

            const newRoomData: GameRoom = { // Pass the full GameRoom structure
              gameId: gameId,
              playerCount: numPlayerCount,
              players: initialPlayers,
              status: 'WAITING_FOR_PLAYERS',
              secretsSetCount: 0,
              targetMap: {},
              turn: undefined,
              winner: undefined
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
            
            const existingPlayerData = room.players[assignedPlayerId] || {};
            const playerUpdatePayload = { // MongoDB update operators
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
            const newStatusUpdate = { $set: {status: 'ALL_PLAYERS_JOINED' as MultiplayerGameStatus} };
            console.log(`All ${room.playerCount} players joined game ${gameId}. Status changing to ALL_PLAYERS_JOINED.`);
            const statusUpdatedRoom = await updateGameRoom(gameId, newStatusUpdate);
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
          // await dbConnectionPromise; // Ensured at main connection handler
          if (!db) { socket.emit('error-event', { message: 'Database not connected (send-secret).' }); return; }
          
          const { gameId, playerId, secret } = data;
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
          
          let secretUpdateOps: any = {
                $set: {
                    [`players.${playerId}.secret`]: secret,
                },
                $inc: { secretsSetCount: 1 } 
            };
            
          if (room.status === 'ALL_PLAYERS_JOINED') {
              secretUpdateOps.$set.status = 'SETTING_SECRETS';
          }
            
          const roomAfterSecretAttempt = await updateGameRoom(gameId, secretUpdateOps);

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
          // await dbConnectionPromise; // Ensured at main connection handler
          if (!db) { socket.emit('error-event', { message: 'Database not connected (make-guess).' }); return; }
          
          const { gameId, playerId, guess: guessArray } = data;
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
    
