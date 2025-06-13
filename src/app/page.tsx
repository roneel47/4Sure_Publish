
"use client";
import LoginForm from "@/components/auth/LoginForm";
import { useAuth } from "@/contexts/AuthContext";
import { useRouter } from "next/navigation";
import { useEffect } from "react";

export default function LoginPage() {
  const { isLoggedIn, isAuthLoading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!isAuthLoading && isLoggedIn) {
      router.replace("/mode-select"); // Changed from /setup to /mode-select
    }
  }, [isLoggedIn, isAuthLoading, router]);

  if (isAuthLoading) {
    return (
      <div className="flex-grow flex flex-col items-center justify-center p-4">
        <p>Loading...</p>
      </div>
    );
  }

  if (isLoggedIn) {
    // This state will be hit if user is logged in AFTER isAuthLoading is false,
    // but before the useEffect redirects. Should be very brief.
    return (
      <div className="flex-grow flex flex-col items-center justify-center p-4">
        <p>Loading...</p>
      </div>
    ); 
  }

  return (
    <main className="flex-grow flex flex-col items-center justify-center p-4 bg-background">
      <div className="z-10">
        <LoginForm />
      </div>
    </main>
  );
}
