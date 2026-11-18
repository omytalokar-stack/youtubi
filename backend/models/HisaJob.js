import mongoose from 'mongoose';

const HisaJobSchema = new mongoose.Schema({
  channelId: { type: String, required: true, index: true },
  scheduledDateIST: { type: String, required: true },
  dueAt: { type: Date, required: true },
  publishDateIST: { type: String, default: '' },
  isTest: { type: Boolean, default: false, index: true },
  status: {
    type: String,
    enum: ['pending', 'processing', 'completed', 'failed', 'fallback'],
    default: 'pending',
    index: true
  },
  title: { type: String, required: true },
  hook: { type: String, default: '' },
  script: { type: String, required: true },
  description: { type: String, default: '' },
  tags: { type: [String], default: [] },
  subtitleBeats: { type: [String], required: true },
  animationPrompts: { type: [String], required: true },
  processingAt: { type: Date },
  completedAt: { type: Date },
  videoId: { type: String, default: '' },
  error: { type: String, default: '' }
}, { timestamps: true });

HisaJobSchema.index({ channelId: 1, scheduledDateIST: 1 }, { unique: true });
HisaJobSchema.index({ status: 1, createdAt: 1 });

export default mongoose.model('HisaJob', HisaJobSchema);
