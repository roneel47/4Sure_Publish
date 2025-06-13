
import type { Server as HTTPServer } from 'http';
import type { Socket as NetSocket } from 'net';
import type { NextApiRequest, NextApiResponse } from 'next';
import { Server as SocketIOServer, Socket } from 'socket.io';
import type { GameRoom, PlayerData, Guess, MultiplayerGameStatus } from '@/types/game';
import { calculateFeedback, checkWin } from '@/lib/gameLogic';
import { MongoClient, Db as MongoDb, FindOneAndUpdateOptions, MongoError, ModifyResult, WithId } from 'mongodb';

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
let dbConnectionPromise: Promise<MongoDb | null>;

// Initialize with dummy functions to satisfy TypeScript's definite assignment analysis
let resolveDbConnection: (value: MongoDb | null | PromiseLike<MongoDb | null>) => void = () => {};
let rejectDbConnection: (reason?: any) => void = () => {};

dbConnectionPromise = new Promise<MongoDb | null>((resolve, reject) => {
  resolveDbConnection = resolve;
  rejectDbConnection = reject;
});

(async () => {
  console.log("Attempting to connect to MongoDB...");
  if (!MONGODB_URI) {
    console.warn('MONGODB_URI not found. Database operations will be unavailable.');
    rejectDbConnection(new Error('MONGODB_URI not found'));
    return;
  }
  try {
    const client = new MongoClient(MONGODB_URI);
    await client.connect();
    db = client.db(DATABASE_NAME);
    console.log(`Successfully connected to MongoDB. Database: ${DATABASE_NAME}`);
    console.log(`MongoDB: Targeting collection: '${COLLECTION_NAME}' in database '${DATABASE_NAME}'.`);
    // IMPORTANT: Ensure you have a unique index on 'gameId' in your 'gameRooms' collection.
    // You can create this in MongoDB Atlas UI or mongo shell:
    // db.gameRooms.createIndex( { "gameId": 1 }, { unique: true } )
    console.log(`MongoDB: DB setup complete. Ensure unique index on 'gameId' in '${COLLECTION_NAME}' exists for reliability.`);
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

export async function getGameRoom(gameId: string): Promise<GameRoom | null> {
  await dbConnectionPromise;
  if (!db) {
    console.warn(`MongoDB: db instance is null (getGameRoom for ${gameId}). Critical connection issue.`);
    return null;
  }
  try {
    const roomDocument: WithId<GameRoom> | null = await db.collection<GameRoom>(COLLECTION_NAME).findOne({ gameId: gameId });
    if (roomDocument) {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { _id, ...data } = roomDocument; 
        return data as GameRoom;
    }
    return null;
  } catch (error) {
    console.error(`MongoDB: Error fetching game room ${gameId} (getGameRoom):`, error);
    return null;
  }
}

async function createGameRoom(gameId: string, newRoomData: GameRoom): Promise<GameRoom | null> {
    await dbConnectionPromise;
    if (!db) {
      console.error(`MongoDB: db instance is null (createGameRoom for ${gameId}). Cannot create.`);
      return null;
    }
    try {
      // Ensure gameId from parameter is part of the document, matching GameRoom type.
      const fullDocumentToInsert: GameRoom = { ...newRoomData, gameId: gameId };
      await db.collection<GameRoom>(COLLECTION_NAME).insertOne(fullDocumentToInsert);
      console.log(`MongoDB: Successfully created game room ${gameId}.`);
      // The document in JS already matches GameRoom (no _id from type def), so just return it
      return fullDocumentToInsert;
    } catch (error: any) {
      if (error instanceof MongoError && error.code === 11000) { // Duplicate key error
        console.warn(`MongoDB: Attempted to create game room ${gameId}, but it already exists (duplicate key). Likely race condition resolved.`);
        return null; // Indicate that another process likely created it.
      }
      console.error(`MongoDB: Error creating game room ${gameId} (createGameRoom):`, error);
      return null;
    }
}

export async function updateGameRoom(
  gameId: string,
  updateOperators: any 
): Promise<GameRoom | null> {
  await dbConnectionPromise;
  if (!db) {
    console.warn(`MongoDB: db instance is null (updateGameRoom for ${gameId}). Cannot update.`);
    return null;
  }

  const filter = { gameId: gameId };
  const options: FindOneAndUpdateOptions = {
    returnDocument: 'after',
  };

  try {
    // Explicitly type the result
    const result: ModifyResult<GameRoom> = await db.collection<GameRoom>(COLLECTION_NAME).findOneAndUpdate(filter, updateOperators, options);
    
    if (result && result.value) { 
      // result.value is the updated document (GameRoom | null)
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { _id, ...roomData } = result.value as WithId<GameRoom>; // Cast to WithId to handle _id if present
      return roomData as GameRoom; // Return as GameRoom (without _id as per type)
    } else if (result && !result.value) {
        console.warn(`MongoDB: updateGameRoom for ${gameId} - Filter matched, but 'result.value' is null. This is unexpected with returnDocument: 'after' unless the document was deleted by the update or the update effectively made it null (not typical).`);
        const refetchedRoom = await getGameRoom(gameId);
        if (refetchedRoom) {
            console.log(`MongoDB: updateGameRoom for ${gameId} - Re-fetched successfully after null value from update.`);
            return refetchedRoom;
        }
        console.warn(`MongoDB: updateGameRoom for ${gameId} - Re-fetch also failed after null value from update.`);
        return null;
    }
    console.warn(`MongoDB: updateGameRoom for ${gameId} did not find/update document (result object itself might be null/undefined or 'ok' status was not 1).`);
    return null;
  } catch (error: any) {
    console.error(`MongoDB: Error during updateGameRoom for ${gameId}. Filter: ${JSON.stringify(filter)}, Update: ${JSON.stringify(updateOperators)}, Error:`, error);
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

      io.on('connection', async (socket: CustomSocket) => { 
        try {
          await dbConnectionPromise; 
          if (!db) {
            console.error(`MongoDB: DB instance is null for new socket connection ${socket.id}. Critical connection issue. Disconnecting socket.`);
            socket.emit('error-event', { message: 'Server database connection critical error. Cannot process connection.' });
            socket.disconnect(true);
            return;
          }
          console.log(`Socket connected: ${socket.id} - MongoDB connection confirmed for this socket.`);
        } catch (dbError) {
          console.error(`Socket ${socket.id} connection aborted due to DB init error:`, dbError);
          socket.emit('error-event', { message: 'Server database initialization error. Please try again later.' });
          socket.disconnect(true);
          return; 
        }

        socket.on('disconnect', async () => {
          await dbConnectionPromise;
          if(!db) {
            console.error(`MongoDB: DB unavailable for disconnect logic (Player ${socket.playerId}, Game ${socket.gameId})`);
            return;
          }
          console.log(`Socket disconnected: ${socket.id}, Player: ${socket.playerId}, Game: ${socket.gameId}`);

          const gameId = socket.gameId;
          const playerId = socket.playerId;

          if (gameId && playerId) {
            try {
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
                        const gameOverUpdate = { $set: { status: 'GAME_OVER' as MultiplayerGameStatus, winner: winnerId, turn: undefined }};
                        const updatedRoom = await updateGameRoom(gameId, gameOverUpdate); 
                        if (updatedRoom) {
                            io.to(gameId).emit('game-over', { gameId, winner: winnerId });
                            io.to(gameId).emit('game-state-update', updatedRoom);
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
            await dbConnectionPromise;
            if (!db) {
                socket.emit('error-event', { message: 'Database connection not available in join-game handler.' });
                console.error(`MongoDB: DB unavailable in join-game handler for ${data.gameId} (socket ${socket.id}).`);
                return;
            }
            console.log(`Socket ${socket.id} attempting to join game: ${data.gameId} (PlayerCount: ${data.playerCount}) - DB Connection Confirmed for this handler.`);
            
            const { gameId, playerCount: playerCountString, rejoiningPlayerId } = data;
            const numPlayerCount = getPlayerCountNumber(playerCountString);

            if (!numPlayerCount) {
              socket.emit('error-event', { message: 'Invalid player count specified.' });
              return;
            }

            socket.join(gameId);
            let room = await getGameRoom(gameId);
            let assignedPlayerId: string | undefined = rejoiningPlayerId;
            let playerUpdatePayload: any;
            let roomUpdateResult: GameRoom | null = null;

            if (!room) {
                console.log(`Game room ${gameId} not found in DB. Preparing to create for ${numPlayerCount} players.`);
                assignedPlayerId = rejoiningPlayerId || `player1`; 
                const initialPlayers: { [playerId: string]: PlayerData } = {};
                initialPlayers[assignedPlayerId] = { socketId: socket.id, guessesMade: [], guessesAgainst: [], secret: [] };
                
                const newRoomDataForCreation: GameRoom = { 
                  gameId: gameId, // gameId is part of GameRoom type
                  playerCount: numPlayerCount,
                  players: initialPlayers,
                  status: 'WAITING_FOR_PLAYERS',
                  secretsSetCount: 0,
                  targetMap: {},
                  turn: undefined,
                  winner: undefined,
                };

                roomUpdateResult = await createGameRoom(gameId, newRoomDataForCreation);
                if (!roomUpdateResult) { 
                    console.log(`Failed to create game room ${gameId} (likely race, re-fetching).`);
                    room = await getGameRoom(gameId); 
                    if (!room) {
                        socket.emit('error-event', { message: 'Failed to create or find game room after race condition.' });
                        console.error(`Failed to get room ${gameId} even after createGameRoom returned null.`);
                        return;
                    }
                } else {
                    room = roomUpdateResult; 
                }
            }
            
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
            
            if (!isPlayerAlreadyInRoom) {
                 if (Object.keys(room.players).length >= room.playerCount) {
                     socket.emit('error-event', { message: 'Game room became full while trying to assign player ID.' });
                     socket.leave(gameId);
                     return;
                 }
                 // Add new player
                 const newPlayerData: PlayerData = { socketId: socket.id, guessesMade: [], guessesAgainst: [], secret: [] };
                 playerUpdatePayload = { $set: { [`players.${assignedPlayerId}`]: newPlayerData } };
                 roomUpdateResult = await updateGameRoom(gameId, playerUpdatePayload);
            } else {
                 // Player is rejoining, just update socketId if necessary
                 if (room.players[assignedPlayerId].socketId !== socket.id) {
                    playerUpdatePayload = { $set: { [`players.${assignedPlayerId}.socketId`]: socket.id } };
                    roomUpdateResult = await updateGameRoom(gameId, playerUpdatePayload);
                 } else {
                    roomUpdateResult = room; // No update needed if socketId is the same
                 }
            }
            
            if (!roomUpdateResult) {
                socket.emit('error-event', { message: 'Failed to update game room with new/rejoining player.' });
                const currentRoomState = await getGameRoom(gameId); // Fetch current state before erroring out
                if (currentRoomState) io.to(gameId).emit('game-state-update', currentRoomState);
                return;
            }
            room = roomUpdateResult;

            socket.gameId = gameId; 
            socket.playerId = assignedPlayerId; 
            socket.emit('player-assigned', { playerId: assignedPlayerId!, gameId }); 
            io.to(gameId).emit('game-state-update', room); 

            if ((room.status === 'WAITING_FOR_PLAYERS' || room.status === 'ALL_PLAYERS_JOINED') && Object.keys(room.players).length === room.playerCount) {
              // Check current status before updating to avoid unnecessary writes or race conditions
              const currentRoomForStatusCheck = await getGameRoom(gameId);
              if (currentRoomForStatusCheck && currentRoomForStatusCheck.status !== 'ALL_PLAYERS_JOINED' && currentRoomForStatusCheck.status !== 'SETTING_SECRETS' && currentRoomForStatusCheck.status !== 'IN_PROGRESS') {
                  const newStatusUpdate = { $set: {status: 'ALL_PLAYERS_JOINED' as MultiplayerGameStatus} };
                  const statusUpdatedRoom = await updateGameRoom(gameId, newStatusUpdate);
                  if (statusUpdatedRoom) {
                      room = statusUpdatedRoom;
                      io.to(gameId).emit('all-players-joined', { gameId }); 
                      io.to(gameId).emit('game-state-update', room); 
                  } else {
                       socket.emit('error-event', { message: 'Failed to update game status to ALL_PLAYERS_JOINED.' });
                  }
              } else if (currentRoomForStatusCheck) { // If status is already appropriate, just send update
                   io.to(gameId).emit('game-state-update', currentRoomForStatusCheck); 
              }
            }
        });

        socket.on('send-secret', async (data: { gameId: string; playerId: string; secret: string[] }) => {
          await dbConnectionPromise;
          if (!db) {
              socket.emit('error-event', { message: 'Database connection not available in send-secret handler.' });
              console.error(`MongoDB: DB unavailable in send-secret for ${data.gameId}, socket ${socket.id}.`);
              return;
          }
          console.log(`Socket ${socket.id} (Player ${data.playerId}) attempting to send secret for game: ${data.gameId} - DB Connection Confirmed for this handler.`);

          const { gameId, playerId, secret } = data;
          let room = await getGameRoom(gameId);

          if (!room || !room.players[playerId] || (room.status !== 'ALL_PLAYERS_JOINED' && room.status !== 'SETTING_SECRETS')) {
            socket.emit('error-event', { message: `Cannot set secret. Game Status: ${room?.status}, Player: ${playerId}` });
            return;
          }
          if (room.players[playerId].secret && room.players[playerId].secret!.length > 0) {
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

          io.to(gameId).emit('secret-update', { playerId, secretSet: true, secretsCurrentlySet: room.secretsSetCount, totalPlayers: room.playerCount });
          io.to(gameId).emit('game-state-update', room); 

          if (room.secretsSetCount === room.playerCount && (room.status === 'SETTING_SECRETS')) {
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
                return;
            }
            room = gameStartedRoom; 
            io.to(gameId).emit('game-start', { gameId, startingPlayer: room.turn!, targetMap: room.targetMap! });
            io.to(gameId).emit('game-state-update', room); 
          }
        });

        socket.on('make-guess', async (data: { gameId: string; playerId: string; guess: string[] }) => {
          await dbConnectionPromise;
          if (!db) {
              socket.emit('error-event', { message: 'Database connection not available in make-guess handler.' });
              console.error(`MongoDB: DB unavailable in make-guess for ${data.gameId}, socket ${socket.id}.`);
              return;
          }
          console.log(`Socket ${socket.id} (Player ${data.playerId}) attempting to make guess for game: ${data.gameId} - DB Connection Confirmed for this handler.`);

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

          const updateFields: any = {
            $push: { 
              [`players.${playerId}.guessesMade`]: guessObject,
              [`players.${targetPlayerId}.guessesAgainst`]: guessObject,
            }
          };

          if (checkWin(feedback)) {
            updateFields.$set = { status: 'GAME_OVER' as MultiplayerGameStatus, winner: playerId, turn: undefined };
          } else {
            const playerIds = Object.keys(room.players).sort();
            const currentPlayerIndex = playerIds.indexOf(playerId);
            const nextPlayerId = playerIds[(currentPlayerIndex + 1) % playerIds.length];
            updateFields.$set = { turn: nextPlayerId };
          }

          const updatedRoomAfterGuess = await updateGameRoom(gameId, updateFields);
          if (!updatedRoomAfterGuess) {
              socket.emit('error-event', { message: 'Failed to update game after guess.'});
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
    
