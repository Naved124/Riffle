// Edge case: TypeScript React (.tsx) with interfaces, generics and an import from a shadcn-style
// path alias ("@/components/ui/card") that doesn't exist outside the original artifact environment — must be stubbed.
// Short keys (q / a), true/false + yes/no answers, and answers with alternatives in parentheses.
import { useState, useEffect, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Eye, EyeOff, ArrowRight } from "lucide-react";

interface Flashcard {
  q: string;
  a: string;
  tags?: string[];
}

const CARDS: Flashcard[] = [
  { q: "Default signal sent by `kill` with no options?", a: "SIGTERM (15)", tags: ["signals"] },
  { q: "Can SIGKILL be caught or ignored by a process?", a: "False", tags: ["signals"] },
  { q: "Signal sent to a process when you press Ctrl+C?", a: "SIGINT (2)" },
  { q: "Does `nohup` make a process ignore SIGHUP?", a: "Yes" },
  { q: "PID of the init/systemd process?", a: "1" },
  { q: "Command to list running processes with full details?", a: "ps aux" },
  { q: "What is a zombie process?", a: "A process that has finished executing but still has an entry in the process table because its parent has not yet read its exit status." },
  { q: "SIGSTOP can be ignored by a process.", a: "False" },
];

export default function SignalsDeck(): JSX.Element {
  const [i, setI] = useState<number>(0);
  const [reveal, setReveal] = useState<boolean>(false);

  const next = useCallback(() => {
    setReveal(false);
    setI((prev) => (prev + 1) % CARDS.length);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter") next();
      if (e.key === " ") setReveal((r) => !r);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [next]);

  const card = CARDS[i] as Flashcard;

  return (
    <div className="min-h-screen bg-slate-900 flex items-center justify-center p-8">
      <Card className="w-full max-w-lg bg-slate-800 text-slate-100 border-slate-700">
        <CardHeader>
          <CardTitle className="text-sm text-slate-400">Process signals · {i + 1}/{CARDS.length}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          <p className="text-xl">{card.q}</p>
          {reveal && <p className="text-2xl font-mono text-emerald-400">{card.a}</p>}
          <div className="flex gap-3">
            <Button onClick={() => setReveal(!reveal)} className="flex items-center gap-2 bg-slate-700 px-4 py-2 rounded">
              {reveal ? <EyeOff size={16} /> : <Eye size={16} />} {reveal ? "Hide" : "Reveal"}
            </Button>
            <Button onClick={next} className="flex items-center gap-2 bg-emerald-600 px-4 py-2 rounded">
              Next <ArrowRight size={16} />
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
