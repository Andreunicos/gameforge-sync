import { useEffect, useState } from "react";
import { collection, limit, onSnapshot, orderBy, query } from "firebase/firestore";
import { db } from "../firebase";
import { colorFor } from "../auth";
import type { ActivityEvent } from "../types";

function ago(ms: number) {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return "agora";
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  if (s < 86400) return `${Math.floor(s / 3600)} h`;
  return `${Math.floor(s / 86400)} d`;
}

export function ActivityFeed({ roomId }: { roomId: string }) {
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [, tick] = useState(0);

  useEffect(() => {
    const q = query(collection(db, "rooms", roomId, "activity"), orderBy("ts", "desc"), limit(25));
    return onSnapshot(q, (snap) => setEvents(snap.docs.map((d) => ({ id: d.id, ...d.data() }) as ActivityEvent)));
  }, [roomId]);

  useEffect(() => {
    const t = window.setInterval(() => tick((n) => n + 1), 30_000);
    return () => window.clearInterval(t);
  }, []);

  return (
    <div className="activity">
      <div className="side-head">
        <span className="title">Atividade</span>
      </div>
      <ul>
        {events.length === 0 && <li className="muted">Nada ainda.</li>}
        {events.map((e) => (
          <li key={e.id}>
            <span className="who" style={{ color: colorFor(e.author.uid) }}>
              {e.author.kind === "claude" ? `Claude de ${e.author.name}` : e.author.name}
            </span>{" "}
            {e.summary} <span className="when">· {e.ts ? ago(e.ts.toMillis()) : "agora"}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
