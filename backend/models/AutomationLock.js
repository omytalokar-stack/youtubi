import mongoose from 'mongoose';

const AutomationLockSchema = new mongoose.Schema({
  lockKey: { type: String, required: true, unique: true, default: 'GLOBAL_RENDER_WORKER' },
  ownerChannelId: { type: String, required: true },
  expiresAt: { type: Date, required: true }
}, { timestamps: true });

AutomationLockSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export default mongoose.model('AutomationLock', AutomationLockSchema);
