import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite';
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
  Store,
  StoreTx,
  Task,
} from '@super-loop/protocol';
import { ErrorCode, LoopError, systemClock } from '@super-loop/shared';

/** 迁移按顺序执行，已执行的版本记录在 meta.schema_version。只能追加，不能修改。 */
const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE journal (
    seq          INTEGER PRIMARY KEY AUTOINCREMENT,
    id           TEXT NOT NULL UNIQUE,
    type         TEXT NOT NULL,
    at           TEXT NOT NULL,
    subject_kind TEXT NOT NULL,
    subject_id   TEXT NOT NULL,
    actor        TEXT NOT NULL,
    trace_id     TEXT,
    data         TEXT NOT NULL
  );
  CREATE INDEX journal_subject ON journal (subject_id, seq);
  CREATE INDEX journal_trace ON journal (trace_id, seq) WHERE trace_id IS NOT NULL;

  CREATE TABLE entities (
    collection TEXT NOT NULL,
    id         TEXT NOT NULL,
    data       TEXT NOT NULL,
    PRIMARY KEY (collection, id)
  ) WITHOUT ROWID;
  CREATE INDEX entities_status ON entities (collection, json_extract(data, '$.status'));
  CREATE INDEX entities_idem ON entities (
    json_extract(data, '$.source.instance'),
    json_extract(data, '$.idempotencyKey')
  ) WHERE collection = 'envelopes';

  CREATE TABLE kv (
    namespace  TEXT NOT NULL,
    key        TEXT NOT NULL,
    value      TEXT NOT NULL,
    expires_at INTEGER,
    PRIMARY KEY (namespace, key)
  ) WITHOUT ROWID;
  `,
];

type Collection =
  | 'envelopes'
  | 'tasks'
  | 'runs'
  | 'routes'
  | 'approvals'
  | 'deliveries'
  | 'incidents'
  | 'remediations';

const FIELD = /^[A-Za-z_][A-Za-z0-9_]*$/;

function toSql(value: unknown): SQLInputValue {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number' || typeof value === 'string' || typeof value === 'bigint') {
    return value;
  }
  return JSON.stringify(value);
}

export interface SqliteStoreOptions {
  /** 数据库文件路径，或 `:memory:`。 */
  path: string;
  clock?: Clock;
}

/**
 * 基于 node:sqlite 的 Store。单连接、WAL 模式。
 * 写操作（含事务外的 put/append）全部经过同一把异步锁串行执行，保证事务边界清晰。
 */
export class SqliteStore implements Store {
  readonly #db: DatabaseSync;
  readonly #clock: Clock;
  readonly #stmts = new Map<string, StatementSync>();
  #lock: Promise<unknown> = Promise.resolve();
  readonly #txScope = new AsyncLocalStorage<true>();
  #closed = false;
  readonly #tx: StoreTx;

  readonly envelopes: EnvelopeRepo;
  readonly tasks: Repo<Task>;
  readonly runs: Repo<Run>;
  readonly routes: Repo<Route>;
  readonly approvals: Repo<Approval>;
  readonly deliveries: Repo<Delivery>;
  readonly incidents: Repo<Incident>;
  readonly remediations: Repo<Remediation>;

  constructor(options: SqliteStoreOptions) {
    if (options.path !== ':memory:') mkdirSync(dirname(options.path), { recursive: true });
    this.#db = new DatabaseSync(options.path);
    this.#clock = options.clock ?? systemClock;
    this.#db.exec(
      'PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;',
    );
    this.#migrate();

    // 事务内视图：直接操作连接，不加锁。
    this.#tx = {
      append: async (drafts) => this.#appendRaw(drafts),
      envelopes: this.#envelopeRepo(false),
      tasks: this.#repo<Task>('tasks', false),
      runs: this.#repo<Run>('runs', false),
      routes: this.#repo<Route>('routes', false),
      approvals: this.#repo<Approval>('approvals', false),
      deliveries: this.#repo<Delivery>('deliveries', false),
      incidents: this.#repo<Incident>('incidents', false),
      remediations: this.#repo<Remediation>('remediations', false),
    };
    // 事务外视图：写操作自动包一层事务。
    this.envelopes = this.#envelopeRepo(true);
    this.tasks = this.#repo<Task>('tasks', true);
    this.runs = this.#repo<Run>('runs', true);
    this.routes = this.#repo<Route>('routes', true);
    this.approvals = this.#repo<Approval>('approvals', true);
    this.deliveries = this.#repo<Delivery>('deliveries', true);
    this.incidents = this.#repo<Incident>('incidents', true);
    this.remediations = this.#repo<Remediation>('remediations', true);
  }

  // ───────────────────────────── 基础设施 ─────────────────────────────

  #stmt(sql: string): StatementSync {
    let stmt = this.#stmts.get(sql);
    if (!stmt) {
      stmt = this.#db.prepare(sql);
      this.#stmts.set(sql, stmt);
    }
    return stmt;
  }

  #migrate(): void {
    this.#db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    const row = this.#stmt("SELECT value FROM meta WHERE key = 'schema_version'").get();
    const current = row ? Number(row.value) : 0;
    for (let v = current; v < MIGRATIONS.length; v++) {
      this.#db.exec('BEGIN');
      try {
        this.#db.exec(MIGRATIONS[v] as string);
        this.#stmt(
          "INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        ).run(String(v + 1));
        this.#db.exec('COMMIT');
      } catch (error) {
        this.#db.exec('ROLLBACK');
        throw error;
      }
    }
  }

  transaction<T>(fn: (tx: StoreTx) => Promise<T>): Promise<T> {
    // 只拒绝"在事务回调内部"再开事务；不同异步流程的并发事务正常排队。
    if (this.#txScope.getStore()) {
      return Promise.reject(
        new LoopError(ErrorCode.INTERNAL, 'nested transaction is not allowed', {
          retryable: false,
        }),
      );
    }
    const run = async () => {
      if (this.#closed) throw new LoopError(ErrorCode.UNAVAILABLE, 'store is closed');
      this.#db.exec('BEGIN IMMEDIATE');
      try {
        const result = await this.#txScope.run(true, () => fn(this.#tx));
        this.#db.exec('COMMIT');
        return result;
      } catch (error) {
        this.#db.exec('ROLLBACK');
        throw error;
      }
    };
    const result = this.#lock.then(run, run);
    this.#lock = result.catch(() => {});
    return result;
  }

  // ───────────────────────────── Journal ─────────────────────────────

  #appendRaw(drafts: JournalEventDraft[]): JournalEvent[] {
    const insert = this.#stmt(
      'INSERT INTO journal (id, type, at, subject_kind, subject_id, actor, trace_id, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    );
    return drafts.map((d) => {
      const { lastInsertRowid } = insert.run(
        d.id,
        d.type,
        d.at,
        d.subject.kind,
        d.subject.id,
        d.actor,
        d.traceId ?? null,
        JSON.stringify(d.data ?? null),
      );
      return { ...structuredClone(d), seq: Number(lastInsertRowid) };
    });
  }

  append(drafts: JournalEventDraft[]): Promise<JournalEvent[]> {
    return this.transaction((tx) => tx.append(drafts));
  }

  async readJournal(
    fromSeq: number,
    limit: number,
    filter: JournalFilter = {},
  ): Promise<JournalEvent[]> {
    const where = ['seq >= ?'];
    const params: SQLInputValue[] = [fromSeq];
    if (filter.subjectId !== undefined) {
      where.push('subject_id = ?');
      params.push(filter.subjectId);
    }
    if (filter.traceId !== undefined) {
      where.push('trace_id = ?');
      params.push(filter.traceId);
    }
    if (filter.types !== undefined) {
      if (filter.types.length === 0) return [];
      where.push(`type IN (${filter.types.map(() => '?').join(', ')})`);
      params.push(...filter.types);
    }
    params.push(limit);
    const rows = this.#stmt(
      `SELECT * FROM journal WHERE ${where.join(' AND ')} ORDER BY seq LIMIT ?`,
    ).all(...params);
    return rows.map(
      (r) =>
        ({
          seq: Number(r.seq),
          id: r.id,
          type: r.type,
          at: r.at,
          subject: { kind: r.subject_kind, id: r.subject_id },
          actor: r.actor,
          ...(r.trace_id === null ? {} : { traceId: r.trace_id }),
          data: JSON.parse(r.data as string),
        }) as JournalEvent,
    );
  }

  async latestSeq(): Promise<number> {
    const row = this.#stmt('SELECT MAX(seq) AS seq FROM journal').get();
    return Number(row?.seq ?? 0);
  }

  // ───────────────────────────── Repos ─────────────────────────────

  #repo<T extends { id: string }>(collection: Collection, locked: boolean): Repo<T> {
    const putRaw = (item: T) => {
      this.#stmt(
        'INSERT INTO entities (collection, id, data) VALUES (?, ?, ?) ON CONFLICT(collection, id) DO UPDATE SET data = excluded.data',
      ).run(collection, item.id, JSON.stringify(item));
    };
    return {
      get: async (id) => {
        const row = this.#stmt('SELECT data FROM entities WHERE collection = ? AND id = ?').get(
          collection,
          id,
        );
        return row ? (JSON.parse(row.data as string) as T) : undefined;
      },
      put: locked
        ? (item) => this.transaction(async () => putRaw(item))
        : async (item) => putRaw(item),
      list: async (query: ListQuery<T> = {}) => this.#list<T>(collection, query),
    };
  }

  #list<T extends { id: string }>(collection: Collection, query: ListQuery<T>): Page<T> {
    const where = ['collection = ?'];
    const params: SQLInputValue[] = [collection];
    for (const [key, expected] of Object.entries(query.where ?? {})) {
      if (!FIELD.test(key)) throw new LoopError(ErrorCode.INVALID_INPUT, `invalid field: ${key}`);
      const expr = `json_extract(data, '$.${key}')`;
      if (Array.isArray(expected)) {
        if (expected.length === 0) return { items: [] };
        where.push(`${expr} IN (${expected.map(() => '?').join(', ')})`);
        params.push(...expected.map(toSql));
      } else if (expected === null || expected === undefined) {
        where.push(`${expr} IS NULL`);
      } else {
        where.push(`${expr} = ?`);
        params.push(toSql(expected));
      }
    }
    const desc = query.order === 'desc';
    if (query.cursor) {
      where.push(desc ? 'id < ?' : 'id > ?');
      params.push(query.cursor);
    }
    const limit = Math.max(1, Math.min(query.limit ?? 50, 1000));
    params.push(limit + 1);
    const rows = this.#stmt(
      `SELECT id, data FROM entities WHERE ${where.join(' AND ')} ORDER BY id ${desc ? 'DESC' : 'ASC'} LIMIT ?`,
    ).all(...params);
    const items = rows.slice(0, limit).map((r) => JSON.parse(r.data as string) as T);
    const page: Page<T> = { items };
    const last = items.at(-1);
    if (rows.length > limit && last) page.nextCursor = last.id;
    return page;
  }

  #envelopeRepo(locked: boolean): EnvelopeRepo {
    return {
      ...this.#repo<Envelope>('envelopes', locked),
      findByIdempotencyKey: async (sourceInstance, key) => {
        const row = this.#stmt(
          `SELECT data FROM entities
           WHERE collection = 'envelopes'
             AND json_extract(data, '$.source.instance') = ?
             AND json_extract(data, '$.idempotencyKey') = ?
           LIMIT 1`,
        ).get(sourceInstance, key);
        return row ? (JSON.parse(row.data as string) as Envelope) : undefined;
      },
    };
  }

  // ───────────────────────────── KV ─────────────────────────────

  kv(namespace: string): KvStore {
    const live = 'namespace = ? AND (expires_at IS NULL OR expires_at > ?)';
    return {
      get: async <T>(key: string) => {
        const row = this.#stmt(`SELECT value FROM kv WHERE ${live} AND key = ?`).get(
          namespace,
          this.#clock.now(),
          key,
        );
        return row ? (JSON.parse(row.value as string) as T) : undefined;
      },
      set: (key, value, options) =>
        this.transaction(async () => {
          this.#stmt(
            'INSERT INTO kv (namespace, key, value, expires_at) VALUES (?, ?, ?, ?) ON CONFLICT(namespace, key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at',
          ).run(
            namespace,
            key,
            JSON.stringify(value ?? null),
            options?.ttlMs === undefined ? null : this.#clock.now() + options.ttlMs,
          );
        }),
      delete: (key) =>
        this.transaction(async () => {
          this.#stmt('DELETE FROM kv WHERE namespace = ? AND key = ?').run(namespace, key);
        }),
      list: async <T>(prefix = '') => {
        const rows = this.#stmt(
          `SELECT key, value FROM kv WHERE ${live} AND substr(key, 1, ?) = ? ORDER BY key`,
        ).all(namespace, this.#clock.now(), prefix.length, prefix);
        return rows.map((r) => ({
          key: r.key as string,
          value: JSON.parse(r.value as string) as T,
        }));
      },
    };
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    await this.#lock;
    this.#closed = true;
    this.#db.close();
  }
}
