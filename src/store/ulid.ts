/**
 * ULID 生成（store 层实现，契约层不引 IO）。
 * 26 位 Crockford Base32：前 10 位时间戳（48bit，ms），后 16 位随机（80bit）。
 */
import { randomBytes } from 'node:crypto';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const TIME_LEN = 10;
const RANDOM_LEN = 16;

export function newUlid(now: number = Date.now()): string {
  let time = '';
  let t = now;
  for (let i = TIME_LEN - 1; i >= 0; i -= 1) {
    time = ALPHABET.charAt(t % 32) + time;
    t = Math.floor(t / 32);
  }
  const bytes = randomBytes(RANDOM_LEN);
  let random = '';
  for (let i = 0; i < RANDOM_LEN; i += 1) {
    random += ALPHABET.charAt((bytes[i] ?? 0) % 32);
  }
  return time + random;
}

export function newTaskId(now?: number): string {
  return `t_${newUlid(now)}`;
}

export function newRunId(now?: number): string {
  return `r_${newUlid(now)}`;
}

/** 是否为合法的 26 位 ULID 主体（不含 t_/r_ 前缀）。 */
export function isUlid(value: string): boolean {
  return /^[0-9A-HJKMNP-TV-Z]{26}$/.test(value);
}
