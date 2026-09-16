import type { Geometry, GeoJsonProperties } from 'geojson';

const BASE_URL = import.meta.env.VITE_API_URL;

export type BackgroundBounds = [
  [number, number],
  [number, number],
  [number, number],
  [number, number]
];

export interface WorldData {
  id?: number;
  name: string;
  edits: Record<string, { name: string; color: string; geometry?: Geometry | null; properties?: GeoJsonProperties }>;
  background_image?: string | null;
  background_bounds?: BackgroundBounds | null;
}

function resolveUrl(url: string): string {
  if (/^https?:\/\//i.test(url)) return url;
  return `${BASE_URL}${url}`;
}

export const api = {
  async getWorlds(): Promise<WorldData[]> {
    const res = await fetch(`${BASE_URL}/worlds`);
    return res.json();
  },

  async createWorld(data: WorldData): Promise<WorldData> {
    const res = await fetch(`${BASE_URL}/worlds`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    return res.json();
  },

  async updateWorld(id: number, data: WorldData): Promise<WorldData> {
    const res = await fetch(`${BASE_URL}/worlds/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    return res.json();
  },

  async deleteWorld(id: number): Promise<void> {
    await fetch(`${BASE_URL}/worlds/${id}`, { method: 'DELETE' });
  },

  async uploadBackgroundImage(file: File): Promise<{ url: string }> {
    const formData = new FormData();
    formData.append('file', file);
    const res = await fetch(`${BASE_URL}/uploads/background-image`, {
      method: 'POST',
      body: formData
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: 'Upload failed' }));
      throw new Error(err.detail ?? 'Upload failed');
    }
    const data = await res.json();
    return { url: resolveUrl(data.url) };
  }
};