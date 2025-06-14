
"use client";
import { useEffect, useState, useCallback, useRef } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import DigitInput from '@/components/game/DigitInput';
import { CODE_LENGTH, isValidDigitSequence } from '@/lib/gameLogic';
import { useToast } from '@/hooks/use-toast';
import { LockKeyhole, Users, Loader2, UserCheck, Hourglass, Play, ShieldCheck, ShieldAlert } from 'lucide-react';
import type { Socket as ClientSocket } from 'socket.io-client';
import { io } from 'socket.io-client';
import type { GameRoom as ServerGameRoom, PlayerData as ServerPlayerData, MultiplayerGameStatus } from '@/types/game';

export default function MultiplayerSecretSetupPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { toast } = useToast();

  const gameId = searchParams ? searchParams.get('gameId') : null;
  const playerCountParam = searchParams ? searchParams.get('playerCount') : null;
  
  const [myPlayerId, setMyPlayerId] = useState<string | null>(null);
  const [currentDigits, setCurrentDigits] = useState<string[]>(Array(CODE_LENGTH).fill(''));
  const [isSubmittingSecret, setIsSubmittingSecret] = useState(false);
  const socketRef = useRef<ClientSocket | null>(null); // Use ref for socket
  const [gameRoomState, setGameRoomState] = useState<ServerGameRoom | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<"connecting" | "connected" | "failed" | "room_full" | "error">("connecting");

  const expectedPlayerCount = playerCountParam === "duo" ? 2 : playerCountParam === "trio" ? 3 : 4;

  useEffect(() => {
    if (!gameId || !playerCountParam) {
        toast({title: "Error", description: "Missing game ID or player count.", variant: "destructive"});
        router.push('/mode-select');
        return;
    }

    // Ensure this effect runs only once to initialize the socket
    if (socketRef.current) return;

    const rejoiningPlayerIdFromStorage = localStorage.getItem('myPlayerId_activeGame');
    const gameIdForRejoiningPlayer = rejoiningPlayerIdFromStorage ? localStorage.getItem(`activeGameId_${rejoiningPlayerIdFromStorage}`) : null;
    
    // Only use rejoiningPlayerIdFromStorage if it's for the current gameId
    const validRejoiningPlayerId = (rejoiningPlayerIdFromStorage && gameIdForRejoiningPlayer === gameId) ? rejoiningPlayerIdFromStorage : null;


    fetch('/api/socketio', { method: 'POST' }) 
      .then((res) => {
        if(!res.ok) throw new Error("Failed to initialize socket endpoint");
        return res.json();
      })
      .then(() => {
        const newSocket = io({ path: '/api/socketio_c', addTrailingSlash: false, transports: ['websocket'] }); 
        socketRef.current = newSocket; // Store socket in ref

        newSocket.on('connect', () => {
          console.log('Connected to Socket.IO server with ID:', newSocket.id);
          setConnectionStatus("connected");
          if (gameId && playerCountParam) {
            console.log(`Emitting join-game with gameId: ${gameId}, playerCount: ${playerCountParam}, rejoiningPlayerId: ${validRejoiningPlayerId || 'null'}`);
            newSocket.emit('join-game', { gameId, playerCount: playerCountParam, rejoiningPlayerId: validRejoiningPlayerId });
          }
        });

        newSocket.on('player-assigned', (data: { playerId: string; gameId: string }) => {
          if (data.gameId === gameId) {
            console.log(`Assigned as ${data.playerId} for game ${gameId}`);
            setMyPlayerId(data.playerId); // Update state, but this won't re-trigger the effect
            localStorage.setItem('myPlayerId_activeGame', data.playerId); 
            localStorage.setItem(`activeGameId_${data.playerId}`, gameId); 
            
            const storedSecret = localStorage.getItem(`mySecret_${gameId}_${data.playerId}`);
            if(storedSecret) {
                setCurrentDigits(JSON.parse(storedSecret));
            }
            toast({ title: "You are " + data.playerId, description: `Joined game room: ${gameId}` });
          }
        });
        
        newSocket.on('game-state-update', (serverGameState: ServerGameRoom) => { 
            if (serverGameState.gameId === gameId) {
                console.log('Received game-state-update in secret setup:', serverGameState);
                setGameRoomState(serverGameState);
                
                // If server says game is in progress or over, and client is on setup, redirect
                if(serverGameState.status === 'IN_PROGRESS' || serverGameState.status === 'GAME_OVER') {
                    // Check if current player ID from state matches a player in the new game state.
                    // This prevents redirecting if 'myPlayerId' hasn't been set yet or if this client isn't part of the game.
                    if (myPlayerId && serverGameState.players && serverGameState.players[myPlayerId]) {
                         console.log(`Game status is ${serverGameState.status}, redirecting to play page for player ${myPlayerId}.`);
                         router.push(`/multiplayer-play?gameId=${gameId}&playerCount=${playerCountParam}`);
                    } else {
                         console.log(`Game status is ${serverGameState.status}, but myPlayerId (${myPlayerId}) not in game or not set. Not redirecting from setup.`);
                    }
                }
            }
        });

        newSocket.on('game-start', (data: { gameId: string; startingPlayer: string; targetMap: any }) => {
          if (data.gameId === gameId) {
            console.log('Game starting!', data);
            toast({ title: "Game Starting!", description: `${data.startingPlayer} will go first.` });
            if(myPlayerId) localStorage.removeItem(`mySecret_${gameId}_${myPlayerId}`);
            router.push(`/multiplayer-play?gameId=${gameId}&playerCount=${playerCountParam}`);
          }
        });
        
        newSocket.on('error-event', (data: { message: string }) => {
            console.error('Server error:', data.message);
            toast({ title: "Error", description: data.message, variant: "destructive" });
            if (data.message.toLowerCase().includes("full") || data.message.toLowerCase().includes("slot already active")) {
                setConnectionStatus("room_full"); // Treat "slot active" like room full for simplicity
            } else {
                setConnectionStatus("error");
            }
        });

        newSocket.on('disconnect', (reason) => {
          console.log('Disconnected from Socket.IO server:', reason);
          setConnectionStatus("failed");
          toast({ title: "Disconnected", description: `Reason: ${reason}`, variant: "destructive" });
        });

        newSocket.on('connect_error', (err) => {
          console.error('Socket connection error:', err);
          setConnectionStatus("failed");
          toast({ title: "Connection Error", description: `Failed to connect: ${err.message}`, variant: "destructive" });
        });
        
      })
      .catch(error => {
        console.error("Failed to initialize socket connection:", error);
        setConnectionStatus("failed");
        toast({ title: "Connection Setup Failed", description: "Could not contact the game server.", variant: "destructive" });
      });

    return () => {
      if (socketRef.current) {
        console.log('Disconnecting socket from secret setup cleanup...');
        socketRef.current.disconnect();
        socketRef.current = null;
      }
    };
  // Dependencies: gameId, playerCountParam, router, toast.
  // myPlayerId removed to prevent re-running on its change.
  // eslint-disable-next-line react-hooks/exhaustive-deps 
  }, [gameId, playerCountParam, router, toast]); // Removed myPlayerId


  const handleSecretSubmit = async () => {
    if (!socketRef.current || !myPlayerId || !gameId) {
      toast({ title: "Error", description: "Not connected or player ID not assigned.", variant: "destructive" });
      return;
    }
    if (currentDigits.some(digit => digit === '') || currentDigits.length !== CODE_LENGTH) {
      toast({ title: "Invalid Secret", description: `Please enter all ${CODE_LENGTH} digits.`, variant: "destructive" });
      return;
    }
    if (!isValidDigitSequence(currentDigits)) {
      toast({ title: "Invalid Secret Pattern", description: `Code cannot have 3 or 4 identical consecutive digits.`, variant: "destructive" });
      return;
    }

    setIsSubmittingSecret(true);
    // Ensure `myPlayerId` from state is used here
    socketRef.current.emit('send-secret', { gameId, playerId: myPlayerId, secret: currentDigits });
    localStorage.setItem(`mySecret_${gameId}_${myPlayerId}`, JSON.stringify(currentDigits)); 
    // Do not setIsSubmittingSecret(false) here; rely on game-state-update for UI changes
  };

  const handleStartGame = () => {
    if (!socketRef.current || !myPlayerId || myPlayerId !== "player1" || !gameId || !gameRoomState || gameRoomState.status !== 'READY_TO_START') {
      toast({ title: "Cannot Start Game", description: "Not host or game not ready.", variant: "destructive" });
      return;
    }
    socketRef.current.emit('request-start-game', { gameId });
  };

  if (!gameId || !playerCountParam ) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[calc(100vh-200px)] py-8">
        <Card className="w-full max-w-md text-center">
          <CardHeader><CardTitle>Error</CardTitle></CardHeader>
          <CardContent>
            <p>Invalid game setup parameters. Please go back and try again.</p>
            <Button onClick={() => router.push('/mode-select')} className="mt-4">Back to Mode Select</Button>
          </CardContent>
        </Card>
      </div>
    );
  }
  
  if (connectionStatus === "connecting" || (!myPlayerId && connectionStatus === "connected" && !gameRoomState && !(gameRoomState?.status === 'WAITING_FOR_PLAYERS' && Object.keys(gameRoomState?.players || {}).length < expectedPlayerCount)) || !gameRoomState && connectionStatus === "connected") {
     return (
      <div className="flex flex-col items-center justify-center min-h-[calc(100vh-200px)] py-8">
        <Card className="w-full max-w-lg mx-auto shadow-xl">
          <CardHeader className="text-center">
            <CardTitle className="text-3xl text-primary flex items-center justify-center">
              <Loader2 className="mr-3 h-8 w-8 animate-spin" /> 
              {connectionStatus === "connecting" ? "Connecting..." : (connectionStatus === "connected" && !myPlayerId) ? "Assigning Player ID..." : "Loading Game Info..."}
            </CardTitle>
            <CardDescription className="pt-2">
                {connectionStatus === "connecting" && "Establishing connection to the game server."}
                {connectionStatus !== "connecting" && "Fetching game details and player status."}
                {myPlayerId && `You are ${myPlayerId}.`}
            </CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  if (connectionStatus === "failed" || connectionStatus === "error" || connectionStatus === "room_full") {
     return (
      <div className="flex flex-col items-center justify-center min-h-[calc(100vh-200px)] py-8">
        <Card className="w-full max-w-lg mx-auto shadow-xl">
          <CardHeader className="text-center">
            <CardTitle className="text-3xl text-destructive">
                {connectionStatus === "room_full" ? "Game Room Full or Slot Active" : "Connection Problem"}
            </CardTitle>
            <CardDescription className="pt-2">
              {connectionStatus === "failed" && "Could not connect to the game server."}
              {connectionStatus === "error" && "An error occurred with the game server. Please try again."}
              {connectionStatus === "room_full" && "This game room is currently full, or your player slot is already active from another session."}
            </CardDescription>
          </CardHeader>
          <CardFooter>
            <Button onClick={() => router.push('/mode-select')} className="w-full">Back to Mode Select</Button>
          </CardFooter>
        </Card>
      </div>
    );
  }

  // If gameRoomState is null at this point, it's an unexpected state.
  if (!gameRoomState) {
    return (
         <div className="flex flex-col items-center justify-center min-h-[calc(100vh-200px)] py-8">
            <Card className="w-full max-w-lg mx-auto shadow-xl">
              <CardHeader className="text-center">
                <CardTitle className="text-3xl text-primary flex items-center justify-center">
                  <Loader2 className="mr-3 h-8 w-8 animate-spin" /> 
                  Initializing Game Room...
                </CardTitle>
                <CardDescription className="pt-2">
                    Waiting for server data. If this persists, try refreshing.
                    {myPlayerId && ` (My ID: ${myPlayerId})`}
                </CardDescription>
              </CardHeader>
            </Card>
          </div>
    );
  }

  const localPlayerIsReady = !!(myPlayerId && gameRoomState.players && gameRoomState.players[myPlayerId]?.isReady);
  const numberOfActivePlayers = gameRoomState.players ? Object.values(gameRoomState.players).filter(p => p.socketId).length : 0;

  const getWaitingMessage = () => {
    if (gameRoomState.status === 'WAITING_FOR_PLAYERS') {
      return `Waiting for players... (${numberOfActivePlayers}/${expectedPlayerCount})`;
    }
    if (gameRoomState.status === 'WAITING_FOR_READY') {
      const readyCount = gameRoomState.players ? Object.values(gameRoomState.players).filter(p => p.isReady && p.socketId).length : 0;
      return `Waiting for players to set secrets... (${readyCount}/${numberOfActivePlayers} ready)`;
    }
    if (gameRoomState.status === 'READY_TO_START') {
      return myPlayerId === "player1" ? "All players ready. You can start the game!" : "All players ready. Waiting for host (Player 1) to start.";
    }
    return `Current Status: ${gameRoomState.status}`;
  };


  return (
    <div className="flex flex-col items-center justify-center min-h-[calc(100vh-200px)] py-8">
      <Card className="w-full max-w-lg mx-auto shadow-xl">
        <CardHeader className="text-center">
          <CardTitle className="text-3xl text-primary flex items-center justify-center">
            {myPlayerId ? <UserCheck className="mr-3 h-8 w-8" /> : <LockKeyhole className="mr-3 h-8 w-8" />}
            {myPlayerId ? `You are ${myPlayerId}` : "Assigning ID..."}
          </CardTitle>
          <CardDescription className="pt-2">
            Game ID: <span className="font-mono text-sm text-accent">{gameId}</span> ({playerCountParam}) <br/>
            {myPlayerId && gameRoomState.players && gameRoomState.players[myPlayerId] && !gameRoomState.players[myPlayerId].isReady &&
              (gameRoomState.status === 'WAITING_FOR_READY' || gameRoomState.status === 'READY_TO_START' || (gameRoomState.status === 'WAITING_FOR_PLAYERS' && numberOfActivePlayers === expectedPlayerCount )) &&
              `Enter a ${CODE_LENGTH}-digit number. No 3 or 4 identical consecutive digits.`
            }
            <span className="flex items-center justify-center mt-2">
                {(gameRoomState.status === 'WAITING_FOR_PLAYERS' || gameRoomState.status === 'WAITING_FOR_READY') && <Hourglass className="mr-2 h-4 w-4 animate-spin" />}
                {getWaitingMessage()}
            </span>
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {myPlayerId && gameRoomState.players && gameRoomState.players[myPlayerId] && !gameRoomState.players[myPlayerId].isReady && 
           (gameRoomState.status === 'WAITING_FOR_READY' || gameRoomState.status === 'READY_TO_START' || (gameRoomState.status === 'WAITING_FOR_PLAYERS' && numberOfActivePlayers === expectedPlayerCount )) && (
            <div className="space-y-6">
              <DigitInput
                count={CODE_LENGTH}
                values={currentDigits}
                onChange={setCurrentDigits}
                disabled={isSubmittingSecret}
                ariaLabel={`Secret digit for ${myPlayerId}`}
              />
              <Button onClick={handleSecretSubmit} className="w-full" disabled={isSubmittingSecret || localPlayerIsReady} size="lg">
                {isSubmittingSecret ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Submitting...</> : `Confirm Secret & Ready Up`}
              </Button>
            </div>
          )}
          {localPlayerIsReady && (
             <p className="text-center text-lg text-green-500">Your secret is locked in! You are ready.</p>
          )}

          <div className="mt-6 border-t pt-4">
            <h4 className="text-lg font-semibold mb-2 text-center">Players in Room ({numberOfActivePlayers}/{expectedPlayerCount})</h4>
            <ul className="space-y-2">
              {gameRoomState.players && Object.entries(gameRoomState.players).map(([pId, playerData]) => {
                if (!playerData.socketId && pId !== myPlayerId) return null; 
                return (
                  <li key={pId} className={`flex justify-between items-center p-3 rounded-md ${playerData.socketId ? 'bg-card' : 'bg-muted/50 opacity-60'}`}>
                    <span className="font-semibold">{pId === myPlayerId ? `${pId} (You)` : pId}</span>
                    {playerData.socketId ? (
                        playerData.isReady ? 
                        <span className="text-green-400 flex items-center"><ShieldCheck className="mr-1 h-5 w-5"/>Ready</span> : 
                        <span className="text-yellow-400 flex items-center"><ShieldAlert className="mr-1 h-5 w-5"/>Setting Secret...</span>
                    ) : (
                        <span className="text-red-500">Disconnected</span>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>

          {myPlayerId === "player1" && gameRoomState.status === 'READY_TO_START' && (
            <Button onClick={handleStartGame} className="w-full mt-6" size="lg">
              <Play className="mr-2 h-5 w-5" /> Start Game
            </Button>
          )}

        </CardContent>
         <CardFooter className="flex flex-col items-center">
            <p className="text-xs text-muted-foreground">
                Current Room Status: {gameRoomState.status}
            </p>
         </CardFooter>
      </Card>
    </div>
  );
}
