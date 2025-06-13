
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
  | "WAITING_FOR_PLAYERS"
  | "ALL_PLAYERS_JOINED"
  | "SETTING_SECRETS"
  | "IN_PROGRESS"
  | "GAME_OVER";

export interface PlayerData {
  socketId: string;
  secret?: string[];
  guessesMade?: Guess[]; // Guesses this player made against their target
  guessesAgainst?: Guess[]; // Guesses made by others against this player's secret
}

export interface GameRoom {
  gameId: string;
  playerCount: number; // e.g., 2 for Duo, 3 for Trio
  players: { [playerId: string]: PlayerData }; // e.g., "player1", "player2"
  status: MultiplayerGameStatus;
  turn?: string; // playerId whose turn it is
  targetMap?: { [playerId: string]: string }; // Who guesses whom, e.g., player1 targets player2
  winner?: string; // playerId of the winner
  secretsSetCount: number;
}

// Structure for the in-memory store on the server
export interface GameRoomsStore {
  [gameId: string]: GameRoom;
}
