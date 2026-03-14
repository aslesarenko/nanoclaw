import type { Migration } from '../migrations.js';
import { migration as m001 } from './001-identity-store.js';
import { migration as m002 } from './002-observability.js';

export const allMigrations: Migration[] = [m001, m002];
