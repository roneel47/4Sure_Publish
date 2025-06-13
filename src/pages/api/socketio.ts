
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
const DATABASE_NAME = "4sureDB";
const COLLECTION_NAME = "gameRooms";
let db: MongoDb | null = null;

// Initialize MongoDB connection
(async () => {
  if (!MONGODB_URI) {
    console.warn('MONGODB_URI not found in environment variables. Database operations will not be available.');
    return;
  }
  try {
    console.log("Attempting to connect to MongoDB...");
    const client = new MongoClient(MONGODB_URI);
    await client.connect();
    console.log("Successfully connected to MongoDB.");
    
    db = client.db(DATABASE_NAME);
    console.log(`MongoDB: Targeting database: '${DATABASE_NAME}'.`);

    // Ensure the collection exists (MongoDB creates it on first write if not present)
    // and log that we are targeting it.
    // const gameRoomsCollection = db.collection<GameRoom>(COLLECTION_NAME);
    console.log(`MongoDB: Targeting collection: '${COLLECTION_NAME}' in database '${DATABASE_NAME}'. DB setup complete.`);
    // Manual index creation is recommended: db.gameRooms.createIndex( { "gameId": 1 }, { unique: true } )

  } catch (error) {
    console.error("Error connecting to MongoDB:", error);
    db = null;
  }
})();


const getPlayerCountNumber = (playerCountString: string): number => {
  if (playerCountString === 'duo') return 2;
  if (playerCountString === 'trio') return 3;
  if (playerCountString === 'quads') return 4;
  return 0; 
};

async function getGameRoom(gameId: string): Promise<GameRoom | null> {
  if (!db) {
    console.warn(`MongoDB: db instance not available (getGameRoom for ${gameId}).`);
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
  if (!db) {
    console.warn(`MongoDB: db instance not available (updateGameRoom for ${gameId}).`);
    return null;
  }
  
  const filter = { gameId: gameId };
  let mongoUpdateOps: any = {};

  // Default structure for a new room on insert
  const defaultsOnInsert: Partial<GameRoom> = {
    gameId: gameId, 
    playerCount: (operationData as GameRoom).playerCount !== undefined ? (operationData as GameRoom).playerCount : 0,
    players: {},
    status: 'WAITING_FOR_PLAYERS',
    secretsSetCount: 0,
    targetMap: {},
    turn: undefined, // Explicitly undefined initially
    winner: undefined, // Explicitly undefined initially
  };

  if (Object.keys(operationData).some(key => key.startsWith('$'))) { // If operationData contains MongoDB operators
    mongoUpdateOps = {...operationData}; // Use operators as is
    // Ensure $setOnInsert is comprehensive for new documents
    mongoUpdateOps.$setOnInsert = { ...defaultsOnInsert, ...(mongoUpdateOps.$setOnInsert || {}) };
    // Remove gameId from $set to avoid conflict if it's there
    if (mongoUpdateOps.$set && mongoUpdateOps.$set.gameId) {
      delete mongoUpdateOps.$set.gameId;
    }
  } else { // If operationData is a plain object of fields to set
    const { gameId: opGameId, ...fieldsToSet } = operationData; // Exclude gameId from $set
    
    mongoUpdateOps.$set = fieldsToSet;
    mongoUpdateOps.$setOnInsert = { ...defaultsOnInsert, ...operationData }; // Merge all fields for insert
  }
  
  // Ensure gameId is part of $setOnInsert but not $set (unless $set is the only operation, which is rare for upserts)
  mongoUpdateOps.$setOnInsert.gameId = gameId;
  if (mongoUpdateOps.$set && Object.keys(mongoUpdateOps.$set).length === 0) {
      delete mongoUpdateOps.$set;
  }


  try {
    const options: UpdateOptions = { upsert: true };
    
    const result = await db.collection<GameRoom>(COLLECTION_NAME).updateOne(
      filter,
      mongoUpdateOps,
      options
    );
    
    console.log(`MongoDB: UpdateOne operation for game room ${gameId}. Matched: ${result.matchedCount}, Modified: ${result.modifiedCount}, UpsertedId: ${result.upsertedId}`);

    if (result.acknowledged) {
      // After update/upsert, fetch the potentially modified/created document to return its state
      return await getGameRoom(gameId);
    }
    
    console.warn(`MongoDB: updateOne for game ${gameId} was not acknowledged or failed. Result:`, result);
    return null;

  } catch (error: any) {
    console.error(`MongoDB: Error in updateGameRoom for ${gameId}. Filter: ${JSON.stringify(filter)}, Operation: ${JSON.stringify(mongoUpdateOps)}`, error);
    if (error.code === 11000 || error.code === 40) { // 11000 is duplicate key, 40 can be gameId conflict
        console.error("Conflict error likely due to 'gameId' unique index or field update. Check filter and operationData:", {filter, mongoUpdateOps});
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
      console.log('Socket.IO server already running.');
    } else {
      console.log('Initializing Socket.IO server...');
      const io = new SocketIOServer(res.socket.server, {
        path: '/api/socketio_c', // Ensure this path is matched by client
        addTrailingSlash: false,
      });
      res.socket.server.io = io;

      io.on('connection', (socket: CustomSocket) => {
        console.log('Socket connected:', socket.id);

        socket.on('disconnect', async () => {
          const gameId = socket.gameId;
          const playerId = socket.playerId;
          console.log(`Socket disconnected: ${socket.id}, Player: ${playerId}, Game: ${gameId}`);

          if (gameId && playerId && db) { 
            try {
              let room = await getGameRoom(gameId);
              if (room && room.players[playerId]) {
                // Basic notification for now. More complex logic could be added here.
                io.to(gameId).emit('player-disconnected', { 
                  gameId, 
                  playerId,
                  message: `${playerId} has disconnected.` 
                });
                
                // Simplified handling: if a player in a 2-player in-progress game disconnects, the other wins.
                if (room.playerCount === 2 && room.status === 'IN_PROGRESS') {
                    const remainingPlayerIds = Object.keys(room.players).filter(pId => pId !== playerId && room!.players[pId].socketId !== socket.id);
                    if (remainingPlayerIds.length === 1) {
                        const winnerId = remainingPlayerIds[0];
                        if (room.players[winnerId]) { // Check if winner still exists in room data
                             const gameOverUpdate = { status: 'GAME_OVER' as MultiplayerGameStatus, winner: winnerId, turn: undefined };
                             const updatedRoom = await updateGameRoom(gameId, { $set: gameOverUpdate });
                             if (updatedRoom) {
                                 io.to(gameId).emit('game-over', { gameId, winner: winnerId });
                                 io.to(gameId).emit('game-state-update', updatedRoom); // Send final state
                             }
                        }
                    }
                } else if (room.status !== 'GAME_OVER') { 
                    // For other cases or if you don't want to auto-end, just send an update
                    const currentRoomState = await getGameRoom(gameId); // Re-fetch
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
          if (!db) {
            socket.emit('error-event', { message: 'Database not connected. Please try again later.' });
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

            const newRoomData: Partial<GameRoom> = { // Using Partial as gameId will be in filter for updateGameRoom
              playerCount: numPlayerCount,
              players: initialPlayers,
              status: 'WAITING_FOR_PLAYERS', // Default status for a new room
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
            
            // Prepare payload for updating an existing room with a new or rejoining player
            const playerUpdatePayload: any = {
              $set: {
                [`players.${assignedPlayerId}`]: {
                  ...(room.players[assignedPlayerId] || playerObjectBase), // Retain existing data if player rejoining
                  socketId: socket.id // Always update socketId
                }
              }
            };
            // If player wasn't in room.players at all, make sure their base structure is set
            if (!room.players[assignedPlayerId]) {
                 playerUpdatePayload.$set[`players.${assignedPlayerId}`] = playerObjectBase;
            }


            const updatedRoomAfterPlayerJoin = await updateGameRoom(gameId, playerUpdatePayload);
            if (!updatedRoomAfterPlayerJoin) {
                socket.emit('error-event', { message: 'Failed to update game room with new/rejoining player.' });
                const currentRoomStateOnError = await getGameRoom(gameId); 
                if(currentRoomStateOnError) io.to(gameId).emit('game-state-update', currentRoomStateOnError);
                return;
            }
            room = updatedRoomAfterPlayerJoin;
          }
          
          // Ensure context is set on the socket
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
            io.to(gameId).emit('game-state-update', room);
          }
        });

        socket.on('send-secret', async (data: { gameId: string; playerId: string; secret: string[] }) => {
          const { gameId, playerId, secret } = data;
          if (!db) { socket.emit('error-event', { message: 'Database not connected.' }); return; }
          
          let room = await getGameRoom(gameId);

          if (!room || !room.players[playerId] || (room.status !== 'ALL_PLAYERS_JOINED' && room.status !== 'SETTING_SECRETS')) {
            socket.emit('error-event', { message: `Cannot set secret. Game Status: ${room?.status}, Player: ${playerId}` });
            return;
          }
          
          // Prevent setting secret if already set (idempotency)
          if (room.players[playerId].secret && room.players[playerId].secret!.length > 0) {
             console.log(`Player ${playerId} trying to set secret again for ${gameId}. Already set.`);
             io.to(gameId).emit('game-state-update', room); 
             return;
          }
          
          const setSecretUpdate: any = {
                $set: {
                    [`players.${playerId}.secret`]: secret,
                    status: 'SETTING_SECRETS' // Transition to this status when first secret is being set
                },
                $inc: { secretsSetCount: 1 }
            };
            
          const roomAfterSecretAttempt = await updateGameRoom(gameId, setSecretUpdate);

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
          io.to(gameId).emit('game-state-update', room); // Send updated state after secret set

          if (room.secretsSetCount === room.playerCount && (room.status === 'SETTING_SECRETS')) { // Check status SETTING_SECRETS
            console.log(`All secrets set for game ${gameId}. Starting game.`);
            
            const playerIds = Object.keys(room.players).sort(); 
            let targetMap: { [playerId: string]: string } = {};
            if (room.playerCount === 2) { 
               targetMap = { [playerIds[0]]: playerIds[1], [playerIds[1]]: playerIds[0] };
            } 
            // TODO: Add targetMap logic for Trio/Quads if implementing
            
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
            io.to(gameId).emit('game-state-update', room); // Send final state with game started
          }
        });
        
        socket.on('make-guess', async (data: { gameId: string; playerId: string; guess: string[] }) => {
          const { gameId, playerId, guess: guessArray } = data;
          if (!db) { socket.emit('error-event', { message: 'Database not connected.' }); return; }
          
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
              [`players.${targetPlayerId}.guessesAgainst`]: guessObject, // Also record on target
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
          
          // Emit guess feedback BEFORE game over or turn update for clarity on client
          io.to(gameId).emit('guess-feedback', { gameId, guessingPlayerId: playerId, targetPlayerId, guess: guessObject });

          if (room.status === 'GAME_OVER') {
            io.to(gameId).emit('game-over', { gameId, winner: room.winner! });
          } else {
            io.to(gameId).emit('turn-update', { gameId, nextPlayerId: room.turn! });
          }
          io.to(gameId).emit('game-state-update', room); // Send comprehensive state update
        });
      });
    }
    res.status(200).json({ message: 'Socket.IO server initialized or already running.' });
  } else {
    res.setHeader('Allow', ['POST']);
    res.status(405).end(`Method ${req.method} Not Allowed`);
  }
}
    
