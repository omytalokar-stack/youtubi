import mongoose from 'mongoose';

const YouTubeCredentialSchema = new mongoose.Schema({
  channelId: { type: String, required: true, unique: true, index: true },
  channelTitle: { type: String, required: true },
  thumbnailUrl: { type: String, default: '' },
  refreshToken: { type: String, required: true },
  iv: { type: String, required: true },
  authTag: { type: String, required: true },
  scopes: { type: [String], default: [] }
}, { timestamps: true });

export default mongoose.model('YouTubeCredential', YouTubeCredentialSchema);
