import { ID_PREFIX, type IdKind, type IdOf, ULID_PATTERN } from '@super-loop/protocol';
import { monotonicFactory } from 'ulid';

const nextUlid = monotonicFactory();

/** 生成带前缀的 ULID，如 `env_01J...`。同一毫秒内单调递增。 */
export function newId<K extends IdKind>(kind: K, now?: number): IdOf<K> {
  return `${ID_PREFIX[kind]}_${nextUlid(now)}` as IdOf<K>;
}

export function isId<K extends IdKind>(kind: K, value: unknown): value is IdOf<K> {
  return (
    typeof value === 'string' && new RegExp(`^${ID_PREFIX[kind]}_${ULID_PATTERN}$`).test(value)
  );
}
