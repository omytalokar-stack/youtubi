export type Channel = { channelId: string; channelTitle: string; thumbnailUrl: string };
export type Profile = {
  channelId: string;
  channelTitle: string;
  niche: string;
  language: 'Hindi' | 'Hinglish' | 'Marathi' | 'English';
  toneAndStyle: string;
  visualKeywordsPrefix: string;
  metadataBlueprint: { titleSuffix: string; fixedDescriptionFooter: string; coreTags: string[] };
  autoPublishEnabled: boolean;
  publishTimeIst: string;
  lastAutoPublishedDateIst: string;
  automation: {
    enabled: boolean;
    scheduleHourIST: number;
    scheduleMinuteIST: number;
    privacyStatus: 'private' | 'unlisted' | 'public';
    lastPublishedDateIST: string;
  };
};
export type Brain = {
  channelId: string;
  selfCorrectionEnabled: boolean;
  winningTactics: string[];
  mistakeRules: string[];
  winningBlueprint: string;
  nextVideoStrategy: string;
  performanceScorecard: {
    videoId: string;
    title: string;
    classification: 'winner' | 'underperformer';
    score: number;
    views: number;
    impressions: number;
    ctr: number;
    averageViewDuration: number;
    retention: number;
    likes: number;
    publishedAt: string | null;
  }[];
  lastAutoAuditAt: string | null;
};
export type Video = {
  videoId: string;
  title: string;
  publishedAt: string;
  views: number;
  likes: number;
  watchTimeMinutes: number;
};
export type Stats = {
  channel: Channel;
  kpis: { views: number; subscribers: number; watchTimeMinutes: number; videos: number };
  recentVideos: Video[];
};
