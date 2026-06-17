import { describe, expect, it } from 'vitest';
import { createThumbnail } from '@/lib/thumbnail';

// jsdom can't decode real images or run canvas.toBlob, so the happy
// path through createThumbnail() returns null. The contract we can
// verify in jsdom is: (1) the function never throws on a non-image
// blob, and (2) it returns null (rather than rejecting) so the
// recents store keeps the source even when the preview can't be
// generated.

describe('createThumbnail', () => {
  it('returns null for a non-image blob instead of throwing', async () => {
    const bogus = new Blob(['not an image'], { type: 'text/plain' });
    const result = await createThumbnail(bogus);
    // jsdom's Image() will fail to decode a text blob; the helper
    // must swallow that and return null.
    expect(result).toBeNull();
  });

  it('returns null for an empty blob', async () => {
    const empty = new Blob([], { type: 'image/jpeg' });
    const result = await createThumbnail(empty);
    expect(result).toBeNull();
  });
});
