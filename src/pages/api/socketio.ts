
import type { Server as HTTPServer } from 'http';
import type { Socket as NetSocket } from 'net';
import type { NextApiRequest, NextApiResponse } from 'next';
import { Server as SocketIOServer, Socket } from 'socket.io';
import type { GameRoom, PlayerData, Guess, MultiplayerGameStatus } from '@/types/game';
import { calculateFeedback, checkWin } from '@/lib/gameLogic';
import { MongoClient, Db as MongoDb, FindOneAndUpdateOptions, MongoError, WithId, ModifyResult } from 'mongodb';

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
  return 0; // Should not happen with current UI
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
    console.warn(`MongoDB: db instance is null (createGameRoom for ${gameId}). Cannot create.`);
    return null;
  }
  try {
    // newRoomData should ALREADY have the first player defined with a specific ID (e.g. "player1")
    await db.collection<GameRoom>(COLLECTION_NAME).insertOne(newRoomData);
    console.log(`MongoDB: Game room ${gameId} created successfully with initial data:`, JSON.stringify(newRoomData));
    // Return the newRoomData as it was intended to be inserted (it doesn't have _id from DB yet, but matches GameRoom structure)
    return newRoomData;
  } catch (error: any) {
    if (error instanceof MongoError && error.code === 11000) { // Duplicate key error
      console.warn(`MongoDB: Attempted to create game room ${gameId}, but it already exists (duplicate key). Another client likely created it.`);
      return null; // Signal to re-fetch
    }
    console.error(`MongoDB: Error creating game room ${gameId} (createGameRoom):`, error);
    return null;
  }
}


async function updateGameRoom(
  gameId: string,
  updateOperators: any // Contains MongoDB update operators like $set, $inc
): Promise<GameRoom | null> {
  await dbConnectionPromise;
  if (!db) {
    console.warn(`MongoDB: db instance is null (updateGameRoom for ${gameId}). Cannot update.`);
    return null;
  }

  const filter = { gameId: gameId };
  const options: FindOneAndUpdateOptions = {
    returnDocument: 'after',
    upsert: false, // We are explicitly not using upsert here for simple updates. Creation is separate.
  };

  try {
    // console.log(`MongoDB: Attempting findOneAndUpdate (update only) for game room ${gameId} with filter: ${JSON.stringify(filter)}, update: ${JSON.stringify(updateOperators)}`);
    const updatedDoc: WithId<GameRoom> | null = await db.collection<GameRoom>(COLLECTION_NAME).findOneAndUpdate(filter, updateOperators, options);
    
    if (updatedDoc) {
      // console.log(`MongoDB: findOneAndUpdate (update only) successful for ${gameId}.`);
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { _id, ...roomData } = updatedDoc;
      return roomData as GameRoom;
    } else {
      console.warn(`MongoDB: findOneAndUpdate (update only) for ${gameId} did not find a document to update or failed. Filter: ${JSON.stringify(filter)}, Update: ${JSON.stringify(updateOperators)}`);
      // It's possible the room was deleted between a get and this update. Re-fetch to confirm.
      const refetchedRoom = await getGameRoom(gameId);
      if (refetchedRoom) {
        console.log(`MongoDB: Re-fetched room ${gameId} successfully after update returned null. Current state will be used.`);
        return refetchedRoom;
      } else {
        console.warn(`MongoDB: Re-fetching room ${gameId} also failed. Room likely does not exist.`);
        return null;
      }
    }
  } catch (error: any) {
    console.error(`MongoDB: Error during findOneAndUpdate (update only) for ${gameId}. Filter: ${JSON.stringify(filter)}, Update: ${JSON.stringify(updateOperators)}, Error:`, error);
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
                // Mark player as disconnected or remove them for cleaner state
                const updateOps = { $unset: { [`players.${playerId}.socketId`]: "" } }; // Remove socketId to mark inactive
                // Optionally, completely remove player: { $unset: { [`players.${playerId}`]: "" } }
                // And potentially decrement playerCount if that's dynamic, or adjust secretsSetCount if they hadn't set.

                const updatedRoom = await updateGameRoom(gameId, updateOps);
                if (updatedRoom) {
                    room = updatedRoom;
                     io.to(gameId).emit('player-disconnected', {
                        gameId,
                        playerId,
                        message: `${playerId} has disconnected.`
                    });
                    io.to(gameId).emit('game-state-update', room);

                    // If it's a 2-player game and one disconnects during play, declare other winner
                    // (More complex logic needed for >2 players if game should end)
                    const activePlayers = Object.values(room.players).filter(p => p.socketId);
                    if (room.playerCount === 2 && room.status === 'IN_PROGRESS' && activePlayers.length === 1) {
                        const winnerId = activePlayers[0] ? Object.keys(room.players).find(pId => room.players[pId].socketId === activePlayers[0].socketId) : null;
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
                    console.warn(`Failed to update room on disconnect for player ${playerId} in game ${gameId}`);
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
                socket.emit('error-event', { message: 'Database connection not available for join-game.' });
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
            
            socket.join(gameId); // Socket joins the room
            let room = await getGameRoom(gameId);
            let assignedPlayerId: string | undefined = undefined; // Will be set to 'player1', 'player2', etc. or rejoiningPlayerId
            let playerJustCreatedRoom = false;

            if (!room) {
                console.log(`Game room ${gameId} not found in DB. This client (${socket.id}) will attempt to create it as player1.`);
                const creatorPlayerId = 'player1';
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
                    socket.playerId = creatorPlayerId;
                    playerJustCreatedRoom = true;
                    console.log(`Game room ${gameId} created successfully by ${assignedPlayerId} (${socket.id}).`);
                } else {
                    console.warn(`MongoDB: createGameRoom for ${gameId} by ${socket.id} returned null (likely duplicate key). Re-fetching.`);
                    room = await getGameRoom(gameId); // Re-fetch in case another client created it during a race
                    if (!room) {
                        socket.emit('error-event', { message: 'Failed to create or find game room after creation attempt.' });
                        console.error(`Critical: Failed to get room ${gameId} even after create attempt and re-fetch by ${socket.id}.`);
                        socket.leave(gameId);
                        return;
                    }
                    console.log(`MongoDB: Successfully re-fetched room ${gameId} for ${socket.id} after its own creation attempt failed.`);
                    // Now this client needs to join as a new player (not player1)
                }
            }
            
            // If room exists (either initially, or after successful creation by this client, or after failed creation + re-fetch)
            if (room) {
                socket.gameId = gameId; // Associate socket with this gameId

                if (!assignedPlayerId) { // If not the creator, or if creation failed and re-fetched, determine player ID
                    const storedGameIdForPlayer = rejoiningPlayerId ? localStorage.getItem(`activeGameId_${rejoiningPlayerId}`) : null;
                    if (rejoiningPlayerId && room.players[rejoiningPlayerId] && storedGameIdForPlayer === gameId) {
                        // Valid rejoining player for this game
                        assignedPlayerId = rejoiningPlayerId;
                        socket.playerId = rejoiningPlayerId;
                        console.log(`Player ${assignedPlayerId} (${socket.id}) is rejoining game ${gameId}.`);
                        // Update socket ID if different
                        if (room.players[assignedPlayerId].socketId !== socket.id) {
                            const updatedRoom = await updateGameRoom(gameId, { $set: { [`players.${assignedPlayerId}.socketId`]: socket.id } });
                            if (updatedRoom) room = updatedRoom; else { /* handle error */ }
                        }
                    } else {
                        // New player joining (or rejoiningPlayerId invalid/for different game)
                        if (Object.keys(room.players).length >= room.playerCount) {
                            // Check if any existing player slot matches rejoiningPlayerId but without socketId (disconnected)
                            let foundDisconnectedSlot = false;
                            if (rejoiningPlayerId && room.players[rejoiningPlayerId] && !room.players[rejoiningPlayerId].socketId) {
                                assignedPlayerId = rejoiningPlayerId;
                                socket.playerId = rejoiningPlayerId;
                                const updatedRoom = await updateGameRoom(gameId, { $set: { [`players.${assignedPlayerId}.socketId`]: socket.id } });
                                if (updatedRoom) room = updatedRoom;
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
                        
                        if(!assignedPlayerId) { // If still not assigned (not a reconnected slot)
                            for (let i = 1; i <= room.playerCount; i++) {
                                const potentialPlayerId = `player${i}`;
                                if (!room.players[potentialPlayerId] || !room.players[potentialPlayerId].socketId) { // Check if slot is free or player disconnected
                                    assignedPlayerId = potentialPlayerId;
                                    socket.playerId = assignedPlayerId;
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
                            // Re-fetch to ensure client has some state if possible
                            const finalCheckRoom = await getGameRoom(gameId);
                            if (finalCheckRoom) io.to(gameId).emit('game-state-update', finalCheckRoom);
                            socket.leave(gameId);
                            return;
                        }
                        room = roomAfterPlayerAdd;
                    }
                }
                
                // Player is now considered in the room (either created or joined)
                socket.emit('player-assigned', { playerId: socket.playerId!, gameId });
                io.to(gameId).emit('game-state-update', room); 
                
                // Check if all players have now joined
                const currentPlayersCount = Object.values(room.players).filter(p => p.socketId).length;
                if (currentPlayersCount === room.playerCount && room.status === 'WAITING_FOR_PLAYERS') {
                  console.log(`All ${room.playerCount} players joined game ${gameId}. Updating status.`);
                  const statusUpdate = { $set: {status: 'ALL_PLAYERS_JOINED' as MultiplayerGameStatus} };
                  const roomAfterStatusUpdate = await updateGameRoom(gameId, statusUpdate);
                  if (roomAfterStatusUpdate) {
                      io.to(gameId).emit('all-players-joined', { gameId }); 
                      io.to(gameId).emit('game-state-update', roomAfterStatusUpdate); 
                      room = roomAfterStatusUpdate; // update local room variable
                  } else {
                       console.warn(`Failed to update game ${gameId} status to ALL_PLAYERS_JOINED.`);
                       // Emit current state anyway
                       const finalRoomState = await getGameRoom(gameId);
                       if(finalRoomState) io.to(gameId).emit('game-state-update', finalRoomState);
                  }
                } else {
                    // If not all players joined or status already past WAITING_FOR_PLAYERS, ensure clients have the latest state
                    // This can happen if a player rejcans and the game was already in ALL_PLAYERS_JOINED or SETTING_SECRETS
                    io.to(gameId).emit('game-state-update', room);
                }

            } else {
                 socket.emit('error-event', { message: 'Game room became unavailable during join process.' });
                 console.error(`Room ${gameId} is null/undefined before final emissions for socket ${socket.id}.`);
                 socket.leave(gameId);
                 return;
            }
        });

        socket.on('send-secret', async (data: { gameId: string; playerId: string; secret: string[] }) => {
          await dbConnectionPromise;
          if (!db) {
              socket.emit('error-event', { message: 'Database connection not available for send-secret.' });
               console.error(`MongoDB: DB unavailable in send-secret for ${data.gameId}, socket ${socket.id}.`);
              return;
          }
          console.log(`Socket ${socket.id} (Player ${data.playerId}) attempting to send secret for game: ${data.gameId} - DB Connection Confirmed.`);

          const { gameId, playerId, secret } = data;
          // Ensure socket.playerId matches the one trying to set secret for security/consistency
          if(socket.playerId !== playerId) {
            socket.emit('error-event', { message: `Player ID mismatch. Socket is ${socket.playerId}, tried to set for ${playerId}.` });
            return;
          }

          let room = await getGameRoom(gameId);

          if (!room || !room.players[playerId] || (room.status !== 'ALL_PLAYERS_JOINED' && room.status !== 'SETTING_SECRETS')) {
            socket.emit('error-event', { message: `Cannot set secret. Game Status: ${room?.status}, Player: ${playerId} in room: ${!!room?.players[playerId]}` });
            return;
          }
          
          if (room.players[playerId].secret && room.players[playerId].secret!.length > 0) {
             console.log(`Player ${playerId} in game ${gameId} attempted to re-set secret. Ignoring.`);
             // Send current state to ensure client is synced if it missed an update
             io.to(gameId).emit('game-state-update', room); 
             // Also emit secret-update to confirm to this specific client that their secret is indeed set
             socket.emit('secret-update', { 
                playerId,
                secretSet: true, // It's already set
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
            const playerIds = Object.keys(room.players).filter(pId => room.players[pId].socketId).sort(); 
            
            if (playerIds.length !== room.playerCount) {
                console.warn(`Mismatch between secretsSetCount (${room.secretsSetCount}) and active playerIds length (${playerIds.length}) for game ${gameId}. Aborting game start.`);
                // Potentially reset status or emit error
                socket.emit('error-event', { message: 'Player count mismatch before starting game. Some players may have disconnected.'});
                // Send latest state to all
                const finalRoomState = await getGameRoom(gameId);
                if(finalRoomState) io.to(gameId).emit('game-state-update', finalRoomState);
                return;
            }

            let targetMap: { [playerId: string]: string } = {};
            if (room.playerCount === 2) { 
               targetMap = { [playerIds[0]]: playerIds[1], [playerIds[1]]: playerIds[0] };
            } else if (room.playerCount > 2) { // Simple ring for >2 players
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
              console.error(`MongoDB: DB unavailable in make-guess for ${data.gameId}, socket ${socket.id}.`);
              return;
          }
          console.log(`Socket ${socket.id} (Player ${data.playerId}) attempting to make guess for game: ${data.gameId} - DB Connection Confirmed.`);

          const { gameId, playerId, guess: guessArray } = data;
          // Ensure socket.playerId matches
          if(socket.playerId !== playerId) {
            socket.emit('error-event', { message: `Player ID mismatch. Socket is ${socket.playerId}, guess for ${playerId}.` });
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
            const playerIds = Object.keys(room.players).filter(pId => room.players[pId].socketId).sort(); // Active players
            if(playerIds.length === 0) { // Should not happen in an IN_PROGRESS game
                console.error(`No active players found in game ${gameId} during turn switch. State:`, room);
                socket.emit('error-event', {message: 'Critical error: No active players found to switch turn.'});
                return;
            }
            const currentPlayerIndex = playerIds.indexOf(playerId);
            if (currentPlayerIndex === -1) { // Current player not in active list (e.g. disconnected right before this)
                console.error(`Current player ${playerId} not in active list for game ${gameId}. State:`, room);
                // Potentially assign turn to the first active player or handle error
                updateFields.$set = { turn: playerIds[0] }; // Fallback, or end game
            } else {
                const nextPlayerId = playerIds[(currentPlayerIndex + 1) % playerIds.length];
                updateFields.$set = { turn: nextPlayerId };
            }
          }

          const updatedRoomAfterGuess = await updateGameRoom(gameId, updateFields);
          if (!updatedRoomAfterGuess) {
              socket.emit('error-event', { message: 'Failed to update game after guess.'});
              const finalRoomState = await getGameRoom(gameId); // Get latest state
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
    
