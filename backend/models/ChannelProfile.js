import mongoose from 'mongoose';

const ChannelProfileSchema = new mongoose.Schema({
  channelId: { type: String, required: true, unique: true, index: true },
  channelTitle: { type: String, required: true },
  niche: { type: String, default: '' },
  language: { type: String, enum: ['Hindi', 'Hinglish', 'Marathi', 'English'], default: 'Hindi' },
  toneAndStyle: { type: String, default: '' },
  visualKeywordsPrefix: { type: String, default: '' },
  metadataBlueprint: {
    titleSuffix: { type: String, default: '' },
    fixedDescriptionFooter: { type: String, default: '' },
    coreTags: { type: [String], default: [] }
  },
  autoPublishEnabled: { type: Boolean, default: true },
  publishTimeIst: { type: String, default: '16:00', match: /^(?:[01]\d|2[0-3]):[0-5]\d$/ },
  lastAutoPublishedDateIst: {
    type: String,
    default: '',
    validate: {
      validator: (value) => value === '' || /^\d{4}-\d{2}-\d{2}$/.test(value),
      message: 'lastAutoPublishedDateIst must use YYYY-MM-DD format.'
    }
  },
  youtubeStats: {
    subscriberCount: { type: Number, default: 0 },
    viewCount: { type: Number, default: 0 },
    videoCount: { type: Number, default: 0 },
    watchTimeMinutes: { type: Number, default: 0 },
    syncedAt: { type: Date, default: null }
  },
  automation: {
    enabled: { type: Boolean, default: false },
    scheduleHourIST: { type: Number, min: 0, max: 23, default: 10 },
    scheduleMinuteIST: { type: Number, min: 0, max: 59, default: 0 },
    privacyStatus: { type: String, enum: ['private', 'unlisted', 'public'], default: 'private' },
    lastPublishedDateIST: { type: String, default: '' },
    omes: {
      enabled: { type: Boolean, default: false },
      frequency: { type: String, enum: ['daily', 'alternate'], default: 'daily' },
      publishTimeIst: { type: String, default: '11:00', match: /^(?:[01]\d|2[0-3]):[0-5]\d$/ },
      lastOmesRunAt: { type: Date, default: null },
      lastOptimizedVideoId: { type: String, default: null }
    }
  }
}, { timestamps: true });

ChannelProfileSchema.index(
  { 'automation.scheduleHourIST': 1, 'automation.scheduleMinuteIST': 1 },
  { unique: true, name: 'unique_ist_schedule_slot' }
);

export default mongoose.model('ChannelProfile', ChannelProfileSchema);
