import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api } from '../lib/api';
import type { Brain, Channel, Profile, Stats } from '../types';

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
};

type AppContextValue = {
  channels: Channel[];
  channelId: string;
  profile: Profile | null;
  brain: Brain | null;
  stats: Stats | null;
  loading: boolean;
  error: string;
  notice: string;
  canInstallPwa: boolean;
  isPwaInstalled: boolean;
  isIosSafari: boolean;
  setChannelId: (id: string) => void;
  installPwa: () => Promise<void>;
  refresh: (includeChannels?: boolean, force?: boolean) => Promise<void>;
  syncAnalytics: (force?: boolean) => Promise<Stats>;
  updateSyncedStats: (channelId: string, stats: Stats) => void;
  saveProfile: (profile: Partial<Profile>) => Promise<void>;
  saveSchedule: (schedule: Pick<Profile, 'autoPublishEnabled' | 'publishTimeIst'>) => Promise<Profile>;
  setNotice: (notice: string) => void;
};

const AppContext = createContext<AppContextValue | null>(null);

function getSavedChannels(): Channel[] {
  const saved = localStorage.getItem('dimag-connected-channels');
  if (!saved) return [];
  try {
    const channels: unknown = JSON.parse(saved);
    if (Array.isArray(channels) && channels.every((item) =>
      item && typeof item.channelId === 'string' &&
      typeof item.channelTitle === 'string' &&
      typeof item.thumbnailUrl === 'string'
    )) {
      return channels as Channel[];
    }
    console.warn('Saved YouTube channel list has an invalid format.');
  } catch (reason) {
    console.warn('Unable to parse the saved YouTube channel list:', reason);
  }
  return [];
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [channels, setChannels] = useState<Channel[]>(getSavedChannels);
  const [channelId, setChannelIdState] = useState(localStorage.getItem('dimag-selected-channel') || '');
  const [profile, setProfile] = useState<Profile | null>(null);
  const [brain, setBrain] = useState<Brain | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const refreshInFlight = useRef(new Map<string, Promise<void>>());
  const channelIdRef = useRef(channelId);
  const lastAnalyticsSyncChannel = useRef('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [isPwaInstalled, setIsPwaInstalled] = useState(() => (
    window.matchMedia('(display-mode: standalone)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  ));
  const isIosSafari = useMemo(() => {
    const userAgent = navigator.userAgent;
    const isIos = /iphone|ipad|ipod/i.test(userAgent) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    return isIos && /safari/i.test(userAgent) && !/(crios|fxios|edgios|opios)/i.test(userAgent);
  }, []);

  useEffect(() => {
    const displayMode = window.matchMedia('(display-mode: standalone)');
    const updateInstalled = () => {
      setIsPwaInstalled(displayMode.matches || (navigator as Navigator & { standalone?: boolean }).standalone === true);
    };
    const onBeforeInstallPrompt = (event: Event) => {
      event.preventDefault();
      setDeferredPrompt(event as BeforeInstallPromptEvent);
    };
    const onAppInstalled = () => {
      setDeferredPrompt(null);
      setIsPwaInstalled(true);
    };
    window.addEventListener('beforeinstallprompt', onBeforeInstallPrompt);
    window.addEventListener('appinstalled', onAppInstalled);
    displayMode.addEventListener('change', updateInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstallPrompt);
      window.removeEventListener('appinstalled', onAppInstalled);
      displayMode.removeEventListener('change', updateInstalled);
    };
  }, []);

  const installPwa = useCallback(async () => {
    if (!deferredPrompt) return;
    await deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    setDeferredPrompt(null);
    if (outcome === 'accepted') setIsPwaInstalled(true);
  }, [deferredPrompt]);

  const setChannelId = (id: string) => {
    localStorage.setItem('dimag-selected-channel', id);
    channelIdRef.current = id;
    if (id !== channelId) {
      setProfile(null);
      setBrain(null);
      setStats(null);
    }
    setChannelIdState(id);
  };

  const refresh = useCallback((includeChannels = true, force = false) => {
    const requestKey = `${channelId}:${includeChannels}`;
    const inFlight = refreshInFlight.current.get(requestKey);
    if (inFlight) return inFlight;
    const request = (async () => {
      setLoading(true);
      setError('');
      let currentId = channelId;
      try {
        if (includeChannels) {
          const { channels: connected } = await api<{ channels: Channel[] }>(
            '/youtube/channels',
            undefined,
            { forceRefresh: force }
          );
          setChannels(connected);
          try {
            localStorage.setItem('dimag-connected-channels', JSON.stringify(connected));
          } catch (reason) {
            console.warn('Unable to persist the YouTube channel list:', reason);
          }
          currentId = connected.some((item) => item.channelId === channelIdRef.current)
            ? channelIdRef.current
            : connected[0]?.channelId || '';
          if (currentId !== channelIdRef.current) {
            setProfile(null);
            setBrain(null);
            setStats(null);
            localStorage.setItem('dimag-selected-channel', currentId);
            channelIdRef.current = currentId;
            setChannelIdState(currentId);
          }
        }
        if (!currentId) {
          setProfile(null); setBrain(null); setStats(null);
          return;
        }
        const results = await Promise.allSettled([
          api<{ profile: Profile }>(`/profile/${encodeURIComponent(currentId)}`),
          api<{ brain: Brain }>(`/brain/${encodeURIComponent(currentId)}`),
          api<Stats>(`/youtube/stats/${encodeURIComponent(currentId)}`)
        ]);
        if (currentId !== channelIdRef.current) return;
        const [profileResult, brainResult, statsResult] = results;
        if (profileResult.status === 'fulfilled') setProfile(profileResult.value.profile);
        if (brainResult.status === 'fulfilled') setBrain(brainResult.value.brain);
        if (statsResult.status === 'fulfilled') setStats(statsResult.value);
        const failure = results.find((result) => result.status === 'rejected');
        if (failure?.status === 'rejected') {
          throw failure.reason;
        }
      } catch (reason) {
        if (currentId === channelIdRef.current) {
          setError(reason instanceof Error ? reason.message : 'Unable to load channel data.');
        }
      } finally {
        if (currentId === channelIdRef.current) setLoading(false);
      }
    })();
    refreshInFlight.current.set(requestKey, request);
    void request.finally(() => {
      if (refreshInFlight.current.get(requestKey) === request) refreshInFlight.current.delete(requestKey);
    });
    return request;
  }, [channelId]);

  const syncAnalytics = useCallback(async (force = false) => {
    if (!channelId) throw new Error('Connect and select a YouTube channel first.');
    const requestedChannelId = channelId;
    const result = await api<Stats>(
      `/analytics/${encodeURIComponent(requestedChannelId)}`,
      undefined,
      { forceRefresh: force }
    );
    if (requestedChannelId === channelIdRef.current) setStats(result);
    return result;
  }, [channelId]);

  const updateSyncedStats = useCallback((requestedChannelId: string, result: Stats) => {
    if (requestedChannelId === channelIdRef.current) setStats(result);
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    const noCachedStats = !stats || (
      stats.kpis.views === 0 && stats.kpis.subscribers === 0 &&
      stats.kpis.videos === 0 && stats.kpis.watchTimeMinutes === 0 &&
      stats.recentVideos.length === 0
    );
    if (loading || !channelId || !noCachedStats || lastAnalyticsSyncChannel.current === channelId) return;
    lastAnalyticsSyncChannel.current = channelId;
    syncAnalytics().catch((reason: unknown) => {
      setNotice(reason instanceof Error ? reason.message : 'Could not sync channel analytics.');
    });
  }, [channelId, loading, stats, syncAnalytics]);

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
    canInstallPwa: Boolean(deferredPrompt), isPwaInstalled, isIosSafari,
    setChannelId, installPwa, refresh, syncAnalytics, updateSyncedStats, saveProfile, saveSchedule, setNotice
  }), [channels, channelId, profile, brain, stats, loading, error, notice, deferredPrompt, isPwaInstalled, isIosSafari, installPwa, refresh, syncAnalytics, updateSyncedStats, saveProfile, saveSchedule]);
  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp() {
  const context = useContext(AppContext);
  if (!context) throw new Error('useApp must be used within AppProvider.');
  return context;
}
