
"use client";
import { useEffect, useState } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { useToast } from '@/hooks/use-toast';
import type { Socket as ClientSocket } from 'socket.io-client';
import { io } from 'socket.io-client';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import PlayerPanel from '@/components/game/PlayerPanel'; // We'll reuse/adapt this
import TurnIndicator from '@/components/game/TurnIndicator'; // Reusable
import { Button } from '@/components/ui/button';
import type { Guess, PlayerData, GameRoom } from '@/types/game'; // Import necessary types
import { CODE_LENGTH } from '@/lib/gameLogic';
import { Award, Hourglass, Loader2 } from 'lucide-react';


// Simplified local state for the multiplayer game board
interface MultiplayerGameState {
  myPlayerId: string | null;
  mySecret: string[];
  currentTurnPlayerId: string | null;
  playersData: { [playerId: string]: Partial<PlayerData> & {displayName: string} }; // Store minimal data like guesses for UI
  gameStatus: 'LOADING' | 'WAITING_FOR_GAME_START' | 'IN_PROGRESS' | 'GAME_OVER';
  winner: string | null;
  targetMap: { [playerId: string]: string } | null;
}

export default function MultiplayerPlayPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { toast } = useToast();

  const gameId = searchParams.get('gameId');
  // const playerCountParam = searchParams.get('playerCount'); // For UI display if needed

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

    // Retrieve myPlayerId assigned during secret setup
    const storedPlayerId = localStorage.getItem(`myPlayerId_activeGame`);
    const mySecretFromStorage = localStorage.getItem(`mySecret_${gameId}_${storedPlayerId}`);

    if (!storedPlayerId) {
        toast({ title: "Error", description: "Player identity not found for this game.", variant: "destructive" });
        router.push(`/multiplayer-setup`); // Or mode-select
        return;
    }
    
    setGameState(prev => ({
        ...prev,
        myPlayerId: storedPlayerId,
        mySecret: mySecretFromStorage ? JSON.parse(mySecretFromStorage) : [],
        gameStatus: 'WAITING_FOR_GAME_START'
    }));


    fetch('/api/socketio', { method: 'POST' }).then(() => {
        const newSocket = io({ path: '/api/socketio_c', addTrailingSlash: false });
        setSocket(newSocket);

        newSocket.on('connect', () => {
            console.log(`MultiplayerPlay: Connected with socket ID ${newSocket.id}`);
            newSocket.emit('join-game', { gameId, playerCount: searchParams.get('playerCount') || "duo" }); // Re-join/confirm presence
             toast({title: "Reconnected to Game", description: `Game ID: ${gameId}`});
        });
        
        // Initial game state might be sent upon rejoining or after 'game-start' was missed
        newSocket.on('game-state-update', (serverGameState: GameRoom) => {
             console.log('Received game-state-update from server:', serverGameState);
             if (serverGameState.gameId === gameId) {
                const newPlayersData: MultiplayerGameState['playersData'] = {};
                Object.keys(serverGameState.players).forEach(pid => {
                    newPlayersData[pid] = {
                        socketId: serverGameState.players[pid].socketId,
                        guessesMade: serverGameState.players[pid].guessesMade || [],
                        guessesAgainst: serverGameState.players[pid].guessesAgainst || [],
                        displayName: pid // Simple display name
                    };
                });

                setGameState(prev => ({
                    ...prev,
                    currentTurnPlayerId: serverGameState.turn || null,
                    playersData: newPlayersData,
                    gameStatus: serverGameState.status === 'IN_PROGRESS' || serverGameState.status === 'GAME_OVER' ? serverGameState.status : prev.gameStatus,
                    winner: serverGameState.winner || null,
                    targetMap: serverGameState.targetMap || null,
                }));
             }
        });


        newSocket.on('game-start', (data: { gameId: string; startingPlayer: string; targetMap: any }) => {
            if (data.gameId === gameId) {
                console.log('MultiplayerPlay: Game Start event received', data);
                setGameState(prev => ({
                    ...prev,
                    currentTurnPlayerId: data.startingPlayer,
                    targetMap: data.targetMap,
                    gameStatus: 'IN_PROGRESS',
                    // Initialize playersData stubs if not already present
                    playersData: prev.playersData || (data.targetMap ? Object.keys(data.targetMap).reduce((acc, pid) => {
                        acc[pid] = { displayName: pid, guessesMade: [], guessesAgainst: [] };
                        return acc;,
                    }, {} as MultiplayerGameState['playersData']) : {}),
                }));
                toast({title: "Game Has Started!", description: `${data.startingPlayer}'s turn.`})
            }
        });

        newSocket.on('guess-feedback', (data: { gameId: string; guessingPlayerId: string; targetPlayerId: string; guess: Guess }) => {
            if (data.gameId === gameId) {
                console.log('MultiplayerPlay: Guess Feedback event received', data);
                setGameState(prev => {
                    const newPlayersData = { ...prev.playersData };
                    // Update guesses for guessing player
                    if (newPlayersData[data.guessingPlayerId]) {
                        if(!newPlayersData[data.guessingPlayerId].guessesMade) newPlayersData[data.guessingPlayerId].guessesMade = [];
                        newPlayersData[data.guessingPlayerId].guessesMade!.push(data.guess);
                    }
                    // Update guesses against target player
                     if (newPlayersData[data.targetPlayerId]) {
                        if(!newPlayersData[data.targetPlayerId].guessesAgainst) newPlayersData[data.targetPlayerId].guessesAgainst = [];
                        newPlayersData[data.targetPlayerId].guessesAgainst!.push(data.guess);
                    }
                    return { ...prev, playersData: newPlayersData };
                });
                setIsSubmittingGuess(false); // Re-enable guess button
            }
        });

        newSocket.on('turn-update', (data: { gameId: string; nextPlayerId: string }) => {
            if (data.gameId === gameId) {
                console.log('MultiplayerPlay: Turn Update event received', data);
                setGameState(prev => ({ ...prev, currentTurnPlayerId: data.nextPlayerId }));
                toast({description: `It's ${data.nextPlayerId}'s turn.`})
            }
        });

        newSocket.on('game-over', (data: { gameId: string; winner: string }) => {
            if (data.gameId === gameId) {
                console.log('MultiplayerPlay: Game Over event received', data);
                setGameState(prev => ({ ...prev, gameStatus: 'GAME_OVER', winner: data.winner }));
                toast({title: "Game Over!", description: `${data.winner} is the winner!`})
            }
        });
        
        newSocket.on('error-event', (data: { message: string }) => {
            toast({ title: "Error", description: data.message, variant: "destructive" });
        });

        newSocket.on('disconnect', (reason) => {
          console.log('MultiplayerPlay: Disconnected from socket server', reason);
          toast({ title: "Disconnected", variant: "destructive", description: `Reason: ${reason}` });
          setGameState(prev => ({ ...prev, gameStatus: 'LOADING' })); // Or an error state
        });

        return () => {
            console.log('MultiplayerPlay: Disconnecting socket');
            newSocket.disconnect();
        };
    });

  }, [gameId, router, toast, searchParams]);

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
    // Clear relevant localStorage
    localStorage.removeItem(`myPlayerId_activeGame`);
    localStorage.removeItem(`mySecret_${gameId}_${gameState.myPlayerId}`);
    router.push('/mode-select');
    if(socket) socket.disconnect();
  };
  
  const handlePlayAgain = () => {
     // For now, just go back to mode select. A real "play again" would need more server logic.
    handleExitGame();
  }

  if (gameState.gameStatus === 'LOADING' || !gameState.myPlayerId) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[calc(100vh-200px)]">
        <Loader2 className="h-12 w-12 animate-spin text-primary" />
        <p className="mt-4 text-lg">Loading game...</p>
      </div>
    );
  }
  
  if (gameState.gameStatus === 'WAITING_FOR_GAME_START') {
     return (
      <div className="flex flex-col items-center justify-center min-h-[calc(100vh-200px)]">
        <Hourglass className="h-12 w-12 animate-spin text-primary" />
        <p className="mt-4 text-lg">Waiting for game to start...</p>
        <p className="text-sm text-muted-foreground">Game ID: {gameId}</p>
      </div>
    );
  }

  if (gameState.gameStatus === 'GAME_OVER') {
    return (
      <Card className="w-full max-w-md mx-auto text-center shadow-xl mt-10">
        <CardHeader>
          <Award className="mx-auto h-16 w-16 text-primary" />
          <CardTitle className="text-3xl mt-4">
            {gameState.winner === gameState.myPlayerId ? "You Win!" : `${gameState.winner || 'Someone'} Wins!`}
          </CardTitle>
          <CardDescription className="pt-2">
            Congratulations to {gameState.winner}!
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
            {/* Optionally display final secrets or scores */}
          <Button onClick={handlePlayAgain} className="w-full" size="lg">Play Again</Button>
          <Button onClick={handleExitGame} className="w-full" size="lg" variant="outline">Exit Game</Button>
        </CardContent>
      </Card>
    );
  }
  
  // Determine opponent ID for Duo mode
  const opponentId = gameState.myPlayerId && gameState.targetMap ? gameState.targetMap[gameState.myPlayerId] : null;

  return (
    <div className="space-y-6">
      <div className={`text-center py-3 mb-4 rounded-lg bg-card shadow-md ${gameState.currentTurnPlayerId === gameState.myPlayerId ? 'border-2 border-primary ring-2 ring-primary/50' : 'border border-border'}`}>
        {gameState.currentTurnPlayerId && (
            <TurnIndicator 
              currentPlayerName={gameState.playersData[gameState.currentTurnPlayerId]?.displayName || gameState.currentTurnPlayerId} 
              isPlayerTurn={gameState.currentTurnPlayerId === gameState.myPlayerId} 
            />
        )}
        {/* Timer could be added here if desired for multiplayer */}
      </div>

      <div className="flex flex-col md:flex-row gap-4 sm:gap-6">
        {gameState.myPlayerId && (
          <PlayerPanel
            playerName={`${gameState.playersData[gameState.myPlayerId]?.displayName || gameState.myPlayerId} (You)`}
            isCurrentPlayer={true} // This panel always represents "you"
            isPlayerTurn={gameState.currentTurnPlayerId === gameState.myPlayerId}
            guesses={gameState.playersData[gameState.myPlayerId]?.guessesMade || []}
            onMakeGuess={handleMakeGuess}
            isSubmitting={isSubmittingGuess}
            secretForDisplay={gameState.mySecret} // Show your own secret
          />
        )}
        {opponentId && gameState.playersData[opponentId] && (
          <PlayerPanel
            playerName={gameState.playersData[opponentId]?.displayName || opponentId}
            isCurrentPlayer={false}
            isPlayerTurn={gameState.currentTurnPlayerId === opponentId}
            guesses={gameState.playersData[opponentId]?.guessesMade || []} // Show opponent's guesses against their target
            onMakeGuess={() => {}} // Opponent panel doesn't submit guesses from your client
            isSubmitting={false}
            secretForDisplay={undefined} // Don't show opponent's secret
          />
        )}
      </div>
       <Button onClick={handleExitGame} variant="outline" className="mt-6">Exit Game</Button>
    </div>
  );
}
