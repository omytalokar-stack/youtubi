import { useState } from 'react';
import { useApp } from '../../context/AppContext';
import { api } from '../../lib/api';
import { Modal } from '../Modal';
import { Check, Circle, LoaderCircle, Plus, Rocket, ShieldCheck, Sparkles, X } from 'lucide-react';
import type { Brain } from '../../types';

export function AgentBrain() {
  const { channelId, profile, brain, setNotice, refresh } = useApp();
  const [confirm, setConfirm] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [itemType, setItemType] = useState<'tactic' | 'mistake' | null>(null);
  const [itemText, setItemText] = useState('');
  const [result, setResult] = useState('');

  async function publish() {
    setPublishing(true); setResult('');
    try {
      const data = await api<{ result: { title?: string; videoId?: string; skipped?: boolean; reason?: string } }>(`/automation/publish/${encodeURIComponent(channelId)}`, { method: 'POST', body: '{}' });
      setResult(data.result.skipped ? data.result.reason || 'Publish was skipped.' : `Published “${data.result.title}” · ${data.result.videoId}`);
      setConfirm(false); await refresh();
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

  return <div className="page-stack">
    <div className="page-heading-row"><div><div className="eyebrow"><span className="eyebrow-line" /> DIMAG · AGENT BRAIN</div><h1>Think sharper, every Short<span className="heading-period">.</span></h1><p className="page-subtitle">A channel-specific creative loop that remembers what works—and what to avoid.</p></div><div className="brain-status"><span className="online-dot" /> BRAIN ONLINE</div></div>
    <section className="panel pipeline-panel"><div className="pipeline-heading"><div><span className="section-kicker">THE CREATION LOOP</span><h2>From channel DNA to published Short</h2></div><span className="memory-note"><ShieldCheck size={14} /> {profile?.channelTitle || 'Selected channel'} · isolated memory</span></div>
      <div className="pipeline">{[
        ['01', 'Channel DNA', 'Voice & guardrails', 'pipeline-done'],
        ['02', 'Dimag writes', 'Script & scenes', 'pipeline-current'],
        ['03', 'Studio renders', 'Voice, clips & captions', ''],
        ['04', 'YouTube upload', profile?.automation.privacyStatus || 'private', '']
      ].map(([step, title, caption, status], index) => <div className="pipeline-step" key={step}><div className={`pipeline-node ${status}`}>{status === 'pipeline-done' ? <Check size={14} /> : step}</div><div className="pipeline-copy"><strong>{title}</strong><span>{caption}</span></div>{index < 3 && <div className={`pipeline-line ${index === 0 ? 'line-done' : ''}`} />}</div>)}</div>
    </section>
    <div className="brain-grid">
      <section className="panel publish-panel"><div className="publish-orb"><Rocket size={22} /></div><span className="section-kicker">READY WHEN YOU ARE</span><h2>Create & publish<br />a Short now</h2><p>Dimag uses this channel’s creative blueprint and its own learning memory, then uploads directly to YouTube.</p><div className="publish-target"><span className="target-avatar">{profile?.channelTitle?.slice(0, 1) || 'Y'}</span><span><small>PUBLISHING TO</small><strong>{profile?.channelTitle || 'Select a channel'}</strong></span><span className={`privacy-pill privacy-${profile?.automation.privacyStatus || 'private'}`}>{profile?.automation.privacyStatus || 'private'}</span></div><button className="button button-primary publish-button" disabled={!channelId || publishing} onClick={() => setConfirm(true)}>{publishing ? <LoaderCircle size={16} className="spin" /> : <Sparkles size={16} />} Create & Publish Short Now</button>{result && <div className={result.startsWith('Published') ? 'publish-result' : 'publish-error'}>{result}</div>}</section>
      <section className="panel brain-memory-panel"><div className="section-heading"><div><span className="section-kicker">CHANNEL MEMORY</span><h2>What Dimag remembers</h2></div><button className={`switch small-switch ${brain?.selfCorrectionEnabled ? 'switch-on' : ''}`} role="switch" aria-label="Toggle self correction" aria-checked={brain?.selfCorrectionEnabled || false} disabled={busy || !brain} onClick={toggleLearning}><span /></button></div><div className="learning-state"><span className={brain?.selfCorrectionEnabled ? 'learning-icon' : 'learning-icon paused'}><Sparkles size={14} /></span><span><strong>Self-correction {brain?.selfCorrectionEnabled ? 'on' : 'paused'}</strong><small>Recent tactics and guardrails influence new scripts.</small></span></div>
        <div className="memory-list"><div className="memory-title"><span className="memory-bullet green" /><strong>Winning tactics</strong><span className="memory-count">{brain?.winningTactics.length || 0}</span><button onClick={() => setItemType('tactic')} aria-label="Add winning tactic"><Plus size={15} /></button></div>
          {brain?.winningTactics.length ? brain.winningTactics.slice(-4).reverse().map((item, index) => <div className="memory-item" key={`${item}-${index}`}>{item}</div>) : <div className="memory-empty">No tactics yet. Run an auto-audit to find the first.</div>}
        </div><div className="memory-list mistake-list"><div className="memory-title"><span className="memory-bullet amber" /><strong>Mistake auto-fix rules</strong><span className="memory-count">{brain?.mistakeRules.length || 0}</span><button onClick={() => setItemType('mistake')} aria-label="Add mistake rule"><Plus size={15} /></button></div>
          {brain?.mistakeRules.length ? brain.mistakeRules.slice(-4).reverse().map((item, index) => <div className="memory-item" key={`${item}-${index}`}>{item}</div>) : <div className="memory-empty">Rules from analytics audits show up here.</div>}
        </div><div className="memory-sync"><span><Circle size={7} fill="currentColor" /> {brain?.lastAutoAuditAt ? `Last audit ${new Date(brain.lastAutoAuditAt).toLocaleDateString()}` : 'Awaiting first performance audit'}</span><span>ONLY THIS CHANNEL</span></div>
      </section>
    </div>
    {confirm && <Modal title="Ready to publish?" onClose={() => setConfirm(false)}><div className="confirm-body"><div className="confirm-icon"><Rocket size={20} /></div><p>This Short will be uploaded to the selected YouTube channel using its saved creative blueprint.</p><div className="confirm-summary"><span>CHANNEL</span><strong>{profile?.channelTitle}</strong><span>VISIBILITY</span><strong className="capitalize">{profile?.automation.privacyStatus}</strong></div><div className="confirm-actions"><button className="button button-secondary" onClick={() => setConfirm(false)}>Cancel</button><button className="button button-primary" onClick={publish} disabled={publishing}>{publishing ? 'Working…' : 'Confirm publish'}</button></div></div></Modal>}
    {itemType && <Modal title={itemType === 'tactic' ? 'Add a winning tactic' : 'Add a mistake rule'} onClose={() => setItemType(null)}><div className="confirm-body"><label className="field"><span>{itemType === 'tactic' ? 'What should this channel keep doing?' : 'What should this channel avoid?'}</span><textarea rows={4} value={itemText} onChange={(event) => setItemText(event.target.value)} autoFocus /></label><div className="confirm-actions"><button className="button button-secondary" onClick={() => setItemType(null)}><X size={15} /> Cancel</button><button className="button button-primary" disabled={busy || !itemText.trim()} onClick={addItem}>{busy ? 'Saving…' : 'Save to channel brain'}</button></div></div></Modal>}
  </div>;
}
