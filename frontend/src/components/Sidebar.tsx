import { useState } from 'react';
import { BrainCircuit, ChevronDown, Clapperboard, LayoutDashboard, MessageSquareText, Moon, Plus, Settings2, Sparkles, Sun } from 'lucide-react';
import type { Channel } from '../types';

export type TabId = 'analytics' | 'dna' | 'brain' | 'studio' | 'settings';

const tabs: { id: TabId; label: string; icon: typeof LayoutDashboard }[] = [
  { id: 'analytics', label: 'Analytics', icon: LayoutDashboard },
  { id: 'dna', label: 'Channel DNA', icon: Sparkles },
  { id: 'brain', label: 'Agent Brain', icon: BrainCircuit },
  { id: 'studio', label: 'Gemini Studio', icon: MessageSquareText },
  { id: 'settings', label: 'Settings', icon: Settings2 }
];

export function Sidebar({ channels, channelId, onChannelChange, onTabChange, activeTab, onConnect, dark, onToggleTheme }: {
  channels: Channel[]; channelId: string; onChannelChange: (id: string) => void;
  onTabChange: (tab: TabId) => void; activeTab: TabId; onConnect: () => void;
  dark: boolean; onToggleTheme: () => void;
}) {
  const [open, setOpen] = useState(false);
  const selected = channels.find((channel) => channel.channelId === channelId);
  return (
    <aside className="sidebar">
      <a className="brand" href="#" onClick={(event) => event.preventDefault()}>
        <span className="brand-mark"><BrainCircuit size={21} /></span>
        <span><strong>dimag</strong><small>CREATOR STUDIO</small></span>
      </a>
      <div className="workspace-label">WORKSPACE</div>
      <div className="channel-picker-wrap">
        <button className="channel-picker" onClick={() => setOpen(!open)}>
          {selected?.thumbnailUrl ? <img src={selected.thumbnailUrl} alt="" /> : <span className="avatar-placeholder"><Clapperboard size={16} /></span>}
          <span className="channel-title"><strong>{selected?.channelTitle || 'Connect a channel'}</strong><small>{selected ? 'YouTube channel' : 'Get started'}</small></span>
          <ChevronDown size={16} className={open ? 'rotate' : ''} />
        </button>
        {open && <div className="channel-menu">
          {channels.map((channel) => <button key={channel.channelId} onClick={() => { onChannelChange(channel.channelId); setOpen(false); }}>
            <img src={channel.thumbnailUrl || ''} alt="" /><span>{channel.channelTitle}</span>{channelId === channel.channelId && <i />}
          </button>)}
          <button className="connect-option" onClick={() => { setOpen(false); onConnect(); }}><Plus size={15} /> Connect YouTube channel</button>
        </div>}
      </div>
      <nav className="nav-list" aria-label="Main navigation">
        <div className="workspace-label">STUDIO</div>
        {tabs.map(({ id, label, icon: Icon }) => <button key={id} onClick={() => onTabChange(id)} className={`nav-item ${activeTab === id ? 'active' : ''}`}>
          <Icon size={18} strokeWidth={1.8} /><span>{label}</span>{id === 'brain' && <span className="nav-dot" />}
        </button>)}
      </nav>
      <div className="sidebar-bottom">
        <div className="plan-card"><div className="plan-icon"><Clapperboard size={17} /></div><div><strong>Creator Studio</strong><small>One channel at a time</small></div><span className="plan-dot" /></div>
        <button className="theme-toggle" onClick={onToggleTheme}>{dark ? <Sun size={16} /> : <Moon size={16} />}<span>{dark ? 'Light appearance' : 'Dark appearance'}</span><kbd>{dark ? '☼' : '◐'}</kbd></button>
        <div className="sidebar-footer"><span className="online-dot" /> Systems operational <span>v2.0.0</span></div>
      </div>
    </aside>
  );
}

export { tabs };
