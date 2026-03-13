import type { Migration } from '../migrations.js';
import { migration as m001 } from './001-identity-store.js';

export const allMigrations: Migration[] = [m001];
