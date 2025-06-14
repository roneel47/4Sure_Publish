
export interface Guess {
  value: string; // The 4-digit guessed number as a string e.g. "1234"
  feedback: boolean[]; // Array of 4 booleans, true if digit is in correct position
}

export type GameStatus =
  | "SETUP_PLAYER" // Player needs to set their secret (single player)
  | "WAITING_OPPONENT_SECRET" // Player secret set, waiting for opponent (single player)
  | "PLAYING" // Game is in progress (single player)
  | "GAME_OVER"; // Game has ended (single player)

// Multiplayer Specific Types
export type MultiplayerGameStatus =
  | "WAITING_FOR_PLAYERS"      // Initial state, room created, waiting for enough players
  | "WAITING_FOR_READY"        // All player slots are filled, waiting for players to set secrets
  | "READY_TO_START"           // All connected players have set secrets, player1 can initiate start
  | "IN_PROGRESS"              // Game is actively being played
  | "GAME_OVER";               // Game has concluded

export interface PlayerData {
  socketId?: string; // Optional: can be undefined if player disconnected
  secret?: string[];
  guessesMade?: Guess[];
  guessesAgainst?: Guess[];
  hasSetSecret?: boolean; // True if this player has submitted their secret data
  isReady?: boolean;      // True if player has confirmed their secret and is ready for game to start
  // displayName?: string; // Future enhancement
}

export interface GameRoom {
  gameId: string;
  playerCount: number; 
  players: { [playerId: string]: PlayerData }; 
  status: MultiplayerGameStatus;
  turn?: string; 
  targetMap?: { [playerId: string]: string }; 
  winner?: string; 
  createdAt?: Date; // For TTL index
}

// Structure for the in-memory store on the server (if not using DB for everything)
export interface GameRoomsStore {
  [gameId: string]: GameRoom;
}

