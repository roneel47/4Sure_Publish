
"use client";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/contexts/AuthContext";
import { useRouter } from "next/navigation";
import { Play, RefreshCw } from "lucide-react";
import Image from "next/image";

export default function LoginForm() {
  const { login, isLoggedIn } = useAuth();
  const router = useRouter();
  const [inputUsername, setInputUsername] = useState("");

  const handleGenerateRandomName = () => {
    const randomSuffix = Math.floor(1000 + Math.random() * 9000);
    const newUsername = `Player_${randomSuffix}`;
    setInputUsername(newUsername);
  };

  const handleLogin = () => {
    login(inputUsername.trim() || undefined); // Pass trimmed username or undefined to generate random
    router.push("/mode-select"); // Changed from /setup to /mode-select
  };

  if (isLoggedIn) {
    // This case should ideally be handled by redirect in page.tsx or layout.tsx
    // For robustness, if user is logged in and somehow lands here, redirect.
    if (typeof window !== 'undefined') router.push("/mode-select"); // Changed
    return null;
  }

  return (
    <Card className="w-full max-w-md shadow-xl">
      <CardHeader className="text-center">
        <div className="flex justify-center mb-2">
          <Image src="/logo.svg" alt="4Sure Logo" width={180} height={54} priority />
        </div>
        <CardDescription className="text-muted-foreground pt-2">
          Guess the secret 4-digit number before your opponent does!
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col items-center space-y-6">
        <div className="w-full space-y-2">
          <Label htmlFor="username-input">Choose Your Name</Label>
          <div className="flex items-center space-x-2">
            <Input
              id="username-input"
              placeholder="Enter name or leave blank for random"
              value={inputUsername}
              onChange={(e) => setInputUsername(e.target.value)}
              className="flex-grow"
            />
            <Button
              variant="outline"
              size="icon"
              onClick={handleGenerateRandomName}
              aria-label="Generate random name"
              title="Generate random name"
            >
              <RefreshCw className="h-4 w-4" />
            </Button>
          </div>
        </div>
        <p className="text-center text-sm text-muted-foreground">
          Enter your name, or use the refresh button for a random one.
          If left blank, a random name will be assigned.
        </p>
        <Button onClick={handleLogin} className="w-full" size="lg">
          <Play className="mr-2 h-5 w-5" /> Login to Play
        </Button>
      </CardContent>
    </Card>
  );
}
