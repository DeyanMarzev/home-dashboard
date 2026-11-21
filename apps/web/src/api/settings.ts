import {
  AdminRulesResponseSchema,
  DevicesResponseSchema,
  MeSchema,
  MyAlertsResponseSchema,
  NetworkDevicesResponseSchema,
  NotificationLogResponseSchema,
  UsersResponseSchema,
  type AdminRule,
  type AlertRuleOverride,
  type DeviceItem,
  type Me,
  type MePatch,
  type MyAlertPut,
  type MyAlertsResponse,
  type NetworkDevice,
  type UserItem,
  type UserPatch,
} from '@home/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getJson, sendJson } from './client.js';

/** Settings (docs/09 §7) and the System page's recent notifications. */

export function useMyAlerts() {
  return useQuery({
    queryKey: ['my-alerts'],
    queryFn: () => getJson<MyAlertsResponse>('/api/me/alerts', MyAlertsResponseSchema),
    refetchInterval: 60_000, // "Open now" lines stay current
  });
}

/** Saves one rule's choice at once, showing it before the API answers (rolled back on error). */
export function useSaveMyAlert() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ ruleId, body }: { ruleId: string; body: MyAlertPut | null }) =>
      body === null
        ? sendJson('DELETE', `/api/me/alerts/${ruleId}`)
        : sendJson('PUT', `/api/me/alerts/${ruleId}`, body),
    onMutate: async ({ ruleId, body }) => {
      await client.cancelQueries({ queryKey: ['my-alerts'] });
      const before = client.getQueryData<MyAlertsResponse>(['my-alerts']);
      if (before && body) {
        const { entities, ...rest } = body;
        client.setQueryData<MyAlertsResponse>(['my-alerts'], {
          groups: before.groups.map((g) => ({
            ...g,
            rules: g.rules.map((r) =>
              r.id === ruleId ? { ...r, ...rest, entitiesSelected: entities, isDefault: false } : r,
            ),
          })),
        });
      }
      return { before };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.before) client.setQueryData(['my-alerts'], ctx.before);
    },
    onSettled: () => client.invalidateQueries({ queryKey: ['my-alerts'] }),
  });
}

export function usePatchMe() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (patch: MePatch) => sendJson<Me>('PATCH', '/api/me', patch),
    onSuccess: (me) => client.setQueryData(['me'], MeSchema.parse(me)),
  });
}

export function useDevices() {
  return useQuery({
    queryKey: ['devices'],
    queryFn: () => getJson<{ items: DeviceItem[] }>('/api/me/devices', DevicesResponseSchema),
  });
}

export function useDeviceActions() {
  const client = useQueryClient();
  const done = () => client.invalidateQueries({ queryKey: ['devices'] });
  return {
    rename: useMutation({
      mutationFn: ({ id, label }: { id: number; label: string }) =>
        sendJson('PATCH', `/api/me/devices/${id}`, { label }),
      onSuccess: done,
    }),
    remove: useMutation({
      mutationFn: (id: number) => sendJson('DELETE', `/api/me/devices/${id}`),
      onSuccess: done,
    }),
  };
}

export function useAlertRules(enabled: boolean) {
  return useQuery({
    queryKey: ['alert-rules'],
    queryFn: () => getJson<{ items: AdminRule[] }>('/api/alert-rules', AdminRulesResponseSchema),
    enabled,
  });
}

export function useAlertRuleActions() {
  const client = useQueryClient();
  const done = async () => {
    await client.invalidateQueries({ queryKey: ['alert-rules'] });
    await client.invalidateQueries({ queryKey: ['my-alerts'] });
  };
  return {
    patch: useMutation({
      mutationFn: ({ id, params }: { id: string; params: AlertRuleOverride }) =>
        sendJson('PATCH', `/api/alert-rules/${id}`, params),
      onSuccess: done,
    }),
    reset: useMutation({
      mutationFn: (id: string) => sendJson('DELETE', `/api/alert-rules/${id}/override`),
      onSuccess: done,
    }),
  };
}

export function useUsers(enabled: boolean) {
  return useQuery({
    queryKey: ['users'],
    queryFn: () => getJson<{ items: UserItem[] }>('/api/users', UsersResponseSchema),
    enabled,
  });
}

export function usePatchUser() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: number; patch: UserPatch }) =>
      sendJson('PATCH', `/api/users/${id}`, patch),
    onSuccess: () => client.invalidateQueries({ queryKey: ['users'] }),
  });
}

export function useNotificationLog(enabled: boolean) {
  return useQuery({
    queryKey: ['notification-log'],
    queryFn: () => getJson('/api/notifications/log?limit=30', NotificationLogResponseSchema),
    enabled,
    refetchInterval: 60_000,
  });
}

export function useNetworkDevices(enabled: boolean) {
  return useQuery({
    queryKey: ['network-devices'],
    queryFn: () =>
      getJson<{ items: NetworkDevice[] }>('/api/network/devices', NetworkDevicesResponseSchema),
    enabled,
    refetchInterval: 5 * 60_000,
  });
}

export function useNetworkDeviceActions() {
  const client = useQueryClient();
  const done = async () => {
    await client.invalidateQueries({ queryKey: ['network-devices'] });
    await client.invalidateQueries({ queryKey: ['events'] });
  };
  return {
    patch: useMutation({
      mutationFn: ({
        mac,
        patch,
      }: {
        mac: string;
        patch: { label?: string | null; known?: boolean };
      }) => sendJson('PATCH', `/api/network/devices/${encodeURIComponent(mac)}`, patch),
      onSuccess: done,
    }),
    forget: useMutation({
      mutationFn: (mac: string) =>
        sendJson('DELETE', `/api/network/devices/${encodeURIComponent(mac)}`),
      onSuccess: done,
    }),
  };
}
