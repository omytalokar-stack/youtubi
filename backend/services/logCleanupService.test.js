import assert from 'node:assert/strict';
import test from 'node:test';
import OmesAuditLog from '../models/OmesAuditLog.js';
import VideoLog from '../models/VideoLog.js';
import { pruneChannelLogs } from './logCleanupService.js';

function query(records) {
  return {
    sort() { return this; },
    skip() { return this; },
    limit() { return this; },
    select() { return this; },
    lean: async () => records
  };
}

test('prunes old and excess database logs without acting on YouTube resources', async (t) => {
  const originals = {
    videoDeleteMany: VideoLog.deleteMany,
    videoFind: VideoLog.find,
    videoCount: VideoLog.countDocuments,
    auditDeleteMany: OmesAuditLog.deleteMany,
    auditFind: OmesAuditLog.find,
    auditCount: OmesAuditLog.countDocuments
  };
  const deletedVideos = [];
  const deletedAudits = [];
  const oldest = Array.from({ length: 10 }, (_, index) => ({
    _id: `video-${index}`,
    createdAt: new Date(2026, 0, index + 1)
  }));
  VideoLog.deleteMany = async (filter) => { deletedVideos.push(filter); };
  OmesAuditLog.deleteMany = async (filter) => { deletedAudits.push(filter); };
  VideoLog.find = (filter) => query(filter.channelId ? [] : oldest);
  OmesAuditLog.find = (filter) => query(filter.channelId ? [] : []);
  VideoLog.countDocuments = async () => 200;
  OmesAuditLog.countDocuments = async () => 110;
  t.after(() => {
    VideoLog.deleteMany = originals.videoDeleteMany;
    VideoLog.find = originals.videoFind;
    VideoLog.countDocuments = originals.videoCount;
    OmesAuditLog.deleteMany = originals.auditDeleteMany;
    OmesAuditLog.find = originals.auditFind;
    OmesAuditLog.countDocuments = originals.auditCount;
  });

  await pruneChannelLogs(`UC${'a'.repeat(22)}`, new Date('2026-03-01T00:00:00Z'));

  assert.equal(deletedVideos.length, 2);
  assert.equal(deletedAudits.length, 1);
  assert.deepEqual(deletedVideos[1], { _id: { $in: oldest.map((record) => record._id) } });
  assert.equal(deletedAudits[0].createdAt.$lt.toISOString(), '2026-01-15T00:00:00.000Z');
});
