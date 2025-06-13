
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
let resolveDbConnection: (value: MongoDb | null | PromiseLike<MongoDb | null>) => void = () => {};
let rejectDbConnection: (reason?: any) => void = () => {};

let dbConnectionPromise: Promise<MongoDb | null> = new Promise<MongoDb | null>((resolve, reject) => {
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
    console.warn(`MongoDB: (getGameRoom) db instance is null for game ${gameId}. Critical connection issue.`);
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
    console.error(`MongoDB: (getGameRoom) Error fetching game room ${gameId}:`, error);
    return null;
  }
}

async function createGameRoom(gameId: string, newRoomData: GameRoom): Promise<GameRoom | null> {
  await dbConnectionPromise;
  if (!db) {
    console.warn(`MongoDB: (createGameRoom) db instance is null for game ${gameId}. Cannot create.`);
    return null;
  }
  try {
    const result = await db.collection<GameRoom>(COLLECTION_NAME).insertOne(newRoomData);
    if (result.insertedId) {
      console.log(`MongoDB: Game room ${gameId} created successfully with initial data:`, JSON.stringify(newRoomData));
      // Return the newRoomData as it was intended (it doesn't have _id from DB yet, but matches GameRoom structure for the app)
      // Or, fetch it again to be absolutely sure, though newRoomData should suffice
      return newRoomData;
    } else {
      console.error(`MongoDB: (createGameRoom) insertOne for ${gameId} did not confirm insertion.`);
      return null;
    }
  } catch (error: any) {
    if (error instanceof MongoError && error.code === 11000) { // Duplicate key error
      console.warn(`MongoDB: (createGameRoom) Attempted to create game room ${gameId}, but it already exists (duplicate key). Another client likely created it.`);
      return null; // Signal to re-fetch
    }
    console.error(`MongoDB: (createGameRoom) Error creating game room ${gameId}:`, error);
    return null;
  }
}

async function updateGameRoom(
  gameId: string,
  updateOperators: any // Contains MongoDB update operators like $set, $inc
): Promise<GameRoom | null> {
  await dbConnectionPromise;
  if (!db) {
    console.warn(`MongoDB: (updateGameRoom) db instance is null for game ${gameId}. Cannot update.`);
    return null;
  }

  const filter = { gameId: gameId };
  const options: FindOneAndUpdateOptions = {
    returnDocument: 'after', // Return the updated document
    upsert: false, // IMPORTANT: For updates, we assume the document exists. Creation is handled by createGameRoom.
  };

  try {
    // console.log(`MongoDB: (updateGameRoom) Attempting findOneAndUpdate for game room ${gameId} with filter: ${JSON.stringify(filter)}, update: ${JSON.stringify(updateOperators)}`);
    const updatedDoc: WithId<GameRoom> | null = await db.collection<GameRoom>(COLLECTION_NAME).findOneAndUpdate(filter, updateOperators, options);

    if (updatedDoc) {
      // console.log(`MongoDB: (updateGameRoom) findOneAndUpdate successful for ${gameId}.`);
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { _id, ...roomData } = updatedDoc;
      return roomData as GameRoom;
    } else {
      console.warn(`MongoDB: (updateGameRoom) findOneAndUpdate for ${gameId} did not find a document to update or failed. Filter: ${JSON.stringify(filter)}, Update: ${JSON.stringify(updateOperators)}`);
      // If an update fails because the document unexpectedly doesn't exist, it might indicate a deeper issue or race condition not caught elsewhere.
      // Re-fetching might be useful for debugging but shouldn't be standard recovery here.
      return null;
    }
  } catch (error: any) {
    console.error(`MongoDB: (updateGameRoom) Error during findOneAndUpdate for ${gameId}. Filter: ${JSON.stringify(filter)}, Update: ${JSON.stringify(updateOperators)}, Error:`, error);
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
        await dbConnectionPromise; // Ensure DB connection is attempted/resolved before proceeding
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
            console.error(`MongoDB: (disconnect) DB unavailable for Player ${socket.playerId}, Game ${socket.gameId}`);
            return;
          }
          console.log(`Socket disconnected: ${socket.id}, Player: ${socket.playerId}, Game: ${socket.gameId}`);

          const gameId = socket.gameId;
          const playerId = socket.playerId;

          if (gameId && playerId) {
            try {
              let room = await getGameRoom(gameId);
              if (room && room.players[playerId]) {
                const updateOps = { $unset: { [`players.${playerId}.socketId`]: "" } };
                const updatedRoom = await updateGameRoom(gameId, updateOps);
                if (updatedRoom) {
                    room = updatedRoom;
                     io.to(gameId).emit('player-disconnected', {
                        gameId,
                        playerId,
                        message: `${playerId} has disconnected.`
                    });
                    io.to(gameId).emit('game-state-update', room);

                    const activePlayersWithSocketId = Object.values(room.players).filter(p => p.socketId);
                    if (room.playerCount === 2 && room.status === 'IN_PROGRESS' && activePlayersWithSocketId.length === 1) {
                        const winnerId = Object.keys(room.players).find(pId => room.players[pId].socketId === activePlayersWithSocketId[0].socketId);
                        if (winnerId) {
                            const gameOverUpdate = { $set: { status: 'GAME_OVER' as MultiplayerGameStatus, winner: winnerId, turn: undefined }};
                            const finalRoom = await updateGameRoom(gameId, gameOverUpdate);
                            if (finalRoom) {
                                io.to(gameId).emit('game-over', { gameId, winner: winnerId });
                                io.to(gameId).emit('game-state-update', finalRoom);
                            }
                        }
                    }
                } else {
                    console.warn(`MongoDB: (disconnect) Failed to update room for player ${playerId} in game ${gameId}`);
                }
              }
            } catch (error) {
                console.error(`MongoDB: (disconnect) Error handling disconnect for player ${playerId} in game ${gameId}:`, error);
            }
          }
        });

        socket.on('join-game', async (data: { gameId: string; playerCount: string; rejoiningPlayerId?: string }) => {
            await dbConnectionPromise;
            if (!db) {
                socket.emit('error-event', { message: 'Database connection not available for join-game.' });
                console.error(`MongoDB: (join-game) DB unavailable for ${data.gameId}, socket ${socket.id}.`);
                return;
            }
            console.log(`Socket ${socket.id} attempting to join game: ${data.gameId} (PlayerCount: ${data.playerCount}) - DB Connection Confirmed for this handler.`);

            const { gameId, playerCount: playerCountString, rejoiningPlayerId } = data;
            const numPlayerCount = getPlayerCountNumber(playerCountString);

            if (!numPlayerCount) {
              socket.emit('error-event', { message: 'Invalid player count specified.' });
              return;
            }

            let room = await getGameRoom(gameId);
            let assignedPlayerId: string | undefined = undefined;
            let playerJustCreatedRoom = false;

            if (!room) {
                console.log(`Game room ${gameId} not found in DB. This client (${socket.id}) will attempt to create it as player1.`);
                const creatorPlayerId = 'player1'; // Creator is always player1
                const initialPlayers: { [playerId: string]: PlayerData } = {
                    [creatorPlayerId]: { socketId: socket.id, guessesMade: [], guessesAgainst: [], secret: [] }
                };
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

                const createdRoom = await createGameRoom(gameId, newRoomDataForCreation);

                if (createdRoom) {
                    room = createdRoom;
                    assignedPlayerId = creatorPlayerId;
                    socket.playerId = creatorPlayerId; // Assign to socket for this creator
                    playerJustCreatedRoom = true;
                    console.log(`Game room ${gameId} created successfully by ${assignedPlayerId} (${socket.id}).`);
                } else {
                    console.warn(`MongoDB: (join-game) createGameRoom for ${gameId} by ${socket.id} returned null (likely duplicate key or other creation error). Re-fetching.`);
                    room = await getGameRoom(gameId); // Re-fetch in case another client created it
                    if (!room) {
                        socket.emit('error-event', { message: 'Failed to create or find game room after creation attempt.' });
                        console.error(`Critical: (join-game) Failed to get room ${gameId} even after create attempt and re-fetch by ${socket.id}.`);
                        return; // Do not join socket to room if room is not confirmed
                    }
                    console.log(`MongoDB: (join-game) Successfully re-fetched room ${gameId} for ${socket.id} after its own creation attempt failed.`);
                    // Now this client needs to join as a new player (not player1)
                    // assignedPlayerId will be determined below if not the creator
                }
            }

            // If room exists (either initially, or after successful creation by this client, or after failed creation + re-fetch)
            if (room) {
                socket.join(gameId); // Socket joins the room
                socket.gameId = gameId; // Associate socket with this gameId

                if (!assignedPlayerId) { // If not the creator, or if creation failed and re-fetched, determine player ID
                    const storedGameIdForPlayer = rejoiningPlayerId ? localStorage.getItem(`activeGameId_${rejoiningPlayerId}`) : null;

                    if (rejoiningPlayerId && room.players[rejoiningPlayerId] && storedGameIdForPlayer === gameId) {
                        // Valid rejoining player
                        assignedPlayerId = rejoiningPlayerId;
                        socket.playerId = rejoiningPlayerId;
                        console.log(`Player ${assignedPlayerId} (${socket.id}) is rejoining game ${gameId}.`);
                        if (room.players[assignedPlayerId].socketId !== socket.id) {
                           const updatedRoomSockId = await updateGameRoom(gameId, { $set: { [`players.${assignedPlayerId}.socketId`]: socket.id } });
                           if (updatedRoomSockId) room = updatedRoomSockId;
                           else { console.error(`Failed to update socketId for rejoining player ${assignedPlayerId}`); /* Handle error */ }
                        }
                    } else {
                        // New player joining (or rejoiningPlayerId invalid/for different game)
                        const currentPlayersWithSocketId = Object.values(room.players).filter(p => p.socketId);
                        if (currentPlayersWithSocketId.length >= room.playerCount) {
                            let foundDisconnectedSlot = false;
                            if (rejoiningPlayerId && room.players[rejoiningPlayerId] && !room.players[rejoiningPlayerId].socketId) {
                                assignedPlayerId = rejoiningPlayerId;
                                socket.playerId = rejoiningPlayerId;
                                const updatedRoomReconn = await updateGameRoom(gameId, { $set: { [`players.${assignedPlayerId}.socketId`]: socket.id } });
                                if (updatedRoomReconn) room = updatedRoomReconn;
                                foundDisconnectedSlot = true;
                                console.log(`Player ${assignedPlayerId} (${socket.id}) reconnected to an existing slot in game ${gameId}.`);
                            }

                            if (!foundDisconnectedSlot) {
                                socket.emit('error-event', { message: 'Game room is full.' });
                                console.log(`Game room ${gameId} is full. Cannot add new player ${socket.id}. Players:`, Object.keys(room.players));
                                socket.leave(gameId);
                                return;
                            }
                        }

                        if(!assignedPlayerId) {
                            for (let i = 1; i <= room.playerCount; i++) {
                                const potentialPlayerId = `player${i}`;
                                if (!room.players[potentialPlayerId] || !room.players[potentialPlayerId].socketId) {
                                    assignedPlayerId = potentialPlayerId;
                                    socket.playerId = assignedPlayerId; // Assign to this joining socket
                                    break;
                                }
                            }
                        }

                        if (!assignedPlayerId) {
                            socket.emit('error-event', { message: 'Could not assign player ID. No available slot.' });
                            console.error(`Could not assign player ID for new player ${socket.id} in game ${gameId}. Room state:`, room);
                            socket.leave(gameId);
                            return;
                        }

                        console.log(`New player ${assignedPlayerId} (${socket.id}) joining game ${gameId}.`);
                        const newPlayerData: PlayerData = { socketId: socket.id, guessesMade: [], guessesAgainst: [], secret: [] };
                        const playerAddUpdate = { $set: { [`players.${assignedPlayerId}`]: newPlayerData } };
                        const roomAfterPlayerAdd = await updateGameRoom(gameId, playerAddUpdate);
                        if (!roomAfterPlayerAdd) {
                            socket.emit('error-event', { message: 'Failed to add new player to game room.' });
                            console.error(`Failed to add player ${assignedPlayerId} to room ${gameId} by ${socket.id}.`);
                            socket.leave(gameId);
                            return;
                        }
                        room = roomAfterPlayerAdd;
                    }
                }

                // Player is now considered in the room
                socket.emit('player-assigned', { playerId: socket.playerId!, gameId });
                io.to(gameId).emit('game-state-update', room);

                const currentPlayersCount = Object.values(room.players).filter(p => p.socketId).length;
                if (currentPlayersCount === room.playerCount && room.status === 'WAITING_FOR_PLAYERS') {
                  console.log(`All ${room.playerCount} players joined game ${gameId}. Updating status.`);
                  const statusUpdate = { $set: {status: 'ALL_PLAYERS_JOINED' as MultiplayerGameStatus} };
                  const roomAfterStatusUpdate = await updateGameRoom(gameId, statusUpdate);
                  if (roomAfterStatusUpdate) {
                      io.to(gameId).emit('all-players-joined', { gameId });
                      io.to(gameId).emit('game-state-update', roomAfterStatusUpdate);
                      room = roomAfterStatusUpdate;
                  } else {
                       console.warn(`Failed to update game ${gameId} status to ALL_PLAYERS_JOINED.`);
                       const finalRoomState = await getGameRoom(gameId);
                       if(finalRoomState) io.to(gameId).emit('game-state-update', finalRoomState);
                  }
                } else {
                    io.to(gameId).emit('game-state-update', room);
                }

            } else {
                 socket.emit('error-event', { message: 'Game room became unavailable during join process.' });
                 console.error(`Room ${gameId} is null/undefined before final emissions for socket ${socket.id}.`);
                 socket.leave(gameId); // ensure socket is not in a room that doesn't exist
                 return;
            }
        });

        socket.on('send-secret', async (data: { gameId: string; playerId: string; secret: string[] }) => {
          await dbConnectionPromise;
          if (!db) {
              socket.emit('error-event', { message: 'Database connection not available for send-secret.' });
              console.error(`MongoDB: (send-secret) DB unavailable for ${data.gameId}, socket ${socket.id}.`);
              return;
          }

          const { gameId, secret } = data;
          const clientProvidedPlayerId = data.playerId;
          const serverAssignedPlayerId = socket.playerId; // Source of truth for this socket's player ID

          console.log(`Socket ${socket.id} (ServerAssigned: ${serverAssignedPlayerId}, ClientProvided: ${clientProvidedPlayerId}) attempting to send secret for game: ${gameId} - DB Connection Confirmed.`);


          if (!serverAssignedPlayerId) {
            console.error(`Critical: Socket ${socket.id} has no serverAssignedPlayerId but tried to send secret for game ${gameId}.`);
            socket.emit('error-event', { message: 'Player ID not properly assigned to your connection. Cannot set secret.' });
            return;
          }
          
          // Critical Check: Ensure the client-provided ID matches the server-assigned ID for this socket
          if (clientProvidedPlayerId !== serverAssignedPlayerId) {
            console.error(`Security Alert/Bug: Client ${socket.id} (server-assigned: ${serverAssignedPlayerId}) tried to send secret using explicit client-provided ID ${clientProvidedPlayerId} in game ${gameId}. Denying.`);
            socket.emit('error-event', { message: `Player ID mismatch. Cannot set secret for another player.` });
            return;
          }
          
          // Use serverAssignedPlayerId for all DB operations and logic from this point
          const playerId = serverAssignedPlayerId;


          let room = await getGameRoom(gameId);

          if (!room || !room.players[playerId] || (room.status !== 'ALL_PLAYERS_JOINED' && room.status !== 'SETTING_SECRETS')) {
            socket.emit('error-event', { message: `Cannot set secret. Game Status: ${room?.status}, Player: ${playerId} in room: ${!!room?.players[playerId]}` });
            return;
          }

          if (room.players[playerId].secret && room.players[playerId].secret!.length > 0) {
             console.log(`Player ${playerId} in game ${gameId} attempted to re-set secret. Ignoring.`);
             io.to(gameId).emit('game-state-update', room);
             socket.emit('secret-update', {
                playerId,
                secretSet: true,
                secretsCurrentlySet: room.secretsSetCount,
                totalPlayers: room.playerCount
             });
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
             if (room && room.players[playerId]) { // Check if player still exists
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
            const playerIds = Object.keys(room.players).filter(pId => room.players[pId].socketId).sort();

            if (playerIds.length !== room.playerCount) {
                console.warn(`Mismatch between secretsSetCount (${room.secretsSetCount}) and active playerIds length (${playerIds.length}) for game ${gameId}. Aborting game start.`);
                socket.emit('error-event', { message: 'Player count mismatch before starting game. Some players may have disconnected.'});
                const finalRoomState = await getGameRoom(gameId);
                if(finalRoomState) io.to(gameId).emit('game-state-update', finalRoomState);
                return;
            }

            let targetMap: { [playerId: string]: string } = {};
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
            console.log(`Game ${gameId} starting. Turn: ${room.turn}, TargetMap:`, room.targetMap);
            io.to(gameId).emit('game-start', { gameId, startingPlayer: room.turn!, targetMap: room.targetMap! });
            io.to(gameId).emit('game-state-update', room);
          }
        });

        socket.on('make-guess', async (data: { gameId: string; playerId: string; guess: string[] }) => {
          await dbConnectionPromise;
          if (!db) {
              socket.emit('error-event', { message: 'Database connection not available for make-guess.' });
              console.error(`MongoDB: (make-guess) DB unavailable for ${data.gameId}, socket ${socket.id}.`);
              return;
          }

          const { gameId, guess: guessArray } = data;
          const clientProvidedPlayerId = data.playerId;
          const serverAssignedPlayerId = socket.playerId;

          console.log(`Socket ${socket.id} (ServerAssigned: ${serverAssignedPlayerId}, ClientProvided: ${clientProvidedPlayerId}) attempting to make guess for game: ${gameId} - DB Connection Confirmed.`);


          if (!serverAssignedPlayerId) {
            console.error(`Critical: Socket ${socket.id} has no serverAssignedPlayerId but tried to make guess for game ${gameId}.`);
            socket.emit('error-event', { message: 'Player ID not properly assigned to your connection. Cannot make guess.' });
            return;
          }

          if (clientProvidedPlayerId !== serverAssignedPlayerId) {
            console.error(`Security Alert/Bug: Client ${socket.id} (server-assigned: ${serverAssignedPlayerId}) tried to make guess using explicit client-provided ID ${clientProvidedPlayerId} in game ${gameId}. Denying.`);
            socket.emit('error-event', { message: `Player ID mismatch. Cannot make guess for another player.` });
            return;
          }
          
          const playerId = serverAssignedPlayerId; // Use server-assigned ID


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
            const playerIds = Object.keys(room.players).filter(pId => room.players[pId].socketId).sort();
            if(playerIds.length === 0) {
                console.error(`No active players found in game ${gameId} during turn switch. State:`, room);
                socket.emit('error-event', {message: 'Critical error: No active players found to switch turn.'});
                return;
            }
            const currentPlayerIndex = playerIds.indexOf(playerId);
            if (currentPlayerIndex === -1) {
                console.error(`Current player ${playerId} not in active list for game ${gameId}. State:`, room);
                updateFields.$set = { turn: playerIds[0] };
            } else {
                const nextPlayerId = playerIds[(currentPlayerIndex + 1) % playerIds.length];
                updateFields.$set = { turn: nextPlayerId };
            }
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
    