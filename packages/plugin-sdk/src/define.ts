import {
  PLUGIN_API_VERSION,
  type PluginContext,
  type PluginDefinition,
  type PluginInstanceMap,
  type PluginKind,
  PluginManifestSchema,
} from '@super-loop/protocol';
import { ErrorCode, LoopError } from '@super-loop/shared';
import type { z } from 'zod';

export interface DefinePluginInput<K extends PluginKind, S extends z.ZodType> {
  name: string;
  version: string;
  kind: K;
  description?: string;
  /** 默认为当前 SDK 的 PLUGIN_API_VERSION。 */
  apiVersion?: number;
  permissions?: string[];
  configSchema: S;
  create(
    config: z.output<S>,
    ctx: PluginContext,
  ): PluginInstanceMap[K] | Promise<PluginInstanceMap[K]>;
}

/**
 * 定义一个插件。插件包必须 `export default definePlugin({...})`。
 * 定义时即校验清单，错误在 import 阶段暴露而不是运行时。
 */
export function definePlugin<K extends PluginKind, S extends z.ZodType>(
  input: DefinePluginInput<K, S>,
): PluginDefinition<K, z.output<S>> {
  const manifest = PluginManifestSchema.safeParse({
    name: input.name,
    version: input.version,
    kind: input.kind,
    apiVersion: input.apiVersion ?? PLUGIN_API_VERSION,
    permissions: input.permissions ?? [],
    ...(input.description === undefined ? {} : { description: input.description }),
  });
  if (!manifest.success) {
    throw new LoopError(ErrorCode.INVALID_CONFIG, `invalid plugin manifest for "${input.name}"`, {
      details: { issues: manifest.error.issues },
    });
  }
  return Object.freeze({
    ...manifest.data,
    kind: input.kind,
    configSchema: input.configSchema as z.ZodType<z.output<S>>,
    create: input.create,
  });
}

type KindInput<K extends PluginKind, S extends z.ZodType> = Omit<DefinePluginInput<K, S>, 'kind'>;

export const defineSourcePlugin = <S extends z.ZodType>(input: KindInput<'source', S>) =>
  definePlugin({ ...input, kind: 'source' });

export const defineAgentPlugin = <S extends z.ZodType>(input: KindInput<'agent', S>) =>
  definePlugin({ ...input, kind: 'agent' });

export const defineSinkPlugin = <S extends z.ZodType>(input: KindInput<'sink', S>) =>
  definePlugin({ ...input, kind: 'sink' });

export const defineRouterPlugin = <S extends z.ZodType>(input: KindInput<'router', S>) =>
  definePlugin({ ...input, kind: 'router' });

export const defineProbePlugin = <S extends z.ZodType>(input: KindInput<'probe', S>) =>
  definePlugin({ ...input, kind: 'probe' });

export const definePlaybookPlugin = <S extends z.ZodType>(input: KindInput<'playbook', S>) =>
  definePlugin({ ...input, kind: 'playbook' });

/** 宿主侧：检查插件与当前内核协议是否兼容。 */
export function assertCompatible(def: Pick<PluginDefinition, 'name' | 'apiVersion'>): void {
  if (def.apiVersion !== PLUGIN_API_VERSION) {
    throw new LoopError(
      ErrorCode.PLUGIN_INCOMPATIBLE,
      `plugin "${def.name}" targets apiVersion ${def.apiVersion}, kernel supports ${PLUGIN_API_VERSION}`,
      { retryable: false },
    );
  }
}
