import { useRef } from 'react';

interface SidebarProps {
  isAddingCountry: boolean;
  onToggleAddCountry: () => void;
  onImportCountries: (file: File) => void;
  onExportCountries: () => void;
  hasCustomBackground: boolean;
  onUploadBackgroundImage: (file: File) => void;
  onResetBackgroundImage: () => void;
}

const iconButtonStyle = (active: boolean) => ({
  width: 36,
  height: 36,
  border: 'none',
  borderRadius: 6,
  background: active ? '#4f46e5' : 'transparent',
  color: 'white',
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontSize: 18
});

const dividerStyle = {
  height: 1,
  background: 'rgba(255,255,255,0.15)',
  margin: '4px 2px'
};

function Sidebar({
  isAddingCountry,
  onToggleAddCountry,
  onImportCountries,
  onExportCountries,
  hasCustomBackground,
  onUploadBackgroundImage,
  onResetBackgroundImage,
}: SidebarProps) {
  const countriesFileInputRef = useRef<HTMLInputElement>(null);
  const backgroundFileInputRef = useRef<HTMLInputElement>(null);

  return (
    <div style={{
      position: 'absolute',
      top: '50%',
      transform: 'translateY(-50%)',
      right: 16,
      display: 'flex',
      flexDirection: 'column',
      gap: 4,
      background: '#1a1a2e',
      borderRadius: 8,
      padding: 6,
      zIndex: 20
    }}>
      <button
        onClick={onToggleAddCountry}
        title="Add Polygon"
        style={iconButtonStyle(isAddingCountry)}
      >
        ⬡
      </button>

      <div style={dividerStyle} />

      <input
        ref={countriesFileInputRef}
        type="file"
        accept=".geojson,.json,application/geo+json,application/json"
        style={{ display: 'none' }}
        onChange={e => {
          const file = e.target.files?.[0];
          if (file) onImportCountries(file);
          e.target.value = '';
        }}
      />
      <button
        onClick={() => countriesFileInputRef.current?.click()}
        title="Import Countries GeoJSON"
        style={iconButtonStyle(false)}
      >
        🗺⬆
      </button>
      <button
        onClick={onExportCountries}
        title="Export Countries GeoJSON"
        style={iconButtonStyle(false)}
      >
        🗺⬇
      </button>

      <div style={dividerStyle} />

      <input
        ref={backgroundFileInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        style={{ display: 'none' }}
        onChange={e => {
          const file = e.target.files?.[0];
          if (file) onUploadBackgroundImage(file);
          e.target.value = '';
        }}
      />
      <button
        onClick={() => backgroundFileInputRef.current?.click()}
        title="Upload Background Map"
        style={iconButtonStyle(false)}
      >
        ▣
      </button>
      {hasCustomBackground && (
        <button
          onClick={() => {
            const confirmed = window.confirm('Reset to the default world map?');
            if (confirmed) onResetBackgroundImage();
          }}
          title="Reset to Default Map"
          style={iconButtonStyle(false)}
        >
          ↺
        </button>
      )}
    </div>
  );
}

export default Sidebar;