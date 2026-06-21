import type { AuthInfo } from '../middleware/auth.js';
import type { TenantContext } from '@boss/core';

declare module 'fastify' {
  interface FastifyRequest {
    auth?: AuthInfo;
    tenant?: TenantContext;
  }
}
