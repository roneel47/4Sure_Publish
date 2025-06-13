
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
import type { Guess, PlayerData, GameRoom as ServerGameRoom } from '@/types/game';
import { CODE_LENGTH } from '@/lib/gameLogic';
import { Award, Hourglass, Loader2 } from 'lucide-react';

// Extended local state for the multiplayer game board
interface MultiplayerGameState {
  myPlayerId: string | null;
  mySecret: string[]; // Player's own secret
  currentTurnPlayerId: string | null;
  playersData: { [playerId: string]: Partial<PlayerData> & { displayName: string } };
  gameStatus: 'LOADING' | 'WAITING_FOR_GAME_START' | 'IN_PROGRESS' | 'GAME_OVER';
  winner: string | null;
  targetMap: { [playerId: string]: string } | null; // Who guesses whom
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

    const storedPlayerId = localStorage.getItem('myPlayerId_activeGame');
    const mySecretFromStorage = storedPlayerId ? localStorage.getItem(`mySecret_${gameId}_${storedPlayerId}`) : null;

    if (!storedPlayerId) {
        toast({ title: "Error", description: "Player identity not found for this game session.", variant: "destructive" });
        router.push(`/multiplayer-setup`);
        return;
    }
    
    setGameState(prev => ({
        ...prev,
        myPlayerId: storedPlayerId,
        mySecret: mySecretFromStorage ? JSON.parse(mySecretFromStorage) : Array(CODE_LENGTH).fill(''),
        gameStatus: 'WAITING_FOR_GAME_START' // Initial status before socket events
    }));

    fetch('/api/socketio', { method: 'POST' }).then(() => { // Ensure server is ready
        const newSocket = io({ path: '/api/socketio_c', addTrailingSlash: false });
        setSocket(newSocket);

        newSocket.on('connect', () => {
            console.log(`MultiplayerPlay: Connected with socket ID ${newSocket.id}`);
            newSocket.emit('join-game', { gameId, playerCount: playerCountParam || "duo" });
            toast({title: "Connected to Game", description: `Attempting to join Game ID: ${gameId}`});
        });
        
        newSocket.on('game-state-update', (serverRoomState: ServerGameRoom) => {
             console.log('Received game-state-update from server:', serverRoomState);
             if (serverRoomState.gameId === gameId) {
                const newPlayersData: MultiplayerGameState['playersData'] = {};
                Object.keys(serverRoomState.players).forEach(pid => {
                    newPlayersData[pid] = {
                        socketId: serverRoomState.players[pid].socketId,
                        guessesMade: serverRoomState.players[pid].guessesMade || [],
                        guessesAgainst: serverRoomState.players[pid].guessesAgainst || [],
                        displayName: pid // Using pid as displayName for now
                    };
                });

                setGameState(prev => ({
                    ...prev,
                    myPlayerId: prev.myPlayerId || storedPlayerId, // Ensure myPlayerId is set
                    mySecret: prev.mySecret.length > 0 ? prev.mySecret : (mySecretFromStorage ? JSON.parse(mySecretFromStorage) : []), // Ensure mySecret is set
                    currentTurnPlayerId: serverRoomState.turn || null,
                    playersData: newPlayersData,
                    gameStatus: serverRoomState.status === 'IN_PROGRESS' || serverRoomState.status === 'GAME_OVER' 
                                ? serverRoomState.status 
                                : (Object.keys(newPlayersData).length === serverRoomState.playerCount ? 'WAITING_FOR_GAME_START' : 'LOADING'), // More nuanced status
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
                    // Initialize player data stubs if targetMap exists and they aren't there
                    if (data.targetMap) {
                        Object.keys(data.targetMap).forEach(pid => {
                            if (!initialPlayersData[pid]) {
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
                        if(!newPlayersData[data.guessingPlayerId].guessesMade) newPlayersData[data.guessingPlayerId].guessesMade = [];
                        newPlayersData[data.guessingPlayerId].guessesMade!.push(data.guess);
                    } else { // Initialize if somehow missing
                        newPlayersData[data.guessingPlayerId] = { displayName: data.guessingPlayerId, guessesMade: [data.guess], guessesAgainst: []};
                    }
                    // Update guessesAgainst for target player (optional for current UI, but good for server state)
                     if (newPlayersData[data.targetPlayerId]) {
                        if(!newPlayersData[data.targetPlayerId].guessesAgainst) newPlayersData[data.targetPlayerId].guessesAgainst = [];
                        newPlayersData[data.targetPlayerId].guessesAgainst!.push(data.guess);
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
                toast({description: `It's ${data.nextPlayerId}'s turn.`})
            }
        });

        newSocket.on('game-over', (data: { gameId: string; winner: string }) => {
            if (data.gameId === gameId) {
                console.log('MultiplayerPlay: Game Over event received', data);
                setGameState(prev => ({ ...prev, gameStatus: 'GAME_OVER', winner: data.winner }));
                toast({title: "Game Over!", description: `${data.winner} is the winner!`, duration: 5000})
            }
        });
        
        newSocket.on('error-event', (data: { message: string }) => {
            toast({ title: "Error", description: data.message, variant: "destructive" });
            // Potentially redirect or change game state on critical errors
            if (data.message.includes("full") || data.message.includes("No available player slot")) {
                 router.push('/mode-select');
            }
        });

        newSocket.on('disconnect', (reason) => {
          console.log('MultiplayerPlay: Disconnected from socket server', reason);
          toast({ title: "Disconnected", variant: "destructive", description: `Reason: ${reason}. Attempting to reconnect...` });
          setGameState(prev => ({ ...prev, gameStatus: 'LOADING' })); 
        });

        return () => {
            console.log('MultiplayerPlay: Disconnecting socket');
            newSocket.disconnect();
        };
    });

  }, [gameId, router, toast, playerCountParam]); // Added playerCountParam for join-game

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
    localStorage.removeItem('myPlayerId_activeGame');
    if (gameState.myPlayerId && gameId) {
      localStorage.removeItem(`mySecret_${gameId}_${gameState.myPlayerId}`);
    }
    router.push('/mode-select');
    if(socket) socket.disconnect();
  };
  
  const handlePlayAgain = () => {
    handleExitGame(); // For now, just exit and let them re-setup
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
  
  if (gameState.gameStatus === 'WAITING_FOR_GAME_START' && (!gameState.targetMap || Object.keys(gameState.playersData).length < (playerCountParam === "duo" ? 2 : 0) )) {
     return (
      <div className="flex flex-col items-center justify-center min-h-[calc(100vh-200px)]">
        <Hourglass className="h-12 w-12 animate-spin text-primary" />
        <p className="mt-4 text-lg">Waiting for all players and game to start...</p>
        <p className="text-sm text-muted-foreground">Game ID: {gameId}</p>
         <p className="text-xs">My ID: {gameState.myPlayerId}, Players in room: {Object.keys(gameState.playersData).length}</p>
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
          <Button onClick={handlePlayAgain} className="w-full" size="lg">Play Again</Button>
          <Button onClick={handleExitGame} className="w-full" size="lg" variant="outline">Exit Game</Button>
        </CardContent>
      </Card>
    );
  }
  
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
        {/* Multiplayer timer could be complex due to sync; not implemented for now */}
      </div>

      <div className="flex flex-col md:flex-row gap-4 sm:gap-6">
        {gameState.myPlayerId && (
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
            secretForDisplay={undefined} 
          />
        )}
        {/* TODO: Add more player panels for Trio/Quads if playerCountParam indicates */}
      </div>
       <Button onClick={handleExitGame} variant="outline" className="mt-6">Exit Game</Button>
    </div>
  );
}
