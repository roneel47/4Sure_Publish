
"use client";
import { useEffect, useState, useCallback } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import DigitInput from '@/components/game/DigitInput';
import { CODE_LENGTH, isValidDigitSequence } from '@/lib/gameLogic';
import { useToast } from '@/hooks/use-toast';
import { LockKeyhole, Users, ArrowRight, Loader2 } from 'lucide-react';
import useLocalStorage from '@/hooks/useLocalStorage';
import type { Socket as ClientSocket } from 'socket.io-client';
import { io } from 'socket.io-client';

type PlayerSecrets = {
  [key: string]: string[] | null; // e.g., "player1": ["1", "2", "3", "4"], "player2": null
};

export default function MultiplayerSecretSetupPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { toast } = useToast();

  const gameId = searchParams.get('gameId');
  const playerCountParam = searchParams.get('playerCount'); // "duo", "trio", "quads"
  const numberOfPlayers = playerCountParam === "duo" ? 2 : playerCountParam === "trio" ? 3 : playerCountParam === "quads" ? 4 : 0;

  const [currentPlayerIndex, setCurrentPlayerIndex] = useState(0); // 0 for Player 1, 1 for Player 2, etc.
  const [secrets, setSecrets] = useLocalStorage<PlayerSecrets>(`multiplayer-secrets-${gameId}`, {});
  const [currentDigits, setCurrentDigits] = useState<string[]>(Array(CODE_LENGTH).fill(''));
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [socket, setSocket] = useState<ClientSocket | null>(null);
  const [allSecretsSet, setAllSecretsSet] = useState(false);

  // Initialize Socket.IO connection
  useEffect(() => {
    // Ensure server-side socket.io is initialized
    fetch('/api/socketio', { method: 'POST' })
      .then((res) => res.json())
      .then((data) => {
        console.log('Socket.IO server init response:', data.message);
        
        // Connect to the Socket.IO server
        // The path option must match the server-side configuration
        const newSocket = io({ path: '/api/socketio_c', addTrailingSlash: false });
        setSocket(newSocket);

        newSocket.on('connect', () => {
          console.log('Connected to Socket.IO server with ID:', newSocket.id);
          if (gameId) {
            newSocket.emit('join-game', gameId);
          }
        });

        newSocket.on('joined-room', (joinedGameId: string) => {
          console.log(`Successfully joined room: ${joinedGameId}`);
          toast({ title: "Connected", description: `Joined game room: ${gameId}` });
        });
        
        newSocket.on('secret-update', (data: { playerId: string; secretSet: boolean }) => {
          console.log('Secret update received from server:', data);
          // This is where you'd update UI to show other players have set their secret
          // For now, just logging
          toast({ title: "Opponent Update", description: `${data.playerId} has set their secret.` });
           // Potentially update a shared state or re-check if all secrets are set
        });

        newSocket.on('disconnect', () => {
          console.log('Disconnected from Socket.IO server');
          toast({ title: "Disconnected", variant: "destructive" });
        });

        newSocket.on('connect_error', (err) => {
          console.error('Socket connection error:', err);
          toast({ title: "Connection Error", description: `Failed to connect: ${err.message}`, variant: "destructive" });
        });
        
        return () => {
          if (newSocket) {
            console.log('Disconnecting socket...');
            newSocket.disconnect();
          }
        };
      })
      .catch(error => {
        console.error("Failed to initialize socket connection:", error);
        toast({ title: "Connection Setup Failed", description: "Could not contact the game server.", variant: "destructive" });
      });
  }, [gameId, toast]);


  const totalPlayers = numberOfPlayers; // For now, assuming "duo"
  const localPlayerId = `player${currentPlayerIndex + 1}`; // Simple local ID

  const handleSecretSubmit = async () => {
    if (currentDigits.some(digit => digit === '') || currentDigits.length !== CODE_LENGTH) {
      toast({ title: "Invalid Secret", description: `Please enter all ${CODE_LENGTH} digits.`, variant: "destructive" });
      return;
    }
    if (!isValidDigitSequence(currentDigits)) {
      toast({ title: "Invalid Secret Pattern", description: `Code cannot have 3 or 4 identical consecutive digits.`, variant: "destructive" });
      return;
    }

    setIsSubmitting(true);
    const newSecrets = { ...secrets, [localPlayerId]: [...currentDigits] };
    setSecrets(newSecrets);

    if (socket) {
      socket.emit('send-secret', { gameId, playerId: localPlayerId, secret: currentDigits });
    }
    
    toast({ title: `Player ${currentPlayerIndex + 1} Secret Set!`, description: "Waiting for other players..." });

    if (currentPlayerIndex < totalPlayers - 1) {
      setCurrentPlayerIndex(prev => prev + 1);
      setCurrentDigits(Array(CODE_LENGTH).fill(''));
    } else {
      // All secrets are set (locally for now)
      setAllSecretsSet(true);
      toast({ title: "All Secrets Set!", description: "Proceeding to game..." });
    }
    setIsSubmitting(false);
  };

  useEffect(() => {
    // Check if all secrets are set
    let allSet = true;
    if(totalPlayers > 0) {
      for (let i = 0; i < totalPlayers; i++) {
        if (!secrets[`player${i + 1}`]) {
          allSet = false;
          break;
        }
      }
    } else {
      allSet = false; // No players defined, so not all set
    }

    if (allSet && totalPlayers > 0) {
      setAllSecretsSet(true);
    } else {
      setAllSecretsSet(false);
    }
  }, [secrets, totalPlayers]);


  if (!gameId || !playerCountParam || totalPlayers === 0) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[calc(100vh-200px)] py-8">
        <Card className="w-full max-w-md text-center">
          <CardHeader>
            <CardTitle>Error</CardTitle>
          </CardHeader>
          <CardContent>
            <p>Invalid game setup parameters. Please go back and try again.</p>
            <Button onClick={() => router.push('/mode-select')} className="mt-4">Back to Mode Select</Button>
          </CardContent>
        </Card>
      </div>
    );
  }
  
  if (!socket) {
     return (
      <div className="flex flex-col items-center justify-center min-h-[calc(100vh-200px)] py-8">
        <Card className="w-full max-w-lg mx-auto shadow-xl">
          <CardHeader className="text-center">
            <CardTitle className="text-3xl text-primary flex items-center justify-center">
              <Loader2 className="mr-3 h-8 w-8 animate-spin" /> Connecting to Game Server...
            </CardTitle>
            <CardDescription className="pt-2">
              Please wait while we establish a connection for your multiplayer game.
            </CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }


  return (
    <div className="flex flex-col items-center justify-center min-h-[calc(100vh-200px)] py-8">
      <Card className="w-full max-w-lg mx-auto shadow-xl">
        <CardHeader className="text-center">
          <CardTitle className="text-3xl text-primary flex items-center justify-center">
            <LockKeyhole className="mr-3 h-8 w-8" /> 
            {allSecretsSet ? "All Secrets Set!" : `Player ${currentPlayerIndex + 1}, Set Your Secret`}
          </CardTitle>
          <CardDescription className="pt-2">
            Game ID: <span className="font-mono text-sm text-accent">{gameId}</span> ({playerCountParam}) <br/>
            {allSecretsSet 
              ? "Ready to start the game."
              : `Enter a ${CODE_LENGTH}-digit number. No 3 or 4 identical consecutive digits.`
            }
          </CardDescription>
        </CardHeader>
        <CardContent>
          {!allSecretsSet ? (
            <div className="space-y-6">
              <DigitInput
                count={CODE_LENGTH}
                values={currentDigits}
                onChange={setCurrentDigits}
                disabled={isSubmitting}
                ariaLabel={`Secret digit for Player ${currentPlayerIndex + 1}`}
              />
              <Button onClick={handleSecretSubmit} className="w-full" disabled={isSubmitting} size="lg">
                {isSubmitting ? 'Submitting...' : `Confirm Player ${currentPlayerIndex + 1}'s Secret`}
              </Button>
            </div>
          ) : (
            <div className="text-center">
              <p className="text-lg mb-4">All players have set their secrets!</p>
              <Users className="mx-auto h-12 w-12 text-primary mb-4" />
            </div>
          )}
        </CardContent>
        <CardFooter>
          {allSecretsSet && (
            <Button 
              onClick={() => router.push(`/multiplayer-play?gameId=${gameId}&playerCount=${playerCountParam}`)} 
              className="w-full" 
              size="lg"
            >
              Start Game <ArrowRight className="ml-2 h-5 w-5" />
            </Button>
          )}
        </CardFooter>
      </Card>
    </div>
  );
}
