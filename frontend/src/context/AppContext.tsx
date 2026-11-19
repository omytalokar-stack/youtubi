import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api } from '../lib/api';
import type { Brain, Channel, Profile, Stats } from '../types';

type AppContextValue = {
  channels: Channel[];
  channelId: string;
  profile: Profile | null;
  brain: Brain | null;
  stats: Stats | null;
  loading: boolean;
  error: string;
  notice: string;
  setChannelId: (id: string) => void;
  refresh: () => Promise<void>;
  saveProfile: (profile: Partial<Profile>) => Promise<void>;
  saveSchedule: (schedule: Pick<Profile, 'autoPublishEnabled' | 'publishTimeIst'>) => Promise<Profile>;
  setNotice: (notice: string) => void;
};

const AppContext = createContext<AppContextValue | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [channelId, setChannelIdState] = useState(localStorage.getItem('dimag-selected-channel') || '');
  const [profile, setProfile] = useState<Profile | null>(null);
  const [brain, setBrain] = useState<Brain | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const setChannelId = (id: string) => {
    localStorage.setItem('dimag-selected-channel', id);
    setChannelIdState(id);
  };

  const refresh = useCallback(async () => {
    setLoading(true);
    setError('');
    setProfile(null);
    setBrain(null);
    setStats(null);
    try {
      const { channels: connected } = await api<{ channels: Channel[] }>('/youtube/channels');
      setChannels(connected);
      const currentId = connected.some((item) => item.channelId === channelId) ? channelId : connected[0]?.channelId || '';
      if (currentId !== channelId) {
        localStorage.setItem('dimag-selected-channel', currentId);
        setChannelIdState(currentId);
      }
      if (!currentId) {
        setProfile(null); setBrain(null); setStats(null);
        return;
      }
      const [profileResult, brainResult, statsResult] = await Promise.all([
        api<{ profile: Profile }>(`/profile/${encodeURIComponent(currentId)}`),
        api<{ brain: Brain }>(`/brain/${encodeURIComponent(currentId)}`),
        api<Stats>(`/youtube/stats/${encodeURIComponent(currentId)}`)
      ]);
      setProfile(profileResult.profile); setBrain(brainResult.brain); setStats(statsResult);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to load channel data.');
    } finally { setLoading(false); }
  }, [channelId]);

  useEffect(() => { void refresh(); }, [refresh]);

  const saveProfile = useCallback(async (partial: Partial<Profile>) => {
    if (!channelId) throw new Error('Connect and select a YouTube channel first.');
    const result = await api<{ profile: Profile }>(`/profile/${encodeURIComponent(channelId)}`, {
      method: 'PUT', body: JSON.stringify(partial)
    });
    setProfile(result.profile);
    setNotice('Channel blueprint saved.');
  }, [channelId]);

  const saveSchedule = useCallback(async (schedule: Pick<Profile, 'autoPublishEnabled' | 'publishTimeIst'>) => {
    if (!channelId) throw new Error('Connect and select a YouTube channel first.');
    const result = await api<{ profile: Profile }>(`/channels/${encodeURIComponent(channelId)}/schedule`, {
      method: 'PATCH', body: JSON.stringify(schedule)
    });
    setProfile(result.profile);
    setNotice('Daily auto-upload schedule saved.');
    return result.profile;
  }, [channelId]);

  const value = useMemo(() => ({
    channels, channelId, profile, brain, stats, loading, error, notice,
    setChannelId, refresh, saveProfile, saveSchedule, setNotice
  }), [channels, channelId, profile, brain, stats, loading, error, notice, refresh, saveProfile, saveSchedule]);
  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp() {
  const context = useContext(AppContext);
  if (!context) throw new Error('useApp must be used within AppProvider.');
  return context;
}
