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
    omes?: {
      enabled: boolean;
      frequency: 'daily' | 'alternate';
      publishTimeIst: string;
      lastOmesRunAt: string | null;
      lastOptimizedVideoId: string | null;
    };
  };
};
export type OmesVideoHistory = {
  videoId: string;
  title: string;
  description: string;
  tags: string[];
  categoryId: string;
  publishedAt: string;
  privacyStatus: 'private' | 'unlisted' | 'public';
  views: number;
  likes: number;
};
export type OmesAuditLog = {
  videoId: string;
  beforeTitle: string;
  afterTitle: string;
  beforeTagCount: number;
  afterTagCount: number;
  privacyBefore: string;
  privacyAfter: string;
  optimizedAt: string;
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
  impressions?: number;
  ctr?: number;
  averageViewDuration?: number;
  retention?: number;
};
export type Stats = {
  channel: Channel;
  kpis: { views: number; subscribers: number; watchTimeMinutes: number; videos: number };
  recentVideos: Video[];
};
export type PipelineStage = 'idle' | 'queued' | 'optimizing' | 'dna' | 'writing' | 'rendering' | 'uploading' | 'completed' | 'failed';
export type PipelineStatus = {
  channelId: string;
  stage: PipelineStage;
  lastVideoTitle: string;
  timestamp: string;
  reason?: string;
  runStatus?: 'idle' | 'queued' | 'running' | 'completed' | 'skipped' | 'failed';
  runSource?: 'scheduled' | 'manual' | '';
  runMode?: 'auto-upload' | 'omes' | '';
  failedAtStage?: Exclude<PipelineStage, 'idle' | 'completed' | 'failed'>;
};
