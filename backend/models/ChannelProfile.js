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
  automation: {
    enabled: { type: Boolean, default: false },
    scheduleHourIST: { type: Number, min: 0, max: 23, default: 10 },
    scheduleMinuteIST: { type: Number, min: 0, max: 59, default: 0 },
    privacyStatus: { type: String, enum: ['private', 'unlisted', 'public'], default: 'private' },
    lastPublishedDateIST: { type: String, default: '' }
  }
}, { timestamps: true });

ChannelProfileSchema.index(
  { 'automation.scheduleHourIST': 1, 'automation.scheduleMinuteIST': 1 },
  { unique: true, name: 'unique_ist_schedule_slot' }
);

export default mongoose.model('ChannelProfile', ChannelProfileSchema);
