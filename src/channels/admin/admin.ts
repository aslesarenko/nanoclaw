import { ASSISTANT_NAME } from '../../config.js';
import type { RegisteredGroup } from '../../types.js';
import type { AdminHttpServer } from './http.js';
import { jsonResponse } from './http.js';

export interface AdminDeps {
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
}

export function registerAdminRoutes(
  server: AdminHttpServer,
  deps: AdminDeps,
): void {
  server.addRoute('GET', '/health', (_req, res) => {
    jsonResponse(res, 200, { status: 'ok', assistantName: ASSISTANT_NAME });
  });

  server.addRoute('GET', '/groups', (_req, res) => {
    jsonResponse(res, 200, deps.registeredGroups());
  });

  server.addRoute('POST', '/groups', (_req, res, body) => {
    let data: {
      jid: string;
      name: string;
      folder: string;
      trigger: string;
      requiresTrigger?: boolean;
      isMain?: boolean;
    };

    try {
      data = JSON.parse(body);
    } catch {
      jsonResponse(res, 400, { error: 'Invalid JSON' });
      return;
    }

    if (!data.jid || !data.name || !data.folder || !data.trigger) {
      jsonResponse(res, 400, {
        error: 'Missing required fields: jid, name, folder, trigger',
      });
      return;
    }

    const group: RegisteredGroup = {
      name: data.name,
      folder: data.folder,
      trigger: data.trigger,
      added_at: new Date().toISOString(),
      requiresTrigger: data.requiresTrigger ?? true,
      isMain: data.isMain ?? false,
    };

    deps.registerGroup(data.jid, group);
    jsonResponse(res, 201, { jid: data.jid, group });
  });
}
