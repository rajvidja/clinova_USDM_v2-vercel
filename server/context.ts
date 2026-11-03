import { AsyncLocalStorage } from 'node:async_hooks';
import type { Role } from '../shared/governance.ts';

export interface Actor {
  userId: string;
  username: string;
  displayName: string;
  roles: Role[];
  permissions: Set<string>;
  ip?: string;
}

/** Actor for start-up seeding and automatic system actions. */
export const SYSTEM_ACTOR: Actor = { userId: 'system', username: 'system', displayName: 'System', roles: [], permissions: new Set(['*']) };

const storage = new AsyncLocalStorage<Actor>();

export const runAs = <T>(actor: Actor, fn: () => T): T => storage.run(actor, fn);
export const currentActor = (): Actor => storage.getStore() ?? SYSTEM_ACTOR;
