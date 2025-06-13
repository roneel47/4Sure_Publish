
"use client";
import Header from "@/components/layout/Header";
import { useAuth } from "@/contexts/AuthContext";
import { useRouter, usePathname } from "next/navigation"; // Added usePathname
import { useEffect } from "react";

export default function GameLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { isLoggedIn, isAuthLoading } = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (!isAuthLoading && !isLoggedIn) {
      // Only redirect if trying to access a game-specific path directly without being logged in.
      // Paths like /mode-select are handled by their own logic or are public.
      if (pathname.startsWith('/setup') || pathname.startsWith('/play') || pathname.startsWith('/multiplayer-setup')) {
        router.replace("/");
      }
    }
  }, [isLoggedIn, isAuthLoading, router, pathname]);

  if (isAuthLoading) {
    return (
      <div className="flex-grow flex flex-col items-center justify-center p-4">
        <p>Loading session...</p>
      </div>
    ); 
  }

  // If trying to access game specific path and not logged in after loading, show redirecting message
  if (!isLoggedIn && (pathname.startsWith('/setup') || pathname.startsWith('/play') || pathname.startsWith('/multiplayer-setup'))) {
    return (
      <div className="flex-grow flex flex-col items-center justify-center p-4">
        <p>Redirecting to login...</p>
      </div>
    );
  }
  
  // If logged in, render the layout, or if on a public path (like /mode-select, handled by its own page)
  // this condition might also pass if children are for non-game routes that still use this layout.
  // The primary check for redirect is above.
  if (isLoggedIn) {
    return (
      <div className="flex flex-col min-h-screen">
        <Header />
        <main className="flex-grow container mx-auto p-4 sm:p-6 md:p-8">
          {children}
        </main>
      </div>
    );
  }

  // Fallback for any other unhandled case, though ideally covered.
  // This allows pages not strictly requiring login but under this layout (if any) to render.
  // Or, if a public page like /mode-select was mistakenly put under this layout, it would render.
  // For strict auth on all (game) routes, the above isLoggedIn checks are key.
  return <>{children}</>;
}
