/**
 * 对话附件存储辅助（M9-03）。
 *
 * 边界：只负责「校验 + 解码 + 落盘 + 生成 content 分片 + 按 id 定位」，
 * 不碰数据库、不写事件、不调用 provider。消息元数据由 store/messages 落库。
 *
 * 安全约定：
 *   - 文件名先取 basename 再去分隔符，最多 120 个码点；
 *   - 落盘与读取都做 resolve 后的目录包含校验（防路径穿越）；
 *   - 错误信息只含数量/类型等通用文案，不回显用户路径或内容。
 */
import {
  mkdirSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';

import { ContractError, ERROR_CODES } from '../core/errors.ts';
import type { LlmContentPart } from '../core/types.ts';
import type { MessageAttachment } from '../store/messages.ts';
import { newUlid } from '../store/ulid.ts';

export const MAX_ATTACHMENTS = 5;
export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
export const MAX_TOTAL_ATTACHMENT_BYTES = 16 * 1024 * 1024;
export const MAX_INLINE_TEXT_BYTES = 64 * 1024;
export const MAX_ATTACHMENT_NAME_CHARS = 120;
/** POST /chat 需要容纳 5×8MB 的 base64 外壳；本地逐项限制仍先给出 400。 */
export const CHAT_BODY_LIMIT_BYTES = 64 * 1024 * 1024;

const IMAGE_MIMES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]);

const TEXT_EXTENSIONS = new Set([
  'md',
  'markdown',
  'txt',
  'text',
  'log',
  'csv',
  'tsv',
  'json',
  'jsonl',
  'yaml',
  'yml',
  'toml',
  'ini',
  'conf',
  'env',
  'xml',
  'html',
  'htm',
  'css',
  'scss',
  'less',
  'js',
  'mjs',
  'cjs',
  'jsx',
  'ts',
  'tsx',
  'py',
  'rb',
  'php',
  'go',
  'rs',
  'java',
  'kt',
  'swift',
  'c',
  'h',
  'cc',
  'cpp',
  'hpp',
  'cs',
  'sh',
  'bash',
  'zsh',
  'ps1',
  'bat',
  'cmd',
  'sql',
  'tex',
  'r',
]);

const TEXT_APPLICATION_MIMES = new Set([
  'application/json',
  'application/ld+json',
  'application/xml',
  'application/javascript',
  'application/x-javascript',
  'application/x-yaml',
  'application/yaml',
  'application/toml',
  'application/sql',
  'application/x-sh',
  'application/x-httpd-php',
]);

export interface RawChatAttachment {
  name: string;
  mime: string;
  dataBase64: string;
}

export interface SavedUpload {
  attachment: MessageAttachment;
  bytes: Buffer;
}

export interface ChatUserContent {
  /** 落库 / GET /messages 的展示文本，只保留用户输入本身。 */
  text: string;
  /** 发给 provider 的当前轮分片：文本 + 图片 data URL。 */
  parts: LlmContentPart[];
}

interface PreparedUpload {
  name: string;
  mime: string;
  bytes: Buffer;
}

function invalid(message: string): never {
  throw new ContractError(ERROR_CODES.E_INVALID_ARGUMENT, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 取 basename、去路径分隔符与控制字符，保留扩展名，最长 120 个码点。 */
export function sanitizeAttachmentName(raw: string): string {
  const normalized = raw.replace(/\\/gu, '/');
  const slash = normalized.lastIndexOf('/');
  let name = slash >= 0 ? normalized.slice(slash + 1) : normalized;
  name = name
    .replace(/[/\\]/gu, '')
    .replace(/[\u0000-\u001f\u007f]/gu, '')
    .trim();
  // Windows 文件名保留字符之外的一律替换，避免落在非法文件名或 ADS 上。
  name = name.replace(/[<>:"|?*]/gu, '_');
  const chars = [...name];
  if (chars.length > MAX_ATTACHMENT_NAME_CHARS) {
    name = chars.slice(0, MAX_ATTACHMENT_NAME_CHARS).join('');
  }
  // "." / ".." 与空名会破坏路径语义，统一替换为普通名字；其余 dotfile 保留。
  if (name.length === 0 || /^\.+$/u.test(name)) name = 'attachment';
  return name;
}

function normalizeMime(raw: string): string {
  const value = raw.split(';')[0]?.trim().toLowerCase() ?? '';
  if (value.length === 0) invalid('附件 mime 不能为空');
  if (!/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/u.test(value)) {
    invalid('附件 mime 格式不合法');
  }
  if (value === 'image/jpg') return 'image/jpeg';
  return value;
}

function decodeBase64(raw: string): Buffer {
  const value = raw.trim();
  if (value.length === 0) return Buffer.alloc(0);
  if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(value)) {
    invalid('附件 dataBase64 不是合法 base64');
  }
  const bytes = Buffer.from(value, 'base64');
  const canonical = bytes.toString('base64').replace(/=+$/u, '');
  if (canonical !== value.replace(/=+$/u, '')) {
    invalid('附件 dataBase64 不是合法 base64');
  }
  return bytes;
}

function isInsideDir(dir: string, target: string): boolean {
  const base = resolve(dir);
  const full = resolve(target);
  const rel = relative(base, full);
  return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel);
}

/**
 * 校验并落盘 POST /chat 的 attachments。
 * 先全量校验（数量/单大小/总大小/base64），再统一写入，避免半途留文件。
 * 所有违规抛 E_INVALID_ARGUMENT，由 server 映射 400。
 */
export function saveChatAttachments(
  raw: unknown,
  uploadsDir: string,
  now: number,
): SavedUpload[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) invalid('attachments 必须是数组');
  if (raw.length > MAX_ATTACHMENTS) {
    invalid(`附件最多 ${MAX_ATTACHMENTS} 个`);
  }

  const prepared: PreparedUpload[] = [];
  let totalBytes = 0;
  for (const item of raw) {
    if (!isRecord(item)) invalid('attachments 每项必须是对象');
    const { name, mime, dataBase64 } = item;
    if (typeof name !== 'string' || name.trim().length === 0) {
      invalid('附件 name 必须是非空字符串');
    }
    if (typeof mime !== 'string') invalid('附件 mime 必须是字符串');
    if (typeof dataBase64 !== 'string') invalid('附件 dataBase64 必须是字符串');

    const bytes = decodeBase64(dataBase64);
    if (bytes.length > MAX_ATTACHMENT_BYTES) {
      invalid(`单个附件不能超过 ${MAX_ATTACHMENT_BYTES / 1024 / 1024}MB`);
    }
    totalBytes += bytes.length;
    if (totalBytes > MAX_TOTAL_ATTACHMENT_BYTES) {
      invalid(`附件总量不能超过 ${MAX_TOTAL_ATTACHMENT_BYTES / 1024 / 1024}MB`);
    }
    prepared.push({
      name: sanitizeAttachmentName(name),
      mime: normalizeMime(mime),
      bytes,
    });
  }

  const saved: SavedUpload[] = [];
  const written: string[] = [];
  try {
    mkdirSync(uploadsDir, { recursive: true });
    for (const item of prepared) {
      const id = newUlid(now);
      const filename = `${id}__${item.name}`;
      const fullPath = resolve(join(uploadsDir, filename));
      if (!isInsideDir(uploadsDir, fullPath)) {
        invalid('附件文件名不合法');
      }
      writeFileSync(fullPath, item.bytes);
      written.push(fullPath);
      saved.push({
        attachment: {
          id,
          name: item.name,
          mime: item.mime,
          size: item.bytes.length,
          path: `data/uploads/${filename}`,
        },
        bytes: item.bytes,
      });
    }
  } catch (error) {
    for (const path of written) {
      try {
        unlinkSync(path);
      } catch {
        // 清理失败不覆盖原始错误；错误文案仍只报通用原因。
      }
    }
    if (error instanceof ContractError) throw error;
    throw new ContractError(ERROR_CODES.E_INTERNAL, '附件保存失败');
  }
  return saved;
}

export function isImageMime(mime: string): boolean {
  return IMAGE_MIMES.has(mime);
}

/** 文本类判断：text/* / application/json 等，或常见代码/数据扩展名。 */
export function isInlineTextAttachment(
  mime: string,
  name: string,
): boolean {
  if (mime.startsWith('text/')) return true;
  if (TEXT_APPLICATION_MIMES.has(mime)) return true;
  const dot = name.lastIndexOf('.');
  if (dot < 0 || dot === name.length - 1) return false;
  return TEXT_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}

export function formatBytes(size: number): string {
  const bytes = Math.max(0, Math.floor(size));
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
  const mb = kb / 1024;
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

/**
 * 生成当前轮 user content：
 *   - 图片 → data URL 分片（真看图）；
 *   - 文本 → 追加到文本部分（>64KB 截断并注明）；
 *   - 其余 → 文本里注明已存档、模型无法直接读取。
 * 落库展示文本只保留用户输入本身，附件正文不写进 messages（控 token）。
 */
export function buildChatUserContent(
  message: string,
  uploads: readonly SavedUpload[],
): ChatUserContent {
  const sections: string[] = [];
  const imageParts: LlmContentPart[] = [];

  for (const upload of uploads) {
    const { attachment, bytes } = upload;
    if (isImageMime(attachment.mime)) {
      const base64 = bytes.toString('base64');
      imageParts.push({
        type: 'image_url',
        image_url: { url: `data:${attachment.mime};base64,${base64}` },
      });
      continue;
    }

    if (isInlineTextAttachment(attachment.mime, attachment.name)) {
      const truncated = bytes.length > MAX_INLINE_TEXT_BYTES;
      const text = bytes.subarray(0, MAX_INLINE_TEXT_BYTES).toString('utf8');
      sections.push(
        `【附件 ${attachment.name}】\n${text}${
          truncated ? '\n…（内容超过 64KB，已截断，仅含前 64KB）' : ''
        }`,
      );
      continue;
    }

    sections.push(
      `已收到二进制附件 ${attachment.name}（${formatBytes(
        attachment.size,
      )}，已存档，模型无法直接读取）`,
    );
  }

  const providerText = [message, ...sections]
    .filter((part) => part.length > 0)
    .join('\n\n');
  const parts: LlmContentPart[] = [];
  if (providerText.length > 0) parts.push({ type: 'text', text: providerText });
  parts.push(...imageParts);
  return { text: message, parts };
}

export interface LocatedUpload {
  id: string;
  filename: string;
  fullPath: string;
}

/**
 * 按 ULID 前缀在 uploads 目录定位文件。
 * id 只允许 Crockford Base32（1–26 位），任何分隔符/点号都直接视为不存在。
 */
export function findUploadById(
  uploadsDir: string,
  rawId: string,
): LocatedUpload | null {
  if (!/^[0-9A-HJKMNP-TV-Z]{1,26}$/u.test(rawId)) return null;
  let entries;
  try {
    entries = readdirSync(uploadsDir, { withFileTypes: true });
  } catch {
    return null;
  }
  const matches = entries
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const separator = entry.name.indexOf('__');
      if (separator !== 26) return null;
      const fileId = entry.name.slice(0, separator);
      if (!/^[0-9A-HJKMNP-TV-Z]{26}$/u.test(fileId)) return null;
      return fileId.startsWith(rawId) ? entry.name : null;
    })
    .filter((name): name is string => name !== null)
    .sort();
  const filename = matches[0];
  if (filename === undefined) return null;

  const fullPath = resolve(join(uploadsDir, filename));
  if (!isInsideDir(uploadsDir, fullPath)) return null;
  const separator = filename.indexOf('__');
  if (separator <= 0) return null;
  return { id: filename.slice(0, separator), filename, fullPath };
}

/** 无消息元数据时的兜底 mime（仅用于历史文件/异常数据）。 */
export function guessMimeFromFilename(filename: string): string {
  const dot = filename.lastIndexOf('.');
  if (dot < 0) return 'application/octet-stream';
  switch (filename.slice(dot + 1).toLowerCase()) {
    case 'png':
      return 'image/png';
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'gif':
      return 'image/gif';
    case 'webp':
      return 'image/webp';
    case 'txt':
    case 'md':
    case 'csv':
    case 'log':
      return 'text/plain; charset=utf-8';
    case 'json':
      return 'application/json';
    default:
      return 'application/octet-stream';
  }
}
