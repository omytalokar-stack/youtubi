import mongoose from 'mongoose';

const OmesAuditLogSchema = new mongoose.Schema({
  channelId: { type: String, required: true, index: true },
  videoId: { type: String, required: true },
  beforeTitle: { type: String, default: '' },
  afterTitle: { type: String, required: true },
  beforeTagCount: { type: Number, default: 0 },
  afterTagCount: { type: Number, default: 0 },
  privacyBefore: { type: String, default: '' },
  privacyAfter: { type: String, default: 'public' },
  optimizedAt: { type: Date, default: Date.now }
}, { timestamps: true });

OmesAuditLogSchema.index({ channelId: 1, optimizedAt: -1 });
export default mongoose.model('OmesAuditLog', OmesAuditLogSchema);
