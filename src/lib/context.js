// A post and a reply under it are different writing targets. Transport (tab/frame)
// is deliberately separate: an editor can be re-rendered without changing its target.
export function fingerprint(value) {
  // chrome.storage may return dictionary keys in a different order than runtime
  // messaging. The same source must compare equal across both serialization paths.
  const text = typeof value === 'string' ? value : JSON.stringify(value, (_key, item) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item);
  let a = 2166136261;
  let b = 5381;
  for (let i = 0; i < text.length; i++) {
    a = Math.imul(a ^ text.charCodeAt(i), 16777619);
    b = Math.imul(b, 33) ^ text.charCodeAt(i);
  }
  return `${(a >>> 0).toString(36)}-${(b >>> 0).toString(36)}`;
}

export function targetIdentity(post) {
  if (!post) return '';
  const reply = post.replyTo;
  return JSON.stringify([
    post.kind === 'message' ? 'message' : 'comment',
    post.key || '',
    reply ? reply.key || fingerprint([reply.author || '', reply.text || '']) : '',
  ]);
}

/** The source as read from LinkedIn, excluding volatile tokens and enrichment. */
export function sourceRevision(post) {
  if (!post) return '';
  return fingerprint([
    targetIdentity(post), post.text || '', post.lastIncoming || '',
    post.replyTo?.text || '', post.imageUrls || [], post.media || null,
    post.author || '', post.authorHeadline || '', post.authorProfile || null,
    post.linkPreview || null, post.existingComments || [],
  ]);
}

export function draftKey(post) {
  return post ? `lca:draft:${fingerprint(targetIdentity(post))}` : '';
}

export function sameTarget(a, b) {
  return Boolean(a && b && targetIdentity(a) === targetIdentity(b));
}
