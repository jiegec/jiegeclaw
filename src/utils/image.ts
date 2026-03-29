/**
 * Image utilities for processing and converting images.
 */

import { fileTypeFromBuffer } from "file-type";
import type { ImageAttachment } from "../types.js";

/**
 * Convert a buffer to an ImageAttachment with proper MIME type detection.
 * @param buffer The image data buffer
 * @param filenamePrefix Prefix for the generated filename
 * @returns ImageAttachment or null if processing fails
 */
export async function bufferToImageAttachment(
  buffer: Buffer,
  filenamePrefix: string
): Promise<ImageAttachment | null> {
  try {
    // Detect MIME type using file-type library
    const fileType = await fileTypeFromBuffer(buffer);
    const mimeType = fileType?.mime ?? "image/jpeg";
    const extension = fileType?.ext ?? "jpg";

    const base64 = buffer.toString("base64");
    return {
      mimeType,
      filename: `${filenamePrefix}.${extension}`,
      dataUrl: `data:${mimeType};base64,${base64}`,
    };
  } catch (err) {
    console.error("Error converting buffer to image attachment:", (err as Error).message);
    return null;
  }
}
