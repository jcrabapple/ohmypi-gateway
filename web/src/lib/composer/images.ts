// Image attachments: validation and base64 encoding for the prompt `images` field.
import type { PromptImage } from '../api/endpoints';

export const MAX_IMAGES = 4;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const IMAGE_TYPES: readonly PromptImage['mimeType'][] = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
export const IMAGE_ACCEPT = IMAGE_TYPES.join(',');

export function isImageType(t: string): t is PromptImage['mimeType'] {
  return (IMAGE_TYPES as readonly string[]).includes(t);
}

/** An error to show the user, or null when the file can be attached. */
export function imageProblem(file: Pick<File, 'type' | 'size' | 'name'>, attached: number): string | null {
  if (attached >= MAX_IMAGES) return `Up to ${MAX_IMAGES} images per message`;
  if (!isImageType(file.type)) return 'Use a PNG, JPEG, WebP or GIF image';
  if (file.size > MAX_IMAGE_BYTES) return 'Images can be at most 5 MB';
  return null;
}

/** Raw base64, no `data:` prefix, as the gateway expects. */
export function fileToBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onerror = () => reject(new Error('Could not read the image'));
    r.onload = () => {
      const url = String(r.result ?? '');
      resolve(url.slice(url.indexOf(',') + 1));
    };
    r.readAsDataURL(file);
  });
}

export async function toPromptImage(file: Blob & { type: string }): Promise<PromptImage> {
  if (!isImageType(file.type)) throw new Error('Unsupported image type');
  return { type: 'image', data: await fileToBase64(file), mimeType: file.type };
}
