import { v4 as uuidv4 } from "uuid";
import { ChatMessage } from "./providers/types";

export interface Session {
  id: string;
  activeVoiceId: string;
  speakResponses: boolean;
  history: ChatMessage[];
  createdAt: string;
}

export interface SessionConfigUpdate {
  activeVoiceId?: string;
  speakResponses?: boolean;
}

/**
 * In-memory session storage. NOTE: a plain Map is process-local and therefore
 * NOT durable across replicas or restarts. Fine for the single always-on
 * replica in v1; swap for a shared store (Redis / Cosmos) before scaling out.
 */
export class SessionStore {
  private readonly sessions = new Map<string, Session>();
  private readonly defaultVoiceId: string;

  constructor(defaultVoiceId: string) {
    this.defaultVoiceId = defaultVoiceId;
  }

  create(): Session {
    const session: Session = {
      id: uuidv4(),
      activeVoiceId: this.defaultVoiceId,
      speakResponses: true,
      history: [],
      createdAt: new Date().toISOString(),
    };
    this.sessions.set(session.id, session);
    return session;
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  update(id: string, patch: SessionConfigUpdate): Session | undefined {
    const session = this.sessions.get(id);
    if (!session) return undefined;
    if (typeof patch.activeVoiceId === "string") {
      session.activeVoiceId = patch.activeVoiceId;
    }
    if (typeof patch.speakResponses === "boolean") {
      session.speakResponses = patch.speakResponses;
    }
    return session;
  }

  appendMessage(id: string, message: ChatMessage): void {
    const session = this.sessions.get(id);
    if (session) session.history.push(message);
  }
}
