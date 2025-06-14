
"use client";
import { useEffect, useState, useCallback } from 'react';
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
  // const [hasSubmittedSecret, setHasSubmittedSecret] = useState(false); // Replaced by checking gameRoomState.players[myPlayerId]?.isReady
  const [socket, setSocket] = useState<ClientSocket | null>(null);
  const [gameRoomState, setGameRoomState] = useState<ServerGameRoom | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<"connecting" | "connected" | "failed" | "room_full" | "error">("connecting");

  const expectedPlayerCount = playerCountParam === "duo" ? 2 : playerCountParam === "trio" ? 3 : 4;

  useEffect(() => {
    if (!gameId || !playerCountParam) {
        toast({title: "Error", description: "Missing game ID or player count.", variant: "destructive"});
        router.push('/mode-select');
        return;
    }

    const activePlayerIdFromStorage = localStorage.getItem('myPlayerId_activeGame');
    // Optional: Check if this gameId matches a stored gameId for activePlayerIdFromStorage if implementing rejoin for specific game

    fetch('/api/socketio', { method: 'POST' }) 
      .then((res) => {
        if(!res.ok) throw new Error("Failed to initialize socket endpoint");
        return res.json();
      })
      .then(() => {
        const newSocket = io({ path: '/api/socketio_c', addTrailingSlash: false }); 
        setSocket(newSocket);

        newSocket.on('connect', () => {
          console.log('Connected to Socket.IO server with ID:', newSocket.id);
          setConnectionStatus("connected");
          if (gameId && playerCountParam) {
            // Send rejoiningPlayerId if it exists from localStorage
            newSocket.emit('join-game', { gameId, playerCount: playerCountParam, rejoiningPlayerId: activePlayerIdFromStorage });
          }
        });

        newSocket.on('player-assigned', (data: { playerId: string; gameId: string }) => {
          if (data.gameId === gameId) {
            console.log(`Assigned as ${data.playerId} for game ${gameId}`);
            setMyPlayerId(data.playerId);
            localStorage.setItem('myPlayerId_activeGame', data.playerId); 
            localStorage.setItem(`activeGameId_${data.playerId}`, gameId); 
            
            const storedSecret = localStorage.getItem(`mySecret_${gameId}_${data.playerId}`);
            if(storedSecret) {
                setCurrentDigits(JSON.parse(storedSecret));
                // Note: hasSubmittedSecret is now derived from gameRoomState
            }
            toast({ title: "You are " + data.playerId, description: `Joined game room: ${gameId}` });
          }
        });
        
        newSocket.on('game-state-update', (serverGameState: ServerGameRoom) => { 
            if (serverGameState.gameId === gameId) {
                console.log('Received game-state-update in secret setup:', serverGameState);
                setGameRoomState(serverGameState);
                
                if(serverGameState.status === 'IN_PROGRESS' || serverGameState.status === 'GAME_OVER') {
                    router.push(`/multiplayer-play?gameId=${gameId}&playerCount=${playerCountParam}`);
                }
            }
        });

        newSocket.on('game-start', (data: { gameId: string; startingPlayer: string; targetMap: any }) => {
          if (data.gameId === gameId) {
            console.log('Game starting!', data);
            toast({ title: "Game Starting!", description: `${data.startingPlayer} will go first.` });
            // Clear local secret storage upon game start to ensure fresh setup next time
            if(myPlayerId) localStorage.removeItem(`mySecret_${gameId}_${myPlayerId}`);
            router.push(`/multiplayer-play?gameId=${gameId}&playerCount=${playerCountParam}`);
          }
        });
        
        newSocket.on('error-event', (data: { message: string }) => {
            console.error('Server error:', data.message);
            toast({ title: "Error", description: data.message, variant: "destructive" });
            if (data.message.toLowerCase().includes("full")) {
                setConnectionStatus("room_full");
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
        
        return () => {
          if (newSocket) {
            console.log('Disconnecting socket from secret setup...');
            newSocket.disconnect();
          }
        };
      })
      .catch(error => {
        console.error("Failed to initialize socket connection:", error);
        setConnectionStatus("failed");
        toast({ title: "Connection Setup Failed", description: "Could not contact the game server.", variant: "destructive" });
      });
  }, [gameId, playerCountParam, router, toast, myPlayerId]);


  const handleSecretSubmit = async () => {
    if (!socket || !myPlayerId || !gameId) {
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
    socket.emit('send-secret', { gameId, playerId: myPlayerId, secret: currentDigits });
    localStorage.setItem(`mySecret_${gameId}_${myPlayerId}`, JSON.stringify(currentDigits)); // Store for potential rejoin before game start
    // UI updates to 'isReady' driven by 'game-state-update' from server
    // toast({ title: `Your Secret Sent!`, description: "Waiting for server confirmation and other players..." });
    // No need to call setIsSubmittingSecret(false) here, as the button will be disabled/hidden by game state change.
  };

  const handleStartGame = () => {
    if (!socket || !myPlayerId || myPlayerId !== "player1" || !gameId || gameRoomState?.status !== 'READY_TO_START') {
      toast({ title: "Cannot Start Game", description: "Not host or game not ready.", variant: "destructive" });
      return;
    }
    socket.emit('request-start-game', { gameId });
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
  
  if (connectionStatus === "connecting" || (!myPlayerId && connectionStatus === "connected") || !gameRoomState) {
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
            </CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  if (connectionStatus === "failed" || connectionStatus === "error" || connectionStatus === "room_full") {
    // UI for failed/error/room_full remains the same
     return (
      <div className="flex flex-col items-center justify-center min-h-[calc(100vh-200px)] py-8">
        <Card className="w-full max-w-lg mx-auto shadow-xl">
          <CardHeader className="text-center">
            <CardTitle className="text-3xl text-destructive">
                {connectionStatus === "room_full" ? "Game Room Full" : "Connection Problem"}
            </CardTitle>
            <CardDescription className="pt-2">
              {connectionStatus === "failed" && "Could not connect to the game server."}
              {connectionStatus === "error" && "An error occurred with the game server. Please try again."}
              {connectionStatus === "room_full" && "This game room is currently full."}
            </CardDescription>
          </CardHeader>
          <CardFooter>
            <Button onClick={() => router.push('/mode-select')} className="w-full">Back to Mode Select</Button>
          </CardFooter>
        </Card>
      </div>
    );
  }

  const localPlayerIsReady = !!(myPlayerId && gameRoomState.players[myPlayerId]?.isReady);
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
      return myPlayerId === "player1" ? "All players ready. You can start the game!" : "All players ready. Waiting for host to start.";
    }
    return "Loading status...";
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
            {!localPlayerIsReady && myPlayerId && (gameRoomState.status === 'WAITING_FOR_READY' || gameRoomState.status === 'READY_TO_START' || (gameRoomState.status === 'WAITING_FOR_PLAYERS' && numberOfActivePlayers === expectedPlayerCount )) &&
              `Enter a ${CODE_LENGTH}-digit number. No 3 or 4 identical consecutive digits.`
            }
            <span className="flex items-center justify-center mt-2">
                {(gameRoomState.status !== 'READY_TO_START' && gameRoomState.status !== 'IN_PROGRESS') && <Hourglass className="mr-2 h-4 w-4 animate-spin" />}
                {getWaitingMessage()}
            </span>
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {myPlayerId && !localPlayerIsReady && (gameRoomState.status === 'WAITING_FOR_READY' || gameRoomState.status === 'READY_TO_START' || (gameRoomState.status === 'WAITING_FOR_PLAYERS' && numberOfActivePlayers === expectedPlayerCount )) && (
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
                if (!playerData.socketId && pId !== myPlayerId) return null; // Don't show disconnected players unless it's me (to see my own status if I disconnected briefly)
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
                Status: {gameRoomState.status}
            </p>
         </CardFooter>
      </Card>
    </div>
  );
}

