
"use client";
import { useState } from 'react';
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Label } from "@/components/ui/label";
import { Input } from '@/components/ui/input';
import { Users, UserPlus, LogIn, ArrowLeft, Gamepad2, Server, CheckCircle, User, ArrowRight } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useToast } from '@/hooks/use-toast';

type MultiplayerStep = "playerCount" | "hostJoin";
type PlayerCount = "duo" | "trio" | "quads" | null;
type HostJoin = "host" | "join" | null;

export default function MultiplayerSetupPage() {
  const router = useRouter();
  const { toast } = useToast();
  const [step, setStep] = useState<MultiplayerStep>("playerCount");
  const [playerCount, setPlayerCount] = useState<PlayerCount>("duo"); // Default to duo for smoother testing
  const [hostJoin, setHostJoin] = useState<HostJoin>(null);
  const [gameId, setGameId] = useState<string>("");
  const [generatedGameId, setGeneratedGameId] = useState<string | null>(null);

  const handlePlayerCountSelect = (value: string) => {
    setPlayerCount(value as PlayerCount);
  };

  const handleHostJoinSelect = (value: string) => {
    setHostJoin(value as HostJoin);
    if (value === "host") {
      const newGameId = `GAME${Math.floor(1000 + Math.random() * 9000)}`;
      setGeneratedGameId(newGameId);
      setGameId(newGameId); // Also set gameId for consistency if they switch back and forth
    } else {
      setGeneratedGameId(null); // Clear generated if switching to join
    }
  };

  const proceedToNextStep = () => {
    if (step === "playerCount" && playerCount) {
      setStep("hostJoin");
    } else if (step === "hostJoin" && hostJoin) {
      const finalGameId = hostJoin === 'host' ? generatedGameId : gameId;
      if (finalGameId && playerCount) {
        router.push(`/multiplayer-secret-setup?gameId=${finalGameId.toUpperCase()}&playerCount=${playerCount}`);
      } else {
        toast({
          title: "Setup Incomplete",
          description: "Please ensure a game ID is entered or generated, and player count is selected.",
          variant: "destructive",
        });
      }
    }
  };

  const goBack = () => {
    if (step === "hostJoin") {
      setStep("playerCount");
      setHostJoin(null);
      setGeneratedGameId(null);
      setGameId(""); // Reset gameId when going back to player count selection
    } else if (step === "playerCount") {
      router.push('/mode-select');
    }
  };
  
  const getPlayerCountText = (count: PlayerCount) => {
    if (count === "duo") return "2 Players";
    if (count === "trio") return "3 Players";
    if (count === "quads") return "4 Players";
    return "";
  }

  return (
    <div className="flex flex-col items-center justify-center min-h-[calc(100vh-200px)] py-8">
      <Card className="w-full max-w-lg shadow-xl">
        <CardHeader>
          <div className="flex items-center justify-between">
            <Button variant="ghost" size="icon" onClick={goBack} className={step === "playerCount" ? "invisible" : ""}>
              <ArrowLeft className="h-5 w-5" />
            </Button>
            <CardTitle className="text-2xl sm:text-3xl text-primary flex-grow text-center">
              <Users className="inline-block mr-3 h-7 w-7 sm:h-8 sm:h-8" />
              Multiplayer Setup
            </CardTitle>
            <div className="w-10"> {/* Spacer to balance the back button */}</div>
          </div>
          {step === "playerCount" && (
            <CardDescription className="text-center pt-2">
              Choose the number of players for your game.
            </CardDescription>
          )}
          {step === "hostJoin" && playerCount && (
            <CardDescription className="text-center pt-2">
              You've selected <span className="font-semibold text-primary">{getPlayerCountText(playerCount)}</span>. Now, host a new game or join an existing one.
            </CardDescription>
          )}
        </CardHeader>

        <CardContent className="space-y-6">
          {step === "playerCount" && (
            <RadioGroup
              onValueChange={handlePlayerCountSelect}
              value={playerCount || ""}
              className="grid grid-cols-1 gap-4"
            >
              {[
                { value: "duo", label: "Duo (2 Players)", icon: <User className="mr-2 h-5 w-5"/> },
                // { value: "trio", label: "Trio (3 Players)", icon: <Users className="mr-2 h-5 w-5"/> },
                // { value: "quads", label: "Quads (4 Players)", icon: <Gamepad2 className="mr-2 h-5 w-5"/> },
              ].map((option) => (
                <Label
                  key={option.value}
                  htmlFor={`player-count-${option.value}`}
                  className={`flex items-center space-x-3 rounded-md border-2 p-4 cursor-pointer transition-all hover:border-primary ${
                    playerCount === option.value ? 'border-primary ring-2 ring-primary bg-primary/10' : 'border-border'
                  }`}
                >
                  <RadioGroupItem value={option.value} id={`player-count-${option.value}`} className="h-5 w-5"/>
                  {option.icon}
                  <span className="font-semibold text-base">{option.label}</span>
                </Label>
              ))}
                <p className="text-xs text-center text-muted-foreground">Trio & Quads modes coming soon!</p>
            </RadioGroup>
          )}

          {step === "hostJoin" && (
            <RadioGroup 
              onValueChange={handleHostJoinSelect} 
              value={hostJoin || ""}
              className="grid grid-cols-1 md:grid-cols-2 gap-4"
            >
              {[
                { value: "host", label: "Host New Game", icon: <Server className="mr-2 h-5 w-5"/> },
                { value: "join", label: "Join Existing Game", icon: <UserPlus className="mr-2 h-5 w-5"/> },
              ].map((option) => (
                <Label
                  key={option.value}
                  htmlFor={`host-join-${option.value}`}
                  className={`flex flex-col items-center justify-center space-y-2 rounded-md border-2 p-6 cursor-pointer transition-all hover:border-primary h-32 ${
                    hostJoin === option.value ? 'border-primary ring-2 ring-primary bg-primary/10' : 'border-border'
                  }`}
                >
                  <RadioGroupItem value={option.value} id={`host-join-${option.value}`} className="h-5 w-5 sr-only"/> {/* Hidden but functional */}
                  {option.icon}
                  <span className="font-semibold text-base">{option.label}</span>
                   {hostJoin === option.value && <CheckCircle className="h-5 w-5 text-primary" />}
                </Label>
              ))}
            </RadioGroup>
          )}
          
          {step === "hostJoin" && hostJoin === 'join' && (
            <div className="space-y-2">
              <Label htmlFor="game-id-input">Enter Game ID</Label>
              <Input 
                id="game-id-input" 
                placeholder="e.g., GAME1234" 
                value={gameId} 
                onChange={(e) => setGameId(e.target.value.toUpperCase())}
                className="text-center tracking-wider"
              />
            </div>
          )}

          {step === "hostJoin" && hostJoin === 'host' && generatedGameId && (
            <Card className="bg-muted/50 p-4 text-center">
              <CardDescription>Share this Game ID with others:</CardDescription>
              <CardTitle className="text-2xl text-primary font-mono tracking-widest py-2">{generatedGameId}</CardTitle>
              <Button variant="outline" size="sm" onClick={() => {
                  navigator.clipboard.writeText(generatedGameId);
                  toast({title: "Copied!", description: "Game ID copied to clipboard."})
                }}>Copy ID</Button>
            </Card>
          )}

        </CardContent>

        <CardFooter className="flex flex-col gap-4">
           {(step === "playerCount" && playerCount) || (step === "hostJoin" && hostJoin && (hostJoin === 'host' || (hostJoin === 'join' && gameId))) ? (
            <Button onClick={proceedToNextStep} className="w-full" size="lg">
              {step === "playerCount" ? "Next: Host or Join" : (hostJoin === "host" ? "Start Hosting" : "Join Game")}
              <ArrowRight className="ml-2 h-5 w-5" />
            </Button>
          ) : (
             <Button className="w-full" size="lg" disabled>
              {step === "playerCount" ? "Select Player Count" : (hostJoin === 'join' ? "Enter Game ID" : "Choose an Option")}
            </Button>
          )}
           <Button variant="link" onClick={() => router.push('/mode-select')} className="text-sm">
            Back to Mode Select
          </Button>
        </CardFooter>
      </Card>
    </div>
  );
}

