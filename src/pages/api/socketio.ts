
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
const DATABASE_NAME = "4SureDB"; // Corrected Casing
const COLLECTION_NAME = "gameRooms";

let db: MongoDb | null = null;
let resolveDbConnection: (value: MongoDb | PromiseLike<MongoDb>) => void;
let rejectDbConnection: (reason?: any) => void;

// Promise that resolves when the DB connection is established
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
    // Manually ensure unique index on gameId in Atlas if not done by code: db.gameRooms.createIndex( { "gameId": 1 }, { unique: true } )
    // Consider removing automatic index creation if it causes issues or if managed manually.
    // await db.collection(COLLECTION_NAME).createIndex({ gameId: 1 }, { unique: true });
    // console.log(`MongoDB: Ensured unique index on 'gameId' in '${COLLECTION_NAME}' collection.`);
    console.log(`MongoDB: DB setup complete. Targeting collection: '${COLLECTION_NAME}'.`);
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
  return 0; // Should not happen with current UI
};

async function getGameRoom(gameId: string): Promise<GameRoom | null> {
  try {
    await dbConnectionPromise; // Wait for DB connection
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
        const { _id, ...data } = roomDocument as any; // Exclude MongoDB's _id
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
    await dbConnectionPromise; // Wait for DB connection
  } catch (connectionError) {
    console.error(`MongoDB connection error during updateGameRoom for ${gameId}:`, connectionError);
    return null;
  }
  if (!db) {
    console.warn(`MongoDB: db instance is null (updateGameRoom for ${gameId}) after promise. Critical connection issue.`);
    return null;
  }

  const filter = { gameId: gameId };
  
  // Separate fields for $set and $setOnInsert to avoid conflicts with gameId
  const { gameId: opGameIdToExclude, ...fieldsToModify } = operationData;

  const updateOps: any = {
    $setOnInsert: {
      gameId: gameId, // Ensure gameId from filter is used for new doc
      playerCount: getPlayerCountNumber(operationData.playerCount || 'duo'), // Default or from data
      players: {},
      status: 'WAITING_FOR_PLAYERS' as MultiplayerGameStatus,
      secretsSetCount: 0,
      targetMap: {},
      turn: undefined,
      winner: undefined,
      ...fieldsToModify // Merge other fields from operationData for new doc
    }
  };

  // If operationData contains operators, use them directly (excluding gameId from $set if present)
  if (Object.keys(fieldsToModify).some(key => key.startsWith('$'))) {
    Object.assign(updateOps, fieldsToModify);
    if (updateOps.$set && updateOps.$set.hasOwnProperty('gameId')) {
        delete updateOps.$set.gameId;
    }
  } else if (Object.keys(fieldsToModify).length > 0) {
    // If it's a plain object of fields to update, put them in $set (excluding gameId)
    updateOps.$set = fieldsToModify;
  }


  const options: FindOneAndUpdateOptions = {
    upsert: true,
    returnDocument: 'after'
  };

  try {
    // console.log(`MongoDB: Attempting findOneAndUpdate for game room ${gameId} with filter: ${JSON.stringify(filter)}, update: ${JSON.stringify(updateOps)}`);
    const result = await db.collection<GameRoom>(COLLECTION_NAME).findOneAndUpdate(filter, updateOps, options);

    if (result && result.value) {
      // console.log(`MongoDB: findOneAndUpdate successful for ${gameId}.`);
      const { _id, ...roomData } = result.value as any;
      return roomData as GameRoom;
    } else {
      // This case should be less likely if findOneAndUpdate with upsert=true works as expected
      console.error(`MongoDB: findOneAndUpdate for ${gameId} did not return a document. Attempting re-fetch. Filter: ${JSON.stringify(filter)}, Update: ${JSON.stringify(updateOps)}`);
      return getGameRoom(gameId); // Attempt to fetch if upsert didn't return as expected
    }
  } catch (error: any) {
    console.error(`MongoDB: Error during findOneAndUpdate for ${gameId}. Filter: ${JSON.stringify(filter)}, Update: ${JSON.stringify(updateOps)}, Error:`, error);
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
        path: '/api/socketio_c', // Ensure this matches client path
        addTrailingSlash: false,
      });
      res.socket.server.io = io;

      io.on('connection', async (socket: CustomSocket) => { 
        try {
          await dbConnectionPromise; 
          console.log('MongoDB connection confirmed for new socket connection:', socket.id);
        } catch (dbError) {
          console.error(`Socket ${socket.id} failed to connect due to DB init error:`, dbError);
          socket.emit('error-event', { message: 'Server database initialization error. Please try again later.' });
          socket.disconnect(true);
          return; 
        }
        if (!db) { 
            console.error(`Critical: DB is null for socket ${socket.id} after dbConnectionPromise resolved. Disconnecting socket.`);
            socket.emit('error-event', { message: 'Server database connection critical error.' });
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
              // DB check is implicitly handled by getGameRoom/updateGameRoom
              let room = await getGameRoom(gameId); 
              if (room && room.players[playerId]) {
                // Logic for player disconnect (e.g., notify others, update room status)
                // Simplified: just emit state update for now
                io.to(gameId).emit('player-disconnected', {
                  gameId,
                  playerId,
                  message: `${playerId} has disconnected.`
                });

                if (room.playerCount === 2 && room.status === 'IN_PROGRESS') {
                    const remainingPlayerIds = Object.keys(room.players).filter(pId => pId !== playerId && room!.players[pId].socketId !== socket.id); // Recheck with socket ID if needed
                    if (remainingPlayerIds.length === 1) {
                        const winnerId = remainingPlayerIds[0];
                        const gameOverUpdate = { $set: { status: 'GAME_OVER' as MultiplayerGameStatus, winner: winnerId, turn: undefined }};
                        const updatedRoom = await updateGameRoom(gameId, gameOverUpdate); 
                        if (updatedRoom) {
                            io.to(gameId).emit('game-over', { gameId, winner: winnerId });
                            io.to(gameId).emit('game-state-update', updatedRoom);
                        }
                    }
                } else if (room.status !== 'GAME_OVER') { // Avoid updating if already over
                    // Potentially remove player from room or mark as disconnected
                    // For now, just re-fetch and emit state
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
          try {
            await dbConnectionPromise; // Ensure DB is ready for THIS SPECIFIC event handling
            if (!db) {
                socket.emit('error-event', { message: 'Database connection not available in join-game handler.' });
                console.error(`MongoDB: DB unavailable in join-game handler for ${data.gameId} (socket ${socket.id}) even after promise.`);
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
            const playerObjectBase: PlayerData = { socketId: socket.id, guessesMade: [], guessesAgainst: [], secret: [] };

            if (!room) {
              console.log(`Game room ${gameId} not found in DB. Attempting to create for ${numPlayerCount} players.`);
              assignedPlayerId = rejoiningPlayerId || `player1`; // If creating, assign player1 or rejoining ID
              const initialPlayers: { [playerId: string]: PlayerData } = {};
              initialPlayers[assignedPlayerId] = { ...playerObjectBase };

              const newRoomData: Partial<GameRoom> = { // Partial because updateGameRoom will merge with defaults
                gameId: gameId, // Explicitly set gameId for new room data
                playerCount: numPlayerCount,
                players: initialPlayers,
                status: 'WAITING_FOR_PLAYERS',
              };
              room = await updateGameRoom(gameId, newRoomData);
              if (!room) {
                  socket.emit('error-event', { message: 'Failed to create game room data.' });
                  console.error(`Failed to create game room ${gameId} with newRoomData: ${JSON.stringify(newRoomData)}`);
                  return;
              }
            } else { // Room exists
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

              if (!assignedPlayerId) { // Assign new player ID if not rejoining
                for (let i = 1; i <= room.playerCount; i++) {
                    const potentialPlayerId = `player${i}`;
                    if (!room.players[potentialPlayerId]) {
                        assignedPlayerId = potentialPlayerId;
                        break;
                    }
                }
              }
              if (!assignedPlayerId) { // Should not happen if room not full
                  socket.emit('error-event', { message: 'Could not assign player ID. No available slot.' });
                  socket.leave(gameId);
                  return;
              }
              
              // Update player's socketId or add new player
              const existingPlayerData = room.players[assignedPlayerId] || {};
              const playerUpdatePayload = {
                $set: {
                  [`players.${assignedPlayerId}`]: {
                    ...playerObjectBase, // Base structure (clears old guesses if rejoining with new socket potentially)
                    ...existingPlayerData, // Merge existing data like secret if any
                    socketId: socket.id // Always update socketId
                  }
                }
              };
              const updatedRoomAfterPlayerJoin = await updateGameRoom(gameId, playerUpdatePayload);
              if (!updatedRoomAfterPlayerJoin) {
                  socket.emit('error-event', { message: 'Failed to update game room with new/rejoining player.' });
                  // Optionally re-fetch and emit current state if update fails
                  const currentRoomStateOnError = await getGameRoom(gameId);
                  if(currentRoomStateOnError) io.to(gameId).emit('game-state-update', currentRoomStateOnError);
                  return;
              }
              room = updatedRoomAfterPlayerJoin;
            }

            socket.gameId = gameId; // Store on socket for disconnect handling
            socket.playerId = assignedPlayerId; // Store on socket
            console.log(`Socket ${socket.id} assigned/confirmed as ${assignedPlayerId} in game ${gameId}. Players in room: ${Object.keys(room.players).length}/${room.playerCount}`);
            socket.emit('player-assigned', { playerId: assignedPlayerId!, gameId }); // Notify client of their ID
            io.to(gameId).emit('game-state-update', room); // Send full state to all in room

            // Check if all players have joined to transition state
            if (room.status === 'WAITING_FOR_PLAYERS' && Object.keys(room.players).length === room.playerCount) {
              const newStatusUpdate = { $set: {status: 'ALL_PLAYERS_JOINED' as MultiplayerGameStatus} };
              console.log(`All ${room.playerCount} players joined game ${gameId}. Status changing to ALL_PLAYERS_JOINED.`);
              const statusUpdatedRoom = await updateGameRoom(gameId, newStatusUpdate);
              if (statusUpdatedRoom) {
                  room = statusUpdatedRoom;
                  io.to(gameId).emit('all-players-joined', { gameId }); // Specific event for this
                  io.to(gameId).emit('game-state-update', room); // And full state update
              } else {
                   // Error updating status, could re-fetch and emit or log
                   socket.emit('error-event', { message: 'Failed to update game status to ALL_PLAYERS_JOINED.' });
              }
            } else if ((room.status === 'ALL_PLAYERS_JOINED' || room.status === 'SETTING_SECRETS' || room.status === 'IN_PROGRESS') && rejoiningPlayerId ) {
              // If player rejoining an active game, just ensure they get the latest state
              console.log(`Player ${rejoiningPlayerId} rejoining game ${gameId} which is in status ${room.status}. Sending full state.`);
              io.to(gameId).emit('game-state-update', room);
            }

          } catch (error) {
            console.error(`Error in join-game for game ${data.gameId}, socket ${socket.id} after DB connection check:`, error);
            socket.emit('error-event', { message: 'An internal server error occurred while joining the game.' });
          }
        });

        socket.on('send-secret', async (data: { gameId: string; playerId: string; secret: string[] }) => {
          try {
            await dbConnectionPromise;
            if (!db) {
                socket.emit('error-event', { message: 'Database connection not available in send-secret handler.' });
                console.error(`MongoDB: DB unavailable in send-secret for ${data.gameId}, socket ${socket.id} after promise.`);
                return;
            }
            console.log(`Socket ${socket.id} (Player ${data.playerId}) attempting to send secret for game: ${data.gameId} - DB Connection Confirmed for this handler.`);

            const { gameId, playerId, secret } = data;
            let room = await getGameRoom(gameId);

            if (!room || !room.players[playerId] || (room.status !== 'ALL_PLAYERS_JOINED' && room.status !== 'SETTING_SECRETS')) {
              socket.emit('error-event', { message: `Cannot set secret. Game Status: ${room?.status}, Player: ${playerId}` });
              return;
            }
            // Prevent setting secret multiple times by the same player in the current game logic
            if (room.players[playerId].secret && room.players[playerId].secret!.length > 0) {
               console.log(`Player ${playerId} trying to set secret again for ${gameId}. Already set.`);
               // Optionally emit current state or a specific message
               io.to(gameId).emit('game-state-update', room);
               return;
            }

            // Atomically update secret and increment count
            let secretUpdateOps: any = {
                  $set: {
                      [`players.${playerId}.secret`]: secret,
                  },
                  $inc: { secretsSetCount: 1 } // Increment secretsSetCount
              };
            // If this is the first secret being set in ALL_PLAYERS_JOINED, transition to SETTING_SECRETS
            if (room.status === 'ALL_PLAYERS_JOINED') {
                secretUpdateOps.$set.status = 'SETTING_SECRETS';
            }

            const roomAfterSecretAttempt = await updateGameRoom(gameId, secretUpdateOps);
            if (!roomAfterSecretAttempt) {
               // Handle failure, e.g., re-fetch state and inform client
               console.warn(`Failed to set secret for ${playerId} in ${gameId}. Re-fetching current state.`);
               room = await getGameRoom(gameId); // Re-fetch the possibly stale room
               if (room) { // If re-fetch is successful
                  io.to(gameId).emit('secret-update', { // Emit based on re-fetched state
                      playerId,
                      secretSet: !!(room.players[playerId]?.secret && room.players[playerId].secret!.length > 0),
                      secretsCurrentlySet: room.secretsSetCount,
                      totalPlayers: room.playerCount
                  });
                  io.to(gameId).emit('game-state-update', room);
               }
               return; // Stop further processing for this event
            }
            room = roomAfterSecretAttempt; // Update local room variable with the latest state

            console.log(`Secret from ${playerId} for ${gameId}. Total set: ${room.secretsSetCount}/${room.playerCount}`);
            io.to(gameId).emit('secret-update', { playerId, secretSet: true, secretsCurrentlySet: room.secretsSetCount, totalPlayers: room.playerCount });
            io.to(gameId).emit('game-state-update', room); // Send full state

            // Check if all secrets are set to start the game
            if (room.secretsSetCount === room.playerCount && (room.status === 'SETTING_SECRETS')) {
              console.log(`All secrets set for game ${gameId}. Starting game.`);
              const playerIds = Object.keys(room.players).sort(); // Consistent order for target assignment
              let targetMap: { [playerId: string]: string } = {};
              if (room.playerCount === 2) { // Simple circular for Duo
                 targetMap = { [playerIds[0]]: playerIds[1], [playerIds[1]]: playerIds[0] };
              }
              // TODO: Implement targetMap logic for Trio/Quads if needed
              
              const startingTurn = playerIds[Math.floor(Math.random() * playerIds.length)]; // Random starting player
              
              const gameStartUpdatePayload = {
                  $set: {
                      status: 'IN_PROGRESS' as MultiplayerGameStatus,
                      targetMap,
                      turn: startingTurn
                  }
              };
              const gameStartedRoom = await updateGameRoom(gameId, gameStartUpdatePayload);
              if (!gameStartedRoom) {
                  // Handle failure to start game
                  socket.emit('error-event', { message: 'Failed to start game after secrets.'});
                  // Consider re-fetching and emitting state
                  return;
              }
              room = gameStartedRoom; // Update local room with started game state
              io.to(gameId).emit('game-start', { gameId, startingPlayer: room.turn!, targetMap: room.targetMap! });
              io.to(gameId).emit('game-state-update', room); // Send final state
            }

          } catch (error) {
            console.error(`Error in send-secret for game ${data.gameId}, player ${data.playerId}, socket ${socket.id} after DB connection check:`, error);
            socket.emit('error-event', { message: 'An internal server error occurred while setting the secret.' });
          }
        });

        socket.on('make-guess', async (data: { gameId: string; playerId: string; guess: string[] }) => {
          try {
            await dbConnectionPromise;
            if (!db) {
                socket.emit('error-event', { message: 'Database connection not available in make-guess handler.' });
                console.error(`MongoDB: DB unavailable in make-guess for ${data.gameId}, socket ${socket.id} after promise.`);
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
            console.log(`${playerId} guessed ${guessArray.join('')} vs ${targetPlayerId} in ${gameId}. Feedback: ${feedback.join(',')}`);

            // Prepare updates
            const updateFields: any = {
              $push: { // Add guess to appropriate arrays
                [`players.${playerId}.guessesMade`]: guessObject,
                [`players.${targetPlayerId}.guessesAgainst`]: guessObject,
              }
            };

            if (checkWin(feedback)) {
              // If win, update status, winner, and clear turn
              updateFields.$set = { status: 'GAME_OVER' as MultiplayerGameStatus, winner: playerId, turn: undefined };
              console.log(`Game ${gameId} over. Winner: ${playerId}`);
            } else {
              // If not a win, determine next player
              const playerIds = Object.keys(room.players).sort();
              const currentPlayerIndex = playerIds.indexOf(playerId);
              const nextPlayerId = playerIds[(currentPlayerIndex + 1) % playerIds.length];
              updateFields.$set = { turn: nextPlayerId };
            }

            const updatedRoomAfterGuess = await updateGameRoom(gameId, updateFields);
            if (!updatedRoomAfterGuess) {
                // Handle failure, e.g., re-fetch state
                socket.emit('error-event', { message: 'Failed to update game after guess.'});
                return;
            }
            room = updatedRoomAfterGuess; // Update local room variable

            // Emit events based on updated room state
            io.to(gameId).emit('guess-feedback', { gameId, guessingPlayerId: playerId, targetPlayerId, guess: guessObject });
            if (room.status === 'GAME_OVER') {
              io.to(gameId).emit('game-over', { gameId, winner: room.winner! });
            } else {
              io.to(gameId).emit('turn-update', { gameId, nextPlayerId: room.turn! });
            }
            io.to(gameId).emit('game-state-update', room); // Always send full state
          } catch (error) {
            console.error(`Error in make-guess for game ${data.gameId}, player ${data.playerId}, socket ${socket.id} after DB connection check:`, error);
            socket.emit('error-event', { message: 'An internal server error occurred while making a guess.' });
          }
        });
      });
    }
    res.status(200).json({ message: 'Socket.IO server initialized or already running.' });
  } else {
    res.setHeader('Allow', ['POST']);
    res.status(405).end(`Method ${req.method} Not Allowed`);
  }
}
    