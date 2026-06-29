import { Jimp, JimpMime } from "jimp";

const defaultMaxDimension = 1280;
const defaultMinDimension = 360;
const defaultTargetBytes = 400_000;
const jpegQualitySteps = [72, 62, 52, 44, 36, 30];
const dimensionScale = 0.75;

export interface CompressedSlackImage {
  bytes: Buffer;
  mimeType: "image/jpeg";
  originalBytes: number;
  compressedBytes: number;
  originalWidth?: number;
  originalHeight?: number;
  width?: number;
  height?: number;
}

export interface CompressSlackImageOptions {
  maxDimension?: number;
  minDimension?: number;
  targetBytes?: number;
}

export function isCompressibleSlackImageMimeType(mimeType?: string): boolean {
  return mimeType === "image/jpeg" || mimeType === "image/png" || mimeType === "image/webp";
}

export async function compressSlackImageForModel(
  input: Buffer,
  mimeType: string | undefined,
  options: CompressSlackImageOptions = {},
): Promise<CompressedSlackImage | null> {
  if (!isCompressibleSlackImageMimeType(mimeType)) {
    return null;
  }

  const targetBytes = options.targetBytes ?? defaultTargetBytes;
  const maxDimension = options.maxDimension ?? defaultMaxDimension;
  const minDimension = Math.min(options.minDimension ?? defaultMinDimension, maxDimension);
  const image = await Jimp.read(input);
  const originalWidth = image.bitmap.width;
  const originalHeight = image.bitmap.height;

  resizeToMaxDimension(image, maxDimension);

  let best: { bytes: Buffer; width: number; height: number } | undefined;
  while (true) {
    for (const quality of jpegQualitySteps) {
      const candidate = await encodeJpeg(image, quality);
      if (!best || candidate.byteLength < best.bytes.byteLength) {
        best = {
          bytes: candidate,
          width: image.bitmap.width,
          height: image.bitmap.height,
        };
      }
      if (candidate.byteLength <= targetBytes) {
        return {
          bytes: candidate,
          mimeType: "image/jpeg",
          originalBytes: input.byteLength,
          compressedBytes: candidate.byteLength,
          originalWidth,
          originalHeight,
          width: image.bitmap.width,
          height: image.bitmap.height,
        };
      }
    }

    const currentLongestSide = Math.max(image.bitmap.width, image.bitmap.height);
    if (currentLongestSide <= minDimension) {
      break;
    }

    const nextMaxDimension = Math.max(minDimension, Math.floor(currentLongestSide * dimensionScale));
    if (nextMaxDimension >= currentLongestSide) {
      break;
    }
    resizeToMaxDimension(image, nextMaxDimension);
  }

  const compressedBytes = best?.bytes ?? Buffer.from(await encodeJpeg(image, jpegQualitySteps.at(-1) ?? 30));
  return {
    bytes: compressedBytes,
    mimeType: "image/jpeg",
    originalBytes: input.byteLength,
    compressedBytes: compressedBytes.byteLength,
    originalWidth,
    originalHeight,
    width: best?.width ?? image.bitmap.width,
    height: best?.height ?? image.bitmap.height,
  };
}

function resizeToMaxDimension(image: Awaited<ReturnType<typeof Jimp.read>>, maxDimension: number): void {
  const { width, height } = image.bitmap;
  const longestSide = Math.max(width, height);
  if (longestSide <= maxDimension) {
    return;
  }

  if (width >= height) {
    image.resize({ w: maxDimension });
  } else {
    image.resize({ h: maxDimension });
  }
}

async function encodeJpeg(image: Awaited<ReturnType<typeof Jimp.read>>, quality: number): Promise<Buffer> {
  return Buffer.from(await image.getBuffer(JimpMime.jpeg, { quality }));
}
