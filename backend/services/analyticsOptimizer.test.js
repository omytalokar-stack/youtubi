import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyPerformance } from './analyticsOptimizer.js';

test('classifies recent videos relative to channel views, CTR, retention, and likes', () => {
  const classified = classifyPerformance([
    { videoId: 'winner', publishedAt: new Date().toISOString(), views: 10000, impressions: 12000, ctr: 8, retention: 90, averageViewDuration: 45, likes: 900 },
    { videoId: 'middle', publishedAt: new Date().toISOString(), views: 5000, impressions: 8000, ctr: 5, retention: 65, averageViewDuration: 30, likes: 300 },
    { videoId: 'underperformer', publishedAt: new Date().toISOString(), views: 1000, impressions: 4000, ctr: 2, retention: 30, averageViewDuration: 12, likes: 20 }
  ]);
  assert.equal(classified.find((video) => video.videoId === 'winner').classification, 'winner');
  assert.equal(classified.find((video) => video.videoId === 'underperformer').classification, 'underperformer');
});

test('does not classify a video without any measurable performance', () => {
  const classified = classifyPerformance([{ videoId: 'new', views: 0, impressions: 0, ctr: 0, retention: 0, likes: 0 }]);
  assert.equal(classified[0].classification, 'underperformer');
});
