import { useState } from 'react';
import { ArrowDownRight, ArrowUpRight, Clock3, Eye, Heart, LoaderCircle, Play, Users, Video } from 'lucide-react';
import { api } from '../../lib/api';
import { useApp } from '../../context/AppContext';
import { Modal } from '../Modal';

const number = (value: number) => new Intl.NumberFormat('en', { notation: value > 999999 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(value);

export function Analytics() {
  const { channelId, stats, refresh, setNotice } = useApp();
  const [auditing, setAuditing] = useState(false);
  const [audit, setAudit] = useState<{ winningTactic: string; mistakeRule: string } | null>(null);
  const [auditAuthOpen, setAuditAuthOpen] = useState(false);
  const [cronSecret, setCronSecret] = useState('');
  const metrics = [
    { label: 'Total views', value: number(stats?.kpis.views || 0), icon: Eye, period: 'LIFETIME', change: 'Lifetime', positive: true },
    { label: 'Subscribers', value: number(stats?.kpis.subscribers || 0), icon: Users, period: 'CURRENT', change: 'Current audience', positive: true },
    { label: 'Watch time', value: `${number(stats?.kpis.watchTimeMinutes || 0)} min`, icon: Clock3, period: '28 DAYS', change: 'Last 28 days', positive: true },
    { label: 'Published videos', value: number(stats?.kpis.videos || 0), icon: Video, period: 'LIFETIME', change: 'Channel total', positive: true }
  ];

  async function runAudit() {
    const secret = cronSecret.trim();
    if (!secret) return;
    setAuditing(true); setAudit(null);
    try {
      const { audit: result } = await api<{ audit: { winningTactic: string; mistakeRule: string } }>('/automation/audit-analytics', {
        method: 'POST', headers: { 'x-cron-secret': secret }, body: JSON.stringify({ channelId })
      });
      setAudit(result); setNotice('Channel analytics audited and brain updated.');
      await refresh();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Auto-audit failed.');
    } finally {
      setAuditing(false);
      setAuditAuthOpen(false);
      setCronSecret('');
    }
  }

  return <div className="page-stack">
    <div className="page-heading-row">
      <div><div className="eyebrow"><span className="eyebrow-line" /> CHANNEL OVERVIEW</div><h1>Good morning, creator<span className="heading-period">.</span></h1><p className="page-subtitle">A clear view of your channel’s momentum and what to do next.</p></div>
      <button className="button button-secondary" onClick={() => setAuditAuthOpen(true)} disabled={auditing || !channelId}>{auditing ? <LoaderCircle className="spin" size={16} /> : <Play size={15} fill="currentColor" />} Run Auto-Audit Now</button>
    </div>
    <div className="metric-grid">
      {metrics.map(({ label, value, icon: Icon, period, change, positive }, index) => <article className={`metric-card metric-${index + 1}`} key={label}>
        <div className="metric-top"><span className="metric-icon"><Icon size={17} /></span><span className="metric-period">{period}</span></div>
        <span className="metric-value">{value}</span><span className="metric-label">{label}</span>
        <div className="metric-foot">{positive ? <ArrowUpRight size={13} /> : <ArrowDownRight size={13} />}<span>{change}</span></div>
      </article>)}
    </div>
    <div className="content-grid">
      <section className="panel recent-panel">
        <div className="section-heading"><div><span className="section-kicker">LATEST PUBLISHING</span><h2>Recent videos</h2></div><span className="small-muted">Last 10 uploads</span></div>
        {!stats?.recentVideos.length ? <div className="empty-table"><span className="empty-icon"><Video size={20} /></span><strong>No recent uploads</strong><span>Published Shorts will appear here with performance details.</span></div> : <div className="table-scroll"><table><thead><tr><th>VIDEO</th><th>PUBLISHED</th><th><Eye size={13} /> VIEWS</th><th><Heart size={13} /> LIKES</th><th>WATCH TIME</th></tr></thead><tbody>
          {stats.recentVideos.map((video) => <tr key={video.videoId}><td><a href={`https://www.youtube.com/watch?v=${encodeURIComponent(video.videoId)}`} target="_blank" rel="noreferrer" className="video-title">{video.title}</a><span className="video-id">{video.videoId}</span></td><td>{video.publishedAt ? new Date(video.publishedAt).toLocaleDateString() : '—'}</td><td>{number(video.views)}</td><td>{number(video.likes)}</td><td>{video.watchTimeMinutes ? `${number(video.watchTimeMinutes)} min` : '—'}</td></tr>)}
        </tbody></table></div>}
      </section>
      <aside className="panel insight-panel">
        <div className="section-heading"><div><span className="section-kicker">YOUR NEXT EDGE</span><h2>Dimag insight</h2></div><span className="brain-spark">✳</span></div>
        {audit ? <div className="audit-insight"><div className="insight-entry"><span className="insight-label positive-label">KEEP DOING</span><p>{audit.winningTactic}</p></div><div className="insight-entry"><span className="insight-label caution-label">WATCH OUT</span><p>{audit.mistakeRule}</p></div></div> : <div className="insight-empty"><span className="insight-orbit">✳</span><p>Run a channel audit to turn your last 7 videos into one practical tactic and one rule for the next Short.</p><span>Grounded in your channel’s actual performance</span></div>}
        <div className="insight-footer"><span className="online-dot" /> Channel-isolated learning</div>
      </aside>
    </div>
    {auditAuthOpen && <Modal title="Authorize channel audit" onClose={() => { if (!auditing) { setAuditAuthOpen(false); setCronSecret(''); } }}><form className="confirm-body" onSubmit={(event) => { event.preventDefault(); void runAudit(); }}><p>Enter the CRON_SECRET configured on your backend. It is sent only with this audit request.</p><label className="field"><span>Backend CRON_SECRET</span><input type="password" autoComplete="off" value={cronSecret} onChange={(event) => setCronSecret(event.target.value)} autoFocus /></label><div className="confirm-actions"><button className="button button-secondary" type="button" disabled={auditing} onClick={() => { setAuditAuthOpen(false); setCronSecret(''); }}>Cancel</button><button className="button button-primary" type="submit" disabled={auditing || !cronSecret.trim()}>{auditing ? 'Auditing…' : 'Run audit'}</button></div></form></Modal>}
  </div>;
}
