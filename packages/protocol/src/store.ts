import type { Approval } from './approval.js';
import type { Envelope } from './envelope.js';
import type { JournalEvent, JournalEventDraft, JournalEventType } from './journal.js';
import type { KvStore } from './plugin.js';
import type { Route } from './route.js';
import type { Delivery } from './sink.js';
import type { Run, Task } from './task.js';
import type { Incident, Remediation } from './watchdog.js';

export interface Page<T> {
  items: T[];
  nextCursor?: string;
}

export interface ListQuery<T> {
  /** 顶层字段等值过滤。 */
  where?: Partial<{ [K in keyof T]: T[K] | readonly T[K][] }>;
  cursor?: string;
  limit?: number;
  order?: 'asc' | 'desc';
}

export interface JournalFilter {
  subjectId?: string;
  traceId?: string;
  types?: readonly JournalEventType[];
}

export interface Repo<T extends { id: string }> {
  get(id: T['id']): Promise<T | undefined>;
  put(item: T): Promise<void>;
  list(query?: ListQuery<T>): Promise<Page<T>>;
}

export interface EnvelopeRepo extends Repo<Envelope> {
  findByIdempotencyKey(sourceInstance: string, key: string): Promise<Envelope | undefined>;
}

export interface StoreTx {
  /** 追加事件并分配 seq，返回带 seq 的事件。 */
  append(events: JournalEventDraft[]): Promise<JournalEvent[]>;
  readonly envelopes: EnvelopeRepo;
  readonly tasks: Repo<Task>;
  readonly runs: Repo<Run>;
  readonly routes: Repo<Route>;
  readonly approvals: Repo<Approval>;
  readonly deliveries: Repo<Delivery>;
  readonly incidents: Repo<Incident>;
  readonly remediations: Repo<Remediation>;
}

/**
 * 存储接口。Journal 为唯一事实来源，Repo 为物化视图（Projection）。
 * 实现：@super-loop/store-sqlite（默认）、@super-loop/testkit MemoryStore（测试）。
 */
export interface Store extends StoreTx {
  /**
   * 在一个原子事务中写事件和更新投影；fn 抛错则全部回滚。
   * 事务串行执行，fn 内禁止再开启事务，也不要等待外部 IO。
   */
  transaction<T>(fn: (tx: StoreTx) => Promise<T>): Promise<T>;
  /** 读取 seq >= fromSeq 的事件（按 seq 升序）。 */
  readJournal(fromSeq: number, limit: number, filter?: JournalFilter): Promise<JournalEvent[]>;
  latestSeq(): Promise<number>;
  kv(namespace: string): KvStore;
  close(): Promise<void>;
}
