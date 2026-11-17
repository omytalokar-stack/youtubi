import { useEffect, useState, type FormEvent } from 'react';
import { Check, Clock3, LockKeyhole, Save } from 'lucide-react';
import { useApp } from '../../context/AppContext';
import type { Profile } from '../../types';

const blank: Omit<Profile, 'channelId' | 'channelTitle'> = {
  niche: '', language: 'Hindi', toneAndStyle: '', visualKeywordsPrefix: '',
  metadataBlueprint: { titleSuffix: '', fixedDescriptionFooter: '', coreTags: [] },
  automation: { enabled: false, scheduleHourIST: 10, scheduleMinuteIST: 0, privacyStatus: 'private', lastPublishedDateIST: '' }
};

export function ChannelDNA() {
  const { profile, saveProfile, channels, channelId, setNotice } = useApp();
  const [form, setForm] = useState(blank);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!profile) {
      setForm(blank);
      setSaved(false);
      return;
    }
    setForm({
      niche: profile.niche || '', language: profile.language || 'Hindi',
      toneAndStyle: profile.toneAndStyle || '', visualKeywordsPrefix: profile.visualKeywordsPrefix || '',
      metadataBlueprint: { titleSuffix: profile.metadataBlueprint?.titleSuffix || '', fixedDescriptionFooter: profile.metadataBlueprint?.fixedDescriptionFooter || '', coreTags: profile.metadataBlueprint?.coreTags || [] },
      automation: { ...blank.automation, ...profile.automation }
    });
  }, [profile]);
  function update<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    setForm((current) => ({ ...current, [key]: value })); setSaved(false);
  }
  async function submit(event: FormEvent) {
    event.preventDefault(); setSaving(true);
    try { await saveProfile(form); setSaved(true); }
    catch (error) { setNotice(error instanceof Error ? error.message : 'Could not save this channel blueprint.'); }
    finally { setSaving(false); }
  }
  const channelTitle = channels.find((item) => item.channelId === channelId)?.channelTitle;
  return <div className="page-stack">
    <div className="page-heading-row"><div><div className="eyebrow"><span className="eyebrow-line" /> CHANNEL DNA</div><h1>Set your creative compass<span className="heading-period">.</span></h1><p className="page-subtitle">A distinct creative blueprint for <strong>{channelTitle || 'your channel'}</strong>. Dimag keeps these rules attached to this channel.</p></div><div className="channel-lock"><LockKeyhole size={15} /> ISOLATED PROFILE</div></div>
    <form onSubmit={submit} className="dna-layout">
      <div className="dna-main">
        <section className="panel form-panel">
          <div className="section-heading"><div><span className="section-kicker">01 — IDENTITY</span><h2>Creative direction</h2></div><span className="step-count">01 <i>/ 03</i></span></div>
          <div className="form-grid">
            <label className="field"><span>Channel niche</span><input value={form.niche} onChange={(event) => update('niche', event.target.value)} placeholder="e.g. mindful productivity, Indian history" required /></label>
            <label className="field"><span>Content language</span><select value={form.language} onChange={(event) => update('language', event.target.value as Profile['language'])}><option>Hindi</option><option>Hinglish</option><option>Marathi</option><option>English</option></select></label>
            <label className="field field-wide"><span>Tone & style</span><textarea rows={3} value={form.toneAndStyle} onChange={(event) => update('toneAndStyle', event.target.value)} placeholder="Describe the voice, pacing, and personality your audience knows." /></label>
            <label className="field field-wide"><span>Visual search prefix <small>Optional</small></span><input value={form.visualKeywordsPrefix} onChange={(event) => update('visualKeywordsPrefix', event.target.value)} placeholder="e.g. warm cinematic India, documentary" /></label>
          </div>
        </section>
        <section className="panel form-panel">
          <div className="section-heading"><div><span className="section-kicker">02 — RECOGNITION</span><h2>Metadata blueprint</h2></div><span className="locked-badge"><LockKeyhole size={12} /> LOCKED FORMAT</span></div>
          <div className="form-grid">
            <label className="field"><span>Title suffix</span><input value={form.metadataBlueprint.titleSuffix} onChange={(event) => update('metadataBlueprint', { ...form.metadataBlueprint, titleSuffix: event.target.value })} placeholder="e.g. | Dimag Daily" /></label>
            <label className="field"><span>Core tags <small>Comma separated</small></span><input value={form.metadataBlueprint.coreTags.join(', ')} onChange={(event) => update('metadataBlueprint', { ...form.metadataBlueprint, coreTags: event.target.value.split(',').map((tag) => tag.trim()).filter(Boolean) })} placeholder="shorts, your-niche, brand" /></label>
            <label className="field field-wide"><span>Fixed description footer</span><textarea rows={3} value={form.metadataBlueprint.fixedDescriptionFooter} onChange={(event) => update('metadataBlueprint', { ...form.metadataBlueprint, fixedDescriptionFooter: event.target.value })} placeholder="A consistent channel signature or call to action." /></label>
          </div>
        </section>
        <section className="panel form-panel schedule-panel">
          <div className="section-heading"><div><span className="section-kicker">03 — RHYTHM</span><h2>Publishing schedule</h2></div><span className="timezone-badge"><Clock3 size={13} /> IST · UTC+05:30</span></div>
          <div className="schedule-row">
            <div className="schedule-info"><strong>Automated publishing</strong><span>At most one channel is processed per trigger for stable memory usage.</span></div>
            <button type="button" className={`switch ${form.automation.enabled ? 'switch-on' : ''}`} role="switch" aria-checked={form.automation.enabled} onClick={() => update('automation', { ...form.automation, enabled: !form.automation.enabled })}><span /></button>
          </div>
          <div className="form-grid schedule-fields">
            <label className="field"><span>Daily IST slot</span><div className="time-input"><input type="number" min="0" max="23" value={String(form.automation.scheduleHourIST).padStart(2, '0')} onChange={(event) => update('automation', { ...form.automation, scheduleHourIST: Number(event.target.value) })} /><b>:</b><input type="number" min="0" max="59" value={String(form.automation.scheduleMinuteIST).padStart(2, '0')} onChange={(event) => update('automation', { ...form.automation, scheduleMinuteIST: Number(event.target.value) })} /></div></label>
            <label className="field"><span>Upload visibility</span><select value={form.automation.privacyStatus} onChange={(event) => update('automation', { ...form.automation, privacyStatus: event.target.value as Profile['automation']['privacyStatus'] })}><option value="private">Private</option><option value="unlisted">Unlisted</option><option value="public">Public</option></select></label>
          </div>
        </section>
        <div className="form-actions"><span className="save-hint">{saved && <><Check size={14} /> Changes saved for this channel</>}</span><button className="button button-primary" disabled={saving || !channelId}>{saving ? 'Saving…' : <><Save size={15} /> Save channel DNA</>}</button></div>
      </div>
      <aside className="panel blueprint-preview"><div className="preview-top"><span className="section-kicker">LIVE BLUEPRINT</span><span className="preview-pulse" /></div><div className="preview-mark">✳</div><h3>{channelTitle || 'Your channel'}</h3><span className="preview-niche">{form.niche || 'Add your channel niche'}</span><div className="preview-separator" /><div className="preview-detail"><span>LANGUAGE</span><strong>{form.language}</strong></div><div className="preview-detail"><span>TONE</span><strong>{form.toneAndStyle || 'Not set yet'}</strong></div><div className="preview-detail"><span>DEFAULT VISIBILITY</span><strong className="capitalize">{form.automation.privacyStatus}</strong></div><div className="preview-footer"><LockKeyhole size={13} /> This blueprint only guides {channelTitle || 'this channel'}.</div></aside>
    </form>
  </div>;
}
