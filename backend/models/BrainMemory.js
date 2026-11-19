import mongoose from 'mongoose';

const BrainMemorySchema = new mongoose.Schema({
  channelId: { type: String, required: true, unique: true, index: true },
  selfCorrectionEnabled: { type: Boolean, default: true },
  winningTactics: { type: [String], default: [] },
  mistakeRules: { type: [String], default: [] },
  winningBlueprint: { type: String, default: '' },
  nextVideoStrategy: { type: String, default: '' },
  performanceScorecard: [{
    videoId: { type: String, default: '' },
    title: { type: String, default: '' },
    classification: { type: String, enum: ['winner', 'underperformer'], default: 'underperformer' },
    score: { type: Number, default: 0 },
    views: { type: Number, default: 0 },
    impressions: { type: Number, default: 0 },
    ctr: { type: Number, default: 0 },
    averageViewDuration: { type: Number, default: 0 },
    retention: { type: Number, default: 0 },
    likes: { type: Number, default: 0 },
    publishedAt: { type: Date, default: null }
  }],
  lastAutoAuditAt: { type: Date, default: null }
}, { timestamps: true });

export default mongoose.model('BrainMemory', BrainMemorySchema);
