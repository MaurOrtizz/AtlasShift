interface NavbarProps {
  onSave: () => void;
  onMyWorlds: () => void;
  allowOverlapping: boolean;
  onToggleOverlapping: () => void;
}

function Navbar({ onSave, onMyWorlds, allowOverlapping, onToggleOverlapping }: NavbarProps) {
  return (
    <div style={{
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      height: 52,
      background: '#1a1a2e',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: '0 24px',
      zIndex: 20,
    }}>
      <span style={{ color: 'white', fontFamily: 'sans-serif', fontWeight: 600, fontSize: 16 }}>
        AtlasShift
      </span>
      <div style={{ display: 'flex', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ color: 'white', fontFamily: 'sans-serif', fontSize: 14 }}>
            Allow Overlapping
          </span>
          <div
            onClick={onToggleOverlapping}
            style={{
              width: 44,
              height: 24,
              borderRadius: 12,
              background: allowOverlapping ? '#4f46e5' : '#ffffff30',
              cursor: 'pointer',
              position: 'relative',
              transition: 'background 0.2s',
              flexShrink: 0
            }}
          >
            <div style={{
              position: 'absolute',
              top: 3,
              left: allowOverlapping ? 23 : 3,
              width: 18,
              height: 18,
              borderRadius: '50%',
              background: 'white',
              transition: 'left 0.2s',
            }} />
          </div>
        </div>
        <button
          onClick={onMyWorlds}
          style={{
            padding: '6px 16px',
            borderRadius: 6,
            border: '1px solid #ffffff40',
            background: 'transparent',
            color: 'white',
            cursor: 'pointer',
            fontFamily: 'sans-serif',
            fontSize: 14
          }}
        >
          My Worlds
        </button>
        <button
          onClick={onSave}
          style={{
            padding: '6px 16px',
            borderRadius: 6,
            border: 'none',
            background: '#4f46e5',
            color: 'white',
            cursor: 'pointer',
            fontFamily: 'sans-serif',
            fontSize: 14
          }}
        >
          Save
        </button>
      </div>
    </div>
  );
}

export default Navbar;
