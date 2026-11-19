import { useEffect, useState, type FormEvent } from 'react';
import { ArrowUpRight, Check, Clock3, Copy, ExternalLink, KeyRound, Server, ShieldCheck, Youtube } from 'lucide-react';
import { useApp } from '../../context/AppContext';
import { api } from '../../lib/api';

const WEBHOOK_URL = 'https://youtubi.onrender.com/api/automation/trigger';

export function Settings() {
  const { channels, channelId, profile, refresh, saveSchedule, setNotice } = useApp();
  const [connecting, setConnecting] = useState(false);
  const [autoPublishEnabled, setAutoPublishEnabled] = useState(true);
  const [publishTimeIst, setPublishTimeIst] = useState('16:00');
  const [savingSchedule, setSavingSchedule] = useState(false);
  const [scheduleSaved, setScheduleSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  const activeChannel = channels.find((channel) => channel.channelId === channelId);
  useEffect(() => {
    setAutoPublishEnabled(profile?.autoPublishEnabled ?? true);
    setPublishTimeIst(profile?.publishTimeIst || '16:00');
  }, [profile, channelId]);

  async function connect() {
    setConnecting(true);
    try {
      const result = await api<{ url: string }>('/youtube/auth-url');
      window.location.assign(result.url);
    } catch (error) { setNotice(error instanceof Error ? error.message : 'Could not start Google OAuth.'); setConnecting(false); }
  }
  async function submitSchedule(event: FormEvent) {
    event.preventDefault();
    setSavingSchedule(true);
    setScheduleSaved(false);
    try {
      const saved = await saveSchedule({ autoPublishEnabled, publishTimeIst });
      setAutoPublishEnabled(saved.autoPublishEnabled);
      setPublishTimeIst(saved.publishTimeIst);
      setScheduleSaved(true);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not save this channel schedule.');
    } finally { setSavingSchedule(false); }
  }
  async function copyWebhookUrl() {
    try {
      await navigator.clipboard.writeText(WEBHOOK_URL);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setNotice('Could not copy the webhook URL. Select and copy it manually.');
    }
  }

  return <div className="page-stack">
    <div className="page-heading-row"><div><div className="eyebrow"><span className="eyebrow-line" /> PREFERENCES & ACCESS</div><h1>Studio settings<span className="heading-period">.</span></h1><p className="page-subtitle">Manage the channel connections and infrastructure behind your creator studio.</p></div><button className="button button-secondary" onClick={() => void refresh()}>Refresh connections</button></div>
    <div className="settings-layout">
      <section className="panel settings-panel"><div className="section-heading"><div><span className="section-kicker">YOUTUBE CONNECTION</span><h2>Your connected channels</h2></div><Youtube className="setting-icon youtube-icon" size={19} /></div><p className="settings-copy">Channels have separate creative blueprints and learning memory. Add another Google account or brand channel at any time.</p>
        <div className="connected-list">{channels.map((channel) => <div className="connected-channel" key={channel.channelId}><img src={channel.thumbnailUrl || ''} alt="" /><span><strong>{channel.channelTitle}</strong><small>{channel.channelId}</small></span><span className="connected-status"><Check size={13} /> CONNECTED</span></div>)}{channels.length === 0 && <div className="connected-empty"><span className="empty-icon"><Youtube size={20} /></span><strong>No channels connected</strong><span>Authorize YouTube to begin setting up your studio.</span></div>}</div>
        <button className="button button-primary connect-button" onClick={connect} disabled={connecting}><Youtube size={16} />{connecting ? 'Opening Google…' : 'Connect YouTube channel'}<ArrowUpRight size={15} /></button>
        <div className="settings-note"><strong>Native publishing pipeline</strong><p>{activeChannel ? `Shorts for ${activeChannel.channelTitle} are generated, rendered with backend FFmpeg, and uploaded directly from this service.` : 'Connect a channel to use the native FFmpeg rendering and publishing pipeline.'}</p></div>
      </section>
      <section className="panel settings-panel"><div className="section-heading"><div><span className="section-kicker">PRIVACY & SAFETY</span><h2>Built to stay in bounds</h2></div><ShieldCheck className="setting-icon" size={19} /></div><div className="setting-list"><div className="setting-row"><span className="setting-row-icon"><KeyRound size={16} /></span><span><strong>Encrypted OAuth tokens</strong><small>Refresh tokens use AES-256-GCM at rest.</small></span><span className="setting-check"><Check size={14} /></span></div><div className="setting-row"><span className="setting-row-icon"><Server size={16} /></span><span><strong>One render at a time</strong><small>A global worker lock keeps memory use predictable.</small></span><span className="setting-check"><Check size={14} /></span></div><div className="setting-row"><span className="setting-row-icon"><ShieldCheck size={16} /></span><span><strong>Channel-scoped memory</strong><small>Scripts and performance notes stay with their channel.</small></span><span className="setting-check"><Check size={14} /></span></div></div><div className="settings-note"><strong>Before your first upload</strong><p>Set the channel privacy, title suffix, and description footer in Channel DNA. A manual publish uses that channel’s saved visibility.</p></div></section>
      <section className="panel settings-panel schedule-settings-panel">
        <div className="section-heading"><div><span className="section-kicker">CHANNEL AUTOMATION</span><h2>Daily Auto-Upload Schedule (IST)</h2></div><span className="timezone-badge"><Clock3 size={13} /> ASIA/KOLKATA · UTC+05:30</span></div>
        <form className="schedule-settings-form" onSubmit={(event) => void submitSchedule(event)}>
          <div className="schedule-settings-controls">
            <div className="schedule-row">
              <div className="schedule-info"><strong>Auto-Upload Enabled</strong><span>{activeChannel ? `Schedule for ${activeChannel.channelTitle}` : 'Select a connected channel to configure its schedule.'}</span></div>
              <button type="button" className={`switch ${autoPublishEnabled ? 'switch-on' : ''}`} role="switch" aria-label="Auto-Upload Enabled" aria-checked={autoPublishEnabled} disabled={!channelId} onClick={() => { setAutoPublishEnabled((enabled) => !enabled); setScheduleSaved(false); }}><span /></button>
            </div>
            <label className="field schedule-time-field"><span>Daily publish time <small>Asia/Kolkata (IST)</small></span><input type="time" value={publishTimeIst} required disabled={!channelId} onChange={(event) => { setPublishTimeIst(event.target.value); setScheduleSaved(false); }} /></label>
            <div className="schedule-save-row"><span className="save-hint">{scheduleSaved && <><Check size={14} /> Schedule saved for this channel</>}</span><button className="button button-primary" disabled={savingSchedule || !channelId}>{savingSchedule ? 'Saving…' : 'Save Schedule'}</button></div>
          </div>
          <div className="webhook-card">
            <div className="webhook-heading"><div><strong>cron-job.org Webhook URL</strong><small>Daily trigger for scheduled uploads</small></div><button type="button" className="button button-secondary webhook-copy" onClick={() => void copyWebhookUrl()}>{copied ? <Check size={14} /> : <Copy size={14} />}{copied ? 'Copied' : 'Copy URL'}</button></div>
            <input className="webhook-url" aria-label="Cron webhook URL" readOnly value={WEBHOOK_URL} onFocus={(event) => event.currentTarget.select()} />
            <p>Set the cron-job.org timezone to Asia/Kolkata and trigger this URL daily at this channel’s exact IST time. If channels use different times, create a job for each time using this same URL. Add the <code>x-cron-secret</code> header when <code>CRON_SECRET</code> is configured. No 10-minute keep-alive pings are needed.</p>
          </div>
        </form>
      </section>
    </div>
    <a className="docs-link" href="https://console.cloud.google.com/apis/library/youtube.googleapis.com" target="_blank" rel="noreferrer">Google API setup guide <ExternalLink size={13} /></a>
  </div>;
}
