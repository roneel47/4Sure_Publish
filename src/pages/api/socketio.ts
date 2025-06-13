
import type { Server as HTTPServer } from 'http';
import type { Socket as NetSocket } from 'net';
import type { NextApiRequest, NextApiResponse } from 'next';
import { Server as SocketIOServer, Socket } from 'socket.io';
import type { GameRoom, PlayerData, Guess, MultiplayerGameStatus } from '@/types/game';
import { calculateFeedback, checkWin } from '@/lib/gameLogic';
import { MongoClient, Db as MongoDb, FindOneAndUpdateOptions, Timestamp, MongoError } from 'mongodb';

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
let resolveDbConnection: (value: MongoDb | null | PromiseLike<MongoDb | null>) => void;
let rejectDbConnection: (reason?: any) => void;

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
    const roomDocument = await db.collection<GameRoom>(COLLECTION_NAME).findOne({ gameId: gameId });
    if (roomDocument) {
        const { _id, ...data } = roomDocument as any; 
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
      const fullDocumentToInsert = { ...newRoomData, gameId }; // Ensure gameId is part of the document
      await db.collection<GameRoom>(COLLECTION_NAME).insertOne(fullDocumentToInsert);
      console.log(`MongoDB: Successfully created game room ${gameId}.`);
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { _id, ...roomData } = fullDocumentToInsert as any; // Exclude _id if you don't want to return it
      return roomData as GameRoom;
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
  updateOperators: any // e.g., { $set: { status: 'IN_PROGRESS' } } or { $set: { 'players.player1': playerData } }
): Promise<GameRoom | null> {
  await dbConnectionPromise;
  if (!db) {
    console.warn(`MongoDB: db instance is null (updateGameRoom for ${gameId}). Cannot update.`);
    return null;
  }

  const filter = { gameId: gameId };
  const options: FindOneAndUpdateOptions = {
    returnDocument: 'after', // Return the modified document
    // No upsert here; creation is handled by createGameRoom
  };

  try {
    const result = await db.collection<GameRoom>(COLLECTION_NAME).findOneAndUpdate(filter, updateOperators, options);
    if (result && result.value) {
      // console.log(`MongoDB: updateGameRoom successful for ${gameId}.`);
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { _id, ...roomData } = result.value as any;
      return roomData as GameRoom;
    } else {
      console.warn(`MongoDB: updateGameRoom for ${gameId} did not find a document to update or an error occurred. Filter: ${JSON.stringify(filter)}, Update: ${JSON.stringify(updateOperators)}`);
      return null; // Room not found or error
    }
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
          const gameId = socket.gameId;
          const playerId = socket.playerId;
          console.log(`Socket disconnected: ${socket.id}, Player: ${playerId}, Game: ${gameId}`);

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
                    // For other modes or if game not over, just update the state
                    // Optionally, remove player from room if they are not re-joinable
                    // const playerDisconnectUpdate = { $unset: { [`players.${playerId}`]: "" } }; // Or set a disconnected flag
                    // await updateGameRoom(gameId, playerDisconnectUpdate);
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
                assignedPlayerId = rejoiningPlayerId || `player1`; // First player to attempt creation is player1
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

                roomUpdateResult = await createGameRoom(gameId, newRoomDataForCreation);
                if (!roomUpdateResult) { // createGameRoom returned null (e.g. duplicate key error)
                    console.log(`Failed to create game room ${gameId} (likely race, re-fetching).`);
                    room = await getGameRoom(gameId); // Attempt to fetch the room created by another client
                    if (!room) {
                        socket.emit('error-event', { message: 'Failed to create or find game room after race condition.' });
                        console.error(`Failed to get room ${gameId} even after createGameRoom returned null.`);
                        return;
                    }
                    // Now room exists, proceed to join as if it was found initially (will be handled below)
                } else {
                    room = roomUpdateResult; // Successfully created by this client
                }
            }
            
            // At this point, 'room' should be the existing or newly created room object.
            // Now, handle adding the current socket/player to this room.
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

            // Determine assignedPlayerId if not already set (e.g. if room was found but this is a new joining player)
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

            // Update or add the player
            const existingPlayerData = room.players[assignedPlayerId] || {};
            const newPlayerDataForSocket: PlayerData = {
                ...existingPlayerData, // Keep existing data like secret if rejoining
                socketId: socket.id, // Update socketId
                guessesMade: existingPlayerData.guessesMade || [], // Ensure arrays exist
                guessesAgainst: existingPlayerData.guessesAgainst || [],
                // secret will be kept if rejoining, or empty if new
            };
            
            playerUpdatePayload = { $set: { [`players.${assignedPlayerId}`]: newPlayerDataForSocket } };
            
            // If the player wasn't in the room's player list before (i.e. room was created by another client, or this is a new joiner)
            if (!room.players[assignedPlayerId]) { 
                 // Check again if player count is exceeded AFTER trying to assign ID, to catch race where room filled up.
                 if (Object.keys(room.players).length >= room.playerCount) {
                     socket.emit('error-event', { message: 'Game room became full while trying to join.' });
                     socket.leave(gameId);
                     return;
                 }
            }
            
            roomUpdateResult = await updateGameRoom(gameId, playerUpdatePayload);
            if (!roomUpdateResult) {
                socket.emit('error-event', { message: 'Failed to update game room with new/rejoining player.' });
                return;
            }
            room = roomUpdateResult;


            socket.gameId = gameId; 
            socket.playerId = assignedPlayerId; 
            socket.emit('player-assigned', { playerId: assignedPlayerId!, gameId }); 
            io.to(gameId).emit('game-state-update', room); 

            if (room.status === 'WAITING_FOR_PLAYERS' && Object.keys(room.players).length === room.playerCount) {
              const newStatusUpdate = { $set: {status: 'ALL_PLAYERS_JOINED' as MultiplayerGameStatus} };
              const statusUpdatedRoom = await updateGameRoom(gameId, newStatusUpdate);
              if (statusUpdatedRoom) {
                  room = statusUpdatedRoom;
                  io.to(gameId).emit('all-players-joined', { gameId }); 
                  io.to(gameId).emit('game-state-update', room); 
              } else {
                   socket.emit('error-event', { message: 'Failed to update game status to ALL_PLAYERS_JOINED.' });
              }
            } else if ((room.status === 'ALL_PLAYERS_JOINED' || room.status === 'SETTING_SECRETS' || room.status === 'IN_PROGRESS') && rejoiningPlayerId ) {
              io.to(gameId).emit('game-state-update', room);
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
             io.to(gameId).emit('game-state-update', room); // Player already set secret
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
            // TODO: Add targetMap logic for 3 and 4 players (e.g., circular)
            
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
    
