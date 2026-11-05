import { AsyncLocalStorage } from 'node:async_hooks';
import type {
  Approval,
  Clock,
  Delivery,
  Envelope,
  EnvelopeRepo,
  Incident,
  JournalEvent,
  JournalEventDraft,
  JournalFilter,
  KvStore,
  ListQuery,
  Page,
  Remediation,
  Repo,
  Route,
  Run,
  SecretResolver,
  Store,
  StoreTx,
  Task,
} from '@super-loop/protocol';
import { systemClock } from '@super-loop/shared';

// ───────────────────────────── KV / Blob / Secrets ─────────────────────────────

export function createMemoryKv(clock: Clock = systemClock): KvStore {
  const data = new Map<string, { value: unknown; expiresAt?: number }>();
  const live = (key: string) => {
    const entry = data.get(key);
    if (entry?.expiresAt !== undefined && entry.expiresAt <= clock.now()) {
      data.delete(key);
      return undefined;
    }
    return entry;
  };
  return {
    async get<T>(key: string) {
      return live(key)?.value as T | undefined;
    },
    async set(key, value, options) {
      data.set(key, {
        value: structuredClone(value),
        ...(options?.ttlMs === undefined ? {} : { expiresAt: clock.now() + options.ttlMs }),
      });
    },
    async delete(key) {
      data.delete(key);
    },
    async list<T>(prefix = '') {
      return [...data.keys()]
        .filter((k) => k.startsWith(prefix) && live(k))
        .sort()
        .map((key) => ({ key, value: data.get(key)?.value as T }));
    },
  };
}

export function createStaticSecrets(values: Record<string, string> = {}): SecretResolver {
  return { get: async (name) => values[name] };
}

// ───────────────────────────── MemoryStore ─────────────────────────────

type Entity = { id: string };
type Tables = Record<RepoName, Map<string, Entity>>;
type RepoName =
  | 'envelopes'
  | 'tasks'
  | 'runs'
  | 'routes'
  | 'approvals'
  | 'deliveries'
  | 'incidents'
  | 'remediations';

const REPO_NAMES: readonly RepoName[] = [
  'envelopes',
  'tasks',
  'runs',
  'routes',
  'approvals',
  'deliveries',
  'incidents',
  'remediations',
];

interface State {
  journal: JournalEvent[];
  tables: Tables;
}

function emptyState(): State {
  return {
    journal: [],
    tables: Object.fromEntries(REPO_NAMES.map((n) => [n, new Map()])) as Tables,
  };
}

function matches<T>(item: T, where: ListQuery<T>['where']): boolean {
  if (!where) return true;
  return Object.entries(where).every(([key, expected]) => {
    const actual = (item as Record<string, unknown>)[key];
    return Array.isArray(expected) ? expected.includes(actual) : actual === expected;
  });
}

function makeRepo<T extends Entity>(getTable: () => Map<string, Entity>): Repo<T> {
  return {
    async get(id) {
      const item = getTable().get(id);
      return item === undefined ? undefined : (structuredClone(item) as T);
    },
    async put(item) {
      getTable().set(item.id, structuredClone(item));
    },
    async list(query = {}) {
      // ID 为 ULID，按 ID 排序即按创建时间排序；cursor 为上一页最后一个 ID。
      const desc = query.order === 'desc';
      const limit = query.limit ?? 50;
      const all = [...getTable().values()]
        .filter((item) => matches(item as T, query.where))
        .sort((a, b) => (desc ? b.id.localeCompare(a.id) : a.id.localeCompare(b.id)));
      const cursor = query.cursor;
      const start = cursor
        ? all.findIndex((item) => (desc ? item.id < cursor : item.id > cursor))
        : 0;
      const items = start < 0 ? [] : all.slice(start, start + limit);
      const last = items.at(-1);
      const page: Page<T> = { items: items.map((i) => structuredClone(i) as T) };
      if (last && start + limit < all.length) page.nextCursor = last.id;
      return page;
    },
  };
}

/**
 * 内存版 Store，语义与正式实现一致（事务原子性、seq 单调），仅用于测试。
 * 事务通过快照实现：fn 抛错时恢复到事务开始前的状态。
 */
export class MemoryStore implements Store {
  #state: State = emptyState();
  #seq = 0;
  #kv = new Map<string, KvStore>();
  #txChain: Promise<unknown> = Promise.resolve();
  readonly #txScope = new AsyncLocalStorage<true>();

  readonly envelopes: EnvelopeRepo;
  readonly tasks: Repo<Task>;
  readonly runs: Repo<Run>;
  readonly routes: Repo<Route>;
  readonly approvals: Repo<Approval>;
  readonly deliveries: Repo<Delivery>;
  readonly incidents: Repo<Incident>;
  readonly remediations: Repo<Remediation>;
  readonly #clock: Clock;

  constructor(clock: Clock = systemClock) {
    this.#clock = clock;
    const table = (name: RepoName) => () => this.#state.tables[name];
    const envelopes = makeRepo<Envelope>(table('envelopes'));
    this.envelopes = {
      ...envelopes,
      findByIdempotencyKey: async (sourceInstance, key) => {
        for (const env of this.#state.tables.envelopes.values()) {
          const e = env as Envelope;
          if (e.source.instance === sourceInstance && e.idempotencyKey === key) {
            return structuredClone(e);
          }
        }
        return undefined;
      },
    };
    this.tasks = makeRepo<Task>(table('tasks'));
    this.runs = makeRepo<Run>(table('runs'));
    this.routes = makeRepo<Route>(table('routes'));
    this.approvals = makeRepo<Approval>(table('approvals'));
    this.deliveries = makeRepo<Delivery>(table('deliveries'));
    this.incidents = makeRepo<Incident>(table('incidents'));
    this.remediations = makeRepo<Remediation>(table('remediations'));
  }

  async append(drafts: JournalEventDraft[]): Promise<JournalEvent[]> {
    const events = drafts.map((d) => ({ ...structuredClone(d), seq: ++this.#seq }));
    this.#state.journal.push(...events);
    return structuredClone(events);
  }

  transaction<T>(fn: (tx: StoreTx) => Promise<T>): Promise<T> {
    // 串行化事务，模拟 SQLite 的单写者语义。
    // 只拒绝"在事务回调内部"再开事务；不同异步流程的并发事务正常排队。
    if (this.#txScope.getStore()) {
      return Promise.reject(new Error('nested transaction is not allowed'));
    }
    const run = async () => {
      const snapshot = structuredClone(this.#state);
      const seq = this.#seq;
      try {
        return await this.#txScope.run(true, () => fn(this));
      } catch (error) {
        this.#state = snapshot;
        this.#seq = seq;
        throw error;
      }
    };
    const result = this.#txChain.then(run, run);
    this.#txChain = result.catch(() => {});
    return result;
  }

  async readJournal(
    fromSeq: number,
    limit: number,
    filter: JournalFilter = {},
  ): Promise<JournalEvent[]> {
    const hit = (e: JournalEvent) =>
      e.seq >= fromSeq &&
      (filter.subjectId === undefined || e.subject.id === filter.subjectId) &&
      (filter.traceId === undefined || e.traceId === filter.traceId) &&
      (filter.types === undefined || filter.types.includes(e.type));
    return structuredClone(this.#state.journal.filter(hit).slice(0, limit));
  }

  async latestSeq(): Promise<number> {
    return this.#seq;
  }

  kv(namespace: string): KvStore {
    let kv = this.#kv.get(namespace);
    if (!kv) {
      kv = createMemoryKv(this.#clock);
      this.#kv.set(namespace, kv);
    }
    return kv;
  }

  async close(): Promise<void> {}
}
