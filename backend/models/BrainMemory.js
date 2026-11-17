import mongoose from 'mongoose';

const BrainMemorySchema = new mongoose.Schema({
  channelId: { type: String, required: true, unique: true, index: true },
  selfCorrectionEnabled: { type: Boolean, default: true },
  winningTactics: { type: [String], default: [] },
  mistakeRules: { type: [String], default: [] },
  lastAutoAuditAt: { type: Date, default: null }
}, { timestamps: true });

export default mongoose.model('BrainMemory', BrainMemorySchema);
