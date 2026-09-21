import { requestJSON } from './http';
import type { WorldData } from './world';
export type { WorldData, BackgroundBounds } from './world';

const BASE_URL = (import.meta.env.VITE_API_URL || 'http://localhost:8000').replace(/\/$/, '');

export const api = {
  getWorlds: () => requestJSON<WorldData[]>(`${BASE_URL}/worlds`),
  getWorld: (id: number) => requestJSON<WorldData>(`${BASE_URL}/worlds/${id}`),
  createWorld: (data: WorldData) => requestJSON<WorldData>(`${BASE_URL}/worlds`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
  }),
  updateWorld: (id: number, data: WorldData) => requestJSON<WorldData>(`${BASE_URL}/worlds/${id}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
  }),
  deleteWorld: (id: number) => requestJSON<void>(`${BASE_URL}/worlds/${id}`, { method: 'DELETE' }),
  async uploadBackgroundImage(file: File): Promise<{ url: string }> {
    const formData = new FormData();
    formData.append('file', file);
    const data = await requestJSON<{ url: string }>(`${BASE_URL}/uploads/background-image`, {
      method: 'POST', body: formData,
    });
    return { url: /^https?:\/\//i.test(data.url) ? data.url : `${BASE_URL}${data.url}` };
  },
};
