import { useEffect, useState } from 'react';
import { api, type WorldData } from '../api';

interface WorldsPanelProps {
  onLoad: (world: WorldData) => void;
  onClose: () => void;
  currentWorldId: number | null;
  onDeleteCurrent: () => void;
  busy: boolean;
}

function WorldsPanel({ onLoad, onClose, currentWorldId, onDeleteCurrent, busy }: WorldsPanelProps) {
  const [worlds, setWorlds] = useState<WorldData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);

  useEffect(() => {
    let active = true;
    api.getWorlds()
      .then(data => { if (active) setWorlds(data); })
      .catch(error => { if (active) setError(error instanceof Error ? error.message : 'Could not load worlds.'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  const handleDelete = async (id: number) => {
    if (!window.confirm('Delete this saved world? This cannot be undone.')) return;
    setDeletingId(id);
    setError(null);
    try {
      await api.deleteWorld(id);
      setWorlds(prev => prev.filter(w => w.id !== id));
      if (id === currentWorldId) onDeleteCurrent();
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Could not delete the world.');
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div style={{
      position: 'absolute',
      top: 52,
      right: 70,
      width: 300,
      height: 'calc(100vh - 52px)',
      background: 'white',
      boxShadow: '-2px 0 8px rgba(0,0,0,0.15)',
      padding: 24,
      fontFamily: 'sans-serif',
      display: 'flex',
      flexDirection: 'column',
      gap: 16,
      overflowY: 'auto',
      zIndex: 10
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h2 style={{ margin: 0, fontSize: 18 }}>My Worlds</h2>
        <button onClick={onClose} style={{ cursor: 'pointer', border: 'none', background: 'none', fontSize: 20 }}>✕</button>
      </div>

      {loading && <p style={{ color: '#666' }}>Loading...</p>}
      {error && <p role="alert" style={{ color: '#b91c1c' }}>{error}</p>}

      {!loading && !error && worlds.length === 0 && (
        <p style={{ color: '#666' }}>No saved worlds yet.</p>
      )}

      {worlds.map(world => (
        <div key={world.id} style={{
          border: '1px solid #eee',
          borderRadius: 8,
          padding: 12,
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center'
        }}>
          <span style={{ fontSize: 14, fontWeight: 500 }}>{world.name}</span>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              onClick={() => onLoad(world)}
              disabled={busy || deletingId !== null}
              style={{
                padding: '4px 10px',
                borderRadius: 4,
                border: 'none',
                background: '#4f46e5',
                color: 'white',
                cursor: 'pointer',
                fontSize: 12
              }}
            >
              Load
            </button>
            <button
              onClick={() => handleDelete(world.id!)}
              disabled={busy || deletingId !== null}
              style={{
                padding: '4px 10px',
                borderRadius: 4,
                border: '1px solid #fca5a5',
                background: 'transparent',
                color: '#ef4444',
                cursor: 'pointer',
                fontSize: 12
              }}
            >
              Delete
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

export default WorldsPanel;
