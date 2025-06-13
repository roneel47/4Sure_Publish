
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
const DATABASE_NAME = "4sureDB"; // Explicitly using your DB name
const COLLECTION_NAME = "gameRooms";
let db: MongoDb | null = null;

// Promise to ensure DB connection is ready before operations
let resolveDbConnection: (value: MongoDb | PromiseLike<MongoDb>) => void;
let rejectDbConnection: (reason?: any) => void;
const dbConnectionPromise = new Promise<MongoDb>((resolve, reject) => {
  resolveDbConnection = resolve;
  rejectDbConnection = reject;
});

(async () => {
  if (!MONGODB_URI) {
    console.warn('MONGODB_URI not found in environment variables. Database operations will not be available.');
    rejectDbConnection(new Error('MONGODB_URI not found'));
    return;
  }
  try {
    console.log("Attempting to connect to MongoDB...");
    const client = new MongoClient(MONGODB_URI);
    await client.connect();
    console.log("Successfully connected to MongoDB.");
    
    db = client.db(DATABASE_NAME);
    console.log(`MongoDB: Targeting database: '${DATABASE_NAME}'.`);
    
    // You should create this index manually in Atlas for better control:
    // db.gameRooms.createIndex( { "gameId": 1 }, { unique: true } )
    // However, attempting here can be a fallback (ensure user has permissions)
    // try {
    //   await db.collection(COLLECTION_NAME).createIndex({ gameId: 1 }, { unique: true });
    //   console.log(`MongoDB: Ensured unique index on 'gameId' in '${COLLECTION_NAME}' collection in '${DATABASE_NAME}'.`);
    // } catch (indexError) {
    //   console.warn(`MongoDB: Could not ensure unique index on 'gameId' (it might already exist or permissions issue):`, indexError);
    // }
    console.log(`MongoDB: Using collection: '${COLLECTION_NAME}' in database '${DATABASE_NAME}'. DB setup complete.`);
    resolveDbConnection(db);
  } catch (error) {
    console.error("Error connecting to MongoDB:", error);
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
    await dbConnectionPromise; // Wait for DB connection
  } catch (connectionError) {
    console.error(`MongoDB connection error (getGameRoom for ${gameId}):`, connectionError);
    return null;
  }
  if (!db) {
    console.warn(`MongoDB: db instance is null even after connection attempt (getGameRoom for ${gameId}).`);
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
  try {
    await dbConnectionPromise; // Wait for DB connection
  } catch (connectionError) {
    console.error(`MongoDB connection error (updateGameRoom for ${gameId}):`, connectionError);
    return null;
  }
  if (!db) {
    console.warn(`MongoDB: db instance is null even after connection attempt (updateGameRoom for ${gameId}).`);
    return null;
  }
  
  const filter = { gameId: gameId };
  let mongoUpdateOps: any = {};

  const defaultsOnInsert: Partial<GameRoom> = {
    gameId: gameId,
    playerCount: (operationData as GameRoom).playerCount !== undefined ? (operationData as GameRoom).playerCount : 0,
    players: {},
    status: 'WAITING_FOR_PLAYERS',
    secretsSetCount: 0,
    targetMap: {},
    turn: undefined,
    winner: undefined,
  };

  if (Object.keys(operationData).some(key => key.startsWith('$'))) {
    mongoUpdateOps = {...operationData};
    mongoUpdateOps.$setOnInsert = { ...defaultsOnInsert, ...(mongoUpdateOps.$setOnInsert || {}) };
    if (mongoUpdateOps.$set && mongoUpdateOps.$set.gameId) {
      delete mongoUpdateOps.$set.gameId; 
    }
  } else {
    const { gameId: opGameId, ...fieldsToSet } = operationData;
    mongoUpdateOps.$set = fieldsToSet;
    // For a plain data update, $setOnInsert should ensure all base fields are present if it's a new doc
    // and merge with operationData to capture specifics for a new room (like playerCount).
    mongoUpdateOps.$setOnInsert = { ...defaultsOnInsert, ...operationData };
  }
  
  if (mongoUpdateOps.$set && Object.keys(mongoUpdateOps.$set).length === 0) {
      delete mongoUpdateOps.$set;
  }
  mongoUpdateOps.$setOnInsert.gameId = gameId;


  try {
    const options: UpdateOptions = { upsert: true };
    
    const result = await db.collection<GameRoom>(COLLECTION_NAME).updateOne(
      filter,
      mongoUpdateOps,
      options
    );
    
    // console.log(`MongoDB: UpdateOne operation for game room ${gameId}. Matched: ${result.matchedCount}, Modified: ${result.modifiedCount}, UpsertedId: ${result.upsertedId}`);

    if (result.acknowledged) {
      return await getGameRoom(gameId); // Fetch the updated/created document
    }
    
    console.warn(`MongoDB: updateOne for game ${gameId} was not acknowledged or failed. Result:`, result);
    return null;

  } catch (error: any) {
    console.error(`MongoDB: Error in updateGameRoom for ${gameId}.`, error);
    if (error.code === 40 || error.message?.includes("conflict at 'gameId'")) {
        console.error("Detailed conflict info: Filter:", JSON.stringify(filter), "Operation:", JSON.stringify(mongoUpdateOps));
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

      io.on('connection', (socket: CustomSocket) => {
        console.log('Socket connected:', socket.id);

        socket.on('disconnect', async () => {
          const gameId = socket.gameId;
          const playerId = socket.playerId;
          console.log(`Socket disconnected: ${socket.id}, Player: ${playerId}, Game: ${gameId}`);

          if (gameId && playerId) { 
            try {
              await dbConnectionPromise; // Ensure DB is ready before trying to modify game state
              if (!db) {
                  console.warn(`DB not available during disconnect for player ${playerId} in game ${gameId}`);
                  return;
              }
              let room = await getGameRoom(gameId);
              if (room && room.players[playerId]) {
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
                             const gameOverUpdate = { status: 'GAME_OVER' as MultiplayerGameStatus, winner: winnerId, turn: undefined };
                             const updatedRoom = await updateGameRoom(gameId, { $set: gameOverUpdate });
                             if (updatedRoom) {
                                 io.to(gameId).emit('game-over', { gameId, winner: winnerId });
                                 io.to(gameId).emit('game-state-update', updatedRoom);
                             }
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
          const { gameId, playerCount: playerCountString, rejoiningPlayerId } = data;
          
          try {
            await dbConnectionPromise;
          } catch (dbError) {
            socket.emit('error-event', { message: 'Database connection error. Please try again later.' });
            return;
          }
          if (!db) { // Should not happen if promise resolved, but good check
            socket.emit('error-event', { message: 'Database not connected (post-promise). Please try again later.' });
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
            console.log(`Game room ${gameId} not found. Creating for ${numPlayerCount} players.`);
            assignedPlayerId = rejoiningPlayerId || `player1`; 
            const initialPlayers: { [playerId: string]: PlayerData } = {};
            initialPlayers[assignedPlayerId] = playerObjectBase;

            const newRoomData: Partial<GameRoom> = {
              gameId: gameId, // Ensure gameId is part of newRoomData for updateGameRoom's $setOnInsert
              playerCount: numPlayerCount,
              players: initialPlayers,
              status: 'WAITING_FOR_PLAYERS',
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
            
            const playerUpdatePayload: any = {
              $set: {
                [`players.${assignedPlayerId}`]: {
                  ...(room.players[assignedPlayerId] || playerObjectBase),
                  socketId: socket.id 
                }
              }
            };
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
          try {
            await dbConnectionPromise;
          } catch (dbError) {
            socket.emit('error-event', { message: 'Database connection error (send-secret).' });
            return;
          }
          if (!db) { socket.emit('error-event', { message: 'Database not connected (send-secret).' }); return; }
          
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
          
          const setSecretUpdate: any = {
                $set: {
                    [`players.${playerId}.secret`]: secret,
                    // status: 'SETTING_SECRETS' // Status should only be set once, perhaps when first secret is set.
                },
                $inc: { secretsSetCount: 1 }
            };
            // Only set status to SETTING_SECRETS if it's currently ALL_PLAYERS_JOINED
            if (room.status === 'ALL_PLAYERS_JOINED') {
                setSecretUpdate.$set.status = 'SETTING_SECRETS';
            }
            
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
          const { gameId, playerId, guess: guessArray } = data;
          try {
            await dbConnectionPromise;
          } catch (dbError) {
            socket.emit('error-event', { message: 'Database connection error (make-guess).' });
            return;
          }
          if (!db) { socket.emit('error-event', { message: 'Database not connected (make-guess).' }); return; }
          
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
    
