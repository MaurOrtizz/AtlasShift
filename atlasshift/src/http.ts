export async function requestJSON<T>(url: string, options?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, options);
  } catch {
    throw new Error('Cannot reach the server. Check your connection and try again.');
  }
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    const detail = typeof body?.detail === 'string' ? body.detail : response.statusText;
    throw new Error(`Request failed (${response.status})${detail ? `: ${detail}` : ''}`);
  }
  if (response.status === 204) return undefined as T;
  try {
    return await response.json() as T;
  } catch {
    throw new Error('The server returned an invalid response.');
  }
}
