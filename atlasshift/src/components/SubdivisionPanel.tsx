import { useState } from 'react';

interface SubdivisionData {
  name: string;
  color: string;
}

interface SubdivisionPanelProps {
  data: SubdivisionData;
  parentName: string;
  onChange: (data: SubdivisionData) => void;
  onClose: () => void;
  onDeleteSubdivision: () => void;
  isEditing: boolean;
  editError: string;
  onEditBorders: () => void;
  onDoneEditing: () => void;
  onCancelEditing: () => void;
}

const buttonStyle = (bg: string) => ({
  padding: '8px 16px',
  borderRadius: 6,
  border: 'none',
  background: bg,
  color: 'white',
  cursor: 'pointer',
  fontSize: 14,
  fontFamily: 'sans-serif'
});

function SubdivisionPanel({ data, parentName, onChange, onClose, onDeleteSubdivision, isEditing, editError, onEditBorders, onDoneEditing, onCancelEditing }: SubdivisionPanelProps) {
  const [localColor, setLocalColor] = useState(data.color);

  return (
    <div style={{
      position: 'absolute',
      top: 52,
      right: 70,
      width: 300,
      height: 'fit-content',
      maxHeight: 'calc(100vh - 52px)',
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
      <div style={{ position: 'relative', padding: '0 28px', textAlign: 'center' }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 12, color: '#666', fontWeight: 600 }}>SUBDIVISION</div>
          <div style={{ fontSize: 13, color: '#444', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            Inside {parentName}
          </div>
        </div>
        <button aria-label="Close subdivision panel" onClick={onClose} style={{ position: 'absolute', right: 0, top: 0, cursor: 'pointer', border: 'none', background: 'none', fontSize: 18, color: '#666' }}>x</button>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <label style={{ fontSize: 12, color: '#666', fontWeight: 600 }}>NAME</label>
        <input
          type="text"
          value={data.name}
          onChange={e => onChange({ ...data, name: e.target.value })}
          style={{
            padding: '8px 12px',
            border: '1px solid #ddd',
            borderRadius: 6,
            fontSize: 14
          }}
        />
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <label style={{ fontSize: 12, color: '#666', fontWeight: 600 }}>COLOR</label>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <input
            type="color"
            value={localColor}
            onInput={e => setLocalColor((e.target as HTMLInputElement).value)}
            onBlur={() => onChange({ ...data, color: localColor })}
            style={{ width: 48, height: 36, cursor: 'pointer', border: 'none' }}
          />
          <span style={{ fontSize: 14, color: '#444' }}>{localColor}</span>
        </div>
      </div>

      {isEditing ? (
        <>
          <p style={{ fontSize: 13, color: '#444', margin: 0 }}>
            Drag a vertex to move it, click a border to add one, or right-click a vertex to remove it.
            Select Done to fit the boundary inside {parentName} and apply the overlap setting.
          </p>
          {editError && <p role="alert" style={{ fontSize: 13, color: '#b91c1c', margin: 0 }}>{editError}</p>}
          <button onClick={onDoneEditing} style={buttonStyle('#16a34a')}>Done</button>
          <button onClick={onCancelEditing} style={buttonStyle('#6b7280')}>Cancel Border Edit</button>
        </>
      ) : (
        <>
          <button onClick={onEditBorders} style={buttonStyle('#4f46e5')}>Edit Borders</button>
          <button onClick={onDeleteSubdivision} style={buttonStyle('#dc2626')}>Delete Subdivision</button>
        </>
      )}
    </div>
  );
}

export default SubdivisionPanel;
