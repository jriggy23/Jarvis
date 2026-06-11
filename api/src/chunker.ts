/**
 * Incremental sentence/clause chunker. Feed streamed brain tokens in; it emits
 * complete chunks at sentence or clause boundaries so each can be sent to TTS
 * before the full answer is generated (plan §5.3). Call flush() at end-of-turn
 * to release any trailing partial text.
 */
export class SentenceChunker {
  private buffer = "";

  /** Boundary chars: end-of-sentence and strong clause separators. */
  private static readonly BOUNDARY = /[.!?;:](\s|$)/;

  push(token: string): string[] {
    this.buffer += token;
    const out: string[] = [];

    // Repeatedly peel off the leading complete chunk.
    let match: RegExpMatchArray | null;
    while ((match = this.buffer.match(SentenceChunker.BOUNDARY))) {
      const end = (match.index ?? 0) + 1; // include the boundary punctuation
      const chunk = this.buffer.slice(0, end).trim();
      this.buffer = this.buffer.slice(end);
      if (chunk.length > 0) out.push(chunk);
    }
    return out;
  }

  flush(): string | null {
    const remaining = this.buffer.trim();
    this.buffer = "";
    return remaining.length > 0 ? remaining : null;
  }
}
