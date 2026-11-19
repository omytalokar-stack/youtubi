import { useEffect, useState } from 'react';
import { useApp } from '../../context/AppContext';
import { API_URL, api } from '../../lib/api';
import { Modal } from '../Modal';
import { Check, Circle, LoaderCircle, Plus, Rocket, ShieldCheck, Sparkles, X } from 'lucide-react';
import type { Brain, PipelineStage, PipelineStatus } from '../../types';

export function AgentBrain() {
  const { channelId, profile, brain, setNotice, refresh } = useApp();
  const [confirm, setConfirm] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [itemType, setItemType] = useState<'tactic' | 'mistake' | null>(null);
  const [itemText, setItemText] = useState('');
  const [result, setResult] = useState('');
  const [jobStatus, setJobStatus] = useState<PipelineStatus | null>(null);
  const activeStages: PipelineStage[] = ['dna', 'writing', 'rendering', 'uploading'];
  const jobIsActive = Boolean(jobStatus && activeStages.includes(jobStatus.stage));

  useEffect(() => {
    setJobStatus(null);
    if (!channelId) return;
    const source = new EventSource(`${API_URL}/automation/events/${encodeURIComponent(channelId)}`);
    source.onmessage = (event) => {
      try {
        const status = JSON.parse(event.data) as PipelineStatus;
        if (status.channelId === channelId) setJobStatus(status);
      } catch {
        setNotice('The pipeline status update could not be read.');
      }
    };
    return () => source.close();
  }, [channelId, setNotice]);

  useEffect(() => {
    if (!channelId || !jobIsActive) return;
    const interval = window.setInterval(() => {
      api<PipelineStatus>(`/automation/status/${encodeURIComponent(channelId)}`)
        .then((status) => {
          if (status.channelId === channelId) setJobStatus(status);
        })
        .catch((error: unknown) => setNotice(error instanceof Error ? error.message : 'Could not refresh pipeline status.'));
    }, 5000);
    return () => window.clearInterval(interval);
  }, [channelId, jobIsActive, setNotice]);

  async function publish() {
    setPublishing(true); setResult('');
    try {
      const data = await api<{ accepted: boolean; message: string }>(`/automation/publish/${encodeURIComponent(channelId)}`, { method: 'POST', body: '{}' });
      setResult(data.message || 'Native publishing started in the background.');
      setConfirm(false);
    } catch (error) { setConfirm(false); setResult(error instanceof Error ? error.message : 'Publish failed.'); }
    finally { setPublishing(false); }
  }

  async function toggleLearning() {
    if (!brain) return;
    setBusy(true);
    try {
      const data = await api<{ brain: Brain }>(`/brain/${encodeURIComponent(channelId)}`, {
        method: 'PATCH', body: JSON.stringify({ selfCorrectionEnabled: !brain.selfCorrectionEnabled })
      });
      setNotice(data.brain.selfCorrectionEnabled ? 'Self-correction enabled.' : 'Self-correction paused.');
      await refresh();
    } catch (error) { setNotice(error instanceof Error ? error.message : 'Could not update self-correction.'); }
    finally { setBusy(false); }
  }

  async function addItem() {
    if (!itemType || !itemText.trim()) return;
    setBusy(true);
    try {
      await api<{ brain: Brain }>(`/brain/${itemType}`, { method: 'POST', body: JSON.stringify({ channelId, text: itemText.trim() }) });
      setItemType(null); setItemText(''); await refresh();
    } catch (error) { setNotice(error instanceof Error ? error.message : 'Could not update brain memory.'); }
    finally { setBusy(false); }
  }

  const pipelineSteps: [PipelineStage, string, string, string][] = [
    ['dna', '01', 'Channel DNA', 'Learning this channel’s creative rules'],
    ['writing', '02', 'Dimag writes', 'Script & scenes'],
    ['rendering', '03', 'Studio renders', 'Voice, native visuals & captions'],
    ['uploading', '04', 'YouTube upload', profile?.automation.privacyStatus || 'private']
  ];
  const failedIndex = jobStatus?.stage === 'failed' && jobStatus.failedAtStage
    ? activeStages.indexOf(jobStatus.failedAtStage)
    : -1;
  const currentIndex = jobStatus && jobIsActive
    ? activeStages.indexOf(jobStatus.stage)
    : jobStatus?.stage === 'completed' ? activeStages.length : failedIndex;
  const stageMessage = jobStatus?.stage === 'completed'
    ? `Published: ${jobStatus.lastVideoTitle || 'Short complete'}`
    : jobStatus?.stage === 'failed'
      ? `Failed during ${jobStatus.failedAtStage || 'the pipeline'}`
      : jobIsActive
        ? `In progress · ${jobStatus?.lastVideoTitle || 'Preparing this channel’s Short'}`
        : 'Idle · waiting for a manual or scheduled run';

  return <div className="page-stack">
    <div className="page-heading-row"><div><div className="eyebrow"><span className="eyebrow-line" /> DIMAG · AGENT BRAIN</div><h1>Think sharper, every Short<span className="heading-period">.</span></h1><p className="page-subtitle">A channel-specific creative loop that remembers what works—and what to avoid.</p></div><div className="brain-status"><span className="online-dot" /> BRAIN ONLINE</div></div>
    <section className="panel pipeline-panel"><div className="pipeline-heading"><div><span className="section-kicker">THE CREATION LOOP</span><h2>From channel DNA to published Short</h2></div><span className="memory-note"><ShieldCheck size={14} /> {profile?.channelTitle || 'Selected channel'} · isolated memory</span></div>
      <div className="pipeline-status" aria-live="polite">{stageMessage}</div>
      <div className="pipeline">{pipelineSteps.map(([stage, step, title, caption], index) => {
        const completed = jobStatus?.stage === 'completed' || (currentIndex >= 0 && index < currentIndex);
        const current = jobIsActive && index === currentIndex;
        const failed = jobStatus?.stage === 'failed' && index === failedIndex;
        const nodeClass = failed ? 'pipeline-failed' : completed ? 'pipeline-done' : current ? 'pipeline-current' : '';
        return <div className="pipeline-step" key={stage}>
          <div className={`pipeline-node ${nodeClass}`}>{completed ? <Check size={14} /> : step}</div>
          <div className="pipeline-copy"><strong>{title}</strong><span>{caption}</span></div>
          {index < 3 && <div className={`pipeline-line ${completed ? 'line-done' : ''}`} />}
        </div>;
      })}</div>
    </section>
    <div className="brain-grid">
      <section className="panel publish-panel"><div className="publish-orb"><Rocket size={22} /></div><span className="section-kicker">READY WHEN YOU ARE</span><h2>Create & publish<br />a Short now</h2><p>Dimag uses this channel’s creative blueprint and its own learning memory, then uploads directly to YouTube.</p><div className="publish-target"><span className="target-avatar">{profile?.channelTitle?.slice(0, 1) || 'Y'}</span><span><small>PUBLISHING TO</small><strong>{profile?.channelTitle || 'Select a channel'}</strong></span><span className={`privacy-pill privacy-${profile?.automation.privacyStatus || 'private'}`}>{(profile?.automation.privacyStatus || 'private').toUpperCase()}</span></div><button className="button button-primary publish-button" disabled={!channelId || publishing} onClick={() => setConfirm(true)}>{publishing ? <LoaderCircle size={16} className="spin" /> : <Sparkles size={16} />} Create & Publish Short Now</button>{result && <div className={result.includes('started') ? 'publish-result' : 'publish-error'}>{result}</div>}</section>
      <section className="panel brain-memory-panel"><div className="section-heading"><div><span className="section-kicker">CHANNEL MEMORY</span><h2>What Dimag remembers</h2></div><button className={`switch small-switch ${brain?.selfCorrectionEnabled ? 'switch-on' : ''}`} role="switch" aria-label="Toggle self correction" aria-checked={brain?.selfCorrectionEnabled || false} disabled={busy || !brain} onClick={toggleLearning}><span /></button></div><div className="learning-state"><span className={brain?.selfCorrectionEnabled ? 'learning-icon' : 'learning-icon paused'}><Sparkles size={14} /></span><span><strong>Self-correction {brain?.selfCorrectionEnabled ? 'on' : 'paused'}</strong><small>Recent tactics and guardrails influence new scripts.</small></span></div>
        <div className="memory-list"><div className="memory-title"><span className="memory-bullet green" /><strong>Winning formula</strong></div><div className="memory-item">{brain?.winningBlueprint || 'The channel blueprint will be learned from recent video performance before the next Short.'}</div></div>
        <div className="memory-list"><div className="memory-title"><span className="memory-bullet green" /><strong>Winning tactics</strong><span className="memory-count">{brain?.winningTactics.length || 0}</span><button onClick={() => setItemType('tactic')} aria-label="Add winning tactic"><Plus size={15} /></button></div>
          {brain?.winningTactics.length ? brain.winningTactics.slice(-4).reverse().map((item, index) => <div className="memory-item" key={`${item}-${index}`}>{item}</div>) : <div className="memory-empty">No tactics yet. The brain learns before each Short.</div>}
        </div><div className="memory-list mistake-list"><div className="memory-title"><span className="memory-bullet amber" /><strong>Mistake auto-fix rules</strong><span className="memory-count">{brain?.mistakeRules.length || 0}</span><button onClick={() => setItemType('mistake')} aria-label="Add mistake rule"><Plus size={15} /></button></div>
          {brain?.mistakeRules.length ? brain.mistakeRules.slice(-4).reverse().map((item, index) => <div className="memory-item" key={`${item}-${index}`}>{item}</div>) : <div className="memory-empty">Rules from analytics audits show up here.</div>}
        </div><div className="memory-list"><div className="memory-title"><span className="memory-bullet green" /><strong>Next-video strategy</strong></div><div className="memory-item">{brain?.nextVideoStrategy || 'Performance-based strategy will appear after the first learning pass.'}</div></div>
        <div className="memory-list"><div className="memory-title"><span className="memory-bullet amber" /><strong>Recent performance scorecard</strong></div>
          {brain?.performanceScorecard?.length ? brain.performanceScorecard.slice(0, 5).map((video) => <div className="memory-item" key={video.videoId}><strong>{video.classification === 'winner' ? 'Winner' : 'Underperformer'} · </strong>{video.title} — {video.views.toLocaleString()} views, {video.impressions.toLocaleString()} impressions, {video.ctr.toFixed(1)}% CTR, {video.averageViewDuration.toFixed(1)}s average view, {video.retention.toFixed(1)}% retention, {video.likes.toLocaleString()} likes</div>) : <div className="memory-empty">No recent performance records yet.</div>}
        </div><div className="memory-sync"><span><Circle size={7} fill="currentColor" /> {brain?.lastAutoAuditAt ? `Last learning pass ${new Date(brain.lastAutoAuditAt).toLocaleDateString()}` : 'Awaiting first performance audit'}</span><span>ONLY THIS CHANNEL</span></div>
      </section>
    </div>
    {confirm && <Modal title="Ready to publish?" onClose={() => setConfirm(false)}><div className="confirm-body"><div className="confirm-icon"><Rocket size={20} /></div><p>This Short will be uploaded to the selected YouTube channel using its saved creative blueprint.</p><div className="confirm-summary"><span>CHANNEL</span><strong>{profile?.channelTitle}</strong><span>VISIBILITY</span><strong className="capitalize">{profile?.automation.privacyStatus}</strong></div><div className="confirm-actions"><button className="button button-secondary" onClick={() => setConfirm(false)}>Cancel</button><button className="button button-primary" onClick={publish} disabled={publishing}>{publishing ? 'Working…' : 'Confirm publish'}</button></div></div></Modal>}
    {itemType && <Modal title={itemType === 'tactic' ? 'Add a winning tactic' : 'Add a mistake rule'} onClose={() => setItemType(null)}><div className="confirm-body"><label className="field"><span>{itemType === 'tactic' ? 'What should this channel keep doing?' : 'What should this channel avoid?'}</span><textarea rows={4} value={itemText} onChange={(event) => setItemText(event.target.value)} autoFocus /></label><div className="confirm-actions"><button className="button button-secondary" onClick={() => setItemType(null)}><X size={15} /> Cancel</button><button className="button button-primary" disabled={busy || !itemText.trim()} onClick={addItem}>{busy ? 'Saving…' : 'Save to channel brain'}</button></div></div></Modal>}
  </div>;
}
