// Only the user's own text is allowed here. Never persist source posts, DM
// transcripts, model conversations, thinking, API configs or attachment bytes.
export const DRAFT_LIMIT = 20;
export const VERSION_LIMIT = 8;
export const DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const INDEX = 'lca:draftIndex';
const STORAGE_BUDGET_BYTES = 4_000_000;
const text = (value, limit = 20000) => typeof value === 'string' ? value.slice(0, limit) : '';

export function sanitizeVersion(raw = {}) {
  raw = raw && typeof raw === 'object' ? raw : {};
  return {
    at: Number.isFinite(raw.at) ? raw.at : Date.now(),
    comment: text(raw.comment),
    translation: text(raw.translation),
    translationFor: text(raw.translationFor),
    generated: text(raw.generated),
    tone: text(raw.tone, 30),
    length: text(raw.length, 30),
  };
}

export function pushVersion(versions, version) {
  const next = sanitizeVersion(version);
  if (!next.comment.trim()) return (versions || []).slice(-VERSION_LIMIT);
  const previous = (versions || []).filter((item) => item.comment !== next.comment);
  return [...previous, next].slice(-VERSION_LIMIT);
}

export function sanitizeDraft(raw, now = Date.now()) {
  if (!raw || typeof raw !== 'object' || !Number.isFinite(raw.at) || raw.at < now - DRAFT_TTL_MS || raw.at > now + 60000) return null;
  return {
    ...sanitizeVersion(raw),
    instruction: text(raw.instruction, 10000),
    feedback: text(raw.feedback, 5000),
    sourceRevision: text(raw.sourceRevision, 100),
    hadAttachments: raw.hadAttachments === true,
    versions: Array.isArray(raw.versions) ? raw.versions.slice(-VERSION_LIMIT).map(sanitizeVersion) : [],
  };
}

/** Service-worker-owned queue survives destruction of the panel's document. */
export class DraftRepository {
  constructor(session, local, now = Date.now) {
    this.session = session;
    this.local = local;
    this.now = now;
    this.queue = Promise.resolve();
  }

  enqueue(fn) {
    const next = this.queue.catch(() => {}).then(fn);
    this.queue = next;
    return next;
  }

  validKey(key) {
    return typeof key === 'string' && /^lca:draft:[a-z0-9-]{1,80}$/.test(key);
  }

  load(key) {
    return this.enqueue(async () => {
      if (!this.validKey(key)) return null;
      const transient = sanitizeDraft((await this.session.get(key))[key], this.now());
      const persistent = sanitizeDraft((await this.local.get(key))[key], this.now());
      if (!transient && !persistent) {
        await Promise.all([this.session.remove(key), this.local.remove(key)]);
        return null;
      }
      return !transient || persistent?.at > transient.at ? persistent : transient;
    });
  }

  save(key, raw, persistent = false) {
    return this.enqueue(async () => {
      if (!this.validKey(key)) return;
      const draft = sanitizeDraft(raw, this.now());
      if (!draft) return;
      await this.session.set({ [key]: draft });
      const keepPermanent = typeof persistent === 'function' ? await persistent() : persistent;
      if (keepPermanent) await this.local.set({ [key]: draft });
      else await this.local.remove(key);
      for (const storage of [this.session, this.local]) {
        const stored = (await storage.get(INDEX))[INDEX];
        const index = Array.isArray(stored) ? stored : [];
        const bytes = new TextEncoder().encode(JSON.stringify(draft)).byteLength;
        const next = [...index.filter((item) => item.key !== key), { key, at: draft.at, bytes }]
          .filter((item) => this.validKey(item.key) && Number.isFinite(item.at))
          .sort((a, b) => b.at - a.at);
        let used = 0;
        const keep = next.filter((item, i) => {
          used += Number(item.bytes) || 0;
          return i < DRAFT_LIMIT && item.at >= this.now() - DRAFT_TTL_MS && used <= STORAGE_BUDGET_BYTES;
        });
        const remove = next.filter((item) => !keep.includes(item)).map((item) => item.key);
        if (remove.length) await storage.remove(remove);
        await storage.set({ [INDEX]: keep });
      }
    });
  }

  clearPersistent() {
    return this.enqueue(async () => {
      const stored = (await this.local.get(INDEX))[INDEX];
      const index = Array.isArray(stored) ? stored : [];
      await this.local.remove([INDEX, ...index.map((item) => item.key).filter((key) => this.validKey(key))]);
    });
  }

  prune() {
    return this.enqueue(async () => {
      for (const storage of [this.session, this.local]) {
        const stored = (await storage.get(INDEX))[INDEX];
        const index = Array.isArray(stored) ? stored : [];
        const expired = index.filter((item) => this.validKey(item.key) && item.at < this.now() - DRAFT_TTL_MS);
        if (expired.length) await storage.remove(expired.map((item) => item.key));
        await storage.set({ [INDEX]: index.filter((item) => !expired.includes(item) && this.validKey(item.key)) });
      }
    });
  }
}
