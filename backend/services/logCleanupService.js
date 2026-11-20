import OmesAuditLog from '../models/OmesAuditLog.js';
import VideoLog from '../models/VideoLog.js';

const MAX_LOGS_PER_CHANNEL = 50;
const MAX_TOTAL_LOGS = 300;
const RETENTION_DAYS = 45;

async function pruneModel(Model, channelId, now) {
  const cutoff = new Date(now.getTime() - RETENTION_DAYS * 86400000);
  await Model.deleteMany({ createdAt: { $lt: cutoff } });

  const channelOverflow = await Model.find({ channelId })
    .sort({ createdAt: -1, _id: -1 })
    .skip(MAX_LOGS_PER_CHANNEL)
    .select('_id')
    .lean();
  if (channelOverflow.length) {
    await Model.deleteMany({ _id: { $in: channelOverflow.map((record) => record._id) } });
  }
}

async function pruneGlobalLimit() {
  const [videoCount, auditCount] = await Promise.all([
    VideoLog.countDocuments(),
    OmesAuditLog.countDocuments()
  ]);
  const overflow = videoCount + auditCount - MAX_TOTAL_LOGS;
  if (overflow > 0) {
    const [oldestVideos, oldestAudits] = await Promise.all([
      VideoLog.find({}).sort({ createdAt: 1, _id: 1 }).limit(overflow).select('_id createdAt').lean(),
      OmesAuditLog.find({}).sort({ createdAt: 1, _id: 1 }).limit(overflow).select('_id createdAt').lean()
    ]);
    const oldest = [
      ...oldestVideos.map((record) => ({ ...record, collection: VideoLog })),
      ...oldestAudits.map((record) => ({ ...record, collection: OmesAuditLog }))
    ].sort((left, right) => left.createdAt - right.createdAt).slice(0, overflow);
    for (const Model of [VideoLog, OmesAuditLog]) {
      const ids = oldest.filter((record) => record.collection === Model).map((record) => record._id);
      if (ids.length) await Model.deleteMany({ _id: { $in: ids } });
    }
  }
}

export async function pruneChannelLogs(channelId, now = new Date()) {
  await Promise.all([
    pruneModel(VideoLog, channelId, now),
    pruneModel(OmesAuditLog, channelId, now)
  ]);
  await pruneGlobalLimit();
}
