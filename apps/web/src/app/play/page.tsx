import type { Metadata } from "next";
import GameLoader from "@/components/GameLoader";

export const metadata: Metadata = { title: "Postmark · Fly" };

export default function PlayPage() {
  return <GameLoader />;
}
