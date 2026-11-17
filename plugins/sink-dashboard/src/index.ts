/**
 * sink-dashboard：把通知写入看板收件箱（插件私有 KV 的 `inbox/` 前缀下）。
 * 看板 / API 通过 `GET /api/v1/notifications?sink=<instance>` 读取。
 */
import { defineSinkPlugin, healthy, type InboxItem } from '@super-loop/plugin-sdk';
import { z } from 'zod';

export type { InboxItem } from '@super-loop/plugin-sdk';

export const INBOX_PREFIX = 'inbox/';

const ConfigSchema = z.object({
  /** 收件箱最多保留条数，超出后删除最旧的。 */
  maxItems: z.number().int().positive().default(1_000),
});

export default defineSinkPlugin({
  name: 'sink-dashboard',
  version: '0.1.0',
  description: 'Store notifications in the dashboard inbox.',
  configSchema: ConfigSchema,
  create(config, ctx) {
    return {
      async deliver(notification) {
        // deliveryId 是 ULID：作为 key 天然按时间排序，重复投递只会覆盖同一条。
        const key = `${INBOX_PREFIX}${notification.deliveryId}`;
        const item: InboxItem = { ...notification, receivedAt: ctx.clock.iso(), read: false };
        await ctx.kv.set(key, item);

        const all = await ctx.kv.list(INBOX_PREFIX);
        for (const old of all.slice(0, Math.max(0, all.length - config.maxItems))) {
          await ctx.kv.delete(old.key);
        }
        return { ok: true, externalId: key };
      },
      async health() {
        return healthy(ctx.clock.iso());
      },
    };
  },
});
