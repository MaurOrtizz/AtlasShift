import { useState } from 'react';

interface CountryData {
  name: string;
  color: string;
}

interface CountryPanelProps {
  countryName: string;
  data: CountryData;
  onChange: (data: CountryData) => void;
  onClose: () => void;
  editingCountry: string | null;
  editMode: 'vertices' | 'draw' | null;
  onEnterEditMode: () => void;
  onSetEditMode: (mode: 'vertices' | 'draw' | null) => void;
  onDoneEditing: () => void;
  isAbsorbing: boolean;
  onStartAbsorb: () => void;
  onCancelAbsorb: () => void;
  onDeleteCountry: () => void;
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


function CountryPanel({ countryName, data, onChange, onClose, editingCountry, editMode, onEnterEditMode, onSetEditMode, onDoneEditing, isAbsorbing, onStartAbsorb, onCancelAbsorb, onDeleteCountry }: CountryPanelProps) {  
  const [localColor, setLocalColor] = useState(data.color);
  const [renderedCountryName, setRenderedCountryName] = useState(countryName);

  if (countryName !== renderedCountryName) {
    setRenderedCountryName(countryName);
    setLocalColor(data.color);
  }

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
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button onClick={onClose} style={{ cursor: 'pointer', border: 'none', background: 'none', fontSize: 18, color: '#666' }}>✕</button>
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
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {isAbsorbing ? (
          <>
            <p style={{ fontSize: 13, color: '#444', margin: 0 }}>
              Click another country on the map to absorb {countryName} into it.
            </p>
            <button onClick={onCancelAbsorb} style={buttonStyle('#6b7280')}>
              Cancel
            </button>
          </>
        ) : editingCountry !== countryName ? (
          <>
            <button onClick={onEnterEditMode} style={buttonStyle('#4f46e5')}>
              Edit Borders
            </button>
            <button onClick={onStartAbsorb} style={buttonStyle('#ea580c')}>
              Absorb Into...
            </button>
            <button onClick={onDeleteCountry} style={buttonStyle('#dc2626')}>
              Delete Country
            </button>
          </>
        ) : (
          <>
            <button
              onClick={() => onSetEditMode(editMode === 'vertices' ? null : 'vertices')}
              style={buttonStyle(editMode === 'vertices' ? '#16a34a' : '#4f46e5')}
            >
              Edit Vertices
            </button>
            <button
              onClick={() => onSetEditMode(editMode === 'draw' ? null : 'draw')}
              style={buttonStyle(editMode === 'draw' ? '#16a34a' : '#4f46e5')}
            >
              Draw Territory
            </button>

            <button onClick={onDoneEditing} style={buttonStyle('#dc2626')}>
              Done
            </button>
          </>
        )}
      </div>
    </div>
  );
}

export default CountryPanel;