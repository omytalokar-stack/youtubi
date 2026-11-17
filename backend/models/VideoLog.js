import mongoose from 'mongoose';

const VideoLogSchema = new mongoose.Schema({
  channelId: { type: String, required: true, index: true },
  videoId: { type: String, required: true },
  title: { type: String, required: true },
  hook: { type: String, default: '' },
  script: { type: String, default: '' },
  tags: { type: [String], default: [] },
  views: { type: Number, default: 0 },
  likes: { type: Number, default: 0 },
  watchTimeMinutes: { type: Number, default: 0 },
  publishedAt: { type: Date, default: Date.now }
}, { timestamps: true });

VideoLogSchema.index({ channelId: 1, publishedAt: -1 });
export default mongoose.model('VideoLog', VideoLogSchema);
