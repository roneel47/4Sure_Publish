
import type { Server as HTTPServer } from 'http';
import type { Socket as NetSocket } from 'net';
import type { NextApiRequest, NextApiResponse } from 'next';
import { Server as SocketIOServer, Socket } from 'socket.io';
import type { GameRoom, PlayerData, Guess, MultiplayerGameStatus } from '@/types/game';
import { calculateFeedback, checkWin } from '@/lib/gameLogic';
import { MongoClient, Db as MongoDb, FindOneAndUpdateOptions, MongoError, WithId } from 'mongodb';

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
    // console.warn(`MongoDB: db instance is null (getGameRoom for ${gameId}). Critical connection issue.`);
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
    console.warn(`MongoDB: db instance is null (createGameRoom for ${gameId}). Cannot create.`);
    return null;
  }
  try {
    await db.collection<GameRoom>(COLLECTION_NAME).insertOne(newRoomData);
    console.log(`MongoDB: Successfully created game room ${gameId}.`);
    // newRoomData already matches GameRoom type (no _id)
    return newRoomData;
  } catch (error: any) {
    if (error instanceof MongoError && error.code === 11000) { // Duplicate key error
      console.warn(`MongoDB: Attempted to create game room ${gameId}, but it already exists (duplicate key). Likely race condition resolved by another client.`);
      return null; // Signal to re-fetch
    }
    console.error(`MongoDB: Error creating game room ${gameId} (createGameRoom):`, error);
    return null;
  }
}

export async function updateGameRoom(
  gameId: string,
  operationData: any, // Contains MongoDB update operators like $set, $inc or the full new room structure for creation
  isCreatingNew: boolean = false 
): Promise<GameRoom | null> {
  await dbConnectionPromise;
  if (!db) {
    console.warn(`MongoDB: db instance is null (updateGameRoom for ${gameId}). Cannot update.`);
    return null;
  }

  const filter = { gameId: gameId };
  let updateOps: any = {}; // MongoDB Update Query

  if (isCreatingNew) {
    // For creation, operationData is the full new room structure
    const newRoomStructure = { ...operationData, gameId: gameId };
    updateOps.$setOnInsert = newRoomStructure;
    updateOps.$set = {}; // Ensure $set is empty to avoid conflict with $setOnInsert paths
  } else {
    // For updates, operationData contains update operators like $set, $inc
    updateOps = operationData;
    // Ensure gameId is not part of $set or other ops that would modify it
    if (updateOps.$set && updateOps.$set.gameId) {
      delete updateOps.$set.gameId;
    }
    // For pure updates, $setOnInsert might not be strictly needed if upsert is false.
    // However, if an update operation could potentially create a document (e.g. through complex logic not used here),
    // ensuring gameId is part of $setOnInsert for safety with upsert:true.
    // Here, upsert is controlled by isCreatingNew, so this is more for robustness if upsert was true.
    if (!updateOps.$setOnInsert) { // Only add if not already defined by operationData
        updateOps.$setOnInsert = { gameId: gameId }; 
    }
  }

  const options: FindOneAndUpdateOptions = {
    returnDocument: 'after', 
    upsert: isCreatingNew, 
  };

  try {
    // console.log(`MongoDB: Attempting findOneAndUpdate for game room ${gameId} with filter: ${JSON.stringify(filter)}, update: ${JSON.stringify(updateOps)}, isCreatingNew: ${isCreatingNew}`);
    // Type the result as WithId<GameRoom> | null based on TypeScript error
    const updatedDoc: WithId<GameRoom> | null = await db.collection<GameRoom>(COLLECTION_NAME).findOneAndUpdate(filter, updateOps, options);

    if (updatedDoc) {
      // console.log(`MongoDB: findOneAndUpdate successful for ${gameId}, returned document.`);
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { _id, ...roomData } = updatedDoc; 
      return roomData as GameRoom;
    } else {
      console.warn(`MongoDB: findOneAndUpdate for ${gameId} did not return a document. Filter: ${JSON.stringify(filter)}, Update: ${JSON.stringify(updateOps)}, isCreatingNew: ${isCreatingNew}`);
      // If an upsert (isCreatingNew = true) was attempted and didn't return a doc, it's unexpected.
      // If an update (isCreatingNew = false) was attempted and didn't return a doc, it means the filter didn't match.
      // A re-fetch can clarify the actual state, especially after a potential upsert.
      const refetchedRoom = await getGameRoom(gameId);
      if (refetchedRoom) {
        console.log(`MongoDB: Re-fetched room ${gameId} successfully after findOneAndUpdate returned null.`);
        return refetchedRoom;
      } else {
        console.warn(`MongoDB: Re-fetching room ${gameId} also failed. Room likely does not exist or creation/update failed silently.`);
        return null;
      }
    }
  } catch (error: any) {
    console.error(`MongoDB: Error during findOneAndUpdate for ${gameId}. Filter: ${JSON.stringify(filter)}, Update: ${JSON.stringify(updateOps)}, isCreatingNew: ${isCreatingNew}, Error:`, error);
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
        await dbConnectionPromise; 
        if (!db) {
          console.error(`MongoDB: DB instance is null for new socket connection ${socket.id}. Critical connection issue. Disconnecting socket.`);
          socket.emit('error-event', { message: 'Server database connection critical error. Cannot process connection.' });
          socket.disconnect(true);
          return;
        }
        console.log(`Socket connected: ${socket.id} - MongoDB connection confirmed for this socket.`);
        
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
                // Optional: Could remove player from DB or mark as disconnected
                // For now, just emitting events.
                io.to(gameId).emit('player-disconnected', {
                  gameId,
                  playerId,
                  message: `${playerId} has disconnected.`
                });

                // If it's a 2-player game and one disconnects during play, declare other winner
                if (room.playerCount === 2 && room.status === 'IN_PROGRESS') {
                    const remainingPlayerIds = Object.keys(room.players).filter(pId => pId !== playerId && room.players[pId].socketId); // Check for active socketId too
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
                    // For other cases, just send a state update if players remain or game not over
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
                socket.emit('error-event', { message: 'Database connection not available.' });
                console.error(`MongoDB: DB unavailable in join-game for ${data.gameId}, socket ${socket.id}.`);
                return;
            }
            console.log(`Socket ${socket.id} attempting to join game: ${data.gameId} (PlayerCount: ${data.playerCount}) - DB Connection Confirmed for this handler.`);
            
            const { gameId, playerCount: playerCountString, rejoiningPlayerId } = data;
            const numPlayerCount = getPlayerCountNumber(playerCountString);

            if (!numPlayerCount) {
              socket.emit('error-event', { message: 'Invalid player count specified.' });
              return;
            }

            socket.join(gameId); // Socket joins the room regardless of DB state initially
            let room = await getGameRoom(gameId);
            let assignedPlayerId: string | undefined = rejoiningPlayerId;
            let playerJustCreatedRoom = false;

            if (!room) {
                console.log(`Game room ${gameId} not found in DB. Attempting to create for ${numPlayerCount} players.`);
                assignedPlayerId = rejoiningPlayerId || `player1`; 
                const initialPlayers: { [playerId: string]: PlayerData } = {};
                initialPlayers[assignedPlayerId] = { socketId: socket.id, guessesMade: [], guessesAgainst: [], secret: [] };
                
                const newRoomDataForCreation: GameRoom = { 
                  gameId: gameId,
                  playerCount: numPlayerCount,
                  players: initialPlayers,
                  status: 'WAITING_FOR_PLAYERS',
                  secretsSetCount: 0,
                  targetMap: {},
                  turn: undefined,
                  winner: undefined,
                };
                
                // Pass true for isCreatingNew
                room = await updateGameRoom(gameId, newRoomDataForCreation, true);

                if (room) {
                    playerJustCreatedRoom = true;
                    console.log(`Game room ${gameId} created successfully by ${assignedPlayerId}.`);
                } else {
                    console.warn(`Failed to create game room ${gameId} via updateGameRoom. Attempting re-fetch in case of race.`);
                    room = await getGameRoom(gameId); // Re-fetch in case another client created it during a race
                    if (!room) {
                        socket.emit('error-event', { message: 'Failed to create or find game room.' });
                        console.error(`Critical: Failed to get room ${gameId} even after create attempt and re-fetch.`);
                        socket.leave(gameId);
                        return;
                    }
                    console.log(`Found room ${gameId} after initial create attempt failed, likely created by another client.`);
                }
            }
            
            // At this point, 'room' should be the existing or newly created room object.
            if (room.status === 'GAME_OVER') {
                 socket.emit('error-event', { message: 'This game has already ended.' });
                 socket.leave(gameId);
                 return;
            }

            const isPlayerAlreadyInRoom = assignedPlayerId && room.players[assignedPlayerId];

            if (!playerJustCreatedRoom && Object.keys(room.players).length >= room.playerCount && !isPlayerAlreadyInRoom) {
                socket.emit('error-event', { message: 'Game room is full.' });
                socket.leave(gameId);
                return;
            }

            if (!assignedPlayerId && !playerJustCreatedRoom) { 
              for (let i = 1; i <= room.playerCount; i++) {
                  const potentialPlayerId = `player${i}`;
                  if (!room.players[potentialPlayerId]) {
                      assignedPlayerId = potentialPlayerId;
                      break;
                  }
              }
            }

            if (!assignedPlayerId) { 
                socket.emit('error-event', { message: 'Could not assign player ID. No available slot or error state.' });
                console.error(`Could not assign player ID for game ${gameId}. Room state:`, room);
                socket.leave(gameId);
                return;
            }
            
            let needsPlayerUpdateInDB = false;
            if (!isPlayerAlreadyInRoom && !playerJustCreatedRoom) {
                 if (Object.keys(room.players).length >= room.playerCount) { // Final check before adding new player
                     socket.emit('error-event', { message: 'Game room became full while trying to assign player ID.' });
                     socket.leave(gameId);
                     return;
                 }
                 needsPlayerUpdateInDB = true;
            } else if (isPlayerAlreadyInRoom && room.players[assignedPlayerId].socketId !== socket.id) {
                 // Player is rejoining, update socketId if different
                 needsPlayerUpdateInDB = true;
            }
            
            if (needsPlayerUpdateInDB) {
                 const newPlayerData: PlayerData = { socketId: socket.id, guessesMade: [], guessesAgainst: [], secret: [] };
                 // If player rejoining and had data, merge it, for now, fresh PlayerData
                 const playerUpdatePayload = { $set: { [`players.${assignedPlayerId}`]: newPlayerData } };
                 const updatedRoomAfterPlayerAdd = await updateGameRoom(gameId, playerUpdatePayload);
                 if (!updatedRoomAfterPlayerAdd) {
                    socket.emit('error-event', { message: 'Failed to update game room with new/rejoining player.' });
                    console.error(`Failed to add/update player ${assignedPlayerId} in room ${gameId}.`);
                    room = await getGameRoom(gameId); // Fetch latest state before exiting or further action
                 } else {
                    room = updatedRoomAfterPlayerAdd;
                 }
            }
            // If room is still null after attempts, something is wrong.
            if (!room) {
                 socket.emit('error-event', { message: 'Game room became unavailable during join process.' });
                 console.error(`Room ${gameId} is null/undefined before final emissions.`);
                 socket.leave(gameId);
                 return;
            }
            
            socket.gameId = gameId; 
            socket.playerId = assignedPlayerId; 
            socket.emit('player-assigned', { playerId: assignedPlayerId!, gameId }); 
            io.to(gameId).emit('game-state-update', room); 

            if ((room.status === 'WAITING_FOR_PLAYERS' || room.status === 'ALL_PLAYERS_JOINED') && Object.keys(room.players).length === room.playerCount) {
              const currentRoomForStatusCheck = await getGameRoom(gameId); // Get latest before status update
              if (currentRoomForStatusCheck && currentRoomForStatusCheck.status !== 'ALL_PLAYERS_JOINED' && currentRoomForStatusCheck.status !== 'SETTING_SECRETS' && currentRoomForStatusCheck.status !== 'IN_PROGRESS') {
                  const newStatusUpdate = { $set: {status: 'ALL_PLAYERS_JOINED' as MultiplayerGameStatus} };
                  const statusUpdatedRoom = await updateGameRoom(gameId, newStatusUpdate);
                  if (statusUpdatedRoom) {
                      io.to(gameId).emit('all-players-joined', { gameId }); 
                      io.to(gameId).emit('game-state-update', statusUpdatedRoom); 
                  } else {
                       socket.emit('error-event', { message: 'Failed to update game status to ALL_PLAYERS_JOINED.' });
                       const finalRoomState = await getGameRoom(gameId); // emit latest whatever it is
                       if(finalRoomState) io.to(gameId).emit('game-state-update', finalRoomState);
                  }
              } else if (currentRoomForStatusCheck) { 
                   io.to(gameId).emit('game-state-update', currentRoomForStatusCheck); 
              }
            }
        });

        socket.on('send-secret', async (data: { gameId: string; playerId: string; secret: string[] }) => {
          await dbConnectionPromise;
          if (!db) {
              socket.emit('error-event', { message: 'Database connection not available.' });
               console.error(`MongoDB: DB unavailable in send-secret for ${data.gameId}, socket ${socket.id}.`);
              return;
          }
          console.log(`Socket ${socket.id} (Player ${data.playerId}) attempting to send secret for game: ${data.gameId} - DB Connection Confirmed for this handler.`);

          const { gameId, playerId, secret } = data;
          let room = await getGameRoom(gameId);

          if (!room || !room.players[playerId] || (room.status !== 'ALL_PLAYERS_JOINED' && room.status !== 'SETTING_SECRETS')) {
            socket.emit('error-event', { message: `Cannot set secret. Game Status: ${room?.status}, Player: ${playerId} in room.players: ${!!room?.players[playerId]}` });
            return;
          }
          // Prevent re-setting secret if already set, to avoid incrementing secretsSetCount multiple times
          if (room.players[playerId].secret && room.players[playerId].secret!.length > 0) {
             console.log(`Player ${playerId} in game ${gameId} attempted to re-set secret. Ignoring.`);
             io.to(gameId).emit('game-state-update', room); // Send current state
             return;
          }

          let secretUpdateOps: any = {
                $set: {
                    [`players.${playerId}.secret`]: secret,
                },
                $inc: { secretsSetCount: 1 } 
            };
          if (room.status === 'ALL_PLAYERS_JOINED') { // First secret being set
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
             } else {
                socket.emit('error-event', { message: 'Failed to update or re-fetch room after secret submission.' });
             }
             return; 
          }
          room = roomAfterSecretAttempt; 

          io.to(gameId).emit('secret-update', { playerId, secretSet: true, secretsCurrentlySet: room.secretsSetCount, totalPlayers: room.playerCount });
          io.to(gameId).emit('game-state-update', room); 

          if (room.secretsSetCount === room.playerCount && (room.status === 'SETTING_SECRETS')) {
            const playerIds = Object.keys(room.players).sort(); 
            let targetMap: { [playerId: string]: string } = {};
            // Simple ring for >2 players, direct for 2 players
            if (room.playerCount === 2) { 
               targetMap = { [playerIds[0]]: playerIds[1], [playerIds[1]]: playerIds[0] };
            } else if (room.playerCount > 2) {
                for(let i=0; i < playerIds.length; i++) {
                    targetMap[playerIds[i]] = playerIds[(i + 1) % playerIds.length];
                }
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
                socket.emit('error-event', { message: 'Failed to start game after all secrets were set.'});
                const finalRoomState = await getGameRoom(gameId);
                if(finalRoomState) io.to(gameId).emit('game-state-update', finalRoomState);
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
              socket.emit('error-event', { message: 'Database connection not available.' });
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
              const finalRoomState = await getGameRoom(gameId);
              if(finalRoomState) io.to(gameId).emit('game-state-update', finalRoomState);
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
    
