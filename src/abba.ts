// desk-recorder: minimal Abba HTTP client. Abba runs locally
// (default http://127.0.0.1:3013, overridable via ABBA_URL). Posting a note
// requires a member bearer token: set ABBA_TOKEN to the `abba_token` value
// from your Abba browser tab's localStorage.
export function abbaBase(): string {
  const raw = process.env.ABBA_URL || "http://127.0.0.1:3013";
  return raw.replace(/\/+$/, "");
}

export function abbaToken(): string {
  return process.env.ABBA_TOKEN || "";
}

export class AbbaError extends Error {
  /** HTTP status from Abba, or 0 when Abba couldn't be reached at all. */
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "AbbaError";
    this.status = status;
  }
}

async function abbaFetch(base: string, token: string, path: string, init?: RequestInit): Promise<any> {
  let res: Response;
  try {
    res = await fetch(base + path, {
      ...init,
      headers: { ...(init?.headers || {}), authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10000),
    });
  } catch (e: unknown) {
    const why = e instanceof Error ? e.message : String(e);
    throw new AbbaError(0, `Abba not reachable at ${base} — is Abba running? (${why})`);
  }
  let body: any = {};
  try {
    body = await res.json();
  } catch {
    /* non-JSON error page — fall through to the generic message */
  }
  if (!res.ok) {
    throw new AbbaError(res.status, String(body?.error || `Abba request failed (${res.status})`));
  }
  return body;
}

export interface AbbaNoteInput {
  title: string;
  body: string;
  tags?: string[];
  /** default false: the note lands in your private notepad; share it from Abba */
  shared?: boolean;
}

/** Create a note in Abba. Returns the new note's id. */
export async function createAbbaNote(
  base: string,
  token: string,
  note: AbbaNoteInput
): Promise<{ id: string }> {
  const out = await abbaFetch(base, token, "/api/notes", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      title: note.title,
      body: note.body,
      tags: note.tags || [],
      shared: note.shared === true,
    }),
  });
  if (!out.note || out.note.id === undefined || out.note.id === null) {
    throw new AbbaError(500, "Abba created the note but returned no id");
  }
  return { id: String(out.note.id) };
}
