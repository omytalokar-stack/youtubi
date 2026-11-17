import { useEffect, useRef, useState } from 'react';
import { ArrowUp, Bot, LoaderCircle, Plus, Sparkles, UserRound } from 'lucide-react';
import { useApp } from '../../context/AppContext';
import { api } from '../../lib/api';

type Message = { role: 'user' | 'assistant'; content: string };

export function GeminiStudio() {
  const { channelId, profile } = useApp();
  const [messages, setMessages] = useState<Message[]>([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => { setMessages([]); setText(''); }, [channelId]);
  useEffect(() => { bottom.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages, busy]);
  async function send(content = text) {
    const message = content.trim();
    if (!message || busy || !channelId) return;
    const next = [...messages, { role: 'user' as const, content: message }];
    setMessages(next); setText(''); setBusy(true);
    try {
      const result = await api<{ response: string }>('/automation/chat', {
        method: 'POST',
        body: JSON.stringify({ channelId, message, history: messages.map(({ role, content: value }) => ({ role, content: value })) })
      });
      setMessages([...next, { role: 'assistant', content: result.response }]);
    } catch (error) {
      setMessages([...next, { role: 'assistant', content: error instanceof Error ? `I couldn't complete that: ${error.message}` : 'I could not complete that request.' }]);
    } finally { setBusy(false); }
  }

  return <div className="studio-page">
    <div className="studio-heading"><div className="eyebrow"><span className="eyebrow-line" /> GEMINI STUDIO</div><h1>Make a little magic<span className="heading-period">.</span></h1><p>Think through ideas with Dimag, shaped by <strong>{profile?.channelTitle || 'your selected channel'}</strong>.</p><div className="studio-channel-lock"><span className="online-dot" /> CHANNEL CONTEXT LOCKED</div></div>
    <div className="chat-shell">
      {messages.length === 0 ? <div className="chat-welcome"><div className="welcome-spark"><Sparkles size={24} /></div><span className="section-kicker">YOUR CREATIVE PARTNER</span><h2>What are we making<br />today?</h2><p>Ideas are grounded in this channel’s niche, language, and tone.</p><div className="prompt-grid">{[
        'Brainstorm 3 fresh Short hooks',
        'Give me 4 visual scene ideas',
        'Sharpen a story for my niche'
      ].map((prompt) => <button key={prompt} onClick={() => void send(prompt)}><span><Sparkles size={14} /></span>{prompt}<ArrowUp size={14} /></button>)}</div></div> : <div className="chat-messages">{messages.map((message, index) => <div className={`chat-message ${message.role}`} key={`${index}-${message.role}`}><span className="message-avatar">{message.role === 'assistant' ? <Bot size={16} /> : <UserRound size={15} />}</span><div><span className="message-author">{message.role === 'assistant' ? 'DIMAG' : 'YOU'}</span><p>{message.content}</p></div></div>)}{busy && <div className="chat-message assistant"><span className="message-avatar"><Bot size={16} /></span><div><span className="message-author">DIMAG</span><p className="thinking"><LoaderCircle size={14} className="spin" /> Thinking it through…</p></div></div>}<div ref={bottom} /></div>}
      <form className="chat-composer" onSubmit={(event) => { event.preventDefault(); void send(); }}><button type="button" className="composer-add" aria-label="Start new chat" onClick={() => setMessages([])}><Plus size={18} /></button><input value={text} onChange={(event) => setText(event.target.value)} placeholder="Ask Dimag about your next Short…" disabled={!channelId || busy} /><span className="composer-context">{profile?.language || 'Hindi'} · {profile?.niche || 'channel context'}</span><button className="send-button" type="submit" disabled={!text.trim() || busy}><ArrowUp size={17} /></button></form>
      <div className="chat-disclaimer">Dimag uses this channel’s profile only. Verify important facts before publishing.</div>
    </div>
  </div>;
}
