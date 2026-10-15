import { expect, it } from '@jest/globals';
import { ViewImageDataSchema, type ImageNormalizationFacts } from '../../src/contracts/index.js';
import { ImageNormalizationFactsSchema } from '../../src/contracts/image-normalization.js';

const original: ImageNormalizationFacts = {
  source_dimensions: { width: 20, height: 10 },
  oriented_dimensions: { width: 20, height: 10 },
  sent_dimensions: { width: 20, height: 10 },
  orientation_applied: false,
  resized: false,
  scale: { x: 1, y: 1 },
  max_dimension: 'original',
};
const resized: ImageNormalizationFacts = {
  ...original, sent_dimensions: { width: 8, height: 4 },
  resized: true, scale: { x: .4, y: .4 }, max_dimension: 8,
};

it('shares original, resized, oriented and rounded selection invariants without a workspace path', () => {
  const rounded = {
    ...resized, source_dimensions: { width: 30, height: 20 },
    oriented_dimensions: { width: 30, height: 20 },
    sent_dimensions: { width: 8, height: 5 }, scale: { x: 8 / 30, y: 5 / 20 },
  };
  for (const facts of [original, resized, rounded, {
    ...resized, oriented_dimensions: { width: 10, height: 20 },
    sent_dimensions: { width: 4, height: 8 }, orientation_applied: true,
  }, {
    ...original, source_dimensions: { width: 2000, height: 20000 },
    oriented_dimensions: { width: 2000, height: 20000 },
    sent_dimensions: { width: 2000, height: 20000 },
  }]) {
    expect(ImageNormalizationFactsSchema.parse(facts)).toEqual(facts);
    expect(ViewImageDataSchema.parse({ ...facts, source_path: 'project:///source.png' }))
      .toEqual({ ...facts, source_path: 'project:///source.png' });
  }
  expect(ViewImageDataSchema.safeParse(original).success).toBe(false);
  expect(ViewImageDataSchema.safeParse({ ...original, source_path: '' }).success).toBe(false);
  expect(ImageNormalizationFactsSchema.safeParse({ ...original, source_path: 'foreign' }).success).toBe(false);
});

it('rejects inconsistent normalization facts with the existing shared diagnostic', () => {
  for (const facts of [
    { ...original, oriented_dimensions: { width: 19, height: 10 } },
    { ...original, oriented_dimensions: { width: 10, height: 20 }, sent_dimensions: { width: 10, height: 20 } },
    { ...original, sent_dimensions: { width: 21, height: 10 } },
    { ...resized, scale: { x: .5, y: .4 } },
    { ...resized, scale: { x: .4, y: .5 } },
    { ...resized, resized: false },
    { ...original, resized: true },
    { ...resized, max_dimension: 'original' },
    { ...resized, max_dimension: 7 },
    { ...resized, sent_dimensions: { width: 8, height: 2 }, scale: { x: .4, y: .2 } },
  ]) {
    for (const parsed of [ImageNormalizationFactsSchema.safeParse(facts), ViewImageDataSchema.safeParse({ ...facts, source_path: 'source.png' })]) {
      expect(parsed.success).toBe(false);
      if (parsed.success) throw new Error('Expected inconsistent facts.');
      expect(parsed.error.issues).toContainEqual(expect.objectContaining({ code: 'custom', message: 'Inconsistent image selection metadata.' }));
    }
  }
});

it('retains strict nested objects and dimension, scale and maximum bounds in both consumers', () => {
  for (const facts of [
    { ...original, extra: true },
    ...(['source_dimensions', 'oriented_dimensions', 'sent_dimensions'] as const).flatMap(key => [
      { ...original, [key]: { ...original[key], extra: true } },
      { ...original, [key]: { width: 4000, height: 10001 } },
      { ...original, [key]: { width: 40000001, height: 1 } },
      { ...original, [key]: { width: 0, height: 10 } },
      { ...original, [key]: { width: 1.5, height: 10 } },
    ]),
    { ...original, scale: { x: 1, y: 1, extra: true } },
    { ...original, scale: { x: 0, y: 1 } },
    { ...original, scale: { x: 1, y: 1.1 } },
    ...[0, 1.5, 16385, 'unknown'].map(max_dimension => ({ ...original, max_dimension })),
  ]) {
    expect(ImageNormalizationFactsSchema.safeParse(facts).success).toBe(false);
    expect(ViewImageDataSchema.safeParse({ ...facts, source_path: 'source.png' }).success).toBe(false);
  }
});
