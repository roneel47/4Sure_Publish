
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
// Initialize with dummy functions to satisfy TypeScript's definite assignment analysis
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
    // Ensure unique index on gameId for reliability (do this once in MongoDB Atlas/shell)
    // await db.collection(COLLECTION_NAME).createIndex({ gameId: 1 }, { unique: true });
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

async function createGameRoom(gameId: string, newRoomData: Omit<GameRoom, 'gameId'>): Promise<GameRoom | null> {
    await dbConnectionPromise;
    if (!db) {
      console.warn(`MongoDB: (createGameRoom) db instance is null for game ${gameId}. Cannot create.`);
      return null;
    }
    try {
      const fullRoomData: GameRoom = { ...newRoomData, gameId };
      const result = await db.collection<GameRoom>(COLLECTION_NAME).insertOne(fullRoomData);
      if (result.insertedId) {
        console.log(`MongoDB: Game room ${gameId} created successfully with initial data:`, JSON.stringify({...fullRoomData, _id: result.insertedId}));
        return fullRoomData; 
      } else {
        console.error(`MongoDB: (createGameRoom) insertOne for ${gameId} did not confirm insertion.`);
        return null;
      }
    } catch (error: any) {
      if (error instanceof MongoError && error.code === 11000) { 
        console.warn(`MongoDB: (createGameRoom) Attempted to create game room ${gameId}, but it already exists (duplicate key). Another client likely created it.`);
        return null; 
      }
      console.error(`MongoDB: (createGameRoom) Error creating game room ${gameId}:`, error);
      return null;
    }
  }


async function updateGameRoom(
  gameId: string,
  updateOperators: any,
): Promise<GameRoom | null> {
  await dbConnectionPromise;
  if (!db) {
    console.warn(`MongoDB: (updateGameRoom) db instance is null for game ${gameId}. Cannot update.`);
    return null;
  }

  const filter = { gameId: gameId };
  const options: FindOneAndUpdateOptions = {
    returnDocument: 'after',
    upsert: false, // We handle inserts separately in createGameRoom or specific logic in join-game
  };

  try {
    const updatedDoc: WithId<GameRoom> | null = await db.collection<GameRoom>(COLLECTION_NAME).findOneAndUpdate(filter, updateOperators, options);
    
    if (updatedDoc) {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { _id, ...roomData } = updatedDoc;
        return roomData as GameRoom;
    } else {
      console.warn(`MongoDB: findOneAndUpdate for ${gameId} did not return a document. Filter: ${JSON.stringify(filter)}, Update: ${JSON.stringify(updateOperators)}`);
      const refetchedRoom = await getGameRoom(gameId); 
      if (refetchedRoom) {
        console.log(`MongoDB: Re-fetched room ${gameId} successfully after update attempt.`);
        return refetchedRoom;
      }
      console.error(`MongoDB: Failed to get room ${gameId} even after re-fetch post-update attempt.`);
      return null;
    }
  } catch (error: any) {
    console.error(`MongoDB: Error during findOneAndUpdate for ${gameId}. Filter: ${JSON.stringify(filter)}, Update: ${JSON.stringify(updateOperators)}, Error:`, error);
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
            console.error(`MongoDB: (disconnect) DB unavailable for Player ${socket.playerId}, Game ${socket.gameId}`);
            return;
          }
          console.log(`Socket disconnected: ${socket.id}, Player: ${socket.playerId}, Game: ${socket.gameId}`);

          const gameId = socket.gameId;
          const playerId = socket.playerId;

          if (gameId && playerId) {
            let room = await getGameRoom(gameId);
            if (!room) { 
                console.warn(`MongoDB: (disconnect) Room ${gameId} not found for player ${playerId}. Cannot process disconnect further.`);
                return;
            }

            if (room.players && room.players[playerId]) { 
                const updateOps = { $unset: { [`players.${playerId}.socketId`]: "" } };
                const updatedRoom = await updateGameRoom(gameId, updateOps);
                if (updatedRoom) {
                    room = updatedRoom; 
                    io.to(gameId).emit('player-disconnected', {
                        gameId,
                        playerId,
                        message: `${playerId} has disconnected.`
                    });
                    
                    if (!room || !room.players) { 
                        console.warn(`MongoDB: (disconnect) room or room.players is undefined for game ${gameId} after update. State:`, room);
                        if (room) io.to(gameId).emit('game-state-update', room); 
                        return;
                    }
                    const activePlayersWithSocketId = Object.values(room.players).filter(p => p.socketId);

                    if (room.playerCount === 2 && room.status === 'IN_PROGRESS' && activePlayersWithSocketId.length === 1) {
                        const winnerId = Object.keys(room.players).find(pId => room.players[pId].socketId === activePlayersWithSocketId[0].socketId);
                        if (winnerId) {
                            const gameOverUpdate = { $set: { status: 'GAME_OVER' as MultiplayerGameStatus, winner: winnerId, turn: undefined }};
                            const finalRoomStateForDisconnect = await updateGameRoom(gameId, gameOverUpdate);
                            if (finalRoomStateForDisconnect) {
                                room = finalRoomStateForDisconnect;
                                io.to(gameId).emit('game-over', { gameId, winner: winnerId });
                            } else {
                                console.warn(`MongoDB: (disconnect) Failed to set game over for ${gameId}. Room state might be stale.`);
                            }
                        }
                    }
                    io.to(gameId).emit('game-state-update', room); 
                } else {
                    console.warn(`MongoDB: (disconnect) Failed to update room (unset socketId) for player ${playerId} in game ${gameId}`);
                    if (room) io.to(gameId).emit('game-state-update', room);
                }
              } else {
                 console.warn(`MongoDB: (disconnect) Player ${playerId} not found in room ${gameId} or room.players undefined. Room state:`, room);
                 if (room) io.to(gameId).emit('game-state-update', room); 
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
            const { gameId, playerCount: playerCountString } = data;
            let { rejoiningPlayerId } = data; 

            console.log(`Socket ${socket.id} attempting to join game: ${gameId} (PlayerCount: ${playerCountString}) - DB Connection Confirmed for this handler.`);

            const numPlayerCount = getPlayerCountNumber(playerCountString);
            if (!numPlayerCount) {
              socket.emit('error-event', { message: 'Invalid player count specified.' });
              return;
            }

            let room = await getGameRoom(gameId);
            let assignedPlayerId: string | undefined = undefined;
            let playerCreatedRoom = false;

            if (!room) {
                console.log(`Game room ${gameId} not found in DB. This client (${socket.id}) will attempt to create it as player1.`);
                assignedPlayerId = "player1"; 
                
                const initialPlayers: { [playerId: string]: PlayerData } = {
                    [assignedPlayerId]: { socketId: socket.id, guessesMade: [], guessesAgainst: [], secret: [] }
                };
                const newRoomDataForCreation: Omit<GameRoom, 'gameId'> = { 
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
                    socket.playerId = assignedPlayerId; 
                    playerCreatedRoom = true;
                    console.log(`Game room ${gameId} created successfully by ${assignedPlayerId} (${socket.id}).`);
                } else {
                    // If creation failed (e.g. duplicate key), re-fetch. Another client might have created it.
                    assignedPlayerId = undefined; // Reset, as this client didn't create it
                    console.warn(`MongoDB: (join-game) createGameRoom for ${gameId} by ${socket.id} returned null. Re-fetching.`);
                    room = await getGameRoom(gameId); 
                    if (!room) {
                        socket.emit('error-event', { message: 'Failed to create or find game room after creation attempt.' });
                        console.error(`Critical: (join-game) Failed to get room ${gameId} even after create attempt and re-fetch by ${socket.id}.`);
                        return; 
                    }
                    console.log(`MongoDB: (join-game) Successfully re-fetched room ${gameId} for ${socket.id} after its own creation attempt failed.`);
                }
            }
            
            socket.join(gameId); 
            socket.gameId = gameId; 

            if (!playerCreatedRoom) { 
                 if (!room) { 
                    socket.emit('error-event', { message: 'Internal server error: Room became unavailable before player assignment.'});
                    console.error(`Critical: Room ${gameId} is unexpectedly null before player assignment logic for socket ${socket.id}`);
                    return;
                }
                
                // Server cannot access client's localStorage.
                // We rely on rejoiningPlayerId and check if it exists in the room.
                // const storedGameIdForPlayer = rejoiningPlayerId ? localStorage.getItem(`activeGameId_${rejoiningPlayerId}`) : null; No server-side localStorage

                if (rejoiningPlayerId && room.players && room.players[rejoiningPlayerId]) { 
                    // Player exists in room, consider it a rejoin for this player ID
                    assignedPlayerId = rejoiningPlayerId;
                    socket.playerId = rejoiningPlayerId;
                    console.log(`Player ${assignedPlayerId} (${socket.id}) is rejoining game ${gameId}.`);
                    if (room.players[assignedPlayerId].socketId !== socket.id) {
                       const updatedRoomSockId = await updateGameRoom(gameId, { $set: { [`players.${assignedPlayerId}.socketId`]: socket.id } });
                       if (updatedRoomSockId) room = updatedRoomSockId;
                       else { console.error(`Failed to update socketId for rejoining player ${assignedPlayerId}`); }
                    }
                } else {
                    // Not a valid rejoin or no rejoiningPlayerId provided, find a new slot.
                    rejoiningPlayerId = undefined; // Clear it if it wasn't a valid rejoin
                    if (!room.players) { 
                        console.error(`Critical: room.players is undefined for game ${gameId} before checking room full status for ${socket.id}.`);
                        socket.emit('error-event', {message: 'Internal server error processing player join.'});
                        return;
                    }
                    
                    const currentPlayersWithSocketIdCount = Object.values(room.players).filter(p => p.socketId).length;
                    
                    if (currentPlayersWithSocketIdCount >= room.playerCount) {
                        socket.emit('error-event', { message: 'Game room is full.' });
                        console.log(`Game room ${gameId} is full. Cannot add new player ${socket.id}. Players:`, Object.keys(room.players));
                        socket.leave(gameId); 
                        return;
                    }

                    for (let i = 1; i <= room.playerCount; i++) {
                        const potentialPlayerId = `player${i}`;
                        if (!room.players[potentialPlayerId] || !room.players[potentialPlayerId].socketId) {
                            assignedPlayerId = potentialPlayerId;
                            break; 
                        }
                    }

                    if (!assignedPlayerId) {
                        socket.emit('error-event', { message: 'Could not assign player ID. No available slot.' });
                        console.error(`Could not assign player ID for new player ${socket.id} in game ${gameId}. Room state:`, room);
                        socket.leave(gameId); 
                        return;
                    }
                    
                    socket.playerId = assignedPlayerId; 
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

            if (!socket.playerId) { 
                console.error(`CRITICAL: Socket ${socket.id} has no playerId before emitting player-assigned for game ${gameId}. AssignedPlayerId was: ${assignedPlayerId}`);
                socket.emit('error-event', { message: 'Internal server error: Player ID not finalized.'});
                socket.leave(gameId);
                return;
            }
             if (!room) {
                console.error(`CRITICAL: Room object is null before emitting player-assigned for game ${gameId}, socket ${socket.id}`);
                socket.emit('error-event', {message: 'Internal server error: Game data lost before assignment.'});
                return;
            }

            socket.emit('player-assigned', { playerId: socket.playerId, gameId });
            io.to(gameId).emit('game-state-update', room); 

            if (!room.players) { 
                console.error(`Critical: room.players is undefined for game ${gameId} before checking all players joined for ${socket.id}.`);
                socket.emit('error-event', {message: 'Internal server error processing player join (state check).'});
                return;
            }
            const finalPlayersInRoom = Object.values(room.players).filter(p => p.socketId);
            if (finalPlayersInRoom.length === room.playerCount && room.status === 'WAITING_FOR_PLAYERS') {
              console.log(`All ${room.playerCount} players joined game ${gameId}. Updating status.`);
              const statusUpdate = { $set: {status: 'ALL_PLAYERS_JOINED' as MultiplayerGameStatus} };
              const roomAfterStatusUpdate = await updateGameRoom(gameId, statusUpdate);
              if (roomAfterStatusUpdate) {
                  room = roomAfterStatusUpdate; 
                  io.to(gameId).emit('all-players-joined', { gameId });
                  io.to(gameId).emit('game-state-update', room); 
              } else {
                   console.warn(`Failed to update game ${gameId} status to ALL_PLAYERS_JOINED.`);
                   const latestRoomState = await getGameRoom(gameId); 
                   if(latestRoomState) io.to(gameId).emit('game-state-update', latestRoomState);
              }
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
          const serverAssignedPlayerId = socket.playerId; 

          if (!serverAssignedPlayerId) {
            console.error(`Critical: Socket ${socket.id} has no serverAssignedPlayerId but tried to send secret for game ${gameId}. Client provided: ${clientProvidedPlayerId}`);
            socket.emit('error-event', { message: 'Player ID not properly assigned to your connection. Cannot set secret.' });
            return;
          }
          
          if (clientProvidedPlayerId !== serverAssignedPlayerId) {
            console.error(`Security Alert: Client ${socket.id} (server-assigned: ${serverAssignedPlayerId}) tried to send secret using explicit client-provided ID ${clientProvidedPlayerId} in game ${gameId}. Denying.`);
            socket.emit('error-event', { message: `Player ID mismatch. Cannot set secret for another player.` });
            return;
          }
          
          const playerId = serverAssignedPlayerId;
          console.log(`Socket ${socket.id} (Player ${playerId}) attempting to send secret for game: ${gameId} - DB Connection Confirmed.`);

          let room = await getGameRoom(gameId);

          if (!room) { 
            console.error(`Error: Room ${gameId} not found when player ${playerId} tried to send secret.`);
            socket.emit('error-event', { message: `Cannot set secret. Game room not found.` });
            return;
          }
          if (!room.players || !room.players[playerId]) { 
            console.error(`Error: Player ${playerId} not found in room ${gameId} or room.players undefined, when trying to send secret.`);
            socket.emit('error-event', { message: `Cannot set secret. Player not found in game.` });
            return;
          }
          if (room.status !== 'ALL_PLAYERS_JOINED' && room.status !== 'SETTING_SECRETS') {
            socket.emit('error-event', { message: `Cannot set secret. Game Status: ${room.status}` });
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
             const currentRoomState = await getGameRoom(gameId); 
             if (currentRoomState && currentRoomState.players && currentRoomState.players[playerId]) { 
                io.to(gameId).emit('secret-update', {
                    playerId,
                    secretSet: !!(currentRoomState.players[playerId]?.secret && currentRoomState.players[playerId].secret!.length > 0),
                    secretsCurrentlySet: currentRoomState.secretsSetCount,
                    totalPlayers: currentRoomState.playerCount
                });
                if (currentRoomState) io.to(gameId).emit('game-state-update', currentRoomState);
             } else {
                socket.emit('error-event', { message: 'Failed to update or re-fetch room after secret submission.' });
             }
             return;
          }
          room = roomAfterSecretAttempt; 

          io.to(gameId).emit('secret-update', { playerId, secretSet: true, secretsCurrentlySet: room.secretsSetCount, totalPlayers: room.playerCount });
          
          if (!room) {
              console.error(`MongoDB: (send-secret) Room ${gameId} is null before emitting game-state-update after secret set for ${playerId}.`);
              return;
          }
          io.to(gameId).emit('game-state-update', room);

          if (room.secretsSetCount === room.playerCount && (room.status === 'SETTING_SECRETS')) {
            if (!room.players) { 
                 console.error(`Critical: room.players is undefined for game ${gameId} before starting game after secrets set.`);
                 socket.emit('error-event', {message: 'Internal server error processing game start.'});
                 return;
            }
            const playerIds = Object.keys(room.players).filter(pId => room.players![pId].socketId).sort(); 

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
            
            if (!room) {
                console.error(`MongoDB: (send-secret) Room ${gameId} is null before emitting final game-state-update after game start for ${playerId}.`);
                return;
            }
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

          if (!serverAssignedPlayerId) {
            console.error(`Critical: Socket ${socket.id} has no serverAssignedPlayerId but tried to make guess for game ${gameId}. Client provided: ${clientProvidedPlayerId}`);
            socket.emit('error-event', { message: 'Player ID not properly assigned to your connection. Cannot make guess.' });
            return;
          }

          if (clientProvidedPlayerId !== serverAssignedPlayerId) {
            console.error(`Security Alert: Client ${socket.id} (server-assigned: ${serverAssignedPlayerId}) tried to make guess using explicit client-provided ID ${clientProvidedPlayerId} in game ${gameId}. Denying.`);
            socket.emit('error-event', { message: `Player ID mismatch. Cannot make guess for another player.` });
            return;
          }
          
          const playerId = serverAssignedPlayerId; 
          console.log(`Socket ${socket.id} (Player ${playerId}) making guess for game: ${gameId} - DB Connection Confirmed.`);


          let room = await getGameRoom(gameId);

          if (!room) { 
            console.error(`Error: Room ${gameId} not found when player ${playerId} tried to make guess.`);
            socket.emit('error-event', { message: 'Game not found.' }); 
            return;
          }
          if (room.status !== 'IN_PROGRESS') {
            socket.emit('error-event', { message: 'Game not in progress.' }); return;
          }
          if (room.turn !== playerId) {
            socket.emit('error-event', { message: 'Not your turn.' }); return;
          }
          
          if (!room.players || !room.targetMap) { 
             console.error(`Error: room.players or room.targetMap is undefined in game ${gameId} for guess by ${playerId}.`);
             socket.emit('error-event', { message: 'Internal server error: Game data incomplete.'});
             return;
          }

          const targetPlayerId = room.targetMap[playerId];
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
            if (!room.players) { 
                console.error(`Critical error: room.players is null/undefined before trying to get playerIds for game ${gameId} (turn switch).`);
                socket.emit('error-event', { message: 'Internal server error processing guess (turn switch).' });
                return;
            }
            const playerIds = Object.keys(room.players).filter(pId => room.players![pId].socketId).sort(); 
            
            if (playerIds.length === 0) { 
                console.error(`No active players found in game ${gameId} during turn switch. State:`, room ? JSON.stringify(room.players) : 'room is null');
                socket.emit('error-event', {message: 'Critical error: No active players found to switch turn.'});
                return;
            }
            const currentPlayerIndex = playerIds.indexOf(playerId);
            if (currentPlayerIndex === -1) { 
                console.error(`Current player ${playerId} not in active list for game ${gameId}. State:`, room ? JSON.stringify(room.players) : 'room is null');
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
          
          if (!room) {
              console.error(`MongoDB: (make-guess) Room ${gameId} is null before emitting final game-state-update for ${playerId}.`);
              return;
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
    
