// Turn post image URLs (media.licdn.com) into base64 image blocks for Claude.
// Base64 instead of `source: {type: "url"}` because LinkedIn's signed media URLs
// may not be fetchable by the API servers, and OpenRouter's pass-through of URL
// images is not guaranteed.

const SUPPORTED_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
// API limit is 5 MB per image (base64 grows ~33%), keep a margin.
const MAX_IMAGE_BYTES = 3.5 * 1024 * 1024;

/**
 * Convert binary data to base64 without blowing the call stack on large inputs.
 * @param {ArrayBuffer} buffer
 * @returns {string}
 */
export function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

/**
 * Fetch one image and build an Anthropic image block; returns null when unusable.
 * @param {string} url
 * @param {typeof fetch} [fetchFn]
 * @returns {Promise<object|null>}
 */
export async function fetchImageBlock(url, fetchFn = fetch) {
  try {
    const response = await fetchFn(url, { credentials: 'omit' });
    if (!response.ok) return null;
    const mediaType = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!SUPPORTED_TYPES.has(mediaType)) return null;
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength === 0 || buffer.byteLength > MAX_IMAGE_BYTES) return null;
    return {
      type: 'image',
      source: { type: 'base64', media_type: mediaType, data: arrayBufferToBase64(buffer) },
    };
  } catch {
    // Network/CORS failure: commenting still works without the image.
    return null;
  }
}

/**
 * @param {string[]} urls
 * @param {typeof fetch} [fetchFn]
 * @returns {Promise<object[]>}
 */
export async function fetchImageBlocks(urls, fetchFn = fetch) {
  const blocks = await Promise.all((urls || []).slice(0, 2).map((u) => fetchImageBlock(u, fetchFn)));
  return blocks.filter(Boolean);
}
