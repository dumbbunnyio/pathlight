export class ActivitySubscriptions {
  private readonly sessions = new Map<string, { ticket: symbol; phase: "pending" | "watching" }>();

  begin(session: string) {
    const previous = this.sessions.get(session);
    if (previous?.phase === "pending") throw new Error("Activity attachment is already pending for this session.");
    if (!previous && this.sessions.size >= 8) throw new Error("Already observing or attaching eight sessions. Stop one before attaching another.");
    const ticket = Symbol(session);
    this.sessions.set(session, { ticket, phase: previous?.phase ?? "pending" });
    return ticket;
  }

  complete(session: string, ticket: symbol) {
    if (this.sessions.get(session)?.ticket !== ticket) return false;
    this.sessions.set(session, { ticket, phase: "watching" });
    return true;
  }

  fail(session: string, ticket: symbol) {
    const entry = this.sessions.get(session);
    if (entry?.ticket === ticket && entry.phase === "pending") this.sessions.delete(session);
  }

  watching(session: string) { return this.sessions.get(session)?.phase === "watching"; }
  stop(session: string) { this.sessions.delete(session); }
  clear() { this.sessions.clear(); }
}
