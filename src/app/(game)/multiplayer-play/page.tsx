
"use client";
import { useEffect, useState } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { useToast } from '@/hooks/use-toast';
import type { Socket as ClientSocket } from 'socket.io-client';
import { io } from 'socket.io-client';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import PlayerPanel from '@/components/game/PlayerPanel';
import TurnIndicator from '@/components/game/TurnIndicator';
import { Button } from '@/components/ui/button';
import type { Guess, PlayerData as ServerPlayerData, GameRoom as ServerGameRoom } from '@/types/game'; // Renamed PlayerData to ServerPlayerData
import { CODE_LENGTH } from '@/lib/gameLogic';
import { Award, Hourglass, Loader2 } from 'lucide-react';

// Local PlayerData might have slightly different needs or be a subset
interface ClientPlayerData extends Partial<ServerPlayerData> {
  displayName: string; 
  // Explicitly define guessesMade and guessesAgainst as potentially undefined or arrays
  guessesMade?: Guess[];
  guessesAgainst?: Guess[];
}


interface MultiplayerGameState {
  myPlayerId: string | null;
  mySecret: string[]; 
  currentTurnPlayerId: string | null;
  playersData: { [playerId: string]: ClientPlayerData }; // Use ClientPlayerData
  gameStatus: 'LOADING' | 'WAITING_FOR_GAME_START' | 'IN_PROGRESS' | 'GAME_OVER';
  winner: string | null;
  targetMap: { [playerId: string]: string } | null; 
}

export default function MultiplayerPlayPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { toast } = useToast();

  const gameId = searchParams.get('gameId');
  const playerCountParam = searchParams.get('playerCount');

  const [socket, setSocket] = useState<ClientSocket | null>(null);
  const [gameState, setGameState] = useState<MultiplayerGameState>({
    myPlayerId: null,
    mySecret: [],
    currentTurnPlayerId: null,
    playersData: {},
    gameStatus: 'LOADING',
    winner: null,
    targetMap: null,
  });
  const [isSubmittingGuess, setIsSubmittingGuess] = useState(false);

  useEffect(() => {
    if (!gameId) {
      toast({ title: "Error", description: "No Game ID found.", variant: "destructive" });
      router.push('/mode-select');
      return;
    }

    // Retrieve playerId and associated gameId from localStorage
    const storedPlayerId = localStorage.getItem('myPlayerId_activeGame');
    const gameIdForStoredPlayer = storedPlayerId ? localStorage.getItem(`activeGameId_${storedPlayerId}`) : null;

    // Validate that the storedPlayerId is for the current gameId
    if (!storedPlayerId || gameIdForStoredPlayer !== gameId) {
        toast({ title: "Error", description: "Player identity mismatch for this game session.", variant: "destructive" });
        localStorage.removeItem('myPlayerId_activeGame'); // Clear potentially stale ID
        if (storedPlayerId) localStorage.removeItem(`activeGameId_${storedPlayerId}`); // Clear linked gameId
        router.push(`/multiplayer-setup`); // Go back to setup
        return;
    }
    
    const mySecretFromStorage = localStorage.getItem(`mySecret_${gameId}_${storedPlayerId}`);

    setGameState(prev => ({
        ...prev,
        myPlayerId: storedPlayerId,
        mySecret: mySecretFromStorage ? JSON.parse(mySecretFromStorage) : Array(CODE_LENGTH).fill(''),
        gameStatus: 'WAITING_FOR_GAME_START' 
    }));

    fetch('/api/socketio', { method: 'POST' }).then(() => { 
        const newSocket = io({ path: '/api/socketio_c', addTrailingSlash: false }); // Ensure path matches server
        setSocket(newSocket);

        newSocket.on('connect', () => {
            console.log(`MultiplayerPlay: Connected with socket ID ${newSocket.id}`);
            // Emit join-game with rejoiningPlayerId if it's set and for the current game
            newSocket.emit('join-game', { gameId, playerCount: playerCountParam || "duo", rejoiningPlayerId: storedPlayerId });
            toast({title: "Connected to Game", description: `Attempting to join Game ID: ${gameId}`});
        });
        
        newSocket.on('game-state-update', (serverRoomState: ServerGameRoom) => {
             console.log('Received game-state-update from server:', serverRoomState);
             if (serverRoomState.gameId === gameId) {
                const newPlayersData: MultiplayerGameState['playersData'] = {};
                Object.keys(serverRoomState.players).forEach(pid => {
                    const serverPlayer = serverRoomState.players[pid];
                    newPlayersData[pid] = {
                        socketId: serverPlayer.socketId,
                        // Ensure guessesMade and guessesAgainst are arrays, even if empty
                        guessesMade: serverPlayer.guessesMade || [], 
                        guessesAgainst: serverPlayer.guessesAgainst || [],
                        displayName: pid // Using pid as displayName for now
                    };
                });

                setGameState(prev => ({
                    ...prev,
                    myPlayerId: prev.myPlayerId || storedPlayerId, 
                    mySecret: prev.mySecret.length > 0 ? prev.mySecret : (mySecretFromStorage ? JSON.parse(mySecretFromStorage) : []), 
                    currentTurnPlayerId: serverRoomState.turn || null,
                    playersData: newPlayersData,
                    gameStatus: serverRoomState.status === 'IN_PROGRESS' || serverRoomState.status === 'GAME_OVER' 
                                ? serverRoomState.status 
                                : (Object.keys(newPlayersData).length === serverRoomState.playerCount ? 'WAITING_FOR_GAME_START' : 'LOADING'), 
                    winner: serverRoomState.winner || null,
                    targetMap: serverRoomState.targetMap || null,
                }));
             }
        });

        newSocket.on('game-start', (data: { gameId: string; startingPlayer: string; targetMap: { [playerId: string]: string } }) => {
            if (data.gameId === gameId) {
                console.log('MultiplayerPlay: Game Start event received', data);
                setGameState(prev => {
                    const initialPlayersData = { ...prev.playersData };
                    if (data.targetMap) {
                        Object.keys(data.targetMap).forEach(pid => {
                            if (!initialPlayersData[pid]) { // Initialize if missing
                                initialPlayersData[pid] = { displayName: pid, guessesMade: [], guessesAgainst: [] };
                            }
                        });
                    }
                    return {
                        ...prev,
                        currentTurnPlayerId: data.startingPlayer,
                        targetMap: data.targetMap,
                        gameStatus: 'IN_PROGRESS',
                        playersData: initialPlayersData,
                    };
                });
                toast({title: "Game Has Started!", description: `${data.startingPlayer}'s turn.`});
            }
        });

        newSocket.on('guess-feedback', (data: { gameId: string; guessingPlayerId: string; targetPlayerId: string; guess: Guess }) => {
            if (data.gameId === gameId) {
                console.log('MultiplayerPlay: Guess Feedback event received', data);
                setGameState(prev => {
                    const newPlayersData = { ...prev.playersData };
                    
                    // Update guessesMade for guessing player
                    if (newPlayersData[data.guessingPlayerId]) {
                        newPlayersData[data.guessingPlayerId].guessesMade = [
                            ...(newPlayersData[data.guessingPlayerId].guessesMade || []), // Ensure array exists
                            data.guess
                        ];
                    } else { 
                        newPlayersData[data.guessingPlayerId] = { displayName: data.guessingPlayerId, guessesMade: [data.guess], guessesAgainst: []};
                    }

                    // Update guessesAgainst for target player
                     if (newPlayersData[data.targetPlayerId]) {
                        newPlayersData[data.targetPlayerId].guessesAgainst = [
                            ...(newPlayersData[data.targetPlayerId].guessesAgainst || []), // Ensure array exists
                            data.guess
                        ];
                    } else {
                        newPlayersData[data.targetPlayerId] = { displayName: data.targetPlayerId, guessesMade: [], guessesAgainst: [data.guess]};
                    }
                    return { ...prev, playersData: newPlayersData };
                });
                setIsSubmittingGuess(false);
            }
        });

        newSocket.on('turn-update', (data: { gameId: string; nextPlayerId: string }) => {
            if (data.gameId === gameId) {
                console.log('MultiplayerPlay: Turn Update event received', data);
                setGameState(prev => ({ ...prev, currentTurnPlayerId: data.nextPlayerId }));
                if (gameState.myPlayerId) { // Check if myPlayerId is set before crafting toast
                     toast({description: `It's ${data.nextPlayerId === gameState.myPlayerId ? 'Your' : data.nextPlayerId + "'s"} turn.`})
                }
            }
        });

        newSocket.on('game-over', (data: { gameId: string; winner: string }) => {
            if (data.gameId === gameId) {
                console.log('MultiplayerPlay: Game Over event received', data);
                setGameState(prev => ({ ...prev, gameStatus: 'GAME_OVER', winner: data.winner }));
                if (gameState.myPlayerId) { // Check if myPlayerId is set
                    toast({title: "Game Over!", description: `${data.winner === gameState.myPlayerId ? 'You are' : (gameState.playersData[data.winner]?.displayName || data.winner) + ' is'} the winner!`, duration: 5000});
                }
            }
        });
        
        newSocket.on('error-event', (data: { message: string }) => {
            toast({ title: "Error", description: data.message, variant: "destructive" });
            if (data.message.includes("full") || data.message.includes("No available player slot")) {
                 router.push('/mode-select');
            }
        });

        newSocket.on('disconnect', (reason) => {
          console.log('MultiplayerPlay: Disconnected from socket server', reason);
          toast({ title: "Disconnected", variant: "destructive", description: `Reason: ${reason}. Please refresh or try rejoining.` });
          setGameState(prev => ({ ...prev, gameStatus: 'LOADING' })); 
        });

        return () => {
            console.log('MultiplayerPlay: Disconnecting socket');
            newSocket.disconnect();
        };
    });

  }, [gameId, router, toast, playerCountParam, gameState.myPlayerId]); // Added gameState.myPlayerId

  const handleMakeGuess = (guessString: string) => {
    if (!socket || !gameId || !gameState.myPlayerId || gameState.currentTurnPlayerId !== gameState.myPlayerId || gameState.gameStatus !== 'IN_PROGRESS') {
      toast({ title: "Cannot make guess", description: "Not your turn or game not active.", variant: "destructive" });
      return;
    }
    setIsSubmittingGuess(true);
    const guessArray = guessString.split('');
    socket.emit('make-guess', { gameId, playerId: gameState.myPlayerId, guess: guessArray });
  };

  const handleExitGame = () => {
    // Clear all game-specific localStorage for this player
    localStorage.removeItem('myPlayerId_activeGame');
    if (gameState.myPlayerId && gameId) {
      localStorage.removeItem(`mySecret_${gameId}_${gameState.myPlayerId}`);
      localStorage.removeItem(`activeGameId_${gameState.myPlayerId}`);
    }
    router.push('/mode-select');
    if(socket) socket.disconnect();
  };
  
  const handlePlayAgain = () => {
    // For multiplayer, re-joining usually means going back to setup to find/host a new game.
    handleExitGame(); 
  }

  if (gameState.gameStatus === 'LOADING' || !gameState.myPlayerId) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[calc(100vh-200px)]">
        <Loader2 className="h-12 w-12 animate-spin text-primary" />
        <p className="mt-4 text-lg">Loading game & player data...</p>
        <p className="text-sm text-muted-foreground">Game ID: {gameId}</p>
      </div>
    );
  }
  
  const expectedPlayerCount = playerCountParam === "duo" ? 2 : (playerCountParam === "trio" ? 3 : (playerCountParam === "quads" ? 4 : 0));
  if (gameState.gameStatus === 'WAITING_FOR_GAME_START' && (!gameState.targetMap || Object.keys(gameState.playersData).length < expectedPlayerCount )) {
     return (
      <div className="flex flex-col items-center justify-center min-h-[calc(100vh-200px)]">
        <Hourglass className="h-12 w-12 animate-spin text-primary" />
        <p className="mt-4 text-lg">Waiting for all players and game to start...</p>
        <p className="text-sm text-muted-foreground">Game ID: {gameId}</p>
         <p className="text-xs">My ID: {gameState.myPlayerId}, Players in room: {Object.keys(gameState.playersData).length}/{expectedPlayerCount}</p>
      </div>
    );
  }

  if (gameState.gameStatus === 'GAME_OVER') {
    return (
      <Card className="w-full max-w-md mx-auto text-center shadow-xl mt-10">
        <CardHeader>
          <Award className="mx-auto h-16 w-16 text-primary" />
          <CardTitle className="text-3xl mt-4">
            {gameState.winner === gameState.myPlayerId ? "You Win!" : `${gameState.playersData[gameState.winner || '']?.displayName || gameState.winner || 'Someone'} Wins!`}
          </CardTitle>
          <CardDescription className="pt-2">
            Congratulations to {gameState.playersData[gameState.winner || '']?.displayName || gameState.winner}!
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Button onClick={handlePlayAgain} className="w-full" size="lg">Play Again Setup</Button>
          <Button onClick={handleExitGame} className="w-full" size="lg" variant="outline">Exit Game</Button>
        </CardContent>
      </Card>
    );
  }
  
  const opponentId = gameState.myPlayerId && gameState.targetMap ? gameState.targetMap[gameState.myPlayerId] : null;

  return (
    <div className="space-y-6">
      <div className={`text-center py-3 mb-4 rounded-lg bg-card shadow-md ${gameState.currentTurnPlayerId === gameState.myPlayerId ? 'border-2 border-primary ring-2 ring-primary/50' : 'border border-border'}`}>
        {gameState.currentTurnPlayerId && gameState.playersData[gameState.currentTurnPlayerId] && (
            <TurnIndicator 
              currentPlayerName={gameState.playersData[gameState.currentTurnPlayerId]?.displayName || gameState.currentTurnPlayerId} 
              isPlayerTurn={gameState.currentTurnPlayerId === gameState.myPlayerId} 
            />
        )}
        {/* Multiplayer timer could be complex due to sync; not implemented for now */}
      </div>

      <div className="flex flex-col md:flex-row gap-4 sm:gap-6">
        {gameState.myPlayerId && gameState.playersData[gameState.myPlayerId] && (
          <PlayerPanel
            playerName={`${gameState.playersData[gameState.myPlayerId]?.displayName || gameState.myPlayerId} (You)`}
            isCurrentPlayer={true}
            isPlayerTurn={gameState.currentTurnPlayerId === gameState.myPlayerId}
            guesses={gameState.playersData[gameState.myPlayerId]?.guessesMade || []}
            onMakeGuess={handleMakeGuess}
            isSubmitting={isSubmittingGuess && gameState.currentTurnPlayerId === gameState.myPlayerId}
            secretForDisplay={gameState.mySecret} 
          />
        )}
        {opponentId && gameState.playersData[opponentId] && (
          <PlayerPanel
            playerName={gameState.playersData[opponentId]?.displayName || opponentId}
            isCurrentPlayer={false}
            isPlayerTurn={gameState.currentTurnPlayerId === opponentId}
            guesses={gameState.playersData[opponentId]?.guessesMade || []} 
            onMakeGuess={() => {}} 
            isSubmitting={false} 
            secretForDisplay={undefined} // Opponent's secret is never displayed on client
          />
        )}
        {/* TODO: Add more player panels for Trio/Quads if playerCountParam indicates */}
      </div>
       <Button onClick={handleExitGame} variant="outline" className="mt-6">Exit Game</Button>
    </div>
  );
}
