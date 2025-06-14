
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
  const socketRef = useRef<ClientSocket | null>(null); 
  const [gameRoomState, setGameRoomState] = useState<ServerGameRoom | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<"connecting" | "connected" | "failed" | "room_full" | "error">("connecting");

  const expectedPlayerCount = playerCountParam === "duo" ? 2 : playerCountParam === "trio" ? 3 : 4;

  useEffect(() => {
    if (!gameId || !playerCountParam) {
        toast({title: "Error", description: "Missing game ID or player count.", variant: "destructive"});
        router.push('/mode-select');
        return;
    }

    // Initialize socket only once
    if (socketRef.current) {
        console.log(`[MultiplayerSecretSetup] useEffect for game ${gameId}: Socket already exists (ID: ${socketRef.current.id}), skipping re-initialization.`);
        // If socket exists but not connected, try to connect (e.g. after navigating back)
        if (!socketRef.current.connected) {
            console.log(`[MultiplayerSecretSetup] Socket ${socketRef.current.id} exists but not connected. Attempting to connect.`);
            socketRef.current.connect();
        }
        return;
    }
    console.log(`[MultiplayerSecretSetup] useEffect: Initializing new socket for game ${gameId}.`);


    const rejoiningPlayerIdFromStorage = localStorage.getItem('myPlayerId_activeGame');
    const gameIdForRejoiningPlayer = rejoiningPlayerIdFromStorage ? localStorage.getItem(`activeGameId_${rejoiningPlayerIdFromStorage}`) : null;
    
    const validRejoiningPlayerId = (rejoiningPlayerIdFromStorage && gameIdForRejoiningPlayer === gameId) ? rejoiningPlayerIdFromStorage : null;
    console.log(`[MultiplayerSecretSetup] GameID: ${gameId}. PlayerCountParam: ${playerCountParam}.`);
    console.log(`[MultiplayerSecretSetup] Reading from localStorage: storedPlayerId='${rejoiningPlayerIdFromStorage}', gameIdForStoredPlayer='${gameIdForRejoiningPlayer}'. Valid rejoiningPlayerId for emit: '${validRejoiningPlayerId}'`);


    fetch('/api/socketio', { method: 'POST' }) 
      .then((res) => {
        if(!res.ok) throw new Error("Failed to initialize socket endpoint");
        return res.json();
      })
      .then(() => {
        const newSocket = io({ path: '/api/socketio_c', addTrailingSlash: false, transports: ['websocket'] }); 
        socketRef.current = newSocket;
        console.log(`[MultiplayerSecretSetup] New socket instance created with provisional ID: ${newSocket.id} for game ${gameId}.`);


        newSocket.on('connect', () => {
          console.log(`[MultiplayerSecretSetup] Socket connected with ID: ${newSocket.id} for game ${gameId}.`);
          setConnectionStatus("connected");
          if (gameId && playerCountParam) {
            console.log(`[MultiplayerSecretSetup] Emitting 'join-game' for game ${gameId}. RejoiningPlayerId: '${validRejoiningPlayerId || 'NONE'}'`);
            newSocket.emit('join-game', { gameId, playerCount: playerCountParam, rejoiningPlayerId: validRejoiningPlayerId });
          }
        });

        newSocket.on('player-assigned', (data: { playerId: string; gameId: string }) => {
          if (data.gameId === gameId) {
            console.log(`[MultiplayerSecretSetup] Received 'player-assigned' for game ${gameId}. Server assigned PlayerID: ${data.playerId}. Current 'myPlayerId' state before update: ${myPlayerId}`);
            setMyPlayerId(data.playerId); 
            localStorage.setItem('myPlayerId_activeGame', data.playerId); 
            localStorage.setItem(`activeGameId_${data.playerId}`, gameId); 
            console.log(`[MultiplayerSecretSetup] 'myPlayerId' state updated to: ${data.playerId}. LocalStorage updated.`);
            
            const storedSecret = localStorage.getItem(`mySecret_${gameId}_${data.playerId}`);
            if(storedSecret) {
                setCurrentDigits(JSON.parse(storedSecret));
            }
            toast({ title: "You are " + data.playerId, description: `Joined game room: ${gameId}` });
          } else {
            console.warn(`[MultiplayerSecretSetup] Received 'player-assigned' for a different game: ${data.gameId}. Current game: ${gameId}. Ignoring.`);
          }
        });
        
        newSocket.on('game-state-update', (serverGameState: ServerGameRoom) => { 
            if (serverGameState.gameId === gameId) {
                console.log(`[MultiplayerSecretSetup] Received 'game-state-update' for game ${gameId}:`, serverGameState);
                setGameRoomState(serverGameState);
                if(serverGameState.status === 'IN_PROGRESS' || serverGameState.status === 'GAME_OVER') {
                    // Check if current player is part of this game session before redirecting
                    // This check uses the 'myPlayerId' state which is updated by 'player-assigned'
                    if (myPlayerId && serverGameState.players && serverGameState.players[myPlayerId]) {
                         router.push(`/multiplayer-play?gameId=${gameId}&playerCount=${playerCountParam}`);
                    }
                }
            } else {
                 console.warn(`[MultiplayerSecretSetup] Received 'game-state-update' for a different game: ${serverGameState.gameId}. Current game: ${gameId}. Ignoring.`);
            }
        });

        newSocket.on('game-start', (data: { gameId: string; startingPlayer: string; targetMap: any }) => {
          if (data.gameId === gameId) {
            console.log(`[MultiplayerSecretSetup] Received 'game-start' for game ${gameId}. Starting player: ${data.startingPlayer}. Redirecting to play page.`);
            toast({ title: "Game Starting!", description: `${data.startingPlayer} will go first.` });
            // Clear only my secret upon game start if myPlayerId is set
            if(myPlayerId) localStorage.removeItem(`mySecret_${gameId}_${myPlayerId}`);
            router.push(`/multiplayer-play?gameId=${gameId}&playerCount=${playerCountParam}`);
          } else {
            console.warn(`[MultiplayerSecretSetup] Received 'game-start' for a different game: ${data.gameId}. Current game: ${gameId}. Ignoring.`);
          }
        });
        
        newSocket.on('error-event', (data: { message: string }) => {
            console.error(`[MultiplayerSecretSetup] Received 'error-event' for game ${gameId}: ${data.message}`);
            toast({ title: "Error", description: data.message, variant: "destructive" });
            if (data.message.toLowerCase().includes("full") || data.message.toLowerCase().includes("slot already active")) {
                setConnectionStatus("room_full");
            } else {
                setConnectionStatus("error");
            }
        });

        newSocket.on('disconnect', (reason) => {
          console.log(`[MultiplayerSecretSetup] Socket disconnected from game ${gameId}. Reason: ${reason}`);
          setConnectionStatus("failed");
          toast({ title: "Disconnected", description: `Reason: ${reason}`, variant: "destructive" });
        });

        newSocket.on('connect_error', (err) => {
          console.error(`[MultiplayerSecretSetup] Socket connection error for game ${gameId}: ${err.message}`, err);
          setConnectionStatus("failed");
          toast({ title: "Connection Error", description: `Failed to connect: ${err.message}`, variant: "destructive" });
        });
        
      })
      .catch(error => {
        console.error(`[MultiplayerSecretSetup] Error in fetch/socket setup for game ${gameId}:`, error);
        setConnectionStatus("failed");
        toast({ title: "Connection Setup Failed", description: "Could not contact the game server.", variant: "destructive" });
      });

    return () => {
      if (socketRef.current) {
        console.log(`[MultiplayerSecretSetup] useEffect cleanup: Disconnecting socket ${socketRef.current.id} for game ${gameId}.`);
        socketRef.current.disconnect();
        socketRef.current = null; 
      }
    };
  }, [gameId, playerCountParam, router, toast]); // myPlayerId is intentionally NOT in the dependency array


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
    console.log(`[MultiplayerSecretSetup] Emitting 'send-secret'. GameID: ${gameId}, PlayerID: ${myPlayerId}, Secret: ${currentDigits.join('')}`);
    socketRef.current.emit('send-secret', { gameId, playerId: myPlayerId, secret: currentDigits });
    localStorage.setItem(`mySecret_${gameId}_${myPlayerId}`, JSON.stringify(currentDigits)); 
    // Server will send game-state-update, no need to optimistically update UI fully here beyond isSubmitting
    // setIsSubmittingSecret(false) will be handled by game-state-update implicitly or if needed, explicitly after server ack.
  };

  const handleStartGame = () => {
    if (!socketRef.current || !myPlayerId || myPlayerId !== "player1" || !gameId || !gameRoomState || gameRoomState.status !== 'READY_TO_START') {
      toast({ title: "Cannot Start Game", description: "Not host or game not ready.", variant: "destructive" });
      return;
    }
    console.log(`[MultiplayerSecretSetup] Emitting 'request-start-game'. GameID: ${gameId}, PlayerID (Host): ${myPlayerId}`);
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
  
  if (connectionStatus === "connecting" || (connectionStatus === "connected" && !myPlayerId && (!gameRoomState || gameRoomState.status === 'WAITING_FOR_PLAYERS')) ) {
     return (
      <div className="flex flex-col items-center justify-center min-h-[calc(100vh-200px)] py-8">
        <Card className="w-full max-w-lg mx-auto shadow-xl">
          <CardHeader className="text-center">
            <CardTitle className="text-3xl text-primary flex items-center justify-center">
              <Loader2 className="mr-3 h-8 w-8 animate-spin" /> 
              {connectionStatus === "connecting" && "Connecting..."}
              {connectionStatus === "connected" && !myPlayerId && "Assigning Player ID..."}
              {connectionStatus === "connected" && myPlayerId && !gameRoomState && "Loading Game Info..."}
            </CardTitle>
            <CardDescription className="pt-2">
                {connectionStatus === "connecting" && "Establishing connection to the game server."}
                {connectionStatus !== "connecting" && "Fetching game details and player status."}
                {myPlayerId && ` (You are ${myPlayerId})`}
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
              {connectionStatus === "room_full" && "This game room is full, or your player slot is already active."}
            </CardDescription>
          </CardHeader>
          <CardFooter>
            <Button onClick={() => router.push('/mode-select')} className="w-full">Back to Mode Select</Button>
          </CardFooter>
        </Card>
      </div>
    );
  }

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

  const localPlayerServerData = myPlayerId && gameRoomState.players ? gameRoomState.players[myPlayerId] : null;
  const localPlayerIsReady = !!(localPlayerServerData && localPlayerServerData.isReady);
  const numberOfActivePlayers = gameRoomState.players ? Object.values(gameRoomState.players).filter(p => p.socketId).length : 0;


  const getWaitingMessage = () => {
    if (!gameRoomState) return "Loading room details...";
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

  const canSetSecret = myPlayerId && localPlayerServerData && !localPlayerServerData.isReady &&
                       (gameRoomState.status === 'WAITING_FOR_READY' || 
                        (gameRoomState.status === 'WAITING_FOR_PLAYERS' && numberOfActivePlayers === expectedPlayerCount) ||
                        gameRoomState.status === 'READY_TO_START' // Allow setting if somehow became unready
                       );

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
            {canSetSecret &&
              `Enter a ${CODE_LENGTH}-digit number. No 3 or 4 identical consecutive digits.`
            }
            <span className="flex items-center justify-center mt-2">
                {(gameRoomState.status === 'WAITING_FOR_PLAYERS' || gameRoomState.status === 'WAITING_FOR_READY') && <Hourglass className="mr-2 h-4 w-4 animate-spin" />}
                {getWaitingMessage()}
            </span>
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {canSetSecret && (
            <div className="space-y-6">
              <DigitInput
                count={CODE_LENGTH}
                values={currentDigits}
                onChange={setCurrentDigits}
                disabled={isSubmittingSecret || localPlayerIsReady}
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
                        pId === myPlayerId ? <span className="text-blue-400">Connecting...</span> : <span className="text-red-500">Disconnected</span>
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
                Current Room Status: {gameRoomState.status || "Loading..."}
            </p>
         </CardFooter>
      </Card>
    </div>
  );
}
    
    
    
    