import { useState } from 'react';
import { ArrowUpRight, Check, ExternalLink, KeyRound, LoaderCircle, Server, ShieldCheck, Sparkles, Youtube } from 'lucide-react';
import { useApp } from '../../context/AppContext';
import { api } from '../../lib/api';

export function Settings() {
  const { channels, channelId, refresh, setNotice } = useApp();
  const [connecting, setConnecting] = useState(false);
  const [queueingHisa, setQueueingHisa] = useState(false);
  const activeChannel = channels.find((channel) => channel.channelId === channelId);
  async function connect() {
    setConnecting(true);
    try {
      const result = await api<{ url: string }>('/youtube/auth-url');
      window.location.assign(result.url);
    } catch (error) { setNotice(error instanceof Error ? error.message : 'Could not start Google OAuth.'); setConnecting(false); }
  }
  async function queueHisaTest() {
    if (!channelId || queueingHisa) return;
    setQueueingHisa(true);
    try {
      const result = await api<{ ok: boolean; jobId: string; status: string }>('/hisa/enqueue-test', {
        method: 'POST',
        body: JSON.stringify({ channelId })
      });
      if (!result.ok || !result.jobId) throw new Error('The Hisa test job was not queued.');
      setNotice(`Queued for Hisa Flow worker — check Hugging Face Space. Job ID: ${result.jobId}`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not queue a Hisa Flow test job.');
    } finally {
      setQueueingHisa(false);
    }
  }
  return <div className="page-stack">
    <div className="page-heading-row"><div><div className="eyebrow"><span className="eyebrow-line" /> PREFERENCES & ACCESS</div><h1>Studio settings<span className="heading-period">.</span></h1><p className="page-subtitle">Manage the channel connections and infrastructure behind your creator studio.</p></div><button className="button button-secondary" onClick={() => void refresh()}>Refresh connections</button></div>
    <div className="settings-layout">
      <section className="panel settings-panel"><div className="section-heading"><div><span className="section-kicker">YOUTUBE CONNECTION</span><h2>Your connected channels</h2></div><Youtube className="setting-icon youtube-icon" size={19} /></div><p className="settings-copy">Channels have separate creative blueprints and learning memory. Add another Google account or brand channel at any time.</p>
        <div className="connected-list">{channels.map((channel) => <div className="connected-channel" key={channel.channelId}><img src={channel.thumbnailUrl || ''} alt="" /><span><strong>{channel.channelTitle}</strong><small>{channel.channelId}</small></span><span className="connected-status"><Check size={13} /> CONNECTED</span></div>)}{channels.length === 0 && <div className="connected-empty"><span className="empty-icon"><Youtube size={20} /></span><strong>No channels connected</strong><span>Authorize YouTube to begin setting up your studio.</span></div>}</div>
        <button className="button button-primary connect-button" onClick={connect} disabled={connecting}><Youtube size={16} />{connecting ? 'Opening Google…' : 'Connect YouTube channel'}<ArrowUpRight size={15} /></button>
        <div className="settings-note"><strong>Flow AI worker test</strong><p>{activeChannel ? `Queue a fresh Hisa Flow job for ${activeChannel.channelTitle}. It uses this channel’s saved creative blueprint and skips local fallback rendering.` : 'Select a connected channel to queue a Hisa Flow test job.'}</p><button className="button button-secondary" onClick={() => void queueHisaTest()} disabled={!channelId || queueingHisa}>{queueingHisa ? <LoaderCircle size={15} className="spin" /> : <Sparkles size={15} />}{queueingHisa ? 'Queueing test job…' : 'Queue Hisa Flow Test Job'}</button></div>
      </section>
      <section className="panel settings-panel"><div className="section-heading"><div><span className="section-kicker">PRIVACY & SAFETY</span><h2>Built to stay in bounds</h2></div><ShieldCheck className="setting-icon" size={19} /></div><div className="setting-list"><div className="setting-row"><span className="setting-row-icon"><KeyRound size={16} /></span><span><strong>Encrypted OAuth tokens</strong><small>Refresh tokens use AES-256-GCM at rest.</small></span><span className="setting-check"><Check size={14} /></span></div><div className="setting-row"><span className="setting-row-icon"><Server size={16} /></span><span><strong>One render at a time</strong><small>A global worker lock keeps memory use predictable.</small></span><span className="setting-check"><Check size={14} /></span></div><div className="setting-row"><span className="setting-row-icon"><ShieldCheck size={16} /></span><span><strong>Channel-scoped memory</strong><small>Scripts and performance notes stay with their channel.</small></span><span className="setting-check"><Check size={14} /></span></div></div><div className="settings-note"><strong>Before your first upload</strong><p>Set the channel privacy, title suffix, and description footer in Channel DNA. A manual publish uses that channel’s saved visibility.</p></div></section>
    </div>
    <a className="docs-link" href="https://console.cloud.google.com/apis/library/youtube.googleapis.com" target="_blank" rel="noreferrer">Google API setup guide <ExternalLink size={13} /></a>
  </div>;
}
