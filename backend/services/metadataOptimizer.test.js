import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeOmesMetadata } from './metadataOptimizer.js';

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

test('counts YouTube tag quotes and separators when applying the 500-character limit', () => {
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

  assert.ok(youtubeLength <= 500);
  assert.ok(metadata.tags.length < tags.length);
  assert.equal(metadata.tags[0], tags[0]);
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
