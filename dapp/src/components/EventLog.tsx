"use client";

import type { LoggedEvent } from "@/hooks/useProviderEvents";

interface Props {
  events: LoggedEvent[];
}

export function EventLog({ events }: Props) {
  if (events.length === 0) {
    return (
      <pre className="output muted" data-testid="event-log">
        No events yet. Nothing emits them until phase 5 — see the manual checks for how to
        fire one by hand from the service worker console.
      </pre>
    );
  }

  return (
    <ul className="event-list" data-testid="event-log">
      {events.map((event) => (
        <li key={event.id}>
          <span className="event-time">{event.at}</span>
          <span className="event-name">{event.name}</span>
          <span className="event-data">{JSON.stringify(event.data)}</span>
        </li>
      ))}
    </ul>
  );
}
