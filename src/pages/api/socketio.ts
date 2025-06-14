
import type { Server as HTTPServer } from 'http';
import type { Socket as NetSocket } from 'net';
import type { NextApiRequest, NextApiResponse } from 'next';
import { Server as SocketIOServer, Socket } from 'socket.io';
import type { GameRoom, PlayerData, Guess, MultiplayerGameStatus } from '@/types/game';
import { calculateFeedback, checkWin } from '@/lib/gameLogic';
import { MongoClient, Db as MongoDb, FindOneAndUpdateOptions, MongoError } from 'mongodb';

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
let dbConnectionPromise: Promise<MongoDb | null> = (async () => {
  console.log("[SocketIO] Attempting to connect to MongoDB...");
  if (!MONGODB_URI) {
    console.warn('[SocketIO] MONGODB_URI not found. Database operations will be unavailable.');
    return null;
  }
  try {
    const client = new MongoClient(MONGODB_URI);
    await client.connect();
    const connectedDb = client.db(DATABASE_NAME);
    console.log(`[SocketIO] Successfully connected to MongoDB. Database: ${DATABASE_NAME}`);
    console.log(`[SocketIO] Targeting collection: '${COLLECTION_NAME}'. Ensure unique index on 'gameId' and TTL index on 'createdAt'.`);
    return connectedDb;
  } catch (error) {
    console.error("[SocketIO] Error connecting to MongoDB:", error);
    return null;
  }
})();

async function getGameRoom(gameId: string): Promise<GameRoom | null> {
  const currentDb = await dbConnectionPromise;
  if (!currentDb) {
    console.warn(`[SocketIO-DB] getGameRoom: db instance is null for game ${gameId}.`);
    return null;
  }
  try {
    const roomDocument = await currentDb.collection<GameRoom>(COLLECTION_NAME).findOne({ gameId: gameId });
    if (roomDocument) {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { _id, ...data } = roomDocument; // Exclude MongoDB's _id
        return data as GameRoom;
    }
    return null;
  } catch (error) {
    console.error(`[SocketIO-DB] getGameRoom: Error fetching game room ${gameId}:`, error);
    return null;
  }
}

async function createGameRoom(gameId: string, newRoomData: Omit<GameRoom, 'gameId' | 'createdAt'> & { playerCount: number }): Promise<GameRoom | null> {
    const currentDb = await dbConnectionPromise;
    if (!currentDb) {
      console.warn(`[SocketIO-DB] createGameRoom: db instance is null for game ${gameId}.`);
      return null;
    }
    try {
      const roomToInsert: GameRoom = { 
        ...newRoomData, 
        gameId, 
        createdAt: new Date(),
        status: 'WAITING_FOR_PLAYERS', // Initial status
        players: newRoomData.players || {}, // Ensure players object exists
        targetMap: newRoomData.targetMap || {}
      };
      const result = await currentDb.collection<GameRoom>(COLLECTION_NAME).insertOne(roomToInsert);
      if (result.insertedId) {
        console.log(`[SocketIO-DB] Game room ${gameId} created successfully. Initial data:`, JSON.stringify(roomToInsert));
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { _id, ...data } = roomToInsert;
        return data as GameRoom;
      } else {
        console.error(`[SocketIO-DB] createGameRoom: insertOne for ${gameId} did not confirm insertion.`);
        return null;
      }
    } catch (error: any) {
      if (error instanceof MongoError && error.code === 11000) { 
        console.warn(`[SocketIO-DB] createGameRoom: Attempted to create ${gameId}, but it already exists.`);
        return getGameRoom(gameId); // Try to return the existing room
      }
      console.error(`[SocketIO-DB] createGameRoom: Error creating game room ${gameId}:`, error);
      return null;
    }
}


async function updateGameRoom(
  gameId: string,
  updateOperators: any, 
): Promise<GameRoom | null> {
  const currentDb = await dbConnectionPromise;
  if (!currentDb) {
    console.warn(`[SocketIO-DB] updateGameRoom: db instance is null for game ${gameId}.`);
    return null;
  }

  const filter = { gameId: gameId };
  const options: FindOneAndUpdateOptions = {
    returnDocument: 'after', 
    upsert: false, 
  };

  try {
    const result = await currentDb.collection<GameRoom>(COLLECTION_NAME).findOneAndUpdate(filter, updateOperators, options);
    
    if (result) {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { _id, ...roomData } = result; 
        return roomData as GameRoom;
    } else {
      console.warn(`[SocketIO-DB] updateGameRoom: findOneAndUpdate for ${gameId} did not return a document. Filter: ${JSON.stringify(filter)}, Update: ${JSON.stringify(updateOperators)}`);
      return null; // Or fetch again to see if it exists but wasn't updated: await getGameRoom(gameId);
    }
  } catch (error: any) {
    console.error(`[SocketIO-DB] updateGameRoom: Error during findOneAndUpdate for ${gameId}. Filter: ${JSON.stringify(filter)}, Update: ${JSON.stringify(updateOperators)}, Error:`, error);
    return null;
  }
}


const getPlayerCountNumber = (playerCountString: string): number => {
  if (playerCountString === 'duo') return 2;
  if (playerCountString === 'trio') return 3;
  if (playerCountString === 'quads') return 4;
  return 0; 
};


export default async function handler(
  req: NextApiRequest,
  res: NextApiResponseWithSocket
) {
  if (req.method === 'POST') { // Still useful to ensure endpoint is hit if client does POST first
    // console.log("[SocketIO] POST request to /api/socketio. Ensuring server is initialized.");
  }

  if (!res.socket.server.io) {
    console.log('[SocketIO] Initializing Socket.IO server...');
    const io = new SocketIOServer(res.socket.server, {
      path: '/api/socketio_c',
      addTrailingSlash: false,
    });
    res.socket.server.io = io;

    // Ensure DB is ready before processing connections
    db = await dbConnectionPromise;
    if (!db) {
      console.error("[SocketIO] CRITICAL: MongoDB connection failed. Socket.IO server will not function correctly.");
      // Potentially emit a global error or handle this state if connections are attempted
    }

    io.on('connection', async (socket: CustomSocket) => {
        if (!db) { // Re-check db connection for each new socket
          console.error(`[SocketIO] Connection ${socket.id}: DB instance is null. Disconnecting socket.`);
          socket.emit('error-event', { message: 'Server database connection critical error.' });
          socket.disconnect(true);
          return;
        }
        console.log(`[SocketIO] Socket connected: ${socket.id} - MongoDB connection confirmed.`);

        socket.on('disconnect', async () => {
          if (!db) {
            console.error(`[SocketIO] Disconnect ${socket.id}: DB unavailable for Player ${socket.playerId}, Game ${socket.gameId}`);
            return;
          }
          console.log(`[SocketIO] Socket disconnected: ${socket.id}, Player: ${socket.playerId}, Game: ${socket.gameId}`);

          const gameId = socket.gameId;
          const playerId = socket.playerId;

          if (gameId && playerId) {
            let room = await getGameRoom(gameId);
            if (!room || !room.players) { 
                console.warn(`[SocketIO] Disconnect ${socket.id}: Room ${gameId} or room.players not found for player ${playerId}.`);
                return;
            }
            if (!room.players[playerId]) {
                console.warn(`[SocketIO] Disconnect ${socket.id}: Player ${playerId} not found in room ${gameId}. Players:`, room.players);
                io.to(gameId).emit('game-state-update', room);
                return;
            }

            const updateOps: any = { 
                $set: { 
                    [`players.${playerId}.socketId`]: undefined, // Mark as disconnected
                } 
            };
            // If game hasn't started or is over, reset ready status
            if (room.status !== 'IN_PROGRESS' && room.status !== 'GAME_OVER') {
                updateOps.$set[`players.${playerId}.isReady`] = false;
                updateOps.$set[`players.${playerId}.hasSetSecret`] = false;
            }
            
            let updatedRoom = await updateGameRoom(gameId, updateOps);
            if (!updatedRoom) {
                console.warn(`[SocketIO] Disconnect ${socket.id}: Failed to update room for player ${playerId} in game ${gameId}. Fetching latest.`);
                updatedRoom = await getGameRoom(gameId); 
            }
            if (!updatedRoom) {
                console.error(`[SocketIO] Disconnect ${socket.id}: Failed to re-fetch room ${gameId} after update/disconnect.`);
                return;
            }
            room = updatedRoom;

            io.to(gameId).emit('player-disconnected', { gameId, playerId, message: `${playerId} has disconnected.` });
            
            const activePlayersWithSocketId = Object.values(room.players).filter(p => p.socketId);

            if (room.status === 'IN_PROGRESS' && room.playerCount === 2 && activePlayersWithSocketId.length < 2) { 
                const winnerId = activePlayersWithSocketId[0] ? Object.keys(room.players).find(pId => room.players[pId]?.socketId === activePlayersWithSocketId[0].socketId) : undefined;
                if (winnerId) {
                    console.log(`[SocketIO] Game ${gameId}: Player ${playerId} disconnected. Remaining player ${winnerId} wins by default.`);
                    const gameOverUpdate = { $set: { status: 'GAME_OVER' as MultiplayerGameStatus, winner: winnerId, turn: undefined }};
                    const finalRoomState = await updateGameRoom(gameId, gameOverUpdate);
                    if (finalRoomState) {
                        room = finalRoomState;
                        io.to(gameId).emit('game-over', { gameId, winner: winnerId });
                    }
                } else if (activePlayersWithSocketId.length === 0 && room.status !== 'GAME_OVER') { // Both disconnected from IN_PROGRESS
                    console.log(`[SocketIO] Game ${gameId}: Both players disconnected from IN_PROGRESS game. Marking as abandoned (GAME_OVER, no winner).`);
                     const abandonUpdate = { $set: { status: 'GAME_OVER' as MultiplayerGameStatus, winner: undefined, turn: undefined }};
                     const abandonedRoom = await updateGameRoom(gameId, abandonUpdate);
                     if (abandonedRoom) room = abandonedRoom;
                }
            } else if (room.status === 'READY_TO_START' || room.status === 'WAITING_FOR_READY') {
                 const stillFull = activePlayersWithSocketId.length === room.playerCount;
                 const newStatus = stillFull ? (activePlayersWithSocketId.every(p => p.isReady) ? 'READY_TO_START' : 'WAITING_FOR_READY') : 'WAITING_FOR_PLAYERS';
                 if (room.status !== newStatus) {
                    const statusUpdate = { $set: { status: newStatus }};
                    const roomAfterStatusUpdate = await updateGameRoom(gameId, statusUpdate);
                    if (roomAfterStatusUpdate) room = roomAfterStatusUpdate;
                 }
            }
            
            io.to(gameId).emit('game-state-update', room); 
          }
        });

        socket.on('join-game', async (data: { gameId: string; playerCount: string; rejoiningPlayerId?: string }) => {
            if (!db) {
                socket.emit('error-event', { message: 'DB connection not available for join-game.' });
                return;
            }
            const { gameId, playerCount: playerCountString } = data;
            let clientRejoiningPlayerId = data.rejoiningPlayerId; 

            console.log(`[SocketIO] Socket ${socket.id} attempting to join game: ${gameId} (PlayerCount: ${playerCountString}, RejoiningAs: ${clientRejoiningPlayerId || 'NEW'}) - DB Confirmed.`);

            const numPlayerCount = getPlayerCountNumber(playerCountString);
            if (!numPlayerCount) {
              socket.emit('error-event', { message: 'Invalid player count specified.' });
              return;
            }

            let room = await getGameRoom(gameId);
            let assignedPlayerId: string | undefined = undefined;
            const updateOps: any = { $set: {} };
            let needsDBUpdate = false;

            if (!room) {
                console.log(`[SocketIO] Game room ${gameId} not found. Client ${socket.id} creating it as player1.`);
                assignedPlayerId = "player1"; 
                socket.playerId = assignedPlayerId; 
                
                const initialPlayers: { [playerId: string]: PlayerData } = {
                    [assignedPlayerId]: { socketId: socket.id, guessesMade: [], guessesAgainst: [], secret: [], hasSetSecret: false, isReady: false }
                };
                const newRoomDataForCreation: Omit<GameRoom, 'gameId' | 'createdAt'> & { playerCount: number } = { 
                  playerCount: numPlayerCount,
                  players: initialPlayers,
                  status: 'WAITING_FOR_PLAYERS', // Will be updated below if full
                  targetMap: {}
                };

                room = await createGameRoom(gameId, newRoomDataForCreation);
                if (!room) {
                    socket.emit('error-event', { message: 'Failed to create or find game room.' });
                    return; 
                }
                // No further DB update needed here as createGameRoom handles it
            } else { // Room exists, player is joining or rejoining
                socket.join(gameId); 
                socket.gameId = gameId; 

                if (!room.players) room.players = {};

                if (clientRejoiningPlayerId && room.players[clientRejoiningPlayerId]) {
                    const playerSlot = room.players[clientRejoiningPlayerId];
                    if (playerSlot.socketId && playerSlot.socketId !== socket.id) {
                         console.log(`[SocketIO] Game ${gameId}: Player slot ${clientRejoiningPlayerId} already active with socket ${playerSlot.socketId}. Denying ${socket.id}.`);
                         socket.emit('error-event', { message: `Player slot ${clientRejoiningPlayerId} already active.`});
                         socket.leave(gameId); return;
                    }
                    assignedPlayerId = clientRejoiningPlayerId;
                    socket.playerId = clientRejoiningPlayerId; // Critical: Assign to current socket
                    console.log(`[SocketIO] Game ${gameId}: Player ${assignedPlayerId} (${socket.id}) rejoining. Updating socket ID.`);
                    updateOps.$set[`players.${assignedPlayerId}.socketId`] = socket.id;
                    // Rejoining player might need their ready status re-evaluated based on game state
                     if (room.status !== 'IN_PROGRESS' && room.status !== 'GAME_OVER') {
                        updateOps.$set[`players.${assignedPlayerId}.isReady`] = playerSlot.isReady || false;
                        updateOps.$set[`players.${assignedPlayerId}.hasSetSecret`] = playerSlot.hasSetSecret || false;
                    }
                    needsDBUpdate = true;
                } else { 
                    // Find an available slot for a new player
                    for (let i = 1; i <= room.playerCount; i++) {
                        const potentialPlayerId = `player${i}`;
                        if (!room.players[potentialPlayerId] || !room.players[potentialPlayerId].socketId) {
                            assignedPlayerId = potentialPlayerId;
                            break; 
                        }
                    }

                    if (!assignedPlayerId) { // All slots are associated with an active socketId
                        socket.emit('error-event', { message: 'Game room is full.' });
                        console.log(`[SocketIO] Game ${gameId}: Room full. Cannot add ${socket.id}. Active players:`, Object.keys(room.players).filter(pId => room.players[pId]?.socketId));
                        socket.leave(gameId); 
                        return;
                    }
                    
                    socket.playerId = assignedPlayerId; // Critical: Assign to current socket
                    console.log(`[SocketIO] Game ${gameId}: New player ${assignedPlayerId} (${socket.id}) joining.`);
                    const newPlayerData: PlayerData = { socketId: socket.id, guessesMade: [], guessesAgainst: [], secret: [], hasSetSecret: false, isReady: false };
                    updateOps.$set[`players.${assignedPlayerId}`] = newPlayerData;
                    needsDBUpdate = true;
                }
            }
            
            if (!socket.playerId) { 
                console.error(`[SocketIO] CRITICAL: Socket ${socket.id} has no playerId for game ${gameId}. AssignedPlayerId was: ${assignedPlayerId}.`);
                socket.emit('error-event', { message: 'Internal server error: Player ID not finalized.'});
                socket.leave(gameId); return;
            }
            
            // Apply DB updates if any were prepared
            if (needsDBUpdate && Object.keys(updateOps.$set).length > 0) {
                const roomAfterPlayerUpdate = await updateGameRoom(gameId, updateOps);
                if (!roomAfterPlayerUpdate) {
                    socket.emit('error-event', { message: 'Failed to update player in game room.' });
                    socket.leave(gameId); return;
                }
                room = roomAfterPlayerUpdate; 
            }
            
            if (!room) { // Should not happen if createGameRoom or updateGameRoom succeeded
                 console.error(`[SocketIO] CRITICAL: Room ${gameId} is null before 'player-assigned' emit for socket ${socket.id}.`);
                 socket.emit('error-event', { message: 'Internal server error: Game data lost.'});
                 return;
            }

            socket.emit('player-assigned', { playerId: socket.playerId, gameId });
            
            // Update room status based on current player count and readiness
            const activePlayersNow = room.players ? Object.values(room.players).filter(p => p.socketId) : [];
            let newStatusForRoom: MultiplayerGameStatus = room.status;

            if (activePlayersNow.length === room.playerCount && room.status === 'WAITING_FOR_PLAYERS') {
              newStatusForRoom = 'WAITING_FOR_READY';
              console.log(`[SocketIO] Game ${gameId}: All ${room.playerCount} players joined. Status now WAITING_FOR_READY.`);
            } else if (activePlayersNow.length < room.playerCount && (room.status === 'WAITING_FOR_READY' || room.status === 'READY_TO_START')) {
              newStatusForRoom = 'WAITING_FOR_PLAYERS'; // Not enough players anymore
              console.log(`[SocketIO] Game ${gameId}: Player count dropped. Status now WAITING_FOR_PLAYERS.`);
            }
            // Further check for READY_TO_START is handled in 'send-secret'

            if (newStatusForRoom !== room.status) {
              const statusUpdatePayload = { $set: { status: newStatusForRoom } };
              const roomAfterStatusUpdate = await updateGameRoom(gameId, statusUpdatePayload);
              if (roomAfterStatusUpdate) room = roomAfterStatusUpdate; 
              else console.warn(`[SocketIO] Game ${gameId}: Failed to update status to ${newStatusForRoom}.`);
            }
            
            if (!room) return; // Guard against room becoming null
            io.to(gameId).emit('game-state-update', room); 
        });

        socket.on('send-secret', async (data: { gameId: string; playerId: string; secret: string[] }) => {
          if (!db) {
              socket.emit('error-event', { message: 'DB connection not available for send-secret.' });
              return;
          }
          const { gameId, secret } = data;
          const clientProvidedPlayerId = data.playerId; 
          const serverAssignedPlayerId = socket.playerId; 

          if (!serverAssignedPlayerId) {
            console.error(`[SocketIO] Critical: Socket ${socket.id} has no serverAssignedPlayerId (send-secret) for game ${gameId}. Client provided: ${clientProvidedPlayerId}`);
            socket.emit('error-event', { message: 'Player ID not properly assigned to your connection.' });
            return;
          }
          if (clientProvidedPlayerId !== serverAssignedPlayerId) {
            console.error(`[SocketIO] Security Alert: Client ${socket.id} (server: ${serverAssignedPlayerId}) tried to send secret as ${clientProvidedPlayerId} in game ${gameId}. Denying.`);
            socket.emit('error-event', { message: `Player ID mismatch. Cannot set secret.` });
            return;
          }
          
          const playerId = serverAssignedPlayerId;
          console.log(`[SocketIO] Socket ${socket.id} (Player ${playerId}) attempting to set secret & ready for game: ${gameId}.`);

          let room = await getGameRoom(gameId);
          if (!room || !room.players || !room.players[playerId]) { 
            socket.emit('error-event', { message: `Game or player ${playerId} not found.` }); return;
          }
          if (room.status !== 'WAITING_FOR_READY' && room.status !== 'READY_TO_START' ) { // Allow re-setting if already ready to start but not started
            socket.emit('error-event', { message: `Cannot set secret. Game Status: ${room.status}` }); return;
          }

          const secretUpdateOps: any = {
                $set: {
                    [`players.${playerId}.secret`]: secret,
                    [`players.${playerId}.hasSetSecret`]: true,
                    [`players.${playerId}.isReady`]: true,
                }
            };
          
          let roomAfterSecretSet = await updateGameRoom(gameId, secretUpdateOps);
          if (!roomAfterSecretSet) {
             socket.emit('error-event', { message: 'Failed to set secret.' }); return;
          }
          room = roomAfterSecretSet; 
          
          const activePlayers = room.players ? Object.values(room.players).filter(p => p.socketId) : [];
          const allActivePlayersReady = activePlayers.length === room.playerCount && activePlayers.every(p => p.isReady && p.hasSetSecret);

          if (allActivePlayersReady && room.status === 'WAITING_FOR_READY') {
            const statusUpdate = { $set: { status: 'READY_TO_START' as MultiplayerGameStatus }};
            const roomNowReadyToStart = await updateGameRoom(gameId, statusUpdate);
            if (roomNowReadyToStart) room = roomNowReadyToStart;
            else console.warn(`[SocketIO] Game ${gameId}: Failed to update status to READY_TO_START.`);
          }
          
          if (!room) { console.error(`[SocketIO] Room ${gameId} became null after secret set.`); return; }
          io.to(gameId).emit('game-state-update', room);
        });

        socket.on('request-start-game', async (data: { gameId: string }) => {
            if (!db) { socket.emit('error-event', { message: 'DB unavailable.'}); return; }

            const { gameId } = data;
            const playerId = socket.playerId; // Host initiating start

            if (playerId !== "player1") { // Only player1 can start
                socket.emit('error-event', {message: "Only player1 (host) can start the game."}); return;
            }

            let room = await getGameRoom(gameId);
            if (!room) { socket.emit('error-event', {message: "Game not found."}); return; }

            if (room.status !== 'READY_TO_START') {
                socket.emit('error-event', {message: `Game not ready to start. Status: ${room.status}`}); return;
            }
            
            if (!room.players) { socket.emit('error-event', {message: 'Player data missing.'}); return;}

            const activePlayers = Object.values(room.players).filter(p => p.socketId);
            const allStillReady = activePlayers.length === room.playerCount && activePlayers.every(p => p.isReady && p.hasSetSecret);

            if (!allStillReady) {
                socket.emit('error-event', {message: "Not all players are ready or have set secrets."});
                // Optionally revert status if it was READY_TO_START but someone became unready
                if (room.status === 'READY_TO_START') {
                    const statusRevert = await updateGameRoom(gameId, {$set: {status: 'WAITING_FOR_READY'}});
                    if (statusRevert) {
                        room = statusRevert; 
                        io.to(gameId).emit('game-state-update', room);
                    }
                }
                return;
            }
            
            const playerIds = Object.keys(room.players).filter(pId => room.players![pId].socketId).sort(); 
            if (playerIds.length !== room.playerCount) {
                socket.emit('error-event', {message: "Active player count mismatch. Cannot start."}); return;
            }

            let targetMap: { [playerId: string]: string } = {};
            if (room.playerCount === 2 && playerIds.length === 2) {
               targetMap = { [playerIds[0]]: playerIds[1], [playerIds[1]]: playerIds[0] };
            } else if (room.playerCount > 2 && playerIds.length === room.playerCount) { 
                for(let i=0; i < playerIds.length; i++) {
                    targetMap[playerIds[i]] = playerIds[(i + 1) % playerIds.length];
                }
            } else {
                 socket.emit('error-event', {message: "Cannot determine targets with current player setup."}); return;
            }

            const startingTurn = playerIds[0]; // Player1 (host) always starts, or pick randomly: playerIds[Math.floor(Math.random() * playerIds.length)];

            const gameStartUpdatePayload = {
                $set: {
                    status: 'IN_PROGRESS' as MultiplayerGameStatus,
                    targetMap,
                    turn: startingTurn
                }
            };
            const gameStartedRoom = await updateGameRoom(gameId, gameStartUpdatePayload);
            if (!gameStartedRoom) {
                socket.emit('error-event', { message: 'Failed to update game to start.'}); return;
            }
            room = gameStartedRoom; 
            console.log(`[SocketIO] Game ${gameId} starting by host ${playerId}. Turn: ${room.turn}, TargetMap:`, room.targetMap);
            
            if (!room.turn || !room.targetMap) {
                console.error(`[SocketIO] CRITICAL: Game ${gameId} started but turn or targetMap is undefined.`);
                socket.emit('error-event', {message: 'Internal error on game start data.'});
                return;
            }
            io.to(gameId).emit('game-start', { gameId, startingPlayer: room.turn, targetMap: room.targetMap });
            io.to(gameId).emit('game-state-update', room); // Send final state after starting
        });


        socket.on('make-guess', async (data: { gameId: string; playerId: string; guess: string[] }) => {
          if (!db) { socket.emit('error-event', { message: 'DB unavailable.'}); return; }

          const { gameId, guess: guessArray } = data;
          const clientProvidedPlayerId = data.playerId; 
          const serverAssignedPlayerId = socket.playerId; 

          if (!serverAssignedPlayerId) { 
            socket.emit('error-event', { message: 'Player ID not assigned for this connection.' }); return; 
          }
          if (clientProvidedPlayerId !== serverAssignedPlayerId) { 
            socket.emit('error-event', { message: `Player ID mismatch. Cannot make guess.` }); return; 
          }
          
          const playerId = serverAssignedPlayerId;
          console.log(`[SocketIO] Socket ${socket.id} (Player ${playerId}) making guess for game: ${gameId}.`);

          let room = await getGameRoom(gameId);
          if (!room) { socket.emit('error-event', { message: 'Game not found.' }); return; }
          if (room.status !== 'IN_PROGRESS') { socket.emit('error-event', { message: 'Game not in progress.' }); return; }
          if (room.turn !== playerId) { socket.emit('error-event', { message: 'Not your turn.' }); return; }
          if (!room.players || !room.targetMap || !room.players[playerId] || !room.targetMap[playerId]) { 
             socket.emit('error-event', { message: 'Internal server error: Game data incomplete for guess.'}); return;
          }

          const targetPlayerId = room.targetMap[playerId];
          const targetPlayer = room.players[targetPlayerId];

          if (!targetPlayer || !targetPlayer.secret || targetPlayer.secret.length === 0) {
            socket.emit('error-event', { message: 'Target player or their secret not found/set.' }); return;
          }

          const targetSecret = targetPlayer.secret;
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
            if (!room.players) { socket.emit('error-event', { message: 'Player data missing for turn switch.' }); return; }
            const playerIds = Object.keys(room.players).filter(pId => room.players![pId].socketId).sort(); 
            if (playerIds.length === 0) { socket.emit('error-event', {message: 'No active players found for turn switch.'}); return; }
            
            const currentPlayerIndex = playerIds.indexOf(playerId);
            const nextPlayerId = playerIds[(currentPlayerIndex + 1) % playerIds.length];
            if (!updateFields.$set) updateFields.$set = {};
            updateFields.$set.turn = nextPlayerId;
          }

          const updatedRoomAfterGuess = await updateGameRoom(gameId, updateFields);
          if (!updatedRoomAfterGuess) { socket.emit('error-event', { message: 'Failed to update game after guess.'}); return; }
          room = updatedRoomAfterGuess; 

          io.to(gameId).emit('guess-feedback', { gameId, guessingPlayerId: playerId, targetPlayerId, guess: guessObject });
          if (room.status === 'GAME_OVER') {
            if (!room.winner) { console.error(`[SocketIO] CRITICAL: Game ${gameId} is over but winner is undefined.`); return; }
            io.to(gameId).emit('game-over', { gameId, winner: room.winner });
          } else if (room.turn) { 
            io.to(gameId).emit('turn-update', { gameId, nextPlayerId: room.turn });
          }
          
          if (!room) { console.error(`[SocketIO] Room ${gameId} became null after guess.`); return; }
          io.to(gameId).emit('game-state-update', room);
        });
      });
    } else {
      // console.log("[SocketIO] Socket.IO server already running.");
    }
    res.end(); // Important: End the response for API route
}
      