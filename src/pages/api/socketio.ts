
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
    console.log(`MongoDB: DB setup complete. Ensure unique index on 'gameId' in '${COLLECTION_NAME}' exists for reliability, and optionally a TTL index on 'createdAt'.`);
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

async function createGameRoom(gameId: string, newRoomData: Omit<GameRoom, 'gameId' | '_id'>): Promise<GameRoom | null> {
    await dbConnectionPromise;
    if (!db) {
      console.warn(`MongoDB: (createGameRoom) db instance is null for game ${gameId}. Cannot create.`);
      return null;
    }
    try {
      const fullRoomData: GameRoom = { ...newRoomData, gameId, createdAt: new Date() };
      const result = await db.collection<GameRoom>(COLLECTION_NAME).insertOne(fullRoomData);
      if (result.insertedId) {
        console.log(`MongoDB: Game room ${gameId} created successfully with initial data:`, JSON.stringify({...fullRoomData, _id: result.insertedId}));
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { _id, ...roomToReturn } = fullRoomData; // Remove _id for consistency with GameRoom type
        return roomToReturn as GameRoom;
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
    upsert: false, 
  };

  try {
    const updatedDoc: WithId<GameRoom> | null = await db.collection<GameRoom>(COLLECTION_NAME).findOneAndUpdate(filter, updateOperators, options);
    
    if (updatedDoc) {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { _id, ...roomData } = updatedDoc; 
        return roomData as GameRoom;
    } else {
      console.warn(`MongoDB: findOneAndUpdate for ${gameId} did not return a document. Filter: ${JSON.stringify(filter)}, Update: ${JSON.stringify(updateOperators)}`);
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
            if (!room.players || !room.players[playerId]) {
                console.warn(`MongoDB: (disconnect) Player ${playerId} not found in room ${gameId} or room.players undefined. Room state:`, room);
                if (room) io.to(gameId).emit('game-state-update', room); 
                return;
            }

            const updateOps: any = { 
                $set: { 
                    [`players.${playerId}.socketId`]: undefined, // Mark as disconnected
                    [`players.${playerId}.isReady`]: false, // Player is no longer ready
                } 
            };
            
            let updatedRoom = await updateGameRoom(gameId, updateOps);
            if (!updatedRoom) {
                console.warn(`MongoDB: (disconnect) Failed to update room for player ${playerId} in game ${gameId}. Fetching latest.`);
                updatedRoom = await getGameRoom(gameId); // Try to get the most current state
                if (!updatedRoom) {
                    console.error(`MongoDB: (disconnect) Failed to re-fetch room ${gameId} after update failure.`);
                    return;
                }
            }
            room = updatedRoom;

            io.to(gameId).emit('player-disconnected', { gameId, playerId, message: `${playerId} has disconnected.` });
            
            const activePlayersWithSocketId = room.players ? Object.values(room.players).filter(p => p.socketId) : [];

            if (room.status === 'IN_PROGRESS' && activePlayersWithSocketId.length < room.playerCount && room.playerCount === 2) { // Simplified for 2 players
                const winnerId = activePlayersWithSocketId[0] ? Object.keys(room.players).find(pId => room.players![pId]?.socketId === activePlayersWithSocketId[0].socketId) : undefined;
                if (winnerId) {
                    const gameOverUpdate = { $set: { status: 'GAME_OVER' as MultiplayerGameStatus, winner: winnerId, turn: undefined }};
                    const finalRoomStateForDisconnect = await updateGameRoom(gameId, gameOverUpdate);
                    if (finalRoomStateForDisconnect) {
                        room = finalRoomStateForDisconnect;
                        io.to(gameId).emit('game-over', { gameId, winner: winnerId });
                    }
                }
            } else if (room.status === 'READY_TO_START' || room.status === 'WAITING_FOR_READY') {
                // If a player disconnects before game starts, revert to WAITING_FOR_READY or WAITING_FOR_PLAYERS
                 const stillFull = activePlayersWithSocketId.length === room.playerCount;
                 const newStatus = stillFull ? 'WAITING_FOR_READY' : 'WAITING_FOR_PLAYERS';
                 if (room.status !== newStatus) {
                    const statusUpdate = { $set: { status: newStatus }};
                    const roomAfterStatusUpdate = await updateGameRoom(gameId, statusUpdate);
                    if (roomAfterStatusUpdate) room = roomAfterStatusUpdate;
                 }
            }
            
            if (room) io.to(gameId).emit('game-state-update', room); 
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
            const clientRejoiningPlayerId = data.rejoiningPlayerId; 

            console.log(`Socket ${socket.id} attempting to join game: ${gameId} (PlayerCount: ${playerCountString}) - DB Connection Confirmed.`);

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
                assignedPlayerId = "player1"; // Creator is always player1
                socket.playerId = assignedPlayerId; // Assign to this socket immediately
                
                const initialPlayers: { [playerId: string]: PlayerData } = {
                    [assignedPlayerId]: { socketId: socket.id, guessesMade: [], guessesAgainst: [], secret: [], hasSetSecret: false, isReady: false }
                };
                const newRoomDataForCreation: Omit<GameRoom, 'gameId' | '_id'> = { 
                  playerCount: numPlayerCount,
                  players: initialPlayers,
                  status: 'WAITING_FOR_PLAYERS',
                  targetMap: {},
                  turn: undefined,
                  winner: undefined,
                  createdAt: new Date()
                };

                const createdRoom = await createGameRoom(gameId, newRoomDataForCreation);

                if (createdRoom) {
                    room = createdRoom;
                    playerCreatedRoom = true;
                    console.log(`Game room ${gameId} created successfully by player1 (${socket.id}).`);
                } else { // Creation failed (likely duplicate key due to race)
                    console.warn(`MongoDB: (join-game) createGameRoom for ${gameId} by ${socket.id} returned null. Re-fetching.`);
                    room = await getGameRoom(gameId); 
                    if (!room) {
                        socket.emit('error-event', { message: 'Failed to create or find game room after creation attempt.' });
                        console.error(`Critical: (join-game) Failed to get room ${gameId} even after create attempt and re-fetch by ${socket.id}.`);
                        return; 
                    }
                    console.log(`MongoDB: (join-game) Successfully re-fetched room ${gameId} for ${socket.id}. Will now proceed to join normally.`);
                }
            }
            
            if (!room) {
                socket.emit('error-event', { message: 'Internal server error: Room unavailable.'});
                console.error(`Critical: Room ${gameId} is null before player processing for socket ${socket.id}`);
                return;
            }

            socket.join(gameId); 
            socket.gameId = gameId; 

            if (!playerCreatedRoom) { // Room existed or was created by another client, so this client is joining
                if (clientRejoiningPlayerId && room.players && room.players[clientRejoiningPlayerId]) { 
                    assignedPlayerId = clientRejoiningPlayerId;
                    socket.playerId = clientRejoiningPlayerId;
                    console.log(`Player ${assignedPlayerId} (${socket.id}) is rejoining game ${gameId}. Updating socket ID.`);
                    const updateOps = { $set: { [`players.${assignedPlayerId}.socketId`]: socket.id, [`players.${assignedPlayerId}.isReady`]: room.players[assignedPlayerId].hasSetSecret } }; // Keep ready status if secret was set
                    const updatedRoomSockId = await updateGameRoom(gameId, updateOps);
                    if (updatedRoomSockId) room = updatedRoomSockId;
                    else { 
                        socket.emit('error-event', { message: `Failed to update session for rejoining player.` });
                        socket.disconnect(); return;
                    }
                } else { // Not a valid rejoining player or slot taken; assign new if possible
                    if (!room.players) room.players = {}; // Initialize if somehow missing
                    const currentPlayersWithSocketId = Object.values(room.players).filter(p => p.socketId);
                    
                    if (currentPlayersWithSocketId.length >= room.playerCount) {
                        const existingPlayerIds = Object.keys(room.players).filter(pId => room.players[pId]?.socketId);
                        socket.emit('error-event', { message: 'Game room is full.' });
                        console.log(`Game room ${gameId} is full. Cannot add new player ${socket.id}. Players with socketId:`, existingPlayerIds);
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
                        socket.leave(gameId); return;
                    }
                    
                    socket.playerId = assignedPlayerId; 
                    console.log(`New player ${assignedPlayerId} (${socket.id}) joining game ${gameId}.`);
                    const newPlayerData: PlayerData = { socketId: socket.id, guessesMade: [], guessesAgainst: [], secret: [], hasSetSecret: false, isReady: false };
                    const playerAddUpdate = { $set: { [`players.${assignedPlayerId}`]: newPlayerData } };
                    const roomAfterPlayerAdd = await updateGameRoom(gameId, playerAddUpdate);
                    if (!roomAfterPlayerAdd) {
                        socket.emit('error-event', { message: 'Failed to add new player to game room.' });
                        socket.leave(gameId); return;
                    }
                    room = roomAfterPlayerAdd; 
                }
            }

            if (!socket.playerId) { 
                console.error(`CRITICAL: Socket ${socket.id} has no playerId before emitting player-assigned for game ${gameId}. AssignedPlayerId was: ${assignedPlayerId}`);
                socket.emit('error-event', { message: 'Internal server error: Player ID not finalized.'});
                socket.leave(gameId); return;
            }
            if (!room) {
                console.error(`CRITICAL: Room object is null before emitting player-assigned for game ${gameId}, socket ${socket.id}`);
                socket.emit('error-event', {message: 'Internal server error: Game data lost before assignment.'}); return;
            }

            socket.emit('player-assigned', { playerId: socket.playerId, gameId });
            
            // Determine new game status based on player count
            const activePlayersNow = room.players ? Object.values(room.players).filter(p => p.socketId) : [];
            let newStatusForRoom: MultiplayerGameStatus = room.status;

            if (activePlayersNow.length === room.playerCount && room.status === 'WAITING_FOR_PLAYERS') {
              newStatusForRoom = 'WAITING_FOR_READY';
              console.log(`All ${room.playerCount} players joined game ${gameId}. Status now WAITING_FOR_READY.`);
              const statusUpdate = { $set: {status: newStatusForRoom} };
              const roomAfterStatusUpdate = await updateGameRoom(gameId, statusUpdate);
              if (roomAfterStatusUpdate) room = roomAfterStatusUpdate; 
              else console.warn(`Failed to update game ${gameId} status to ${newStatusForRoom}.`);
            }
            
            if (room) io.to(gameId).emit('game-state-update', room); 
        });

        socket.on('send-secret', async (data: { gameId: string; playerId: string; secret: string[] }) => {
          await dbConnectionPromise;
          if (!db) {
              socket.emit('error-event', { message: 'Database connection not available for send-secret.' });
              return;
          }

          const { gameId, secret } = data;
          const clientProvidedPlayerId = data.playerId; 
          const serverAssignedPlayerId = socket.playerId; 

          if (!serverAssignedPlayerId) {
            socket.emit('error-event', { message: 'Player ID not properly assigned to your connection.' });
            return;
          }
          if (clientProvidedPlayerId !== serverAssignedPlayerId) {
            socket.emit('error-event', { message: `Player ID mismatch. Cannot set secret for another player.` });
            return;
          }
          
          const playerId = serverAssignedPlayerId;
          console.log(`Socket ${socket.id} (Player ${playerId}) attempting to set secret & ready for game: ${gameId}.`);

          let room = await getGameRoom(gameId);
          if (!room || !room.players || !room.players[playerId]) { 
            socket.emit('error-event', { message: `Game or player not found.` }); return;
          }
          if (room.status !== 'WAITING_FOR_READY' && room.status !== 'READY_TO_START' /* Allow re-setting if already ready to start but game not started */) {
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
          
          // Check if all active players are now ready
          const activePlayers = room.players ? Object.values(room.players).filter(p => p.socketId) : [];
          const allActivePlayersReady = activePlayers.length === room.playerCount && activePlayers.every(p => p.isReady);

          if (allActivePlayersReady && room.status === 'WAITING_FOR_READY') {
            const statusUpdate = { $set: { status: 'READY_TO_START' as MultiplayerGameStatus }};
            const roomNowReadyToStart = await updateGameRoom(gameId, statusUpdate);
            if (roomNowReadyToStart) room = roomNowReadyToStart;
            else console.warn(`Failed to update game ${gameId} status to READY_TO_START.`);
          }
          
          if (!room) { console.error(`Room ${gameId} became null after secret set.`); return; }
          io.to(gameId).emit('game-state-update', room);
        });

        socket.on('request-start-game', async (data: { gameId: string }) => {
            await dbConnectionPromise;
            if (!db) { socket.emit('error-event', { message: 'DB unavailable.'}); return; }

            const { gameId } = data;
            const playerId = socket.playerId;

            if (playerId !== "player1") {
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
                // Optionally, revert status if someone became un-ready
                if (room.status === 'READY_TO_START') {
                    const statusRevert = await updateGameRoom(gameId, {$set: {status: 'WAITING_FOR_READY'}});
                    if (statusRevert) io.to(gameId).emit('game-state-update', statusRevert);
                }
                return;
            }
            
            const playerIds = Object.keys(room.players).filter(pId => room.players![pId].socketId).sort(); 
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

            const startingTurn = playerIds[0]; // Player1 starts, or make it random: playerIds[Math.floor(Math.random() * playerIds.length)];

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
            console.log(`Game ${gameId} starting by host ${playerId}. Turn: ${room.turn}, TargetMap:`, room.targetMap);
            io.to(gameId).emit('game-start', { gameId, startingPlayer: room.turn!, targetMap: room.targetMap! });
            if (!room) { console.error(`Room ${gameId} became null after game start.`); return; }
            io.to(gameId).emit('game-state-update', room);
        });


        socket.on('make-guess', async (data: { gameId: string; playerId: string; guess: string[] }) => {
          await dbConnectionPromise;
          if (!db) { socket.emit('error-event', { message: 'DB unavailable.'}); return; }

          const { gameId, guess: guessArray } = data;
          const clientProvidedPlayerId = data.playerId; 
          const serverAssignedPlayerId = socket.playerId; 

          if (!serverAssignedPlayerId) { socket.emit('error-event', { message: 'Player ID not assigned.' }); return; }
          if (clientProvidedPlayerId !== serverAssignedPlayerId) { socket.emit('error-event', { message: `Player ID mismatch.` }); return; }
          
          const playerId = serverAssignedPlayerId;
          console.log(`Socket ${socket.id} (Player ${playerId}) making guess for game: ${gameId}.`);

          let room = await getGameRoom(gameId);
          if (!room) { socket.emit('error-event', { message: 'Game not found.' }); return; }
          if (room.status !== 'IN_PROGRESS') { socket.emit('error-event', { message: 'Game not in progress.' }); return; }
          if (room.turn !== playerId) { socket.emit('error-event', { message: 'Not your turn.' }); return; }
          if (!room.players || !room.targetMap || !room.players[playerId] || !room.targetMap[playerId]) { 
             socket.emit('error-event', { message: 'Internal server error: Game data incomplete for guess.'}); return;
          }

          const targetPlayerId = room.targetMap[playerId];
          if (!targetPlayerId || !room.players[targetPlayerId]?.secret || room.players[targetPlayerId].secret?.length === 0) {
            socket.emit('error-event', { message: 'Target player or their secret not found/set.' }); return;
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
            if (!room.players) { socket.emit('error-event', { message: 'Player data missing for turn switch.' }); return; }
            const playerIds = Object.keys(room.players).filter(pId => room.players![pId].socketId).sort(); 
            if (playerIds.length === 0) { socket.emit('error-event', {message: 'No active players found for turn switch.'}); return; }
            
            const currentPlayerIndex = playerIds.indexOf(playerId);
            if (currentPlayerIndex === -1) { 
                updateFields.$set = { turn: playerIds[0] }; 
            } else {
                const nextPlayerId = playerIds[(currentPlayerIndex + 1) % playerIds.length];
                updateFields.$set = { turn: nextPlayerId };
            }
          }

          const updatedRoomAfterGuess = await updateGameRoom(gameId, updateFields);
          if (!updatedRoomAfterGuess) { socket.emit('error-event', { message: 'Failed to update game after guess.'}); return; }
          room = updatedRoomAfterGuess; 

          io.to(gameId).emit('guess-feedback', { gameId, guessingPlayerId: playerId, targetPlayerId, guess: guessObject });
          if (room.status === 'GAME_OVER') {
            io.to(gameId).emit('game-over', { gameId, winner: room.winner! });
          } else if (room.turn) { // Ensure turn is defined before emitting
            io.to(gameId).emit('turn-update', { gameId, nextPlayerId: room.turn });
          }
          
          if (!room) { console.error(`Room ${gameId} became null after guess.`); return; }
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
    
