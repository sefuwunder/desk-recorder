// desk-recorder: minimal Ascent HTTP client. Ascent runs locally
// (default http://127.0.0.1:3004, overridable via ASCENT_URL) and its API
// is localhost-only by design, so no auth is needed here.
export const ASCENT_PROJECT = "Desk Recorder";

export function ascentBase(): string {
  const raw = process.env.ASCENT_URL || "http://127.0.0.1:3004";
  return raw.replace(/\/+$/, "");
}

export class AscentError extends Error {
  /** HTTP status from Ascent, or 0 when Ascent couldn't be reached at all. */
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "AscentError";
    this.status = status;
  }
}

async function ascentFetch(base: string, path: string, init?: RequestInit): Promise<any> {
  let res: Response;
  try {
    res = await fetch(base + path, { ...init, signal: AbortSignal.timeout(10000) });
  } catch (e: unknown) {
    const why = e instanceof Error ? e.message : String(e);
    throw new AscentError(0, `Ascent not reachable at ${base} — is Ascent running? (${why})`);
  }
  let body: any = {};
  try {
    body = await res.json();
  } catch {
    /* non-JSON error page — fall through to the generic message */
  }
  if (!res.ok) {
    throw new AscentError(res.status, String(body?.error || `Ascent request failed (${res.status})`));
  }
  return body;
}

/** Find the named project, creating it when absent. Returns its id + name. */
export async function findOrCreateProject(
  base: string,
  name: string = ASCENT_PROJECT
): Promise<{ id: string; name: string }> {
  const list = await ascentFetch(base, "/api/projects");
  const found = (list.projects || []).find((p: any) => p && p.name === name);
  if (found) return { id: String(found.id), name: String(found.name) };
  const created = await ascentFetch(base, "/api/projects", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, icon: "🎙️" }),
  });
  if (!created.project || !created.project.id) {
    throw new AscentError(500, "Ascent created the project but returned no id");
  }
  return { id: String(created.project.id), name: String(created.project.name) };
}

/** Create a task in a project. Returns the new task's id. */
export async function createAscentTask(
  base: string,
  projectId: string,
  title: string,
  notes?: string
): Promise<{ id: string }> {
  const out = await ascentFetch(base, `/api/projects/${encodeURIComponent(projectId)}/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title, notes: notes || "" }),
  });
  if (!out.task || !out.task.id) {
    throw new AscentError(500, "Ascent created the task but returned no id");
  }
  return { id: String(out.task.id) };
}
