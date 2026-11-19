import { useEffect, useState } from 'react';
import { Bell, ChevronRight, LoaderCircle, Search } from 'lucide-react';
import { Sidebar, type TabId, tabs } from './components/Sidebar';
import { Toast } from './components/Toast';
import { Analytics } from './components/tabs/Analytics';
import { ChannelDNA } from './components/tabs/ChannelDNA';
import { AgentBrain } from './components/tabs/AgentBrain';
import { GeminiStudio } from './components/tabs/GeminiStudio';
import { Settings } from './components/tabs/Settings';
import { useApp } from './context/AppContext';
import { api } from './lib/api';

const pages = { analytics: Analytics, dna: ChannelDNA, brain: AgentBrain, studio: GeminiStudio, settings: Settings };

export default function App() {
  const { channels, channelId, setChannelId, loading, error, notice, setNotice } = useApp();
  const [activeTab, setActiveTab] = useState<TabId>('analytics');
  const [dark, setDark] = useState(localStorage.getItem('dimag-theme') !== 'light');
  const [connecting, setConnecting] = useState(false);
  const Page = pages[activeTab];
  const title = tabs.find((tab) => tab.id === activeTab)?.label || 'Analytics';
  const databaseUnavailable = error.toLowerCase().includes('database is unavailable');

  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    localStorage.setItem('dimag-theme', dark ? 'dark' : 'light');
  }, [dark]);
  useEffect(() => {
    const url = new URL(window.location.href);
    const error = url.searchParams.get('error');
    const message = url.searchParams.get('message');
    const reason = url.searchParams.get('reason');
    if (error === 'oauth') {
      const detail = reason === 'google-code-expired'
        ? 'Google auth code expired or was already used. Please reconnect the channel and try again.'
        : message || 'YouTube authentication failed. Please try again.';
      setNotice(detail);
      url.search = ''; window.history.replaceState({}, '', url);
    } else if (url.searchParams.get('connected') === '1') {
      setNotice(`YouTube connected. ${url.searchParams.get('channelCount') || '0'} channel(s) discovered.`);
      url.search = ''; window.history.replaceState({}, '', url);
    }
  }, [setNotice]);

  async function connect() {
    setConnecting(true);
    try {
      const result = await api<{ url: string }>('/youtube/auth-url');
      window.location.assign(result.url);
    } catch (reason) { setNotice(reason instanceof Error ? reason.message : 'Could not start YouTube authorization.'); setConnecting(false); }
  }

  return <div className="app-shell">
    <Sidebar channels={channels} channelId={channelId} onChannelChange={setChannelId} activeTab={activeTab} onTabChange={setActiveTab} onConnect={connect} dark={dark} onToggleTheme={() => setDark(!dark)} />
    <main className="main-shell">
      <header className="topbar"><div className="breadcrumb"><span>Studio</span><ChevronRight size={14} /><strong>{title}</strong></div><div className="topbar-actions"><div className="topbar-search"><Search size={14} /><span>Search your studio</span><kbd>⌘ K</kbd></div><button className="top-icon" aria-label="Notifications"><Bell size={17} /><i /></button><span className="topbar-divider" /><div className="user-avatar">D</div></div></header>
      <div className="main-content">
        {loading && channels.length === 0 ? <div className="loading-screen"><LoaderCircle size={22} className="spin" /><span>Waking up your studio…</span></div> : error && channels.length === 0 ? <div className="setup-state"><div className="setup-orb">✳</div><span className="section-kicker">YOUR CREATOR WORKSPACE</span><h1>{databaseUnavailable ? <>Database<br />connection needed<span className="heading-period">.</span></> : <>Let’s get your channel<br />in the room<span className="heading-period">.</span></>}</h1><p>{error}</p>{!databaseUnavailable && <button className="button button-primary" onClick={connect} disabled={connecting}>{connecting ? 'Opening Google…' : 'Connect your YouTube channel'}<ChevronRight size={16} /></button>}<span className="setup-caption">{databaseUnavailable ? 'Your saved channel data is protected; restore the MongoDB connection to continue.' : 'Your channel’s data stays isolated from every other channel.'}</span></div> : channels.length === 0 ? <div className="setup-state"><div className="setup-orb">✳</div><span className="section-kicker">YOUR CREATOR WORKSPACE</span><h1>Let’s get your channel<br />in the room<span className="heading-period">.</span></h1><p>Connect a YouTube channel to build its creative DNA, chat with Dimag, and create your first Short.</p><button className="button button-primary" onClick={connect} disabled={connecting}>{connecting ? 'Opening Google…' : 'Connect your YouTube channel'}<ChevronRight size={16} /></button><span className="setup-caption">Your channel’s data stays isolated from every other channel.</span></div> : <Page key={channelId + activeTab} />}
      </div>
      <footer className="app-footer"><span>✳ dimag</span><span>Built for thoughtful creators</span><span>{databaseUnavailable ? 'DATABASE UNAVAILABLE' : 'ALL SYSTEMS OPERATIONAL'} <i /></span></footer>
    </main>
    <Toast message={notice} onClose={() => setNotice('')} error={Boolean(error && channels.length > 0)} />
  </div>;
}
