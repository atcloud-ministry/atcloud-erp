/**
 * Server-Side Image Compression Service
 *
 * Ensures all uploaded images are compressed and optimized for storage.
 * Original files are never permanently stored - only compressed versions.
 *
 * Key Features:
 * - Automatic compression with Sharp
 * - Different compression profiles for different use cases
 * - Original file cleanup after compression
 * - Fallback error handling
 * - Size and format optimization
 */

import sharp, { type Metadata } from "sharp";
import path from "path";
import fs from "fs/promises";
// import { Request } from "express"; // unused

export interface CompressionConfig {
  maxWidth: number;
  maxHeight: number;
  quality: number;
  format: "jpeg" | "png" | "webp";
  progressive?: boolean;
  stripMetadata?: boolean;
}

export interface CompressionResult {
  compressedPath: string;
  originalSize: number;
  compressedSize: number;
  compressionRatio: number;
  dimensions: {
    width: number;
    height: number;
  };
  format: CompressionConfig["format"];
  mimeType: string;
}

// Compression profiles for different image types
export const COMPRESSION_PROFILES = {
  avatar: {
    maxWidth: 512,
    maxHeight: 512,
    quality: 82,
    format: "webp" as const,
    progressive: false,
    stripMetadata: true,
  },
  eventImage: {
    maxWidth: 1600,
    maxHeight: 1600,
    quality: 82,
    format: "webp" as const,
    progressive: true,
    stripMetadata: true,
  },
  thumbnail: {
    maxWidth: 256,
    maxHeight: 256,
    quality: 78,
    format: "webp" as const,
    progressive: false,
    stripMetadata: true,
  },
} as const;

const MIME_BY_FORMAT: Record<CompressionConfig["format"], string> = {
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

export class ImageCompressionService {
  /**
   * Compress an uploaded image file
   * @param originalPath Path to the original uploaded file
   * @param config Compression configuration
   * @returns Compression result with details
   */
  static async compressImage(
    originalPath: string,
    config: CompressionConfig
  ): Promise<CompressionResult> {
    try {
      // Get original file stats
      const originalStats = await fs.stat(originalPath);
      const originalSize = originalStats.size;

      // Generate compressed file path
      const parsedPath = path.parse(originalPath);
      const compressedPath = path.join(
        parsedPath.dir,
        `${parsedPath.name}-compressed.${config.format}`
      );

      // Rotate according to EXIF orientation, normalize color, then resize.
      // Sharp strips metadata by default when withMetadata() is not called.
      let sharpInstance = sharp(originalPath)
        .rotate()
        .toColorspace("srgb")
        .resize(config.maxWidth, config.maxHeight, {
          fit: "inside",
          withoutEnlargement: true,
          kernel: "lanczos3",
        });

      // Apply format-specific optimizations
      switch (config.format) {
        case "jpeg":
          sharpInstance = sharpInstance.jpeg({
            quality: config.quality,
            progressive: config.progressive || false,
            mozjpeg: true, // Use mozjpeg encoder for better compression
          });
          break;
        case "png":
          sharpInstance = sharpInstance.png({
            quality: config.quality,
            compressionLevel: 9,
            progressive: config.progressive || false,
          });
          break;
        case "webp":
          sharpInstance = sharpInstance.webp({
            quality: config.quality,
            effort: 6, // Higher effort for better compression
          });
          break;
      }

      // Preserve metadata only when explicitly requested. Default output strips it.
      if (config.stripMetadata === false) {
        sharpInstance = sharpInstance.withMetadata({
          icc: "srgb", // Keep color profile
        });
      }

      // Save compressed image
      const compressedInfo = await sharpInstance.toFile(compressedPath);

      // Get compressed file size
      const compressedStats = await fs.stat(compressedPath);
      const compressedSize = compressedStats.size;

      // Calculate compression ratio
      const compressionRatio = Math.round(
        ((originalSize - compressedSize) / originalSize) * 100
      );

      // Clean up original file
      await fs.unlink(originalPath);

      return {
        compressedPath,
        originalSize,
        compressedSize,
        compressionRatio,
        dimensions: {
          width: compressedInfo.width,
          height: compressedInfo.height,
        },
        format: config.format,
        mimeType: MIME_BY_FORMAT[config.format],
      };
    } catch (error) {
      // Clean up files on error
      try {
        await fs.unlink(originalPath);
      } catch (cleanupError) {
        console.warn("Failed to clean up original file:", cleanupError);
      }

      throw new Error(
        `Image compression failed: ${
          error instanceof Error ? error.message : "Unknown error"
        }`
      );
    }
  }

  /**
   * Get compression profile based on field name
   */
  static getCompressionProfile(fieldName: string): CompressionConfig {
    switch (fieldName) {
      case "avatar":
        return COMPRESSION_PROFILES.avatar;
      case "image":
        return COMPRESSION_PROFILES.eventImage;
      default:
        return COMPRESSION_PROFILES.avatar; // Default fallback
    }
  }

  /**
   * Generate optimized filename for compressed image
   */
  static generateCompressedFilename(
    originalFilename: string,
    config: CompressionConfig
  ): string {
    const parsedPath = path.parse(originalFilename);
    const timestamp = Date.now();
    const random = Math.round(Math.random() * 1e9);

    return `${parsedPath.name}-${timestamp}-${random}-compressed.${config.format}`;
  }

  static getMimeTypeForFormat(format: CompressionConfig["format"]): string {
    return MIME_BY_FORMAT[format];
  }

  /**
   * Validate image file before processing
   */
  static async validateImageFile(filePath: string): Promise<{
    isValid: boolean;
    metadata?: Metadata;
    error?: string;
  }> {
    try {
      const metadata = await sharp(filePath).metadata();

      // Check if it's a valid image
      if (!metadata.width || !metadata.height) {
        return {
          isValid: false,
          error: "Invalid image: missing dimensions",
        };
      }

      // Check reasonable size limits (not too small, not corrupted)
      if (metadata.width < 10 || metadata.height < 10) {
        return {
          isValid: false,
          error: "Image too small (minimum 10x10 pixels)",
        };
      }

      if (metadata.width > 10000 || metadata.height > 10000) {
        return {
          isValid: false,
          error: "Image too large (maximum 10000x10000 pixels)",
        };
      }

      return {
        isValid: true,
        metadata,
      };
    } catch (error) {
      return {
        isValid: false,
        error: `Image validation failed: ${
          error instanceof Error ? error.message : "Unknown error"
        }`,
      };
    }
  }

  /**
   * Get file size in human-readable format
   */
  static formatFileSize(bytes: number): string {
    if (bytes === 0) return "0 Bytes";

    const k = 1024;
    const sizes = ["Bytes", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));

    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
  }
}

export default ImageCompressionService;
