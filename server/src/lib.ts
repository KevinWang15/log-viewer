// Public API of the log-viewer package.
//
//   import { createLogViewer } from '@kevinwang15/log-viewer';
//
// Stable: createLogViewer and its options/handle, the provider SPI
// (LogProvider & co.), MemoryProvider, the authorization types, LogSource and
// BaseSource for custom sources. Marked @experimental: viewer.store and
// ViewerModule.

export { createLogViewer } from './viewer';
export type { LogViewer, LogViewerOptions, RequestHandler } from './viewer';

export * from './provider/spi';
export { MemoryProvider } from './provider/memory';
export type { MemoryProviderOptions } from './provider/memory';
export { ProviderSource } from './provider/source';
export type { ProviderSourceOptions, ProviderSourceState } from './provider/source';
export type { ProvidersOptions } from './options';

export { keyAuthorizer } from './auth';
export type { AuthAction, AuthContext, AuthDecision, Authorizer, KeyAuthOptions } from './auth';

export type { AppendEvent, Criteria, EntryOut, LogSource } from './source-api';
export { BaseSource } from './sources';
export type { StreamEntryInput } from './sources';
export type { FileOpener, FilesOptions, Logger, RemoteOptions, StreamsApi, StreamsOptions } from './options';

export { configFromEnv, DEFAULTS, ENV_VARS } from './config';
export type { EnvConfig, ScopedStreamToken } from './config';
export { compilePattern, LEVEL_NAMES, levelFromString, parseTimestamp } from './parser';
