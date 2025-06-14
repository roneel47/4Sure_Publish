
"use client";
import { useEffect, useState, useCallback } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import DigitInput from '@/components/game/DigitInput';
import { CODE_LENGTH, isValidDigitSequence } from '@/lib/gameLogic';
import { useToast } from '@/hooks/use-toast';
import { LockKeyhole, Users, ArrowRight, Loader2, UserCheck, Hourglass } from 'lucide-react';
import type { Socket as ClientSocket } from 'socket.io-client';
import { io } from 'socket.io-client';
import type { GameRoom as ServerGameRoom } from '@/types/game'; // Import ServerGameRoom

export default function MultiplayerSecretSetupPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { toast } = useToast();

  const gameId = searchParams ? searchParams.get('gameId') : null;
  const playerCountParam = searchParams ? searchParams.get('playerCount') : null;
  
  const [myPlayerId, setMyPlayerId] = useState<string | null>(null);
  const [currentDigits, setCurrentDigits] = useState<string[]>(Array(CODE_LENGTH).fill(''));
  const [isSubmittingSecret, setIsSubmittingSecret] = useState(false);
  const [hasSubmittedSecret, setHasSubmittedSecret] = useState(false);
  const [socket, setSocket] = useState<ClientSocket | null>(null);
  const [allPlayersJoined, setAllPlayersJoined] = useState(false);
  const [secretsActuallySet, setSecretsActuallySet] = useState(0); // Renamed from secretsCurrentlySet
  const [actualPlayersInGame, setActualPlayersInGame] = useState(0);
  const [expectedPlayerCount, setExpectedPlayerCount] = useState(0); 
  const [connectionStatus, setConnectionStatus] = useState<"connecting" | "connected" | "failed" | "room_full" | "error">("connecting");


  useEffect(() => {
    if (!gameId || !playerCountParam) {
        toast({title: "Error", description: "Missing game ID or player count.", variant: "destructive"});
        router.push('/mode-select');
        return;
    }
    const expectedCount = playerCountParam === "duo" ? 2 : playerCountParam === "trio" ? 3 : 4;
    setExpectedPlayerCount(expectedCount);

    const activePlayerId = localStorage.getItem('myPlayerId_activeGame');
    if(activePlayerId){
        const storedSecretForGame = localStorage.getItem(`mySecret_${gameId}_${activePlayerId}`);
        if (storedSecretForGame) {
            setHasSubmittedSecret(true); 
            setCurrentDigits(JSON.parse(storedSecretForGame));
        }
    }


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
            const rejoiningPlayerId = localStorage.getItem('myPlayerId_activeGame');
            // Server will validate if this rejoiningPlayerId is valid for this gameId
            newSocket.emit('join-game', { gameId, playerCount: playerCountParam, rejoiningPlayerId: rejoiningPlayerId });
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
                // If secret was already in localStorage for this player & game, reflect that
                setHasSubmittedSecret(true);
                setCurrentDigits(JSON.parse(storedSecret));
            }
            toast({ title: "You are " + data.playerId, description: `Joined game room: ${gameId}` });
          }
        });
        
        newSocket.on('game-state-update', (serverGameState: ServerGameRoom) => { 
            if (serverGameState.gameId === gameId) {
                console.log('Received game-state-update in secret setup:', serverGameState);
                
                const currentPlayers = Object.values(serverGameState.players || {}).filter(p => p.socketId);
                setActualPlayersInGame(currentPlayers.length);
                setExpectedPlayerCount(serverGameState.playerCount);
                
                const secretsSetCount = currentPlayers.filter(p => p.hasSetSecret).length;
                setSecretsActuallySet(secretsSetCount);


                if (myPlayerId && serverGameState.players && serverGameState.players[myPlayerId]?.hasSetSecret) {
                    setHasSubmittedSecret(true);
                } else if (myPlayerId && serverGameState.players && !serverGameState.players[myPlayerId]?.hasSetSecret) {
                    // This can happen if server state resets or player rejoined without local secret state
                    // Forcing submission again if server says secret not set.
                    // setHasSubmittedSecret(false); 
                    // Re-evaluate if this line above is needed, might cause UI flicker if server is slow to confirm secret.
                }
                
                if (currentPlayers.length === serverGameState.playerCount && serverGameState.status !== 'WAITING_FOR_PLAYERS') {
                    setAllPlayersJoined(true);
                } else {
                    setAllPlayersJoined(false);
                }

                if(serverGameState.status === 'IN_PROGRESS' || serverGameState.status === 'GAME_OVER') {
                    router.push(`/multiplayer-play?gameId=${gameId}&playerCount=${playerCountParam}`);
                }
            }
        });


        newSocket.on('player-joined', (data: {playerId: string, playersInRoom: number, totalPlayerCapacity: number}) => { 
           console.log('Player joined event:', data);
           setActualPlayersInGame(data.playersInRoom);
           setExpectedPlayerCount(data.totalPlayerCapacity);
           if (data.playersInRoom === data.totalPlayerCapacity) {
             setAllPlayersJoined(true);
           }
            if (data.playerId !== myPlayerId) { 
                toast({ description: `${data.playerId} joined. ${data.playersInRoom}/${data.totalPlayerCapacity} players.` });
            }
        });
        
        newSocket.on('all-players-joined', (data: { gameId: string }) => {
          if (data.gameId === gameId) {
            console.log('All players have joined the game:', gameId);
            setAllPlayersJoined(true);
            toast({ title: "Ready to Set Secrets!", description: "All players have joined." });
          }
        });

        newSocket.on('secret-update', (data: { playerId: string; secretSet: boolean; secretsCurrentlySet: number; totalPlayers: number }) => {
          console.log('Secret update received:', data);
          setSecretsActuallySet(data.secretsCurrentlySet);
          setExpectedPlayerCount(data.totalPlayers);
          if (data.playerId === myPlayerId && data.secretSet) {
            setHasSubmittedSecret(true);
            setIsSubmittingSecret(false); // Ensure button is re-enabled after confirmation
          }
          if (data.playerId !== myPlayerId) {
            toast({ title: "Opponent Update", description: `${data.playerId} has set their secret. (${data.secretsCurrentlySet}/${data.totalPlayers})` });
          }
        });

        newSocket.on('game-start', (data: { gameId: string; startingPlayer: string; targetMap: any }) => {
          if (data.gameId === gameId) {
            console.log('Game starting!', data);
            toast({ title: "Game Starting!", description: `${data.startingPlayer} will go first.` });
            router.push(`/multiplayer-play?gameId=${gameId}&playerCount=${playerCountParam}`);
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
        
        newSocket.on('error-event', (data: { message: string }) => {
            console.error('Server error:', data.message);
            toast({ title: "Error", description: data.message, variant: "destructive" });
            if (data.message.toLowerCase().includes("full")) {
                setConnectionStatus("room_full");
            } else {
                setConnectionStatus("error");
            }
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
  // eslint-disable-next-line react-hooks/exhaustive-deps 
  }, [gameId, playerCountParam, router]); // Removed toast from deps as it's stable


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
    // Client sends its 'myPlayerId' along with the secret. Server will verify.
    socket.emit('send-secret', { gameId, playerId: myPlayerId, secret: currentDigits });
    localStorage.setItem(`mySecret_${gameId}_${myPlayerId}`, JSON.stringify(currentDigits));
    
    // UI updates to 'hasSubmittedSecret' will primarily be driven by 'secret-update' or 'game-state-update' from server
    // toast({ title: `Your Secret Sent!`, description: "Waiting for server confirmation and other players..." });
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
  
  if (connectionStatus === "connecting") {
     return (
      <div className="flex flex-col items-center justify-center min-h-[calc(100vh-200px)] py-8">
        <Card className="w-full max-w-lg mx-auto shadow-xl">
          <CardHeader className="text-center">
            <CardTitle className="text-3xl text-primary flex items-center justify-center">
              <Loader2 className="mr-3 h-8 w-8 animate-spin" /> Connecting...
            </CardTitle>
            <CardDescription className="pt-2">Establishing connection to the game server.</CardDescription>
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

  const getWaitingMessage = () => {
    if (!myPlayerId) return "Assigning your player ID...";
    if (!allPlayersJoined || actualPlayersInGame < expectedPlayerCount) {
        return `Waiting for players... (${actualPlayersInGame > 0 ? actualPlayersInGame : '?'}/${expectedPlayerCount > 0 ? expectedPlayerCount : '?'})`;
    }
    if (secretsActuallySet < expectedPlayerCount) { 
        return `Waiting for secrets... (${secretsActuallySet}/${expectedPlayerCount})`;
    }
    return "All secrets set. Starting game soon...";
  }


  return (
    <div className="flex flex-col items-center justify-center min-h-[calc(100vh-200px)] py-8">
      <Card className="w-full max-w-lg mx-auto shadow-xl">
        <CardHeader className="text-center">
          <CardTitle className="text-3xl text-primary flex items-center justify-center">
            {myPlayerId ? <UserCheck className="mr-3 h-8 w-8" /> : <LockKeyhole className="mr-3 h-8 w-8" />}
            {myPlayerId ? `You are ${myPlayerId}` : "Connecting..."}
          </CardTitle>
          <CardDescription className="pt-2">
            Game ID: <span className="font-mono text-sm text-accent">{gameId}</span> ({playerCountParam}) <br/>
            {!hasSubmittedSecret && myPlayerId && allPlayersJoined &&
              `Enter a ${CODE_LENGTH}-digit number. No 3 or 4 identical consecutive digits.`
            }
            {(hasSubmittedSecret || !allPlayersJoined || !myPlayerId || (allPlayersJoined && secretsActuallySet < expectedPlayerCount)) &&
                <span className="flex items-center justify-center mt-2"><Hourglass className="mr-2 h-4 w-4 animate-spin" /> {getWaitingMessage()}</span>
            }
             {!myPlayerId && connectionStatus === "connected" && <span className="flex items-center justify-center mt-2"><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Waiting for player assignment...</span>}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {myPlayerId && allPlayersJoined && !hasSubmittedSecret && (
            <div className="space-y-6">
              <DigitInput
                count={CODE_LENGTH}
                values={currentDigits}
                onChange={setCurrentDigits}
                disabled={isSubmittingSecret}
                ariaLabel={`Secret digit for ${myPlayerId}`}
              />
              <Button onClick={handleSecretSubmit} className="w-full" disabled={isSubmittingSecret} size="lg">
                {isSubmittingSecret ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Submitting...</> : `Confirm ${myPlayerId}'s Secret`}
              </Button>
            </div>
          )}
          {hasSubmittedSecret && (
             <p className="text-center text-lg text-green-500">Your secret is locked in! Waiting for others or game start.</p>
          )}
        </CardContent>
         <CardFooter className="flex flex-col items-center">
            <p className="text-xs text-muted-foreground">Players: {actualPlayersInGame}/{expectedPlayerCount > 0 ? expectedPlayerCount : (playerCountParam === "duo" ? 2 : playerCountParam === "trio" ? 3 : 4)} | Secrets Set: {secretsActuallySet}</p>
         </CardFooter>
      </Card>
    </div>
  );
}
