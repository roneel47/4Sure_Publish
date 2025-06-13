
"use client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useAuth } from "@/contexts/AuthContext";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { Users, User, ArrowRight } from "lucide-react";
import Image from "next/image";

export default function ModeSelectPage() {
  const { isLoggedIn, isAuthLoading, username } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!isAuthLoading && !isLoggedIn) {
      router.replace("/");
    }
  }, [isLoggedIn, isAuthLoading, router]);

  if (isAuthLoading || !isLoggedIn) {
    return (
      <div className="flex-grow flex flex-col items-center justify-center p-4 min-h-screen bg-background">
        <p>Loading user session...</p>
      </div>
    );
  }

  return (
    <main className="flex-grow flex flex-col items-center justify-center p-4 min-h-screen bg-background">
      <Card className="w-full max-w-md shadow-xl">
        <CardHeader className="text-center">
          <div className="flex justify-center mb-4">
            <Image src="/logo.svg" alt="4Sure Logo" width={120} height={36} />
          </div>
          <CardTitle className="text-3xl">Welcome, {username || 'Player'}!</CardTitle>
          <CardDescription className="pt-2 text-lg">
            Choose your game mode:
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Button 
            onClick={() => router.push('/setup')} 
            className="w-full" 
            size="lg"
            variant="outline"
          >
            <User className="mr-2 h-5 w-5" /> Single Player (vs Computer)
            <ArrowRight className="ml-auto h-5 w-5" />
          </Button>
          <Button 
            onClick={() => router.push('/multiplayer-setup')} 
            className="w-full" 
            size="lg"
          >
            <Users className="mr-2 h-5 w-5" /> Multiplayer
            <ArrowRight className="ml-auto h-5 w-5" />
          </Button>
        </CardContent>
      </Card>
    </main>
  );
}
