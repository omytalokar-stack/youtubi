import assert from 'node:assert/strict';
import test from 'node:test';
import { generateOmesMetadata, normalizeOmesMetadata } from './metadataOptimizer.js';

test('preserves the channel title suffix and description footer within YouTube limits', () => {
  const suffix = ' | My Channel';
  const footer = 'Subscribe for more.';
  const metadata = normalizeOmesMetadata({
    title: `${'A'.repeat(120)}${suffix}`,
    description: `${'Description '.repeat(600)}\n\n${footer}`,
    tags: ['science', 'shorts']
  }, {
    metadataBlueprint: {
      titleSuffix: suffix,
      fixedDescriptionFooter: footer,
      coreTags: ['my channel']
    }
  });

  assert.ok(metadata.title.length <= 100);
  assert.ok(metadata.title.endsWith(suffix.trim()));
  assert.ok(metadata.description.length <= 5000);
  assert.ok(metadata.description.endsWith(footer));
  assert.deepEqual(metadata.tags, ['my channel', 'science', 'shorts']);
});

test('counts YouTube tag quotes and separators when applying the 450-character limit', () => {
  const tags = [
    'early morning devotional lofi',
    'peaceful bhajan lofi',
    'morning chants 2026',
    'punfk studio',
    'shree ram lofi bhajan',
    'mahadev lofi chants',
    'shri krishna peaceful flute',
    'ganpati morning lofi',
    'hanuman chalisa lofi',
    'maa durga devotional music',
    'vitthal bhajan lofi',
    'gayatri mantra lofi',
    'morning meditation music india',
    'wake up spiritual music',
    'non stop morning bhajan jukebox',
    'morning bhajan',
    'devotional lofi',
    'peaceful chants',
    'morning meditation',
    'spiritual music',
    'bhakti lofi',
    'morning lofi bhajans',
    'morning devotional beats',
    'lofi music'
  ];
  const metadata = normalizeOmesMetadata({
    title: 'Title',
    description: 'Description',
    tags
  });
  const youtubeLength = metadata.tags.reduce((length, tag) =>
    length + tag.length + (tag.includes(' ') ? 2 : 0), 0) + metadata.tags.length - 1;

  assert.ok(youtubeLength < 450);
  assert.ok(metadata.tags.length < tags.length);
  assert.equal(metadata.tags[0], tags[0]);
});

test('removes hashtags and unsupported characters while keeping OMES tags below 450 characters', () => {
  const metadata = normalizeOmesMetadata({
    title: 'Title',
    description: 'Description',
    tags: ['#Shorts😀', '<Coffee> "garden"', 'under_score', 'x'.repeat(449)]
  });

  assert.deepEqual(metadata.tags, ['Shorts', 'Coffee garden', 'under score']);
  const youtubeLength = metadata.tags.reduce((length, tag) =>
    length + Array.from(tag).length + (tag.includes(' ') ? 2 : 0), 0) + metadata.tags.length - 1;
  assert.ok(youtubeLength < 450);
});

test('keeps required channel tags and rejects an impossible footer or title suffix', () => {
  assert.throws(() => normalizeOmesMetadata({
    title: 'Title',
    description: 'Useful description',
    tags: ['topic']
  }, {
    metadataBlueprint: { titleSuffix: 'x'.repeat(100), coreTags: [] }
  }), /title suffix is too long/);
  assert.throws(() => normalizeOmesMetadata({
    title: 'Title',
    description: 'Useful description',
    tags: ['topic']
  }, {
    metadataBlueprint: { fixedDescriptionFooter: 'x'.repeat(5001), coreTags: [] }
  }), /description footer is too long/);
  assert.throws(() => normalizeOmesMetadata({
    title: 'Title', description: 'Description', tags: []
  }, {
    metadataBlueprint: { coreTags: ['x'.repeat(501)] }
  }), /core tags exceed/);
});

test('retries duplicate and heavily overlapping titles while preserving the metadata blueprint', async () => {
  const suffix = ' | My Channel';
  const footer = 'Subscribe for more.';
  const history = [{
    videoId: 'old-video',
    title: `Ancient Egypt: 7 Secrets${suffix}`,
    description: 'History from an older upload.\n\n' + footer,
    tags: ['history']
  }];
  const generated = [
    { title: 'Ancient Egypt: 7 Secrets', description: 'About the new video.', tags: ['new-topic'] },
    { title: 'Ancient Egypt: 7 Secrets You Never Knew', description: 'Still about the new video.', tags: ['new-topic'] },
    { title: 'Why the Nile Flooded Every Summer', description: `A distinct video body.\n\n${footer}`, tags: ['new-topic'] }
  ];
  const prompts = [];
  const metadata = await generateOmesMetadata({
    videoId: 'new-video',
    title: 'A new upload',
    description: 'Unoptimized description',
    tags: ['draft'],
    privacyStatus: 'private'
  }, history, {
    channelTitle: 'My Channel',
    metadataBlueprint: {
      titleSuffix: suffix,
      fixedDescriptionFooter: footer,
      coreTags: ['my channel']
    }
  }, {
    transcript: 'The video explains the Nile flood cycle.',
    thumbnail: { mimeType: 'image/jpeg', data: 'dGh1bWJuYWls' }
  }, {
    generate: async (prompt, context) => {
      prompts.push(prompt);
      assert.equal(context.transcript, 'The video explains the Nile flood cycle.');
      return generated.shift();
    }
  });

  assert.equal(prompts.length, 3);
  assert.match(prompts[0], /Ancient Egypt: 7 Secrets/);
  assert.match(prompts[0], /History from an older upload/);
  assert.match(prompts[0], /The video explains the Nile flood cycle/);
  assert.match(prompts[1], /Additional blocked main titles from previous generation attempts/);
  assert.ok(metadata.title.endsWith(suffix));
  assert.equal(metadata.description, `A distinct video body.\n\n${footer}`);
  assert.ok(metadata.tags.includes('my channel'));
  assert.ok(metadata.tags.includes('new topic'));
});

test('rejects a title if all three generations collide with a recent main title', async () => {
  let attempts = 0;
  await assert.rejects(generateOmesMetadata({
    videoId: 'new-video',
    title: 'Current',
    description: 'Current description',
    tags: []
  }, [{
    videoId: 'old-video',
    title: 'A Bright Red Balloon',
    description: 'Old body'
  }], {}, {}, {
    generate: async () => {
      attempts += 1;
      return { title: 'A Bright Red Balloon', description: 'New body', tags: ['balloon'] };
    }
  }), /duplicate or heavily overlapping title after 3 attempts/);
  assert.equal(attempts, 3);
});
