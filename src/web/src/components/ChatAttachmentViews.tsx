/**
 * 对话附件视图与浏览器侧预处理（M9-03）。
 *
 * 压缩只在这里做：图片发送前用 canvas 缩到长边 ≤1568px，非透明图统一
 * JPEG 0.85；PNG 若检测到透明像素则保持 PNG。文件本身仍由 chatApi 读成
 * base64，组件不直接发请求。
 */
import { Button, Image } from "antd";
import { CloseOutlined, FileOutlined } from "@ant-design/icons";

import type { ChatAttachment } from "../chatApi";

export const MAX_ATTACHMENTS = 5;
export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
export const MAX_TOTAL_ATTACHMENT_BYTES = 16 * 1024 * 1024;
export const MAX_IMAGE_EDGE = 1568;
export const JPEG_QUALITY = 0.85;

export interface PendingAttachment {
  /** 本地唯一键；同时用作发送前气泡里的临时附件 id。 */
  key: string;
  name: string;
  mime: string;
  size: number;
  file: File;
  previewUrl?: string;
}

const IMAGE_MIMES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

export function isImageMime(mime: string): boolean {
  return IMAGE_MIMES.has(mime.toLowerCase());
}

export function formatBytes(size: number): string {
  const bytes = Math.max(0, Math.floor(size));
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
  const mb = kb / 1024;
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new window.Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("图片读取失败"));
    };
    image.src = url;
  });
}

function hasTransparentPixels(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
): boolean {
  const pixels = context.getImageData(0, 0, width, height).data;
  for (let index = 3; index < pixels.length; index += 4) {
    if ((pixels[index] ?? 255) < 255) return true;
  }
  return false;
}

function dataUrlToBlob(dataUrl: string): Blob {
  const comma = dataUrl.indexOf(",");
  if (comma < 0) throw new Error("图片编码失败");
  const header = dataUrl.slice(0, comma);
  const body = dataUrl.slice(comma + 1);
  const mime = /data:([^;]+)/u.exec(header)?.[1] ?? "application/octet-stream";
  const binary = atob(body);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Blob([bytes], { type: mime });
}

function replaceExtension(name: string, extension: string): string {
  const dot = name.lastIndexOf(".");
  const base = dot > 0 ? name.slice(0, dot) : name;
  return `${base}${extension}`;
}

/** PNG 检测透明；其余一律 JPEG 0.85（透明底先铺白，避免变黑）。 */
export async function compressImageFile(file: File): Promise<File> {
  if (!isImageMime(file.type)) return file;
  const image = await loadImage(file);
  const sourceWidth = image.naturalWidth || image.width;
  const sourceHeight = image.naturalHeight || image.height;
  if (sourceWidth <= 0 || sourceHeight <= 0) {
    throw new Error("图片尺寸不合法");
  }
  const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(sourceWidth, sourceHeight));
  const width = Math.max(1, Math.round(sourceWidth * scale));
  const height = Math.max(1, Math.round(sourceHeight * scale));

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (context === null) throw new Error("浏览器不支持 canvas");

  context.clearRect(0, 0, width, height);
  context.drawImage(image, 0, 0, width, height);
  const keepPng =
    file.type === "image/png" && hasTransparentPixels(context, width, height);
  if (!keepPng) {
    context.globalCompositeOperation = "destination-over";
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, width, height);
    context.globalCompositeOperation = "source-over";
  }

  const mime = keepPng ? "image/png" : "image/jpeg";
  const dataUrl = canvas.toDataURL(mime, JPEG_QUALITY);
  const blob = dataUrlToBlob(dataUrl);
  return new File(
    [blob],
    replaceExtension(file.name, keepPng ? ".png" : ".jpg"),
    { type: mime, lastModified: file.lastModified },
  );
}

/** FileReader → data URL → 逗号后的 base64（POST /chat 的 dataBase64）。 */
export function readFileBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") {
        reject(new Error("读取附件失败"));
        return;
      }
      const comma = result.indexOf(",");
      if (comma < 0) {
        reject(new Error("读取附件失败"));
        return;
      }
      resolve(result.slice(comma + 1));
    };
    reader.onerror = () => {
      reject(new Error("读取附件失败"));
    };
    reader.readAsDataURL(file);
  });
}

export function PendingAttachmentChips({
  items,
  disabled,
  onRemove,
}: {
  items: readonly PendingAttachment[];
  disabled: boolean;
  onRemove: (key: string) => void;
}) {
  if (items.length === 0) return null;
  return (
    <div className="chat-attachment-chips" aria-label="待发送附件">
      {items.map((item) => (
        <span key={item.key} className="chat-attachment-chip">
          {item.previewUrl === undefined ? (
            <FileOutlined className="chat-attachment-icon" />
          ) : (
            <img className="chat-attachment-thumb" src={item.previewUrl} alt="" />
          )}
          <span className="chat-attachment-meta">
            <span className="chat-attachment-name" title={item.name}>
              {item.name}
            </span>
            <span className="chat-attachment-size">{formatBytes(item.size)}</span>
          </span>
          <Button
            type="text"
            size="small"
            icon={<CloseOutlined />}
            aria-label={`移除附件 ${item.name}`}
            disabled={disabled}
            onClick={() => {
              onRemove(item.key);
            }}
          />
        </span>
      ))}
    </div>
  );
}

export function MessageAttachments({
  attachments,
}: {
  attachments: readonly ChatAttachment[];
}) {
  if (attachments.length === 0) return null;
  const images = attachments.filter((attachment) => isImageMime(attachment.mime));
  const files = attachments.filter((attachment) => !isImageMime(attachment.mime));
  return (
    <div className="chat-message-attachments">
      {images.length === 0 ? null : (
        <div className="chat-message-images">
          {images.map((attachment, index) => {
            const src =
              attachment.previewUrl ??
              (attachment.id.length > 0
                ? `/uploads/${encodeURIComponent(attachment.id)}`
                : null);
            if (src === null) return null;
            return (
              <Image
                key={`${attachment.id}-${String(index)}`}
                className="chat-message-image"
                src={src}
                alt={attachment.name}
                width={160}
                preview={{ mask: "点击放大" }}
              />
            );
          })}
        </div>
      )}
      {files.length === 0 ? null : (
        <div className="chat-message-files">
          {files.map((attachment, index) => (
            <span
              key={`${attachment.id}-${String(index)}`}
              className="chat-file-chip"
              title={attachment.name}
            >
              <FileOutlined />
              <span className="chat-file-name">{attachment.name}</span>
              <span className="chat-file-size">{formatBytes(attachment.size)}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
