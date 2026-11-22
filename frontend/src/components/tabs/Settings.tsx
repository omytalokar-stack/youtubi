import { useEffect, useState, type FormEvent } from 'react';
import { AlertTriangle, ArrowUpRight, Check, Clock3, Copy, Download, ExternalLink, KeyRound, Play, RefreshCw, Server, Share2, ShieldCheck, Smartphone, Youtube } from 'lucide-react';
import { useApp } from '../../context/AppContext';
import { api } from '../../lib/api';
import type { OmesAuditLog, OmesVideoHistory } from '../../types';

const WEBHOOK_URL = 'https://youtubi.onrender.com/api/automation/trigger';

export function Settings() {
  const { channels, channelId, profile, refresh, saveSchedule, setNotice, canInstallPwa, isPwaInstalled, isIosSafari, installPwa } = useApp();
  const [connecting, setConnecting] = useState(false);
  const [autoPublishEnabled, setAutoPublishEnabled] = useState(true);
  const [publishTimeIst, setPublishTimeIst] = useState('16:00');
  const [omesEnabled, setOmesEnabled] = useState(false);
  const [omesFrequency, setOmesFrequency] = useState<'daily' | 'alternate'>('daily');
  const [omesTimeIst, setOmesTimeIst] = useState('11:00');
  const [omesSecret, setOmesSecret] = useState('');
  const [omesVideos, setOmesVideos] = useState<OmesVideoHistory[]>([]);
  const [omesAudits, setOmesAudits] = useState<OmesAuditLog[]>([]);
  const [omesHistoryLoaded, setOmesHistoryLoaded] = useState(false);
  const [loadingOmesHistory, setLoadingOmesHistory] = useState(false);
  const [savingOmes, setSavingOmes] = useState(false);
  const [runningOmes, setRunningOmes] = useState(false);
  const [savingSchedule, setSavingSchedule] = useState(false);
  const [scheduleSaved, setScheduleSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  const activeChannel = channels.find((channel) => channel.channelId === channelId);
  const latestAuditByVideo = new Map<string, OmesAuditLog>();
  for (const audit of omesAudits) {
    if (!latestAuditByVideo.has(audit.videoId)) latestAuditByVideo.set(audit.videoId, audit);
  }
  useEffect(() => {
    setAutoPublishEnabled(profile?.autoPublishEnabled ?? true);
    setPublishTimeIst(profile?.publishTimeIst || '16:00');
    setOmesEnabled(profile?.automation?.omes?.enabled ?? false);
    setOmesFrequency(profile?.automation?.omes?.frequency || 'daily');
    setOmesTimeIst(profile?.automation?.omes?.publishTimeIst || '11:00');
  }, [profile]);
  useEffect(() => {
    setOmesSecret('');
    setOmesVideos([]);
    setOmesAudits([]);
    setOmesHistoryLoaded(false);
  }, [channelId]);

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
  async function loadOmesHistory() {
    if (!channelId || !omesSecret) {
      setNotice('Enter the backend CRON_SECRET to load OMES history.');
      return;
    }
    setLoadingOmesHistory(true);
    try {
      const history = await api<{ videos: OmesVideoHistory[]; auditLogs: OmesAuditLog[] }>(
        `/channels/${encodeURIComponent(channelId)}/omes/history`,
        { headers: { 'x-cron-secret': omesSecret } }
      );
      setOmesVideos(history.videos);
      setOmesAudits(history.auditLogs);
      setOmesHistoryLoaded(true);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not load OMES history.');
    } finally { setLoadingOmesHistory(false); }
  }
  async function saveOmesSettings(event: FormEvent) {
    event.preventDefault();
    if (!channelId || !omesSecret) {
      setNotice('Enter the backend CRON_SECRET to save OMES settings.');
      return;
    }
    setSavingOmes(true);
    try {
      await api(`/channels/${encodeURIComponent(channelId)}/omes`, {
        method: 'PUT',
        headers: { 'x-cron-secret': omesSecret },
        body: JSON.stringify({ enabled: omesEnabled, frequency: omesFrequency, publishTimeIst: omesTimeIst })
      });
      setNotice('OMES settings saved for this channel.');
      await refresh();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not save OMES settings.');
    } finally { setSavingOmes(false); }
  }
  async function runOmesNow() {
    if (!channelId || !omesSecret) {
      setNotice('Enter the backend CRON_SECRET to run OMES.');
      return;
    }
    if (!window.confirm('OMES will optimize the latest uploaded video and change its YouTube visibility to PUBLIC. Continue?')) return;
    setRunningOmes(true);
    try {
      const response = await api<{ result: { skipped: boolean; reason?: string; title?: string } }>(
        `/channels/${encodeURIComponent(channelId)}/omes/run`,
        { method: 'POST', headers: { 'x-cron-secret': omesSecret } }
      );
      setNotice(response.result.skipped
        ? response.result.reason || 'OMES did not change a video.'
        : 'Latest video metadata optimized and published publicly.');
      await loadOmesHistory();
      await refresh();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not run OMES.');
    } finally { setRunningOmes(false); }
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
  async function requestInstall() {
    try {
      await installPwa();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not open the dimag install prompt.');
    }
  }

  return <div className="page-stack">
    <div className="page-heading-row"><div><div className="eyebrow"><span className="eyebrow-line" /> PREFERENCES & ACCESS</div><h1>Studio settings<span className="heading-period">.</span></h1><p className="page-subtitle">Manage the channel connections and infrastructure behind your creator studio.</p></div><button className="button button-secondary" onClick={() => void refresh()}>Refresh connections</button></div>
    <div className="settings-layout">
      <section className="panel settings-panel install-panel"><div className="section-heading"><div><span className="section-kicker">DIMAG FOR YOUR DEVICE</span><h2>Install Mobile App (PWA)</h2></div><Smartphone className="setting-icon" size={19} /></div><p className="settings-copy">Add dimag to your home screen for a fast, app-like experience on this device.</p>
        {isPwaInstalled ? <span className="installed-badge" role="status"><Check size={14} /> Installed on this device</span> : isIosSafari ? <div className="ios-install-guide"><strong><Share2 size={15} /> Add dimag to your Home Screen</strong><ol><li>Tap the Share button in Safari.</li><li>Choose <strong>Add to Home Screen</strong>.</li><li>Tap <strong>Add</strong> to finish.</li></ol></div> : canInstallPwa ? <button className="button button-primary install-button" onClick={() => void requestInstall()}><Download size={16} /> Install dimag App</button> : <p className="install-unavailable">Installation will be available from your browser when this device supports it.</p>}
      </section>
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
            <p>The backend checks schedules every 10 seconds and also retries queued jobs automatically. cron-job.org is optional backup; if used, set its timezone to Asia/Kolkata and trigger this URL daily at this channel’s exact IST time. If channels use different times, create a job for each time using this same URL. Add the <code>x-cron-secret</code> header when <code>CRON_SECRET</code> is configured.</p>
          </div>
        </form>
      </section>
      <section className="panel settings-panel omes-panel">
        <div className="section-heading"><div><span className="section-kicker">MANUAL UPLOAD AUTOMATION</span><h2>OMES · Metadata SEO & Publish</h2></div><Clock3 className="setting-icon" size={19} /></div>
        <p className="settings-copy">Use OMES when you upload videos yourself. When enabled, scheduled automation skips Short generation and instead optimizes your latest completed upload.</p>
        <div className="omes-warning"><AlertTriangle size={17} /><span><strong>Publishing permission:</strong> OMES changes the selected video's visibility to <b>Public</b>. Completed Private, Unlisted, and Public uploads are available; YouTube Studio drafts may not appear in the uploads list.</span></div>
        <form className="omes-form" onSubmit={(event) => void saveOmesSettings(event)}>
          <label className="field omes-secret-field"><span>Backend access secret <small>CRON_SECRET · kept only in this page's memory</small></span><input type="password" autoComplete="off" value={omesSecret} disabled={!channelId} onChange={(event) => setOmesSecret(event.target.value)} placeholder="Enter CRON_SECRET" /></label>
          <div className="schedule-row omes-toggle-row">
            <div className="schedule-info"><strong>OMES Mode {omesEnabled ? 'ON' : 'OFF'}</strong><span>{omesEnabled ? 'Scheduled runs will not create or upload new videos.' : 'Scheduled runs continue using the normal video pipeline.'}</span></div>
            <button type="button" className={`switch ${omesEnabled ? 'switch-on' : ''}`} role="switch" aria-label="OMES Mode" aria-checked={omesEnabled} disabled={!channelId} onClick={() => setOmesEnabled((enabled) => !enabled)}><span /></button>
          </div>
          <div className="omes-settings-row">
            <label className="field"><span>Schedule frequency</span><select value={omesFrequency} disabled={!channelId} onChange={(event) => setOmesFrequency(event.target.value as 'daily' | 'alternate')}><option value="daily">Daily</option><option value="alternate">Alternate days (44-hour minimum)</option></select></label>
            <label className="field"><span>Publish time <small>Asia/Kolkata (IST)</small></span><input type="time" value={omesTimeIst} required disabled={!channelId} onChange={(event) => setOmesTimeIst(event.target.value)} /></label>
          </div>
          <div className="omes-actions">
            <button className="button button-primary" disabled={savingOmes || !channelId}>{savingOmes ? 'Saving…' : 'Save OMES Settings'}</button>
            <button type="button" className="button button-secondary" disabled={runningOmes || !channelId} onClick={() => void runOmesNow()}><Play size={14} />{runningOmes ? 'Optimizing…' : 'Optimize Latest Video Now'}</button>
            <button type="button" className="button button-secondary" disabled={loadingOmesHistory || !channelId} onClick={() => void loadOmesHistory()}><RefreshCw size={14} />{loadingOmesHistory ? 'Loading…' : 'Load Video History'}</button>
          </div>
        </form>
        {omesHistoryLoaded && <div className="omes-history">
          <h3>Recent channel uploads & OMES changes</h3>
          {omesVideos.length ? <div className="omes-history-scroll"><table className="omes-history-table"><thead><tr><th>Video</th><th>Visibility</th><th>Views</th><th>Latest optimization</th></tr></thead><tbody>
            {omesVideos.map((video) => {
              const audit = latestAuditByVideo.get(video.videoId);
              return <tr key={video.videoId}>
                <td><strong>{video.title || 'Untitled video'}</strong><small>{video.publishedAt ? new Date(video.publishedAt).toLocaleDateString() : 'Upload date unavailable'}</small></td>
                <td><span className={`omes-status omes-status-${video.privacyStatus}`}>{video.privacyStatus}</span></td>
                <td>{video.views.toLocaleString()}</td>
                <td>{audit ? <><span>{audit.beforeTitle || '—'} → {audit.afterTitle}</span><small>{new Date(audit.optimizedAt).toLocaleString()}</small></> : <span className="omes-no-audit">Not optimized yet</span>}</td>
              </tr>;
            })}
          </tbody></table></div> : <p className="omes-empty">No completed uploads were found on this channel.</p>}
        </div>}
      </section>
    </div>
    <a className="docs-link" href="https://console.cloud.google.com/apis/library/youtube.googleapis.com" target="_blank" rel="noreferrer">Google API setup guide <ExternalLink size={13} /></a>
  </div>;
}
