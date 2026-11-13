// Manually supplied slides use the same image API as post photos. No PDF fetching,
// carousel clicks, extra host permissions or durable attachment storage.
import { arrayBufferToBase64 } from './images.js';

export const MAX_MEDIA_IMAGES = 6;
export const MAX_ATTACHMENT_BYTES = Math.floor(3.5 * 1024 * 1024);
export const MAX_ATTACHMENTS_BYTES = 12 * 1024 * 1024;
export const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

export async function readAttachment(file) {
  if (!IMAGE_TYPES.has(file.type)) throw new Error('Wybierz obraz PNG, JPG, WebP albo GIF. PDF możesz dodać jako zrzuty stron.');
  if (!file.size || file.size > MAX_ATTACHMENT_BYTES) throw new Error('Jeden obraz może mieć najwyżej 3,5 MB. Zapisz mniejszy obraz i spróbuj ponownie.');
  const buffer = await file.arrayBuffer();
  if (buffer.byteLength > MAX_ATTACHMENT_BYTES) throw new Error('Obraz jest za duży (limit 3,5 MB).');
  const bytes = new Uint8Array(buffer);
  const ascii = (start, count) => String.fromCharCode(...bytes.slice(start, start + count));
  const signature = file.type === 'image/png' ? bytes[0] === 137 && ascii(1, 3) === 'PNG'
    : file.type === 'image/jpeg' ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
    : file.type === 'image/gif' ? /^GIF8[79]a$/.test(ascii(0, 6))
    : ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP';
  if (!signature) throw new Error('Plik nie zawiera poprawnego obrazu. Wybierz zrzut PNG, JPG, WebP albo GIF.');
  return {
    id: crypto.randomUUID(), name: String(file.name || 'Obraz').slice(0, 160), bytes: buffer.byteLength,
    block: { type: 'image', source: { type: 'base64', media_type: file.type, data: arrayBufferToBase64(buffer) } },
  };
}

export function mediaCoverage(post, { imageCount = 0, attachmentCount = 0, failed = 0, imagesEnabled = true } = {}) {
  const media = post?.media;
  const notes = [];
  if (media?.kind === 'document') {
    const count = imageCount + attachmentCount;
    notes.push(`Dokument${media.title ? `: ${media.title}` : ''}. ${count ? `Obrazy stron w zapytaniu: ${count}. ${media.totalPages ? `Liczba stron dokumentu: ${media.totalPages}.` : 'Liczba wszystkich stron nieznana.'}` : 'Do modelu trafia tylko odczytany opis i tytuł, bez slajdów.'}`);
  } else if (media?.kind === 'poll') {
    notes.push(media.complete ? `Ankieta: pytanie i ${media.options.length} opcji, tylko dane widoczne na stronie.` : 'Ankieta: niepełny odczyt. Uzupełnij pytanie i opcje lub dodaj zrzut.');
  } else if (media?.kind === 'video') {
    notes.push('Wideo: model otrzymuje opis i ewentualne obrazy, bez nagrania, dźwięku i napisów.');
  }
  if (attachmentCount) notes.push(`Ręcznie dodane obrazy: ${attachmentCount}.`);
  if (!imagesEnabled && (post?.imageUrls?.length || media?.pages?.length)) notes.push('Obrazy ze strony są wyłączone.');
  if (failed) notes.push(`Nie pobrano ${failed} obrazów. Model otrzyma dostępny tekst i pozostałe obrazy.`);
  return notes.join('\n');
}
